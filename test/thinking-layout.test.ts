/**
 * computeOrphans 单元测试 — 锁定「思考卡位置判定」的关键边界
 *
 * 直接 import 真实实现（thinkingLayout.ts 仅用 import type，运行时无 CSS 依赖，tsx 下安全）。
 *
 * 核心不变量：
 *  1. 已被答案气泡匹配的 thinking 轮次不进孤儿集合（避免与气泡上方思考卡重复渲染）
 *  2. live 实时活跃卡：只要「最新孤儿轮」仍处于 thinking/outputting 且全局 busy，就显示，
 *     不受历史里是否有 assistant 气泡影响（正是「有历史的任务发消息也能看到思考卡」的关键）
 *  3. 已结束/中断的孤儿轮一律进入 history，由 ChatArea 渲染为底部历史卡
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOrphans } from '../src/gui/web/thinkingLayout.ts';

// 测试数据用的轻量本地类型（与 thinkingLayout 实际类型结构一致）
interface UiMessage { id: number; role: string; text: string; thinkingId?: number }
interface ThinkingTurn {
  turnId: number;
  status: 'thinking' | 'outputting' | 'done' | 'interrupted';
  collapsed: boolean;
  entries: Array<{ id: number; kind: string; title?: string; text: string; status: 'streaming' | 'done' }>;
}

const t = (id: number, status: ThinkingTurn['status']): ThinkingTurn => ({
  turnId: id, status, collapsed: true, entries: [],
});

test('无 assistant 消息 + busy=true → live 显示', () => {
  const layout = computeOrphans([t(1, 'thinking')], [], true);
  assert.strictEqual(layout.live?.turnId, 1, '首轮实时活跃应被显示');
});

test('已有 assistant 消息 + busy=true → 最新孤儿 thinking 轮仍作为 live 显示', () => {
  // 复现场景：第一轮响应完成（assistant with thinkingId=1），第二轮发消息（thinkingId=2）
  // 修复前：live 被过度抑制（有 assistant 就不显示），导致第二轮思考阶段看不到助手头像/思考卡
  // 修复后：turnId=2 是「最新孤儿且 thinking」，应显示 live；turnId=1 已 matched 不进孤儿
  const messages: UiMessage[] = [
    { id: 0, role: 'user', text: 'hi' },
    { id: 1, role: 'assistant', text: 'hello', thinkingId: 1 },
  ];
  const layout = computeOrphans([t(1, 'done'), t(2, 'thinking')], messages, true);
  assert.strictEqual(layout.live?.turnId, 2, '有历史的任务，当前活跃思考轮应作为 live 显示');
  assert.strictEqual(layout.history.length, 0, 'turnId=1 已匹配，不进 history；turnId=2 是 live 不进 history');
});

test('多轮：首轮 matched，第二轮 thinking（history 有 assistant）→ 第二轮 live', () => {
  const messages: UiMessage[] = [
    { id: 1, role: 'assistant', text: 'a', thinkingId: 1 },
    { id: 2, role: 'user', text: 'q2' },
  ];
  const layout = computeOrphans([t(1, 'done'), t(2, 'thinking')], messages, true);
  assert.strictEqual(layout.live?.turnId, 2, '后续任务的实时思考轮必须可见');
  assert.deepStrictEqual(layout.history.map((h) => h.turnId), []);
});

test('当前活跃轮已有匹配答案气泡（thinkingId 已绑）→ 不重复渲染 live', () => {
  // assistant.thinkingId === turnId 且 busy=true（同一轮正在 streaming 最终答案）
  const messages: UiMessage[] = [{ id: 1, role: 'assistant', text: '', thinkingId: 1 }];
  const layout = computeOrphans([t(1, 'outputting')], messages, true);
  assert.strictEqual(layout.live, undefined, '已匹配气泡的轮不进孤儿，也不会与气泡上方卡重叠');
});

test('thinking turn 与 assistant 的 thinkingId 不匹配 → 新轮作为 live，旧轮 matched 不进 history', () => {
  // assistant 标 thinkingId=1（已 done），当前活跃 thinking 是 turnId=2（outputting）
  const messages: UiMessage[] = [{ id: 1, role: 'assistant', text: '...', thinkingId: 1 }];
  const layout = computeOrphans([t(1, 'done'), t(2, 'outputting')], messages, true);
  assert.strictEqual(layout.live?.turnId, 2, '未匹配的最新孤儿活跃轮应为 live');
  assert.deepStrictEqual(layout.history.map((h) => h.turnId), [], '已 matched 的 turn=1 不进孤儿（无重复渲染）');
});

test('busy=false → live 永远为 undefined', () => {
  const layout = computeOrphans([t(1, 'thinking')], [], false);
  assert.strictEqual(layout.live, undefined, 'idle 状态下不应显示实时卡');
  assert.strictEqual(layout.history.length, 1, '但仍作为 history 孤儿保留');
});

test('interrupted turn 归 history（不归 live）', () => {
  const layout = computeOrphans([t(1, 'interrupted')], [], true);
  assert.strictEqual(layout.live, undefined, 'interrupted 不是 thinking/outputting');
  assert.strictEqual(layout.history[0].turnId, 1);
});

test('matched turn 不进入孤儿集合', () => {
  const messages: UiMessage[] = [{ id: 1, role: 'assistant', text: '...', thinkingId: 1 }];
  const layout = computeOrphans([t(1, 'done')], messages, false);
  assert.strictEqual(layout.live, undefined);
  assert.strictEqual(layout.history.length, 0, '已被匹配的 turn 不出现在 history');
});

test('busy=true 但最新孤儿已 done → live 为 undefined，归 history', () => {
  // 防止「把已结束的轮误当 live」——live 只认 thinking/outputting
  const layout = computeOrphans([t(1, 'done')], [], true);
  assert.strictEqual(layout.live, undefined);
  assert.strictEqual(layout.history[0].turnId, 1);
});
