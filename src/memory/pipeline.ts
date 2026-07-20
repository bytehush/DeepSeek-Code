import type { MemoryService } from './service.ts';
import type { ScoredMemory } from './retriever.ts';

/**
 * 标记常量：每轮注入到对话历史的「记忆召回」消息携带此 marker，
 * 下一轮追加前据此移除旧条，避免历史无限膨胀（冲突 D 机制）。
 */
export const MEMORY_RECALL_MARKER = '__dsa_memory_recall__';

/** 与 MemoryManager/Orchestrator.compose 一致的向量最低相似度阈值。 */
const VECTOR_MIN_SCORE = 0.3;

/**
 * 每轮重算语义召回（M5 · P2a 修复 L2「boot-only compose 冻结」）。
 *
 * 旧架构 `compose` 仅在 assemble 启动时被调用一次，导致整会话语义检索冻结：
 * 会话中新写入 / 更相关的记忆无法被后续轮次召回。本管线把「按当前 query 重算召回」
 * 抽成独立能力，由 runChatTurn 每轮调用，并把结果作为一条带标记的消息注入对话
 * （不重写 system 提示词，冲突 D）。
 *
 * `base` 参数为兼容 MemoryService.composeForTurn 签名预留（当前召回块不依赖 base，
 * 仅返回与 query 最相关的语义记忆条目）；未来可做「剔除已进 system 的事实」去重。
 */
export class MemoryPipeline {
  constructor(private readonly store: MemoryService) {}

  /** 返回本轮相关记忆的召回块文本；query 为空或无可召回条目时返回空串。 */
  async composeForTurn(_base: string, query: string, k = 5): Promise<string> {
    if (!query) return '';
    const scored: ScoredMemory[] = await this.store.queryScored(query, k);
    const retrieved = scored
      .filter((s) => s.mode === 'keyword' || s.score >= VECTOR_MIN_SCORE)
      .map((s) => s.entry);
    if (retrieved.length === 0) return '';
    const lines = retrieved.map((e) => `- ${e.content}`).join('\n');
    return `[记忆召回 · 本轮相关]\n${lines}`;
  }
}
