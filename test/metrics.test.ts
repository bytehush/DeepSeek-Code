/**
 * M10 监控指标测试：MemoryMetrics 采集与快照，以及 store 热路径埋点接入单例。
 *
 * 锁定：
 * - 延迟直方图（count/total/p50/p95/max）、embed 缓存命中率、向量索引命中率、抽取/治理计数、I/O 字节。
 * - 单例 memoryMetrics 被 store 写路径接入：addEntry 后 ioBytes>0 且记录 addEntry 延迟。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { MemoryStore } from '../src/memory/store.ts';
import { Embedder } from '../src/memory/embedder.ts';
import { MemoryMetrics, memoryMetrics, formatMetrics } from '../src/memory/metrics.ts';
import { VectorIndexRetriever } from '../src/memory/vector-retriever.ts';
import { DefaultRetriever } from '../src/memory/retriever-iface.ts';
import type { MemoryEntry } from '../src/memory/types.ts';
import { handleMemory } from '../src/app/commands.ts';

const SHARED_HOME = mkdtempSync(join(os.tmpdir(), 'dsa-home-metrics-'));
const REAL_HOME = process.env.HOME;
process.env.HOME = SHARED_HOME;
process.on('exit', () => {
  process.env.HOME = REAL_HOME;
  rmSync(SHARED_HOME, { recursive: true, force: true });
});

test('MemoryMetrics 延迟直方图与比率正确', () => {
  const m = new MemoryMetrics();
  m.recordLatency('retrieve', 10);
  m.recordLatency('retrieve', 30);
  m.recordLatency('retrieve', 20);
  m.recordEmbed(true); // 1 命中
  m.recordEmbed(false); // 1 未命中
  m.recordEmbed(false); // 1 未命中
  m.recordVectorIndex(true);
  m.recordVectorIndex(true);
  m.recordVectorIndex(false);
  m.recordExtract(3);
  m.recordRevise(2, 1);
  m.recordIo(1024);

  const s = m.snapshot();
  assert.equal(s.ops.retrieve.count, 3);
  assert.equal(s.ops.retrieve.totalMs, 60);
  assert.equal(s.ops.retrieve.maxMs, 30);
  assert.ok(s.ops.retrieve.p95Ms >= 30, `p95 应≈30，实际 ${s.ops.retrieve.p95Ms}`);
  assert.equal(s.embed.calls, 3);
  assert.equal(s.embed.cacheHits, 1);
  assert.ok(Math.abs(s.embed.hitRate - 1 / 3) < 1e-9, `命中率应 1/3，实际 ${s.embed.hitRate}`);
  assert.equal(s.vectorIndex.hits, 2);
  assert.equal(s.vectorIndex.misses, 1);
  assert.ok(Math.abs(s.vectorIndex.hitRate - 2 / 3) < 1e-9);
  assert.equal(s.extract.count, 3);
  assert.equal(s.revise.deleted, 2);
  assert.equal(s.revise.merged, 1);
  assert.equal(s.ioBytes, 1024);
  assert.ok(s.uptimeMs >= 0);
});

test('formatMetrics 产出可读多行文本', () => {
  const m = new MemoryMetrics();
  m.recordLatency('retrieve', 5);
  m.recordEmbed(false);
  const text = formatMetrics(m.snapshot());
  assert.ok(text.includes('记忆系统监控指标'), '应含标题');
  assert.ok(text.includes('操作延迟'), '应含延迟段');
  assert.ok(text.includes('嵌入'), '应含嵌入段');
});

test('store 写路径接入单例：addEntry 计入 ioBytes 与延迟', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'dsa-metrics-store-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    memoryMetrics.reset();
    const store = new MemoryStore(dir, new Embedder({ mode: 'off' }));
    await store.addEntry('受监控的记忆');
    const s = memoryMetrics.snapshot();
    assert.ok(s.ioBytes > 0, '写盘应计入 ioBytes');
    assert.ok((s.ops.addEntry?.count ?? 0) >= 1, '应记录 addEntry 延迟');
    await store.onDispose();
  } finally {
    cleanup();
  }
});

test('VectorIndexRetriever 上报矩阵缓存命中/未命中（onCache → memoryMetrics）', () => {
  const calls: boolean[] = [];
  const ret = new VectorIndexRetriever(new DefaultRetriever(), {
    versionProvider: () => 1,
    onCache: (hit) => calls.push(hit),
  });
  const entries: MemoryEntry[] = [
    { id: 'a', content: 'x', createdAt: 0, updatedAt: 0, embedding: [1, 0, 0] },
    { id: 'b', content: 'y', createdAt: 0, updatedAt: 0, embedding: [0, 1, 0] },
  ];
  const q = [1, 0, 0];
  // 第一次：缓存为空 → miss（构建矩阵）；store 据此 recordVectorIndex(false)
  ret.retrieveScored(q, 'q', entries, 5);
  // 第二次：版本与 entries 引用均不变 → hit（复用矩阵）；recordVectorIndex(true)
  ret.retrieveScored(q, 'q', entries, 5);

  assert.deepEqual(calls, [false, true], '第一次 miss、第二次 hit');
  // 经单例串接验证：直接喂给 memoryMetrics 的结果一致
  memoryMetrics.reset();
  calls.forEach((h) => memoryMetrics.recordVectorIndex(h));
  const s = memoryMetrics.snapshot();
  assert.equal(s.vectorIndex.misses, 1);
  assert.equal(s.vectorIndex.hits, 1);
});

test('/memory stats 子命令输出监控指标（CLI 与 GUI 共用 handleMemory）', async () => {
  const pushed: string[] = [];
  // stats 分支不依赖 manager，传占位即可
  await handleMemory('/memory stats', {} as never, (_role, text) => pushed.push(text));
  assert.equal(pushed.length, 1, '应推送一条指标文本');
  assert.ok(pushed[0].includes('记忆系统监控指标'), '应输出指标标题');
  assert.ok(pushed[0].includes('文件 I/O'), '应输出 I/O 段');
});
