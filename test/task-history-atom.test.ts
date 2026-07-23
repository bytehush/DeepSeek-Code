/**
 * task_history 原子替换测试
 *
 * 验证核心假设：task_history 事件将整个消息数组原子写入 messagesByTask，
 * 且之后的 new_message / update 事件不会被后续到达的 task_history 覆盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// UiMessage 简单重建（仅 id/role/text）
interface UiMessage { id: number; role: string; text: string; thinkingId?: number; ts?: string; localId?: number }
type MsgAction = { type: 'apply'; taskId: string; updater: (m: UiMessage[]) => UiMessage[] };

// messagesReducer 内联（避免 import App.tsx 引入 CSS → Node test 报错）
function messagesReducer(state: Record<string, UiMessage[]>, action: MsgAction): Record<string, UiMessage[]> {
  if (action.type === 'apply') {
    const next = action.updater(state[action.taskId] ?? []);
    return { ...state, [action.taskId]: next };
  }
  return state;
}

const t = 'task_b';

test('task_history replaces entire array atomically', () => {
  // 初始：某任务有 5 条历史
  let state: Record<string, UiMessage[]> = {
    [t]: [
      { id: 0, role: 'user', text: 'q1' },
      { id: 1, role: 'assistant', text: 'a1' },
      { id: 2, role: 'user', text: 'q2' },
      { id: 3, role: 'assistant', text: 'a2' },
      { id: 4, role: 'system', text: 'sys' },
    ],
  };

  // task_history 替换为新历史（假设任务被重新加载，有 3 条消息）
  const newHistory: UiMessage[] = [
    { id: 0, role: 'user', text: 'q1' },
    { id: 1, role: 'assistant', text: 'a1' },
    { id: 2, role: 'system', text: 'new_sys' },
  ];
  state = messagesReducer(state, { type: 'apply', taskId: t, updater: () => newHistory });

  assert.deepStrictEqual(
    state[t],
    newHistory,
    `task_history 后 messagesByTask[${t}] 应严格等于传入的数组`,
  );
  assert.strictEqual(state[t].length, 3, '应为 3 条消息');
});

test('new message after task_history is appended correctly', () => {
  // task_history 落地后
  let state: Record<string, UiMessage[]> = {
    [t]: [
      { id: 0, role: 'user', text: 'hi' },
      { id: 1, role: 'assistant', text: 'hello' },
    ],
  };

  // 用户发送新消息
  const userMsg: UiMessage = { id: 2, role: 'user', text: '你好' };
  state = messagesReducer(state, { type: 'apply', taskId: t, updater: (m) => [...m, userMsg] });

  assert.strictEqual(state[t].length, 3, '用户消息应追加');
  assert.strictEqual(state[t][2].text, '你好');

  // 助手回答（流式创建 + 更新）
  const asst: UiMessage = { id: 3, role: 'assistant', text: '' };
  state = messagesReducer(state, { type: 'apply', taskId: t, updater: (m) => [...m, asst] });
  assert.strictEqual(state[t].length, 4, '助手空气泡应追加');

  // 流式更新
  state = messagesReducer(state, {
    type: 'apply',
    taskId: t,
    updater: (m) =>
      m.map((x) => (x.id === 3 ? { ...x, text: '你好，我是 DeepSeek。请问有什么可以帮你的？' } : x)),
  });
  assert.strictEqual(state[t][3].text, '你好，我是 DeepSeek。请问有什么可以帮你的？');
  assert.strictEqual(state[t].length, 4, 'update 不应改变消息数量');
});

test('task_history on task A does not affect task B', () => {
  let state: Record<string, UiMessage[]> = {
    task_a: [{ id: 0, role: 'user', text: 'a_msg' }],
    task_b: [{ id: 0, role: 'user', text: 'b_msg' }],
  };

  const newA: UiMessage[] = [{ id: 0, role: 'user', text: 'a_new' }];
  state = messagesReducer(state, { type: 'apply', taskId: 'task_a', updater: () => newA });

  assert.deepStrictEqual(state.task_a, newA, 'task_a 应被替换');
  assert.strictEqual(state.task_b.length, 1, 'task_b 不应受影响');
  assert.strictEqual(state.task_b[0].text, 'b_msg', 'task_b 的消息应保持原样');
});

test('concurrent messages: first message is not lost', () => {
  // 模拟快切场景：task_history 落地后立即收到新消息
  let state: Record<string, UiMessage[]> = {
    [t]: [],
  };

  // task_history 原子替换
  const history: UiMessage[] = [
    { id: 0, role: 'user', text: 'old_q' },
    { id: 1, role: 'assistant', text: 'old_a' },
  ];
  state = messagesReducer(state, { type: 'apply', taskId: t, updater: () => history });

  // 紧接的新消息（由 host.push 产生）
  const sysMsg: UiMessage = { id: 2, role: 'system', text: '已切换' };
  state = messagesReducer(state, { type: 'apply', taskId: t, updater: (m) => [...m, sysMsg] });

  assert.strictEqual(state[t].length, 3, '历史和系统消息共存');
  assert.strictEqual(state[t][2].text, '已切换');

  // 用户再发一条
  const userMsg: UiMessage = { id: 3, role: 'user', text: 'new_q' };
  state = messagesReducer(state, { type: 'apply', taskId: t, updater: (m) => [...m, userMsg] });

  assert.strictEqual(state[t].length, 4, '用户新消息追加');
  assert.strictEqual(state[t][3].text, 'new_q');
});
