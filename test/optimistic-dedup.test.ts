/**
 * 乐观渲染去重测试：
 * 前端 onSend 创建临时 user 气泡（id=-1, localId=N），
 * 后端回显时按 localId 原地替换 id（不追加重复气泡）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

interface UiMessage {
  id: number; role: string; text: string;
  localId?: number; ts?: string;
}

function optimisticDedup(
  messages: UiMessage[],
  pendingLocalId: number | null,
  serverMsg: { id: number; role: string; text: string; ts: string },
): { messages: UiMessage[]; pendingLocalId: number | null } {
  if (serverMsg.role === 'user' && pendingLocalId !== null) {
    return {
      messages: messages.map((m) =>
        m.localId === pendingLocalId ? { ...m, id: serverMsg.id, text: serverMsg.text, ts: serverMsg.ts } : m,
      ),
      pendingLocalId: null,
    };
  }
  return { messages, pendingLocalId };
}

test('乐观消息被服务器回显原位替换', () => {
  const msgs: UiMessage[] = [
    { id: 0, role: 'assistant', text: 'old', localId: 1 },
    { id: -1, role: 'user', text: 'hello', localId: 2 },
  ];
  const { messages, pendingLocalId } = optimisticDedup(msgs, 2, {
    id: 5, role: 'user', text: 'hello', ts: '2024-01-01T00:00:00Z',
  });
  assert.strictEqual(messages.length, 2, '不应追加新气泡');
  assert.strictEqual(messages[1].id, 5, '临时 id=-1 应被替换为服务端 id=5');
  assert.strictEqual(messages[1].text, 'hello');
  assert.strictEqual(pendingLocalId, null, 'pending 应清零');
});

test('role 不是 user → 不触发去重', () => {
  const msgs: UiMessage[] = [
    { id: -1, role: 'user', text: 'hi', localId: 1 },
  ];
  const { messages, pendingLocalId } = optimisticDedup(msgs, 1, {
    id: 6, role: 'assistant', text: 'hello', ts: '',
  });
  assert.strictEqual(pendingLocalId, 1, 'pending 应保持');
  assert.strictEqual(messages[0].id, -1, 'assistant 消息不触发替换');
});

test('无 pending → 不替换', () => {
  const msgs: UiMessage[] = [
    { id: 0, role: 'user', text: 'old', localId: 1 },
  ];
  const { messages, pendingLocalId } = optimisticDedup(msgs, null, {
    id: 7, role: 'user', text: 'new', ts: '',
  });
  assert.strictEqual(messages[0].id, 0, '无 pending 时不变');
  assert.strictEqual(pendingLocalId, null);
});

test('localId 不匹配 → pending 仍清零但消息不变', () => {
  const msgs: UiMessage[] = [
    { id: -1, role: 'user', text: 'hi', localId: 3 },
  ];
  const { messages, pendingLocalId } = optimisticDedup(msgs, 99, {
    id: 8, role: 'user', text: 'hi', ts: '',
  });
  assert.strictEqual(messages[0].id, -1, 'localId 不匹配不替换消息');
  assert.strictEqual(pendingLocalId, null, '但 pending 仍清零（回显已收到）');
});
