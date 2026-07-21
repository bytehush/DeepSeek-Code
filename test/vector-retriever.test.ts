/**
 * M9 向量化检索测试：VectorIndexRetriever 行为与 DefaultRetriever 等价 + 版本门控缓存 + 关键词降级委托。
 * 约定：确定性嵌入（直接构造带 embedding 的 MemoryEntry 或 FakeEmbedder），无网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import type { MemoryEntry } from '../src/memory/types.ts';
import { DefaultRetriever, type Retriever } from '../src/memory/retriever-iface.ts';
import { VectorIndexRetriever } from '../src/memory/vector-retriever.ts';
import { MemoryStore } from '../src/memory/store.ts';
import type { EmbedderBackend } from '../src/memory/embedder-backend.ts';

let idc = 0;
function entry(content: string, embedding: number[]): MemoryEntry {
  return { id: `e${idc++}`, content, embedding, createdAt: 1, updatedAt: 1 };
}

/** 可计数嵌入调用的 FakeEmbedder：内容 → 确定性 3 维向量。 */
class FakeEmbedder implements EmbedderBackend {
  embedCalls = 0;
  async embed(text: string): Promise<number[] | null> {
    this.embedCalls++;
    const v = [0, 0, 0];
    for (const ch of text) {
      const c = ch.charCodeAt(0);
      v[c % 3] += c;
    }
    return v;
  }
  async warmup(): Promise<void> {}
}

function ids(scored: Array<{ entry: MemoryEntry }>): string[] {
  return scored.map((s) => s.entry.id);
}

test('VectorIndexRetriever 的 top-K 与 DefaultRetriever 完全等价（有向量）', () => {
  const entries: MemoryEntry[] = [
    entry('alpha', [1, 0, 0]),
    entry('beta', [0, 1, 0]),
    entry('gamma', [0, 0, 1]),
    entry('delta', [0.5, 0.5, 0]),
  ];
  const query = 'q';
  const qEmbed = [1, 0, 0]; // 与 alpha 完全对齐
  const base: Retriever = new DefaultRetriever();
  const vi = new VectorIndexRetriever(base, { versionProvider: () => 1 });

  for (const k of [1, 2, 3, 4]) {
    const a = ids(base.retrieveScored(qEmbed, query, entries, k));
    const b = ids(vi.retrieveScored(qEmbed, query, entries, k));
    assert.deepEqual(b, a, `k=${k} 时 top-K 应完全一致`);
  }
});

test('版本 + 引用门控：同 entries 引用复用矩阵，新内容则重建反映新条目', () => {
  const state = { v: 1 };
  const base: Retriever = new DefaultRetriever();
  const vi = new VectorIndexRetriever(base, { versionProvider: () => state.v });

  const qEmbed = [1, 0, 0];
  // 稳定引用 entriesA（同一数组，模拟 store.readIndex() 命中缓存）
  const a = entry('a', [1, 0, 0]);
  const b = entry('b', [0, 1, 0]);
  const entriesA: MemoryEntry[] = [a, b];
  const r1 = ids(vi.retrieveScored(qEmbed, 'q', entriesA, 2));
  assert.deepEqual(r1, [a.id], 'entriesA top1 应为 a（与 query 对齐）');

  // 同引用、同版本 → 命中缓存，结果一致
  const r2 = ids(vi.retrieveScored(qEmbed, 'q', entriesA, 2));
  assert.deepEqual(r2, r1, '同引用同版本应复用矩阵，结果不变');

  // 版本变更但内容引用未变 → 仍重建（结果同内容，等价）
  state.v = 2;
  const r3 = ids(vi.retrieveScored(qEmbed, 'q', entriesA, 2));
  assert.deepEqual(r3, r1, '版本变更但内容同引用，结果仍一致');

  // 新内容（新引用，含与 query 对齐的 c）→ 必须重建，反映新条目
  const c = entry('c', [1, 0, 0]);
  const entriesB: MemoryEntry[] = [a, b, c];
  const r4 = ids(vi.retrieveScored(qEmbed, 'q', entriesB, 2));
  assert.deepEqual(r4, [a.id, c.id], '新内容应重建矩阵并召回 c（与 query 对齐）');
});

test('无 query 向量时委托 base 关键词降级，结果与 DefaultRetriever 一致', () => {
  const entries: MemoryEntry[] = [
    entry('项目使用 TypeScript 与 React', [1, 0, 0]),
    entry('今天午餐吃了牛肉面', [0, 1, 0]),
    entry('偏好使用 pnpm 管理依赖', [0, 0, 1]),
  ];
  const query = 'TypeScript React';
  const base: Retriever = new DefaultRetriever();
  const vi = new VectorIndexRetriever(base, { versionProvider: () => 1 });

  const a = ids(base.retrieveScored(null, query, entries, 5));
  const b = ids(vi.retrieveScored(null, query, entries, 5));
  assert.deepEqual(b, a, 'null query 向量应完全委托关键词降级');
});

test('store 集成：vectorIndex 开时 getVersion 随索引变更自增 + query 向量缓存复用', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'dsa-vi-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const embedder = new FakeEmbedder();
    const store = new MemoryStore(dir, embedder, { async: false, vectorIndex: true });

    // 初始版本 0，写入后自增
    assert.equal(store.getVersion(), 0);
    await store.addEntry('项目使用 TypeScript 与 React 构建前端');
    assert.equal(store.getVersion(), 1, 'addEntry 应使版本 +1');
    await store.addEntry('今天午餐吃了牛肉面');
    assert.equal(store.getVersion(), 2);

    // 语义召回：query 与第一条高度相似，应召回之
    const hits = await store.retrieve('TypeScript 与 React 前端', 3);
    assert.ok(hits.some((e) => e.content.includes('TypeScript')), '向量化检索应召回相似条目');

    // query 向量缓存：同 query 调用两次，embed 仅触发一次
    const before = embedder.embedCalls;
    await store.retrieve('缓存复用测试 query', 3);
    await store.retrieve('缓存复用测试 query', 3);
    assert.equal(embedder.embedCalls - before, 1, '同 query 应复用缓存，仅嵌入一次');

    await store.onDispose();
  } finally {
    cleanup();
  }
});
