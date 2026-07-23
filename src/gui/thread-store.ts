/**
 * 网页版多任务（多线程）管理。
 *
 * 每个任务 = 一个独立的 dataDir（~/.dsa/users/<username>/threads/<taskId>/），
 * 拥有独立的 trace / session / memory / 历史，互不可见。
 * 切换任务即切换 dataDir 并重新装配内核。助手可在左栏维护多个并行任务，
 * 各自带 status（进行中/已暂停/已完成）与 goal（任务目标），互不干扰。
 */
import { mkdir, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

/** 任务状态：进行中 / 已暂停 / 已完成 */
export type TaskStatus = 'active' | 'paused' | 'done';

export interface TaskMeta {
  id: string;
  title: string;
  /** 任务状态；旧线程缺省视为 active */
  status: TaskStatus;
  /** 任务目标 / 一句话描述；首条消息自动捕获，也可手动编辑 */
  goal: string;
  createdAt: number;
  updatedAt: number;
  /** 列表排序权重；越小越靠前。新建任务取当前时间戳以保证追加在末尾。 */
  order: number;
}

export class TaskStore {
  private baseDir: string;
  /**
   * 已「逻辑删除」的任务 id，**持久化到磁盘**（baseDir/.deleted.json）。
   * 修复「刷新后已删任务又回来」：原实现用内存 Set，但浏览器刷新 = 重新登录 =
   * 新建 TaskStore 实例，内存集合被重置为空；而物理目录因 Windows 文件锁未删掉，
   * list() 从磁盘重读又把任务读回来。改为磁盘持久化后，删除标记跨重连/重启都生效，
   * 前端卡片不会再复活。物理目录删除仍为尽力而为（见 remove）。
   */
  private deleted = new Set<string>();
  private deletedLoaded = false;
  private deletedPath: string;

  constructor(userDataDir: string) {
    this.baseDir = join(userDataDir, 'threads');
    this.deletedPath = join(this.baseDir, '.deleted.json');
  }

  private async ensureBase(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  /** 懒加载删除清单（仅首次，之后用内存副本）；清单缺失视为空 */
  private async ensureDeleted(): Promise<void> {
    if (this.deletedLoaded) return;
    try {
      const txt = await readFile(this.deletedPath, 'utf8');
      const arr = JSON.parse(txt);
      if (Array.isArray(arr)) this.deleted = new Set(arr.filter((x) => typeof x === 'string'));
    } catch {
      // 无清单文件：视为空
    }
    this.deletedLoaded = true;
  }

  /** 持久化删除清单到磁盘（失败仅记日志，不影响上层逻辑） */
  private async saveDeleted(): Promise<void> {
    try {
      await writeFile(this.deletedPath, JSON.stringify([...this.deleted]), 'utf8');
    } catch (e) {
      console.error('[TaskStore] 保存删除清单失败:', (e as Error)?.message);
    }
  }

  private metaPath(id: string): string {
    return join(this.baseDir, id, 'meta.json');
  }

  private dataDir(id: string): string {
    return join(this.baseDir, id);
  }

  /** 列出所有任务，按 order 升序（拖拽排序写入的权重）；向后兼容旧 meta：缺字段补默认 */
  async list(): Promise<TaskMeta[]> {
    await this.ensureBase();
    await this.ensureDeleted();
    const dirs = await readdir(this.baseDir);
    const out: TaskMeta[] = [];
    for (const id of dirs) {
      if (id.startsWith('.')) continue; // 跳过 .deleted.json 等隐藏文件
      if (this.deleted.has(id)) continue; // 已删除的任务不出现在列表
      try {
        const txt = await readFile(this.metaPath(id), 'utf8');
        const raw = JSON.parse(txt) as Partial<TaskMeta>;
        if (!raw || typeof raw.id !== 'string') continue;
        const updatedAt = raw.updatedAt ?? 0;
        out.push({
          id: raw.id,
          title: raw.title ?? '未命名任务',
          status: raw.status ?? 'active',
          goal: raw.goal ?? '',
          createdAt: raw.createdAt ?? 0,
          updatedAt,
          order: raw.order ?? updatedAt,
        });
      } catch {
        // 忽略无 meta 的目录
      }
    }
    out.sort((a, b) => a.order - b.order);
    return out;
  }

  /**
   * 拖拽重排：按传入的 id 顺序重新写入每个任务的 order 权重。
   * 不在列表中的 id 保持原顺序（排到末尾，由 list 的排序兜住）。
   */
  async reorder(orderedIds: string[]): Promise<void> {
    for (let i = 0; i < orderedIds.length; i++) {
      const meta = await this.get(orderedIds[i]);
      if (!meta) continue;
      meta.order = i;
      await writeFile(this.metaPath(meta.id), JSON.stringify(meta, null, 2), 'utf8');
    }
  }

  /**
   * 复制任务：生成新 id，复制标题（加「副本」后缀）/ 目标 / 状态，
   * 但**不复制**对话历史与记忆——保持任务间上下文隔离，新任务从空白上下文开始。
   * 返回新任务 id。
   */
  async duplicate(id: string): Promise<string | null> {
    const src = await this.get(id);
    if (!src) return null;
    const newId = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const meta: TaskMeta = {
      id: newId,
      title: `${src.title} 副本`.slice(0, 80),
      status: 'active',
      goal: src.goal.slice(0, 200),
      createdAt: now,
      updatedAt: now,
      order: now,
    };
    await mkdir(this.dataDir(newId), { recursive: true });
    await writeFile(this.metaPath(newId), JSON.stringify(meta, null, 2), 'utf8');
    return newId;
  }

  /** 创建新任务，返回其 id；可带初始目标（模板新建时传入） */
  async create(title = '新任务', goal = ''): Promise<string> {
    await this.ensureBase();
    await this.ensureDeleted();
    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const meta: TaskMeta = {
      id,
      title: title.slice(0, 80) || '新任务',
      status: 'active',
      goal: goal.slice(0, 200),
      createdAt: now,
      updatedAt: now,
      order: now,
    };
    await mkdir(this.dataDir(id), { recursive: true });
    await writeFile(this.metaPath(id), JSON.stringify(meta, null, 2), 'utf8');
    if (this.deleted.delete(id)) await this.saveDeleted(); // 新建即退出删除态（如曾删后重建）
    return id;
  }

  /** 更新任务标题 / 状态 / 目标 / 时间 */
  async update(id: string, patch: Partial<TaskMeta>): Promise<void> {
    const meta = await this.get(id);
    if (!meta) return;
    Object.assign(meta, patch, { updatedAt: Date.now() });
    await writeFile(this.metaPath(id), JSON.stringify(meta, null, 2), 'utf8');
  }

  /** 获取单个任务元数据（向后兼容旧 meta：缺 status/goal 补默认） */
  async get(id: string): Promise<TaskMeta | null> {
    await this.ensureDeleted();
    if (this.deleted.has(id)) return null;
    try {
      const txt = await readFile(this.metaPath(id), 'utf8');
      const raw = JSON.parse(txt) as Partial<TaskMeta>;
      if (!raw || typeof raw.id !== 'string') return null;
      return {
        id: raw.id,
        title: raw.title ?? '未命名任务',
        status: raw.status ?? 'active',
        goal: raw.goal ?? '',
        createdAt: raw.createdAt ?? 0,
        updatedAt: raw.updatedAt ?? 0,
        order: raw.order ?? (raw.updatedAt ?? 0),
      };
    } catch {
      return null;
    }
  }

  /**
   * 删除任务（级联物理删除，确保关联数据无残留）。
   * 设计：删除标记（.deleted.json）先持久化 → 前端卡片必消失、上下文隔离成立，
   * 且跨重连/重启生效（修复「刷新后已删任务又回来」）；随后**同步**递归删除整个任务目录
   * （meta / traces 历史 / memory / sandbox 会话 等全部关联数据），带指数退避重试 +
   * 存在性校验，覆盖 Windows 瞬时文件锁与内核异步 flush 竞态。失败明确报错，绝不静默孤儿。
   * 含目录越界守卫，防 id 路径穿越误删/泄漏（呼应「避免数据泄漏」）。
   */
  async remove(id: string): Promise<void> {
    await this.ensureDeleted();
    const target = this.dataDir(id);
    // 越界守卫：id 不得逃出 threads/ 基目录（防 ../ 路径穿越删除或泄漏任意目录）
    const base = resolve(this.baseDir);
    const resolved = resolve(target);
    if (resolved !== base && !resolved.startsWith(base + sep)) {
      console.error('[TaskStore.remove] 拒绝越界删除（疑似路径穿越）：', id);
      return; // 不写标记、不删
    }
    this.deleted.add(id);
    await this.saveDeleted(); // 标记先持久化：卡片消失、隔离成立
    const tryRm = (): Promise<boolean> =>
      rm(target, { recursive: true, force: true })
        .then(() => true)
        .catch(() => false);
    const stillThere = async (): Promise<boolean> => {
      try {
        await stat(target);
        return true;
      } catch {
        return false;
      }
    };
    // 主删除：同步、指数退避重试并校验真正消失（覆盖瞬时锁 / 内核异步 flush 竞态）
    const backoff = [150, 300, 600, 1200, 2000];
    for (const wait of backoff) {
      if ((await tryRm()) && !(await stillThere())) return;
      await new Promise((r) => setTimeout(r, wait));
    }
    // 兜底延迟重试：捕捉内核异步 flush 可能重建的零散文件（尽力而为，不阻塞调用方）
    const tail = setTimeout(() => {
      void tryRm().then(async () => {
        if (await stillThere()) {
          console.error('[TaskStore.remove] 任务目录物理删除仍失败，数据可能残留：', target);
        }
      });
    }, 3000);
    tail.unref?.(); // 不阻止进程退出
  }

  /** 任务的数据目录，用于 assembleAppProps */
  dir(id: string): string {
    return this.dataDir(id);
  }

  /** 取第一个未被删除的任务 id（无则 null） */
  async firstExisting(): Promise<string | null> {
    const all = await this.list(); // list 已过滤删除集
    return all[0]?.id ?? null;
  }

  /**
   * 确保默认任务存在。
   * @param force 为 true 时即使 default 曾被删除也强制重建（仅用于「一个任务都不剩」时的兜底）。
   *   默认 false：尊重删除标记——若用户主动删过 default，则不强行复活，让其他任务成为激活项。
   */
  async ensureDefault(force = false): Promise<string | null> {
    await this.ensureBase();
    await this.ensureDeleted();
    const id = 'default';
    if (this.deleted.has(id) && !force) return null; // 尊重用户的删除意图，不复活 default
    if (!(await this.get(id))) {
      this.deleted.delete(id); // 重建 default 时退出删除态
      await this.saveDeleted();
      const now = Date.now();
      await mkdir(this.dataDir(id), { recursive: true });
      await writeFile(
        this.metaPath(id),
        JSON.stringify({ id, title: '默认任务', status: 'active', goal: '', createdAt: now, updatedAt: now, order: now }, null, 2),
        'utf8',
      );
    }
    return id;
  }
}
