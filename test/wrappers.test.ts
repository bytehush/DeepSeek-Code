import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrieveScored } from '../src/memory/retriever.ts';
import { DefaultRetriever } from '../src/memory/retriever-iface.ts';
import { composeSystemPrompt } from '../src/memory/composer.ts';
import { DefaultComposer } from '../src/memory/composer.ts';
import { detectMemoryIntent } from '../src/memory/intent.ts';
import { DefaultIntentDetector } from '../src/memory/intent.ts';
import type { MemoryEntry } from '../src/memory/types.ts';

const sampleEntries: MemoryEntry[] = [
  { id: '1', content: 'apple banana', embedding: null, createdAt: 0, tags: [] },
  { id: '2', content: 'orange melon', embedding: null, createdAt: 0, tags: [] },
];

test('DefaultRetriever 委托纯函数 retrieveScored 结果一致', () => {
  const fn = retrieveScored(null, 'apple', sampleEntries, 2);
  const cls = new DefaultRetriever().retrieveScored(null, 'apple', sampleEntries, 2);
  assert.deepEqual(cls, fn);
});

test('DefaultComposer 委托 composeSystemPrompt 结果一致（有/无记忆两种）', () => {
  const base = 'system base';
  const u = '- 偏好 pnpm';
  const p = '- 用 TypeScript';
  const retr: MemoryEntry[] = [
    { id: 'r', content: '历史记忆', embedding: null, createdAt: 0, tags: [] },
  ];
  assert.equal(
    new DefaultComposer().compose(base, u, p, retr),
    composeSystemPrompt(base, u, p, retr),
  );
  assert.equal(
    new DefaultComposer().compose(base, '', '', []),
    composeSystemPrompt(base, '', '', []),
  );
});

test('DefaultIntentDetector 委托 detectMemoryIntent 结果一致（命中/未命中）', () => {
  const hit = '记一下 项目用 TypeScript 写';
  assert.deepEqual(new DefaultIntentDetector().detect(hit), detectMemoryIntent(hit));
  assert.equal(new DefaultIntentDetector().detect('记住了吗'), detectMemoryIntent('记住了吗'));
});
