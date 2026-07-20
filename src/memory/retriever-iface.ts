import type { MemoryEntry } from './types.ts';
import { retrieve, retrieveScored, type ScoredMemory } from './retriever.ts';

/**
 * 检索器接口（M1 架构抽象 · 解决 L7「无接口抽象」）。
 *
 * 当前实现直接复用 retriever.ts 的纯函数（余弦 + 关键词降级）。
 * 后续阶段可加 VectorRetriever（预建索引，替代 O(N) 线性扫描）、
 * HybridRetriever（向量 + 关键词加权融合）等，调用方零改动。
 */
export interface Retriever {
  /** 带分数的检索：返回 {entry, score, mode} 的 top-K。 */
  retrieveScored(
    queryEmbedding: number[] | null,
    query: string,
    entries: MemoryEntry[],
    k?: number,
  ): ScoredMemory[];
  /** 不带分数的召回（等价于 retrieveScored(...).map(s => s.entry)）。 */
  retrieve(
    queryEmbedding: number[] | null,
    query: string,
    entries: MemoryEntry[],
    k?: number,
  ): MemoryEntry[];
}

/**
 * 默认检索器实现（M2 纯函数收口）：直接委托 retriever.ts 的纯函数，
 * 零逻辑改动。后续阶段可加 VectorRetriever / HybridRetriever 等替换，
 * 调用方（MemoryOrchestrator / 测试）零改动。
 */
export class DefaultRetriever implements Retriever {
  retrieveScored(
    queryEmbedding: number[] | null,
    query: string,
    entries: MemoryEntry[],
    k?: number,
  ): ScoredMemory[] {
    return retrieveScored(queryEmbedding, query, entries, k);
  }

  retrieve(
    queryEmbedding: number[] | null,
    query: string,
    entries: MemoryEntry[],
    k?: number,
  ): MemoryEntry[] {
    return retrieve(queryEmbedding, query, entries, k);
  }
}

/** 工厂：默认检索器（依赖注入点）。 */
export function createRetriever(): Retriever {
  return new DefaultRetriever();
}
