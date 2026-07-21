/**
 * M10 监控指标采集（第三步·叶④）。
 *
 * 进程级单例 `memoryMetrics`，在记忆子系统关键路径埋点：
 * - 各 op 延迟直方图（retrieve / queryScored / isDuplicate / addEntry）
 * - 嵌入调用次数与缓存命中率（query 向量缓存命中 = 省一次 embed）
 * - 向量索引矩阵缓存命中率（MemoryService 稳态单轮复用矩阵）
 * - 抽取累计条数、治理删除/合并组数、文件 I/O 字节
 *
 * 设计为只读可观测、零行为变更：采集动作全部落在热路径的旁路，不返回、不影响主流程；
 * 故默认开启、不挂 feature flag。CLI `/memory stats` 与 GUI 记忆面板读取 snapshot()。
 */
export interface OpStat {
  count: number;
  totalMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
}

export interface MetricsSnapshot {
  ops: Record<string, OpStat>;
  embed: { calls: number; cacheHits: number; hitRate: number };
  vectorIndex: { hits: number; misses: number; hitRate: number };
  extract: { count: number };
  revise: { deleted: number; merged: number };
  ioBytes: number;
  uptimeMs: number;
}

export class MemoryMetrics {
  private readonly start = Date.now();
  private readonly durations = new Map<string, number[]>();
  private embedCalls = 0;
  private embedHits = 0;
  private viHits = 0;
  private viMisses = 0;
  private extractCount = 0;
  private reviseDeleted = 0;
  private reviseMerged = 0;
  private ioBytes = 0;
  /** 单 op 采样上限，防止长驻进程无限增长。 */
  private static readonly MAX_SAMPLES = 1000;

  recordLatency(op: string, ms: number): void {
    let arr = this.durations.get(op);
    if (!arr) {
      arr = [];
      this.durations.set(op, arr);
    }
    arr.push(ms);
    if (arr.length > MemoryMetrics.MAX_SAMPLES) arr.shift();
  }

  /** 记录一次嵌入调用；cacheHit=true 表示命中 query 向量缓存（未真正调用 embedder）。n 可批量计数。 */
  recordEmbed(cacheHit: boolean, n = 1): void {
    for (let i = 0; i < n; i++) {
      this.embedCalls++;
      if (cacheHit) this.embedHits++;
    }
  }

  /** 记录向量索引矩阵缓存命中（true=复用矩阵 / false=重建）。 */
  recordVectorIndex(hit: boolean): void {
    if (hit) this.viHits++;
    else this.viMisses++;
  }

  recordExtract(n = 1): void {
    this.extractCount += n;
  }

  recordRevise(deleted: number, merged: number): void {
    this.reviseDeleted += deleted;
    this.reviseMerged += merged;
  }

  recordIo(bytes: number): void {
    this.ioBytes += bytes;
  }

  private percentile(arr: number[], p: number): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
    return sorted[idx];
  }

  snapshot(): MetricsSnapshot {
    const ops: Record<string, OpStat> = {};
    for (const [op, arr] of this.durations) {
      const total = arr.reduce((s, x) => s + x, 0);
      ops[op] = {
        count: arr.length,
        totalMs: Math.round(total * 100) / 100,
        maxMs: arr.length ? Math.max(...arr) : 0,
        p50Ms: Math.round(this.percentile(arr, 50) * 100) / 100,
        p95Ms: Math.round(this.percentile(arr, 95) * 100) / 100,
      };
    }
    const embedTotal = this.embedCalls;
    const viTotal = this.viHits + this.viMisses;
    return {
      ops,
      embed: {
        calls: this.embedCalls,
        cacheHits: this.embedHits,
        hitRate: embedTotal ? this.embedHits / embedTotal : 0,
      },
      vectorIndex: {
        hits: this.viHits,
        misses: this.viMisses,
        hitRate: viTotal ? this.viHits / viTotal : 0,
      },
      extract: { count: this.extractCount },
      revise: { deleted: this.reviseDeleted, merged: this.reviseMerged },
      ioBytes: this.ioBytes,
      uptimeMs: Date.now() - this.start,
    };
  }

  reset(): void {
    this.durations.clear();
    this.embedCalls = 0;
    this.embedHits = 0;
    this.viHits = 0;
    this.viMisses = 0;
    this.extractCount = 0;
    this.reviseDeleted = 0;
    this.reviseMerged = 0;
    this.ioBytes = 0;
  }
}

/** 进程级单例。 */
export const memoryMetrics = new MemoryMetrics();

/** 把快照渲染为可读的多行文本（CLI `/memory stats` 与 GUI 文本仪表共用）。 */
export function formatMetrics(s: MetricsSnapshot): string {
  const lines: string[] = ['📊 记忆系统监控指标：'];
  const opNames = Object.keys(s.ops);
  if (opNames.length) {
    lines.push('  操作延迟（ms）：');
    for (const name of opNames) {
      const o = s.ops[name];
      lines.push(`    · ${name}: n=${o.count} 总=${o.totalMs} p50=${o.p50Ms} p95=${o.p95Ms} max=${o.maxMs}`);
    }
  } else {
    lines.push('  操作延迟：暂无采样');
  }
  lines.push(
    `  嵌入：${s.embed.calls} 次（query 缓存命中 ${s.embed.cacheHits}，命中率 ${(s.embed.hitRate * 100).toFixed(1)}%）`,
  );
  lines.push(
    `  向量索引缓存：${s.vectorIndex.hits} 命中 / ${s.vectorIndex.misses} 未命中（命中率 ${(s.vectorIndex.hitRate * 100).toFixed(1)}%）`,
  );
  lines.push(`  抽取：累计 ${s.extract.count} 条`);
  lines.push(`  治理：删除 ${s.revise.deleted} / 合并 ${s.revise.merged} 组`);
  lines.push(`  文件 I/O：${(s.ioBytes / 1024).toFixed(2)} KB`);
  lines.push(`  运行时长：${(s.uptimeMs / 1000).toFixed(1)} s`);
  return lines.join('\n');
}
