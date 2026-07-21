import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MemoryEntry, TrashItem } from './types.ts';
import type { EmbedderBackend } from './embedder-backend.ts';
import type { MemoryBackend } from './backend.ts';
import { keywordScore, type ScoredMemory } from './retriever.ts';
import { DefaultRetriever, type Retriever } from './retriever-iface.ts';
import { VectorIndexRetriever } from './vector-retriever.ts';
import { FileLock } from './lock.ts';
import { memoryMetrics } from './metrics.ts';

/**
 * 记忆库：单作用域（baseDir 指定目录）双轨记忆的落盘与 CRUD。
 *
 * 两轨：
 * 1. 常驻事实 MEMORY.md —— 人类可读，每次会话整段注入系统提示词（类 Claude Code 的 CLAUDE.md）。
 * 2. 语义记忆 memories.json —— MemoryEntry[]，带 embedding 缓存，启动时语义预取召回。
 *
 * 设计约束（来自架构决策）：
 * - 记忆只服务非代码语义，绝不进入 grep/search 工具链（避免污染代码检索）。
 * - 子 Agent 不加载本库（隔离，保持 delegate 现状）。
 * - 所有写操作落盘；嵌入失败不影响事实记忆与关键词降级检索。
 *
 * ── M8 异步 I/O ──
 * 全部读/写方法均为 async。内部 I/O 由 `this._async` 决定走 `fs/promises`（异步、不阻塞事件循环）
 * 还是同步 `fs`（回退路径，输出逐字节一致，作安全锚点）。异步模式下所有「读-改-写」变更操作经
 * 实例级写串行链 `_chain` 排队，杜绝并发 async 写交错导致丢失更新 / 半截文件。纯读命中内存缓存，
 * 不进写链，保证读取不阻塞写入。
 */
const FACTS_FILE = 'MEMORY.md';
const INDEX_FILE = 'memories.json';
const TRASH_FILE = 'trash.json';
/** M10 跨进程 advisory lock 锁文件（仅 crossProcLock 开时创建/删除）。 */
const LOCK_FILE = '.dsa-lock';
/** 回收站保留时长（ms）：30 天后超期项在下次读取时自动清理。 */
const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 后台回收站 sweep 默认周期（ms）：6 小时。仅 bgTrashSweep 开时启用。 */
const BG_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface FileMemoryBackendOpts {
  /** 异步 I/O 开关（M8）。true=fs/promises 不阻塞事件循环；false=同步 fs 回退（输出逐字节一致）。 */
  async?: boolean;
  /** 向量化检索开关（M9）。true=预计算归一化矩阵向量化余弦 + 版本缓存；false=线性扫描现状（默认）。 */
  vectorIndex?: boolean;
  /** 后台回收站清理开关（M10）。true=setInterval 后台周期 sweep trash.json 超期项，读路径不再内联重写；false=读时清理现状（默认）。 */
  bgTrashSweep?: boolean;
  /** 跨进程 advisory lock 开关（M10）。true=GUI+CLI 同写一 scope 时加文件锁包裹读-改-写临界区，防相互覆盖；false=无锁现状（默认）。 */
  crossProcLock?: boolean;
}

/**
 * 单作用域记忆库。baseDir 由调用方决定：
 * - 项目级 = <cwd>/.dsa/memory
 * - 用户级全局 = ~/.dsa/memory
 * 两层由 MemoryManager 聚合（见 manager.ts）。
 */
