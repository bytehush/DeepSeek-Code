import type { MemoryEntry, TrashItem } from './types.ts';
import type { EmbedderBackend } from './embedder-backend.ts';
import type { ScoredMemory } from './retriever.ts';
import { FileMemoryBackend, type FileMemoryBackendOpts } from './store.ts';
import { loadMemoryConfig } from './config.ts';

/**
 * 单作用域记忆后端接口（M1 架构抽象 · 解决 L7「无接口抽象」）。
 *
 * - 对齐当前 FileMemoryBackend（原 MemoryStore）的公开方法签名，逐字对应，
 *   确保具体类「套上接口」是纯零行为变更重构。
 * - 每个后端只服务一个作用域（user 或 project）；scope 路由由上层聚合器
 *   （当前 MemoryManager，后续 MemoryOrchestrator）负责，不在此接口内。
 * - 实现可替换：当前唯一实现是 FileMemoryBackend；后续阶段可加
 *   SqliteMemoryBackend / PgMemoryBackend 等，调用方零改动。
 */
export interface MemoryBackend {
  /** 读取常驻事实全文（MEMORY.md），不存在返回空串。 */
  loadFacts(): Promise<string>;
  /** 追加一条常驻事实。 */
  addFact(text: string): Promise<void>;
  /** 新增一条语义记忆（写入时即嵌入缓存）。 */
  addEntry(content: string, tags?: string[]): Promise<MemoryEntry>;
  /** 批量新增语义记忆（写入时并发嵌入、单次写盘，M8 批量嵌入复用）。 */
  addEntries(contents: string[], tagsList?: Array<string[] | undefined>): Promise<MemoryEntry[]>;
  /** 列出全部语义记忆。 */
  list(): Promise<MemoryEntry[]>;
  /** 清空全部语义记忆（进回收站）。 */
  clear(): Promise<void>;
  /** 按 id 前缀删除一条语义记忆（进回收站）。 */
  forget(idPrefix: string): Promise<boolean>;
  /** 按内容删除一条常驻事实（进回收站）。 */
  forgetFact(content: string): Promise<boolean>;
  /** 更新一条语义记忆内容（保留 id/createdAt）。 */
  updateEntry(id: string, content: string): Promise<boolean>;
  /** 列出回收站（已过滤超期项）。 */
  listTrash(): Promise<TrashItem[]>;
  /** 从回收站恢复一条。 */
  restore(trashId: string): Promise<boolean>;
  /** 永久清空回收站。 */
  purgeTrash(): Promise<void>;
  /** 读取作用域元数据。 */
  getMeta(): Promise<{ lastReviseAt?: number }>;
  /** 合并写入作用域元数据。 */
  setMeta(patch: { lastReviseAt?: number }): Promise<void>;
  /** 启动语义预取：top-K 相关记忆（无向量自动关键词降级）。 */
  retrieve(query: string, k?: number): Promise<MemoryEntry[]>;
  /** 带分数的召回（去重判定用）。 */
  queryScored(query: string, k?: number): Promise<ScoredMemory[]>;
  /** 内容是否与现有记忆重复（语义 + 常驻事实，阈值 0.82 / 0.6）。 */
  isDuplicate(content: string): Promise<boolean>;
  /** 资源释放钩子（M8 异步 I/O：冲刷写链确保落盘）。 */
  onDispose(): Promise<void>;
  /** 返回 scope 版本号（M9：索引每次变更自增，供向量化检索门控矩阵重建）。 */
  getVersion(): number;
}

/**
 * 工厂：按 baseDir + embedder 构造文件后端。
 * 作为依赖注入点，后续阶段可在此切换实现而不动调用方。
 * asyncBackend / vectorIndex / bgTrashSweep flag 经 loadMemoryConfig 读取并透传给 FileMemoryBackend
 * （asyncBackend：true=异步 I/O 不阻塞事件循环，默认；false=同步回退，输出逐字节一致。
 *  vectorIndex：true=预计算归一化矩阵向量化余弦 + 版本缓存，默认 false=线性扫描现状。
 *  bgTrashSweep：true=后台周期 sweep trash.json，默认 false=读时清理现状）。
 */
export function createMemoryBackend(
  baseDir: string,
  embedder: EmbedderBackend,
  opts?: FileMemoryBackendOpts,
): MemoryBackend {
  const cfg = loadMemoryConfig();
  const async = opts?.async ?? cfg.asyncBackend;
  const vectorIndex = opts?.vectorIndex ?? cfg.vectorIndex;
  const bgTrashSweep = opts?.bgTrashSweep ?? cfg.bgTrashSweep;
  return new FileMemoryBackend(baseDir, embedder, { async, vectorIndex, bgTrashSweep });
}
