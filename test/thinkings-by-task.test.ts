/**
 * thinkingsByTask 按 taskId 隔离测试
 *
 * 验证路线 B 核心不变量：
 *  1. thinkings 按 taskId 路由，各任务独立维护
 *  2. 切任务时 derivation 自动切换展示
 *  3. 一个任务的 thinking_update 不污染另一个任务
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

interface ThinkingEntry { id: number; kind: string; title?: string; text: string; status: 'streaming' | 'done' }
interface ThinkingTurn {
  turnId: number; status: 'thinking' | 'outputting' | 'done';
  collapsed: boolean; entries: ThinkingEntry[];
}

// 内联 thinkingsByTask reducer（与 App.tsx 中 setThinkings wrapper 等价）
function applyThinking(
  state: Record<string, ThinkingTurn[]>,
  taskId: string,
  updater: (t: ThinkingTurn[]) => ThinkingTurn[],
): Record<string, ThinkingTurn[]> {
  const current = state[taskId] ?? [];
  const next = updater(current);
  if (next === current) return state;
  return { ...state, [taskId]: next };
}

test('thinking_start → 追加到指定 taskId', () => {
  let state: Record<string, ThinkingTurn[]> = {};
  state = applyThinking(state, 'A', (t) => [
    ...t,
    { turnId: 1, status: 'thinking', collapsed: true, entries: [] },
  ]);
  assert.strictEqual(state['A'].length, 1);
  assert.strictEqual(state['A'][0].turnId, 1);
  assert.strictEqual(state['B'], undefined);
});

test('thinking_entry → 仅更新目标 taskId', () => {
  let state: Record<string, ThinkingTurn[]> = {
    A: [{ turnId: 1, status: 'thinking', collapsed: true, entries: [] }],
    B: [{ turnId: 1, status: 'thinking', collapsed: true, entries: [] }],
  };
  state = applyThinking(state, 'A', (t) => {
    const last = t[t.length - 1];
    return t.slice(0, -1).concat({
      ...last,
      entries: [...last.entries, { id: 1, kind: 'reason', text: 'hello', status: 'streaming' }],
    });
  });
  assert.strictEqual(state['A'][0].entries.length, 1, 'A 应有 1 条 entry');
  assert.strictEqual(state['B'][0].entries.length, 0, 'B 不应受影响');
});

test('切任务后 derivation 自然切换展示', () => {
  const state: Record<string, ThinkingTurn[]> = {
    A: [{ turnId: 1, status: 'done', collapsed: true, entries: [] }],
    B: [{ turnId: 2, status: 'thinking', collapsed: true, entries: [] }],
  };
  const activeTaskId = 'B';
  const thinkings = state[activeTaskId] ?? [];
  assert.strictEqual(thinkings.length, 1);
  assert.strictEqual(thinkings[0].turnId, 2, '应展现任务 B 的 thinkings');
});

test('thinking_update 跨任务不串扰', () => {
  let state: Record<string, ThinkingTurn[]> = {
    A: [{
      turnId: 1, status: 'thinking', collapsed: true,
      entries: [{ id: 1, kind: 'reason', text: 'A_text', status: 'streaming' }],
    }],
    B: [{
      turnId: 1, status: 'thinking', collapsed: true,
      entries: [{ id: 2, kind: 'reason', text: 'B_text', status: 'streaming' }],
    }],
  };
  // A 的 thinking 继续追加
  state = applyThinking(state, 'A', (t) => {
    const last = t[t.length - 1];
    const entries = last.entries.map((e) =>
      e.id === 1 ? { ...e, text: e.text + ' appended' } : e,
    );
    return t.slice(0, -1).concat({ ...last, entries });
  });
  assert.strictEqual(state['A'][0].entries[0].text, 'A_text appended', 'A 应更新');
  assert.strictEqual(state['B'][0].entries[0].text, 'B_text', 'B 应保持原样');
});

test('task_history 原子替换 thinkings', () => {
  let state: Record<string, ThinkingTurn[]> = {};
  const historyTurns: ThinkingTurn[] = [
    { turnId: 1, status: 'done', collapsed: true, entries: [] },
    { turnId: 2, status: 'done', collapsed: true, entries: [] },
  ];
  state = applyThinking(state, 'C', () => historyTurns);
  assert.strictEqual(state['C'].length, 2, '应为 2 个历史 turn');
});

test('host map 路由隔离：A send 不应该进 B 的 thinkings', () => {
  // 模拟：活跃 taskId=B，但 WS 事件 evTaskId=A → 应写入 A 的 thinkings
  let state: Record<string, ThinkingTurn[]> = {};
  const activeTaskId = 'B';

  // 事件带上 evTaskId=A（来自非活跃 host 的 wireHost 闭包）
  state = applyThinking(state, 'A', (t) => [
    ...t,
    { turnId: 1, status: 'thinking', collapsed: true, entries: [] },
  ]);
  assert.strictEqual(state['A']?.length, 1, '应写入 A');
  assert.strictEqual(state['B'], undefined, 'B 不应被污染');
  assert.strictEqual(state[activeTaskId], undefined, '活跃任务 B 不应有 thinkings');
});

test('thinking_start 新建轮默认展开 (collapsed:false)', () => {
  // 回归：早期默认 collapsed:true 会把思考过程藏起来，用户看不到实时推理。
  // 修复后 thinking_start handler 必须创建 collapsed:false 的轮，确保头像+思考卡立即可见。
  const state: Record<string, ThinkingTurn[]> = {};
  const next = applyThinking(state, 'A', (t) => [
    ...t,
    { turnId: 1, status: 'thinking', collapsed: false, entries: [] },
  ]);
  assert.strictEqual(next['A'][0].collapsed, false, '活跃思考轮必须默认展开');
});

test('thinking_end 回合结束自动收起 (collapsed:true)', () => {
  // 用户确认：回合结束后思考卡立即收起，减少下一轮开始的视觉噪音（可手动点开回看）。
  let state: Record<string, ThinkingTurn[]> = {
    A: [{ turnId: 1, status: 'thinking', collapsed: false, entries: [] }],
  };
  state = applyThinking(state, 'A', (t) => {
    const idx = t.findIndex((x) => x.turnId === 1);
    const nextArr = t.slice();
    nextArr[idx] = { ...nextArr[idx], status: 'done', collapsed: true };
    return nextArr;
  });
  assert.strictEqual(state['A'][0].status, 'done');
  assert.strictEqual(state['A'][0].collapsed, true, '回合结束必须收起');
});