export class FileMemoryBackend implements MemoryBackend {
  private dir: string;
  private embedder: EmbedderBackend;
  /** M8 异步 I/O 开关；false = 同步回退（逐字节一致）。 */
  private _async: boolean;
  /** M9 向量化检索开关；false = 线性扫描（默认，与旧路径一致）。 */
  private _vectorIndex: boolean;
  /** M9 scope 版本计数器：索引内容变更时自增，供 VectorIndexRetriever 门控矩阵重建。 */
  private _version = 0;
  /** 检索器实例（M9 接线点）：默认 DefaultRetriever；vectorIndex 开→VectorIndexRetriever。 */
  private retriever: Retriever;
  /** M9 query 向量缓存（仅 vectorIndex 开时启用）：同 query 字符串复用嵌入，省重复 embed。 */
  private _queryVecCache = new Map<string, number[] | null>();
  /** M10 后台回收站清理开关（bgTrashSweep）。true=后台周期 sweep；false=读时清理（默认）。 */
  private _bgSweep: boolean;
  /** M10 后台 sweep 定时器句柄（bgSweep 开时存在；unref 以免阻止进程退出）。 */
  private _sweepTimer: ReturnType<typeof setInterval> | undefined;
  /** M10 跨进程 advisory lock 开关（crossProcLock）。true=加文件锁包裹临界区；false=无锁（默认）。 */
  private _crossProcLock: boolean;
  /** M10 跨进程锁实例（crossProcLock 开时创建）。 */
  private _lock: FileLock | undefined;

  /** ✅ 性能：readIndex 内存缓存，避免每次操作都从磁盘全量重读+解析 JSON */
  private _indexCache: MemoryEntry[] | null = null;
  private _indexDirty = true;
  /** ✅ 性能：MEMORY.md 事实缓存 */
  private _factsCache: string | null = null;
  private _factsDirty = true;

  /** M8 写串行链：所有读-改-写变更操作入队，保证异步模式下不交错损坏。 */
  private _chain: Promise<void> = Promise.resolve();
  /**
   * 重入标记：当前是否正处于某个已入链操作的执行体中。
   * 用于打破「操作体内又调用 enqueue」（如 forget→pushTrash、restore→addFact）引发的死锁：
   * 处于操作体内时，被调用的内部写直接就地执行（本就已被外层操作串行化），不再挂新链节。
   */
  private _inOp = false;

  constructor(baseDir: string, embedder: EmbedderBackend, opts?: FileMemoryBackendOpts) {
    this.dir = baseDir;
    this.embedder = embedder;
    this._async = opts?.async ?? false;
    this._vectorIndex = opts?.vectorIndex ?? false;
    this._bgSweep = opts?.bgTrashSweep ?? false;
    this._crossProcLock = opts?.crossProcLock ?? false;
    if (this._crossProcLock) this._lock = new FileLock(join(this.dir, LOCK_FILE));
    this.retriever = this._vectorIndex
      ? new VectorIndexRetriever(new DefaultRetriever(), {
          versionProvider: () => this._version,
          // M10 监控：向量索引矩阵缓存命中率
          onCache: (hit) => memoryMetrics.recordVectorIndex(hit),
        })
      : new DefaultRetriever();
    // M10 bgTrashSweep：开→启动后台周期 sweep（unref，不阻止进程退出）；关→不启动（读时清理现状）。
    if (this._bgSweep) this.startBackgroundSweep();
  }

  /** 确保目录存在（同步 mkdir，幂等，两种模式通用）。 */
  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  /**
   * 异步模式下把变更操作入写链串行执行；同步模式直接执行（同步 fs 天然不交错）。
   *
   * 重入处理（关键）：若当前已处于某个入链操作的执行体中（_inOp=true），则被调用的写操作
   * 直接就地执行、不再挂新链节。否则会出现循环依赖死锁——
   *   父操作 opA 体内 await 子操作 opB 的 enqueue 结果；
   *   而 opB 的 prev 被设为 runA.then(...)（链尾需等 opA 整体完成）；
   *   opA 又必须等 opB 完成才算完成 ⇒ 互相等待 ⇒ 事件循环排空 ⇒ 进程退出 ⇒ 测试被 cancelledByParent。
   * 重入时就地执行可彻底解除该循环：opB 在 opA 的执行体内同步顺序跑完，opA 继续。
   */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    if (!this._async) {
      // 同步回退路径：直接用同步 fs，锁也走同步获取（临界区前后加/解）。
      if (this._crossProcLock && !this._inOp) {
        this._lock!.acquireSync();
        // 跨进程：获取锁后强制从磁盘重读，避免读到另一进程写入前的陈旧内存缓存
        this.invalidateIndex();
        this._factsDirty = true;
      }
      try {
        return op();
      } finally {
        if (this._crossProcLock && !this._inOp) this._lock!.releaseSync();
      }
    }
    if (this._inOp) return op();
    const prev = this._chain;
    const run = (async () => {
      await prev;
      // M10 跨进程锁：获取锁后强制从磁盘重读，保证 read-modify-write 看到的是最新磁盘状态
      if (this._crossProcLock) {
        await this._lock!.acquire();
        this.invalidateIndex();
        this._factsDirty = true;
      }
      this._inOp = true;
      try {
        return await op();
      } finally {
        this._inOp = false;
        if (this._crossProcLock) await this._lock!.release();
      }
    })();
    // 链尾 = run 的状态（run 即调用方 await 的对象，无额外悬挂 tail）
    this._chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** 读文本文件：异步模式用 fs/promises，同步模式用 readFileSync；不存在/失败返回 null。 */
  private async readText(p: string): Promise<string | null> {
    if (this._async) {
      try {
        return await readFile(p, 'utf8');
      } catch {
        return null;
      }
    }
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }

