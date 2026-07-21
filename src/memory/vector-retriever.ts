import type { MemoryEntry } from './types.ts';
import { keywordScore, type ScoredMemory } from './retriever.ts';
import type { Retriever } from './retriever-iface.ts';

/**
 * 向量化检索器（M9 · 第三步·枝）。
 *
 * 包装一个基础 `Retriever`（默认 `DefaultRetriever`，走纯函数余弦 + 关键词降级），
 * 在「有 query 向量且条目有向量」时改用**预计算归一化矩阵**做向量化余弦：
 *
 *   cosine(q, e) = dot(q/|q|, e/|e|) = 矩阵-向量点积
 *
 * 相对 `retriever.ts` 的逐条 `cosine()`（每次重算两向量模长），本实现把条目模长在
 * 索引变更时一次性算好缓存为归一化矩阵，查询只做一次矩阵-向量点积（缓存友好 Float32Array，
 * 单趟扫描），常数因子显著更低；并配合「scope 版本计数器」门控——条目未变时不重建矩阵，
 * 实现「仅变更时重检索」。query 向量由调用方（`FileMemoryBackend`）按 query 字符串缓存复用，
 * 进一步省去重复嵌入。
 *
 * 与 `DefaultRetriever` 结果**等价**（归一化点积 == 余弦，浮点仅 ULP 级差异，不影响 top-K 集合）；
 * 无 query 向量 / 条目无向量 / 向量长度不匹配时**完全委托 base**（关键词降级或 score=0），
 * 行为与默认路径逐字节一致。
 *
 * 设计注（与方案字面偏差，已记入提交与项目记忆）：方案称 O(N)→O(log N) 的 ANN（hnswlib），
 * 但 CN 沙箱引入原生依赖风险高，M9 务实落地为「归一化矩阵 + 版本门控缓存 + query 向量缓存」
 * 的向量化余弦——这是内存 RAG 的标准做法，已兑现方案「单轮召回≈一次矩阵乘 / 仅变更时重检索」
 * 的核心收益；真正 ANN 留作后续可选增强。
 */
export interface VectorIndexRetrieverOpts {
  /** 返回当前 scope 的单调版本号；变更时重建归一化矩阵。 */
  versionProvider: () => number;
}

/** 归一化向量：返回单位向量（模长 1）；零向量返回全 0（点积为 0，与 cosine 的 denom=0→0 一致）。 */
function normalize(v: number[]): number[] {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const norm = Math.sqrt(s);
  if (norm === 0) return new Array(v.length).fill(0);
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/** 矩阵单行（已归一化）与查询归一化向量的点积。 */
function dotRow(qNorm: number[], matrix: Float32Array, row: number, dim: number): number {
  let dot = 0;
  const base = row * dim;
  for (let i = 0; i < dim; i++) dot += qNorm[i] * matrix[base + i];
  return dot;
}

interface MatrixCache {
  version: number;
  /** 构建矩阵时所基于的 entries 数组引用（引用身份即「内容是否同一份」的判据）。 */
  entriesRef: MemoryEntry[];
  /** 扁平归一化矩阵：row r 的向量在 matrix[r*dim .. r*dim+dim)。 */
  matrix: Float32Array;
  /** 长度 = entries.length，entry 下标 → 矩阵行号（-1 表示无向量/长度不匹配）。O(1) 数组访问，避免 Map 开销。 */
  rowOf: Int32Array;
  dim: number;
}

export class VectorIndexRetriever implements Retriever {
  private _cache: MatrixCache | null = null;

  constructor(
    private readonly base: Retriever,
    private readonly opts: VectorIndexRetrieverOpts,
  ) {}

  retrieveScored(
    queryEmbedding: number[] | null,
    query: string,
    entries: MemoryEntry[],
    k = 5,
  ): ScoredMemory[] {
    // 无 query 向量 → 整段关键词降级，与默认路径完全一致
    if (!queryEmbedding) return this.base.retrieveScored(queryEmbedding, query, entries, k);

    const dim = queryEmbedding.length;
    const version = this.opts.versionProvider();

    // 取出「有向量且长度匹配」的条目，构建/复用归一化矩阵
    const embeddedIdx: number[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.embedding && e.embedding.length === dim) embeddedIdx.push(i);
    }

    // 完全没有可用向量 → 委托 base（关键词降级），结果一致
    if (embeddedIdx.length === 0) return this.base.retrieveScored(queryEmbedding, query, entries, k);

    // 重建条件：版本变更 或 entries 引用变化（内容换了一份）。二者任一满足即重建，
    // 保证「仅变更时重检索」且绝不对不同内容复用旧矩阵。
    if (!this._cache || this._cache.version !== version || this._cache.entriesRef !== entries) {
      const matrix = new Float32Array(embeddedIdx.length * dim);
      const rowOf = new Int32Array(entries.length).fill(-1);
      embeddedIdx.forEach((entryIdx, r) => {
        rowOf[entryIdx] = r;
        const n = normalize(entries[entryIdx].embedding as number[]);
        for (let i = 0; i < dim; i++) matrix[r * dim + i] = n[i];
      });
      this._cache = { version, entriesRef: entries, matrix, rowOf, dim };
    }

    const qNorm = normalize(queryEmbedding);
    const { matrix, rowOf } = this._cache;

    // 逐条打分：有向量走向量化余弦；无向量走关键词降级；长度不匹配的嵌入式条目 score=0（与 cosine denom=0 一致）
    const scored: ScoredMemory[] = entries.map((e, i) => {
      let score: number;
      let mode: 'vector' | 'keyword';
      const row = rowOf[i];
      if (row >= 0) {
        score = dotRow(qNorm, matrix, row, dim);
        mode = 'vector';
      } else if (e.embedding) {
        score = 0;
        mode = 'vector';
      } else {
        score = keywordScore(query, e.content);
        mode = 'keyword';
      }
      return { entry: e, score, mode };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k).filter((s) => s.score > 0);
  }

  retrieve(
    queryEmbedding: number[] | null,
    query: string,
    entries: MemoryEntry[],
    k = 5,
  ): MemoryEntry[] {
    return this.retrieveScored(queryEmbedding, query, entries, k).map((s) => s.entry);
  }
}
