import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosine, keywordScore, retrieveScored } from '../src/memory/retriever.ts';
import type { MemoryEntry } from '../src/memory/types.ts';

test('cosine: 同向向量为 1', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
});

test('cosine: 正交向量为 0', () => {
  assert.equal(cosine([1, 0], [0, 1]), 0);
});

test('cosine: 反向向量为 -1', () => {
  assert.equal(cosine([1, 0], [-1, 0]), -1);
});

test('cosine: 长度不匹配 / 空 / 零向量返回 0', () => {
  assert.equal(cosine([1, 0], [1, 0, 0]), 0);
  assert.equal(cosine([], []), 0);
  assert.equal(cosine([0, 0], [0, 0]), 0);
});

test('keywordScore: 完全相同文本为 1', () => {
  assert.equal(keywordScore('TypeScript 项目', 'TypeScript 项目'), 1);
});

test('keywordScore: 无重叠为 0', () => {
  assert.equal(keywordScore('苹果 香蕉', '橙子 西瓜'), 0);
});

test('keywordScore: 部分重叠在 (0,1)', () => {
  const s = keywordScore('使用 TypeScript 写', '项目用 TypeScript');
  assert.ok(s > 0 && s < 1, `期望 0<s<1，实际 ${s}`);
});

test('keywordScore: 空输入为 0', () => {
  assert.equal(keywordScore('', 'abc'), 0);
  assert.equal(keywordScore('abc', ''), 0);
});

test('retrieveScored: 无向量时走关键词模式、按分数降序、至多返回 k 条', () => {
  const entries: MemoryEntry[] = [
    { id: '1', content: 'apple banana', createdAt: 0 },
    { id: '2', content: 'orange watermelon', createdAt: 0 },
    { id: '3', content: 'apple fruit', createdAt: 0 },
  ];
  const scored = retrieveScored(null, 'apple', entries, 2);
  assert.equal(scored.length, 2, '应截断到 k=2');
  assert.ok(scored[0].score >= scored[1].score, '应降序');
  assert.ok(scored[0].mode === 'keyword', '无向量应走 keyword 降级');
  assert.ok(scored[0].entry.content.includes('apple'), '最相关项应含 apple');
});

test('retrieveScored: 空候选返回空数组', () => {
  assert.deepEqual(retrieveScored(null, 'anything', [], 5), []);
});
