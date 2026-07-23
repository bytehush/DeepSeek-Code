/**
 * flushSync 触发条件测试
 *
 * 验证：仅当 role==='assistant' 且 text='' 时才走 flushSync 路径
 * （强制 React 立即 commit DOM，打破自动批处理）。
 * 其余消息走正常 dispatch（不额外开销）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// 复刻 App.tsx message handler 中的 flushSync 判定逻辑
function shouldFlushSync(role: string, text: string): boolean {
  return role === 'assistant' && text.length === 0;
}

test('助手空气泡 → flushSync=true', () => {
  assert.strictEqual(shouldFlushSync('assistant', ''), true);
});

test('助手有内容 → flushSync=false（正常 dispatch）', () => {
  assert.strictEqual(shouldFlushSync('assistant', 'Hello'), false);
  assert.strictEqual(shouldFlushSync('assistant', '你好'), false);
});

test('用户消息 → flushSync=false', () => {
  assert.strictEqual(shouldFlushSync('user', ''), false);
  assert.strictEqual(shouldFlushSync('user', '你好'), false);
});

test('系统消息 → flushSync=false', () => {
  assert.strictEqual(shouldFlushSync('system', ''), false);
  assert.strictEqual(shouldFlushSync('system', '已切换到任务'), false);
});

test('promoteThinkingToFinal 首次创建的空气泡 → flushSync=true', () => {
  // 场景：promoteThinkingToFinal emit('message', {role:'assistant', text:''})
  assert.strictEqual(shouldFlushSync('assistant', ''), true);
});

test('appendStreaming 首个 chunk 创建的非空气泡 → flushSync=false', () => {
  // 场景：appendStreaming('final') 首个 chunk 非空
  assert.strictEqual(shouldFlushSync('assistant', 'Hello World'), false);
});

test('历史回放消息（role=assistant, text=完整内容） → flushSync=false', () => {
  assert.strictEqual(shouldFlushSync('assistant', '这是历史回答内容'), false);
});

/**
 * update handler 首块 flushSync 条件（P2-A）：
 * 仅当「目标气泡当前 text 仍为空（刚由 message handler flushSync 提交为空气泡）」时，
 * 本次 update 用 flushSync 强制立即 commit，确保首字在空气泡 paint 之后出现。
 */
function shouldFlushSyncOnUpdate(textOfTargetBubble: string): boolean {
  return textOfTargetBubble.trim() === '';
}

test('update 命中空气泡（text 为空）→ flushSync=true', () => {
  assert.strictEqual(shouldFlushSyncOnUpdate(''), true);
});

test('update 命中已有内容的气泡 → flushSync=false', () => {
  assert.strictEqual(shouldFlushSyncOnUpdate('你'), false);
  assert.strictEqual(shouldFlushSyncOnUpdate('你好世界'), false);
});

test('update 命中空白但有空格的气泡 → flushSync=true', () => {
  assert.strictEqual(shouldFlushSyncOnUpdate('   '), true, 'trim 后空，视为首块');
});
