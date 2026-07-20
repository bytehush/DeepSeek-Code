import type { ConversationHistory } from '../context/history.ts';
import type { DeepSeekClient } from '../llm/deepseek.ts';
import type { MemoryEntry, TrashItem } from './types.ts';
import type { MemoryBackend } from './backend.ts';
import type { ScoredMemory } from './retriever.ts';
import type { ReviseResult } from './revise.ts';

/**
 * 记忆服务聚合接口（M3 · 解决 L1「模块级守卫」的前置抽象）。
 *
 * - 镜像当前 `MemoryManager` 的全部公开 API（逐字对应），并新增三个编排钩子
 *   `extractAtTurnEnd` / `revise` / `onDispose`，把「会话结束抽取 / 陈旧性治理 /
 *   资源释放」从 app 层（chat.ts）上移到服务实例，使守卫从「模块级」变为「实例级」，
 *   解决长驻 GUI 进程只触发一次、子任务隔离等 L1 缺陷。
 * - 两个实现都满足本接口：`MemoryManager`（旧路径，flag=false）与 `MemoryOrchestrator`
 *   （新路径，flag=true）。调用方只依赖本接口，切换实现零改动。
 * - 行为契约：本接口本身不含逻辑，仅类型契约；具体行为由实现方保证与旧路径等价
 *   （flag=false 时逐字节一致），由影子比对单测守护。
 */
export interface MemoryService {
  /** 用户级全局记忆后端（~/.dsa/memory）。 */
  readonly user: MemoryBackend;
  /** 项目级记忆后端（<cwd>/.dsa/memory）。 */
  readonly project: MemoryBackend;

  /** 读取两层的常驻事实（MEMORY.md）。 */
  loadFacts(): { user: string; project: string };
  /** 追加一条常驻事实；scope 默认项目级。 */
  addFact(text: string, scope?: 'user' | 'project'): void;
  /** 新增一条语义记忆（写入时即嵌入缓存）；scope 默认项目级。 */
  addEntry(content: string, tags?: string[], scope?: 'user' | 'project'): Promise<MemoryEntry>;
  /** 列出两层全部语义记忆，标注作用域。 */
  list(): Array<{ scope: 'user' | 'project'; entry: MemoryEntry }>;
  /** 删除一条语义记忆；scope 指定删哪一层。 */
  forget(idPrefix: string, scope: 'user' | 'project'): boolean;
  /** 列出两层回收站条目，标注作用域（最新删除的在前）。 */
  listTrash(): Array<{ scope: 'user' | 'project'; item: TrashItem }>;
  /** 从指定作用域的回收站恢复一条。 */
  restore(trashId: string, scope: 'user' | 'project'): boolean;
  /** 永久清空回收站；不传 scope 时两层都清。 */
  purgeTrash(scope?: 'user' | 'project'): void;
  /** 合并两层语义预取（各取 top-K 再合并截断，项目级优先）。 */
  retrieve(query: string, k?: number): Promise<MemoryEntry[]>;
  /** 合并两层带分数召回（去重判定用）。 */
  queryScored(query: string, k?: number): Promise<ScoredMemory[]>;
  /** 任一层命中即视为重复（语义记忆 + 常驻事实都查）。 */
  isDuplicate(content: string): Promise<boolean>;
  /** 一键产出最终系统提示词：两层常驻事实 + 启动语义预取。 */
  compose(base: string, query: string, k?: number): Promise<string>;

  /**
   * 每轮重算语义召回（M5 · P2a 修复 L2 boot-only 冻结）。
   * 返回与当前 query 最相关的语义记忆召回块文本；query 空 / 无召回返回空串。
   * 调用方（runChatTurn）每轮调用并把结果作为带标记消息注入对话，不重写 system 提示词。
   */
  composeForTurn(base: string, query: string, k?: number): Promise<string>;

  /**
   * 会话结束自动抽取用户偏好（幂等实例守卫）。
   * 同实例重复调用只抽取一次；无 client 直接返回 0。返回新增条数。
   */
  extractAtTurnEnd(history: ConversationHistory, client: DeepSeekClient): Promise<number>;

  /**
   * 会话结束自动整理记忆（陈旧性治理，带节流 + 幂等实例守卫）。
   * `force=true` 时跳过守卫与节流（/dream 手动整理用），否则守卫保证自动路径只跑一次。
   * 非 force 且已整理过 / 无 client 时返回 null。返回体检结果（含 skipped 标记）。
   */
  revise(
    client: DeepSeekClient,
    opts?: { recentContext?: string; force?: boolean },
  ): Promise<ReviseResult | null>;

  /** 资源释放钩子（异步 I/O 阶段 M8 扩展；当前实现为空操作或置 disposed 标记）。 */
  onDispose(): void;
}