  /** 原子写：临时文件 + rename；异步/同步模式分别用对应 API，输出逐字节一致。 */
  private async writeText(p: string, data: string): Promise<void> {
    this.ensureDir();
    const tmp = `${p}.tmp`;
    // M10 监控：记录写盘字节数（旁路，不影响主流程）
    memoryMetrics.recordIo(Buffer.byteLength(data, 'utf8'));
    if (this._async) {
      await writeFile(tmp, data, 'utf8');
      await rename(tmp, p);
    } else {
      writeFileSync(tmp, data, 'utf8');
      renameSync(tmp, p);
    }
  }

  /** 读取常驻事实全文；文件不存在返回空串。使用缓存避免重复 I/O。 */
  async loadFacts(): Promise<string> {
    if (!this._factsDirty && this._factsCache !== null) return this._factsCache;
    const raw = await this.readText(join(this.dir, FACTS_FILE));
    const text = raw ? raw.trim() : '';
    this._factsCache = text;
    this._factsDirty = false;
    return text;
  }

  /** 追加一条常驻事实到 MEMORY.md。 */
  async addFact(text: string): Promise<void> {
    return this.enqueue(async () => {
      const existing = await this.loadFacts();
      const line = `- ${text.trim()}\n`;
      const sep = existing && !existing.endsWith('\n') ? '\n' : '';
      const next = existing + sep + line;
      await this.writeText(join(this.dir, FACTS_FILE), next);
      // ✅ 写完后更新缓存，而非标记脏（避免下次重读整个文件）
      this._factsCache = next;
      this._factsDirty = false;
    });
  }

