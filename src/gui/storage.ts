/**
 * 对话存储抽象层（重架构 M1）。
 *
 * 将「从哪里读取历史对话」与上层（服务 / 传输 / 视图）解耦：
 * - 上层只依赖 `ConversationStore` 接口，不关心底层是 JSONL 文件系统还是数据库；
 * - 默认 `JsonlConversationStore` 复用现有 `TraceLogger` 的 `.dsa/traces/` 目录结构，
 *   不破坏 CLI 兼容的存储格式；未来要换 SQLite 只需新增一个实现类，上层零改动。
 *
 * 每条返回的消息已带 `ts`（发生时间，ISO 字符串），由 `trace.ts` 的 `parseReplay`
 * 从 JSONL 事件的 timestamp 提取，时间线功能因此贯通到前端。
 */
import type { ReplayedConversation } from '../context/trace.ts';
import { TraceLogger } from '../context/trace.ts';
import type { TaskStore, TaskMeta } from './thread-store.ts';

/** 左侧栏线程摘要（不含对话内容） */
export interface ThreadSummary {
  id: string;
  title: string;
  status: 'active' | 'paused' | 'done';
  updatedAt: number;
}

/** 对话存储契约：上层只依赖此接口 */
export interface ConversationStore {
  /** 列出当前用户的所有线程摘要（供左侧栏渲染） */
  listThreads(): Promise<ThreadSummary[]>;
  /** 加载某线程完整对话（消息含 ts 时间线 + 思考轮次），无历史则 null */
  load(threadId: string): Promise<ReplayedConversation | null>;
}

/** 默认实现：基于文件系统 JSONL（TraceLogger 目录结构） */
export class JsonlConversationStore implements ConversationStore {
  constructor(private readonly taskStore: TaskStore) {}

  async listThreads(): Promise<ThreadSummary[]> {
    const metas: TaskMeta[] = await this.taskStore.list();
    return metas.map((m) => ({
      id: m.id,
      title: m.title,
      status: m.status,
      updatedAt: m.updatedAt,
    }));
  }

  async load(threadId: string): Promise<ReplayedConversation | null> {
    const dir = this.taskStore.dir(threadId);
    return TraceLogger.replayAll(dir);
  }
}
