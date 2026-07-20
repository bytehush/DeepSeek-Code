/**
 * MemoryPipeline 每轮召回 + ConversationHistory 标记消息单测（M5 · P2a 修复 L2）。
 *
 * 锁定：
 * 1. composeForTurn 每轮重算语义召回，能召回会话中新写入的条目（证明不再 boot-only 冻结）。
 * 2. composeForTurn 空 query / 无条目返回空串（安全降级）。
 * 3. ConversationHistory removeMarked+addMarked 实现「下一轮替换上一轮」，历史不无限膨胀。
 * 4. getMessages 返回的消息已剥离内部 _marker（不泄漏到 API）。
 *
 * 隔离：临时 HOME（user 层）+ 临时 cwd（project 层），结束恢复环境。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { MemoryOrchestrator } from '../src/memory/orchestrator.ts';
import { Embedder } from '../src/memory/embedder.ts';
import { MEMORY_RECALL_MARKER } from '../src/memory/pipeline.ts';
import { ConversationHistory } from '../src/context/history.ts';

const REAL_HOME = process.env.HOME;

async function withIsolatedEnv(fn: (orch: MemoryOrchestrator) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(os.tmpdir(), 'dsa-m5-home-'));
  const cwd = mkdtempSync(join(os.tmpdir(), 'dsa-m5-cwd-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  const orch = new MemoryOrchestrator(cwd, new Embedder({ mode: 'off' }));
  try {
    await fn(orch);
  } finally {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('M5 composeForTurn 召回会话中新写入的 react 条目（修复 L2 冻结）', async () => {
  await withIsolatedEnv(async (orch) => {
    await orch.addEntry('前端用 React 加 TypeScript 写函数式组件', ['前端', 'React']);
    await orch.addEntry('状态管理用 Zustand 而不是 Redux', ['状态管理']);
    await orch.addEntry('样式用 CSS Modules 管理', ['样式']);

    const recall = await orch.composeForTurn('system-base', 'react 组件怎么组织', 5);
    assert.ok(recall.length > 0, 'composeForTurn 应返回非空召回块');
    assert.match(recall, /React/, '召回块应包含会话中新写入的 react 条目');

    // 与 boot-only compose 对比：两者都用同一 queryScored，召回口径一致
    const boot = await orch.compose('system-base', 'react 组件怎么组织', 5);
    assert.match(boot, /React/, '旧 compose 同样应能召回 react 条目（口径一致）');
  });
});

test('M5 composeForTurn 空 query / 无条目返回空串（安全降级）', async () => {
  await withIsolatedEnv(async (orch) => {
    const emptyQuery = await orch.composeForTurn('base', '', 5);
    assert.strictEqual(emptyQuery, '', '空 query 应返回空串');
    const noData = await orch.composeForTurn('base', '任意查询但库空', 5);
    assert.strictEqual(noData, '', '无语义记忆时应返回空串');
  });
});

test('M5 标记消息：removeMarked+addMarked 实现下一轮替换，历史不膨胀', () => {
  const h = new ConversationHistory('SYS');
  // 首轮注入
  h.addMarked('system', 'recall-round-1', MEMORY_RECALL_MARKER);
  let msgs = h.getMessages();
  assert.strictEqual(msgs.length, 2, 'system + 1 条标记消息');
  // 次轮：先移除再注入（与 runChatTurn 同款顺序）
  h.removeMarked(MEMORY_RECALL_MARKER);
  h.addMarked('system', 'recall-round-2', MEMORY_RECALL_MARKER);
  msgs = h.getMessages();
  assert.strictEqual(msgs.length, 2, '替换后仍为 system + 1 条（不无限膨胀）');
  // 内容应为新一轮的
  const content = msgs
    .filter((m) => m.role === 'system' && m.content.includes('recall-round'))
    .map((m) => m.content)
    .join('|');
  assert.match(content, /recall-round-2/, '标记消息内容应为新一轮');
  // removeMarked 后清空
  h.removeMarked(MEMORY_RECALL_MARKER);
  assert.strictEqual(h.getMessages().length, 1, 'removeMarked 后仅剩 system');
});

test('M5 getMessages 返回的消息已剥离内部 _marker（不泄漏到 API）', () => {
  const h = new ConversationHistory('SYS');
  h.addMarked('system', 'recall-x', MEMORY_RECALL_MARKER);
  for (const m of h.getMessages()) {
    assert.strictEqual(
      (m as Record<string, unknown>)._marker,
      undefined,
      'getMessages 不应暴露 _marker 字段',
    );
  }
});