  private async readIndexFile(): Promise<MemoryEntry[]> {
    const raw = await this.readText(join(this.dir, INDEX_FILE));
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? (arr as MemoryEntry[]) : [];
    } catch {
      return [];
    }
  }

  /** 读取索引（带内存缓存，避免每次全量重读解析）。 */
  private async readIndex(): Promise<MemoryEntry[]> {
    if (!this._indexDirty && this._indexCache !== null) return this._indexCache;
    const entries = await this.readIndexFile();
    this._indexCache = entries;
    this._indexDirty = false;
    return this._indexCache;
  }

  private async writeIndex(entries: MemoryEntry[]): Promise<void> {
    this._indexCache = entries;
    this._indexDirty = false;
    // ✅ 紧凑 JSON（去掉 null, 2），减少序列化开销和文件尺寸
    await this.writeText(join(this.dir, INDEX_FILE), JSON.stringify(entries));
  }

  /** 标记索引缓存脏，下次 readIndex 时重新从磁盘读取。 */
  private invalidateIndex(): void {
    this._indexDirty = true;
  }

  /** 新增一条语义记忆（写入时即嵌入并缓存向量）。 */
  async addEntry(content: string, tags?: string[]): Promise<MemoryEntry> {
    return this.enqueue(() => this.doAddEntries([content], tags ? [tags] : [undefined]).then((es) => es[0]));
  }

  /**
   * 批量新增语义记忆（M8 批量嵌入复用）：并发嵌入 N 条，读一次索引、单次写盘落盘全部。
   * 比循环调用 addEntry 少 N-1 次磁盘写，长对话多记忆沉淀时延迟显著下降。
   */
  async addEntries(contents: string[], tagsList?: Array<string[] | undefined>): Promise<MemoryEntry[]> {
    return this.enqueue(() => this.doAddEntries(contents, tagsList));
  }

  private async doAddEntries(
    contents: string[],
    tagsList?: Array<string[] | undefined>,
  ): Promise<MemoryEntry[]> {
    const t0 = performance.now();
    this._version++;
    const embeddings = await Promise.all(contents.map((c) => this.embedder.embed(c)));
    const now = Date.now();
    const entries: MemoryEntry[] = contents.map((c, i) => ({
      id: randomUUID(),
      content: c.trim(),
      tags: tagsList?.[i],
      createdAt: now,
      updatedAt: now,
      embedding: embeddings[i] ?? undefined,
    }));
    const all = await this.readIndex();
    all.push(...entries);
    await this.writeIndex(all);
    // M10 监控：嵌入调用次数 + addEntry 延迟（旁路）
    memoryMetrics.recordEmbed(false, contents.length);
    memoryMetrics.recordLatency('addEntry', performance.now() - t0);
    return entries;
  }

  /** 列出全部语义记忆。 */
  async list(): Promise<MemoryEntry[]> {
    return this.readIndex();
  }

  /** 清空全部语义记忆（保留 MEMORY.md 常驻事实）；被清空的条目进回收站可恢复。 */
  async clear(): Promise<void> {
    return this.enqueue(async () => {
      const all = await this.readIndex();
      if (all.length > 0) await this.pushTrash(all.map((entry) => this.entryTrash(entry)));
      this._version++;
      await this.writeIndex([]);
    });
  }

  /** 按 id 前缀删除一条语义记忆（list 展示的是前 8 位，用户粘贴前缀即可）；删除进回收站可恢复。 */
  async forget(idPrefix: string): Promise<boolean> {
    return this.enqueue(async () => {
      const all = await this.readIndex();
      const removed = all.filter((e) => e.id.startsWith(idPrefix));
      if (removed.length === 0) return false;
      const next = all.filter((e) => !e.id.startsWith(idPrefix));
      await this.pushTrash(removed.map((entry) => this.entryTrash(entry)));
      this._version++;
      await this.writeIndex(next);
      return true;
    });
  }

  /** 按内容删除 MEMORY.md 中的一条常驻事实（精确匹配去 `- ` 前缀后的文本）；删除进回收站可恢复。 */
  async forgetFact(content: string): Promise<boolean> {
    return this.enqueue(async () => {
      const p = join(this.dir, FACTS_FILE);
      const raw = await this.readText(p);
      if (!raw) return false;
      const lines = raw.split('\n');
      const target = content.trim();
      const idx = lines.findIndex((l) => l.replace(/^- /, '').trim() === target);
      if (idx === -1) return false;
      lines.splice(idx, 1);
      await this.writeText(p, lines.join('\n'));
      await this.pushTrash([{ trashId: randomUUID(), kind: 'fact', deletedAt: Date.now(), fact: target }]);
      return true;
    });
  }

  /** 更新一条语义记忆的内容（保留 id/createdAt，刷新 updatedAt）；供陈旧性治理合并使用。 */
  async updateEntry(id: string, content: string): Promise<boolean> {
    return this.enqueue(async () => {
      const all = await this.readIndex();
      const idx = all.findIndex((e) => e.id === id);
      if (idx === -1) return false;
      all[idx] = { ...all[idx], content: content.trim(), updatedAt: Date.now() };
      this._version++;
      await this.writeIndex(all);
      return true;
    });
  }

  // ── 回收站（软删除 / 恢复） ──

  /** 把一条语义记忆包装成回收项快照。 */
  private entryTrash(entry: MemoryEntry): TrashItem {
    return { trashId: randomUUID(), kind: 'entry', deletedAt: Date.now(), entry };
  }

  private async readTrash(): Promise<TrashItem[]> {
    const raw = await this.readText(join(this.dir, TRASH_FILE));
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      // 读取时过滤超期回收项（30 天）；仅 bgTrashSweep 关时顺手重写磁盘（现状）。
      // 开 bgTrashSweep 时内联重写交给后台 sweep，读路径只过滤返回、不再写盘（减少读时 I/O）。
      const now = Date.now();
      const alive = (arr as TrashItem[]).filter((t) => now - (t.deletedAt ?? 0) < TRASH_TTL_MS);
      if (!this._bgSweep && alive.length !== arr.length) await this.writeTrash(alive);
      return alive;
    } catch {
      return [];
    }
  }

  /**
   * M10 后台回收站清理：入写链串行执行「读原始 trash.json → 过滤超期 → 仅变化时写回」，
   * 与 pushTrash/restore 等 trash 写入串行，避免进程内交错。返回本次清理掉的条数。
   * 背景定时器与手动调用共用此方法。
   */
  async sweepTrash(): Promise<number> {
    return this.enqueue(async () => {
      const raw = await this.readText(join(this.dir, TRASH_FILE));
      if (!raw) return 0;
      let arr: TrashItem[];
      try {
        arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return 0;
      } catch {
        return 0;
      }
      const now = Date.now();
      const alive = arr.filter((t) => now - (t.deletedAt ?? 0) < TRASH_TTL_MS);
      const removed = arr.length - alive.length;
      if (removed > 0) await this.writeTrash(alive);
      return removed;
    });
  }

  /** 启动后台回收站 sweep（bgTrashSweep 语义）。intervalMs 可注入（测试用短周期）。定时器 unref 不阻止进程退出。 */
  startBackgroundSweep(intervalMs: number = BG_SWEEP_INTERVAL_MS): void {
    if (this._sweepTimer) clearInterval(this._sweepTimer);
    this._sweepTimer = setInterval(() => {
      this.sweepTrash().catch(() => {});
    }, intervalMs);
    // 后台任务不应阻止进程自然退出
    this._sweepTimer.unref?.();
  }

  /** 停止后台回收站 sweep（资源释放时调用）。 */
  stopBackgroundSweep(): void {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = undefined;
    }
  }

  private async writeTrash(items: TrashItem[]): Promise<void> {
    await this.writeText(join(this.dir, TRASH_FILE), JSON.stringify(items, null, 2));
  }

  /** 追加回收项（最新的排前面）。 */
  private async pushTrash(items: TrashItem[]): Promise<void> {
    if (items.length === 0) return;
    return this.enqueue(async () => {
      const cur = await this.readTrash();
      await this.writeTrash([...items, ...cur]);
    });
  }

  /** 列出回收站全部条目（已自动过滤超期项）。 */
  async listTrash(): Promise<TrashItem[]> {
    return this.readTrash();
  }

  /** 从回收站恢复一条（entry 写回 memories.json，fact 追加回 MEMORY.md）。 */
  async restore(trashId: string): Promise<boolean> {
    return this.enqueue(async () => {
      const cur = await this.readTrash();
      const item = cur.find((t) => t.trashId === trashId);
      if (!item) return false;
      if (item.kind === 'entry' && item.entry) {
        const all = await this.readIndex();
        // 避免重复恢复：同 id 已存在则跳过写入
        if (!all.some((e) => e.id === item.entry!.id)) {
          all.push({ ...item.entry, updatedAt: Date.now() });
          this._version++;
          await this.writeIndex(all);
        }
      } else if (item.kind === 'fact' && item.fact) {
        await this.addFact(item.fact);
      } else {
        return false;
      }
      await this.writeTrash(cur.filter((t) => t.trashId !== trashId));
      return true;
    });
  }

  /** 永久清空回收站。 */
  async purgeTrash(): Promise<void> {
    await this.writeTrash([]);
  }

  private metaPath(): string {
    return join(this.dir, 'meta.json');
  }

  /** 读取作用域元数据（当前用于陈旧性治理的 lastReviseAt 时间戳）。 */
  async getMeta(): Promise<{ lastReviseAt?: number }> {
    const raw = await this.readText(this.metaPath());
    if (!raw) return {};
    try {
      const obj = JSON.parse(raw);
      return obj && typeof obj === 'object' ? obj : {};
    } catch {
      return {};
    }
  }

  /** 合并写入作用域元数据。 */
  async setMeta(patch: { lastReviseAt?: number }): Promise<void> {
    return this.enqueue(async () => {
      const cur = await this.getMeta();
      await this.writeText(this.metaPath(), JSON.stringify({ ...cur, ...patch }, null, 2));
    });
  }

  /** 启动语义预取：用 query 检索 top-K 相关记忆（无向量时自动关键词降级）。 */
  async retrieve(query: string, k = 5): Promise<MemoryEntry[]> {
    const qEmbed = await this.embedQuery(query);
    const t0 = performance.now();
    const res = await this.retriever.retrieve(qEmbed, query, await this.readIndex(), k);
    memoryMetrics.recordLatency('retrieve', performance.now() - t0);
    return res;
  }

  /** 带分数的召回（去重用，需要分数阈值判断是否重复）。 */
  async queryScored(query: string, k = 5): Promise<ScoredMemory[]> {
    const qEmbed = await this.embedQuery(query);
    const t0 = performance.now();
    const res = await this.retriever.retrieveScored(qEmbed, query, await this.readIndex(), k);
    memoryMetrics.recordLatency('queryScored', performance.now() - t0);
    return res;
  }

  /** 计算 query 向量（M9：vectorIndex 开时按 query 字符串缓存复用，省重复 embed）。 */
  private async embedQuery(query: string): Promise<number[] | null> {
    if (this._vectorIndex) {
      const cached = this._queryVecCache.get(query);
      if (cached !== undefined) {
        // M10 监控：命中 query 向量缓存 = 省一次 embed
        memoryMetrics.recordEmbed(true);
        return cached;
      }
      const v = await this.embedder.embed(query);
      this._queryVecCache.set(query, v);
      memoryMetrics.recordEmbed(false);
      return v;
    }
    const v = await this.embedder.embed(query);
    memoryMetrics.recordEmbed(false);
    return v;
  }

  /**
   * 判断 content 是否与现有记忆重复（语义记忆 + 常驻事实都查）。
   * - 向量模式：cosine ≥ 0.82 视为重复。
   * - 关键词降级（无 key/无向量）：重叠率 ≥ 0.6 视为重复。
   * 常驻事实（MEMORY.md）无向量，仅按关键词重叠判定。
   */
  async isDuplicate(content: string): Promise<boolean> {
    const t0 = performance.now();
    const top = (await this.queryScored(content, 1))[0];
    memoryMetrics.recordLatency('isDuplicate', performance.now() - t0);
    if (top && top.score >= (top.mode === 'vector' ? 0.82 : 0.6)) return true;
    // 常驻事实逐行比较（避免整坨 MEMORY.md 越攒越稀释相似度）
    const facts = await this.loadFacts();
    if (facts) {
      const lines = facts
        .split('\n')
        .map((l) => l.replace(/^- /, '').trim())
        .filter(Boolean);
      for (const line of lines) {
        if (keywordScore(content, line) >= 0.6) return true;
      }
    }
    return false;
  }

  /**
   * 资源释放（M8 异步 I/O）：冲刷写链，确保全部排队的写操作落盘后再返回。
   * 同步模式写本是同步完成，_chain 为空链，await 立即结束。M10：释放前先停后台 sweep 定时器。
   */
  async onDispose(): Promise<void> {
    this.stopBackgroundSweep();
    await this._chain;
  }

  /** M9 scope 版本号：索引每次变更（add/forget/update/restore/clear）自增，供向量化检索门控矩阵重建。 */
  getVersion(): number {
    return this._version;
  }
}

/** 兼容别名：保留旧名 MemoryStore，避免大范围改调用方（M1 零行为变更）。 */
export { FileMemoryBackend as MemoryStore };
