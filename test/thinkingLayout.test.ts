/**
 * thinkingLayout 单测：锁住「孤儿思考轮」落位逻辑，防止回归（孤儿轮在历史/恢复时须渲染）。
 * 孤儿轮 = 思考已 done/interrupted 但 messages 里没有 thinkingId 匹配的答案气泡。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOrphans } from '../src/gui/web/thinkingLayout.ts';
import type { ThinkingTurn, ThinkingEntry } from '../src/gui/web/App.tsx';
import type { UiMessage } from '../src/app/types.ts';

function turn(turnId: number, status: ThinkingTurn['status'], entries: ThinkingEntry[] = []): ThinkingTurn {
  return { turnId, status, collapsed: true, entries };
}

function msg(role: UiMessage['role'], thinkingId?: number): UiMessage {
  return { id: thinkingId ?? Math.floor(Math.random() * 1e9), role, text: '', thinkingId } as UiMessage;
}

test('已匹配气泡的思考轮不进孤儿集合', () => {
  const thinkings = [turn(1, 'done', [{ id: 1, kind: 'reason', text: '闭包是函数+环境' }])];
  const messages = [msg('user'), msg('assistant', 1)];
  const { live, history } = computeOrphans(thinkings, messages, false);
  assert.equal(live, undefined);
  assert.equal(history.length, 0);
});

test('done 但无答案气泡 → 进 history（孤儿轮①）', () => {
  const thinkings = [turn(1, 'done', [{ id: 1, kind: 'reason', text: '推理文字' }])];
  const messages = [msg('user'), msg('assistant')]; // 答案气泡无 thinkingId
  const { live, history } = computeOrphans(thinkings, messages, false);
  assert.equal(live, undefined);
  assert.equal(history.length, 1);
  assert.equal(history[0].turnId, 1);
  assert.equal(history[0].status, 'done');
});

test('interrupted 但无答案气泡 → 进 history（孤儿轮②）', () => {
  const thinkings = [turn(7, 'interrupted', [{ id: 1, kind: 'reason', text: '中断前的思考' }])];
  const messages = [msg('user')]; // 无答案气泡
  const { live, history } = computeOrphans(thinkings, messages, false);
  assert.equal(live, undefined);
  assert.equal(history.length, 1);
  assert.equal(history[0].turnId, 7);
  assert.equal(history[0].status, 'interrupted');
});

test('busy + 思考中且无气泡 → 进 live（实时活跃卡）', () => {
  const thinkings = [turn(3, 'thinking', [{ id: 1, kind: 'reason', text: '正在想' }])];
  const messages = [msg('user')];
  const { live, history } = computeOrphans(thinkings, messages, true);
  assert.equal(live?.turnId, 3);
  assert.equal(history.length, 0);
});

test('busy 时多轮 orphan：思考中轮作 live，已结束轮作 history', () => {
  const thinkings = [
    turn(1, 'done', [{ id: 1, kind: 'reason', text: '第一轮' }]), // 孤儿（无气泡）
    turn(2, 'thinking', [{ id: 2, kind: 'reason', text: '第二轮思考中' }]), // 实时
  ];
  const messages = [msg('user')];
  const { live, history } = computeOrphans(thinkings, messages, true);
  assert.equal(live?.turnId, 2);
  assert.equal(history.length, 1);
  assert.equal(history[0].turnId, 1);
});

test('非 busy 时思考中轮不作为 live（避免恢复历史时把未完成态当活跃卡）', () => {
  const thinkings = [turn(1, 'thinking', [{ id: 1, kind: 'reason', text: 'x' }])];
  const messages = [msg('user')];
  const { live, history } = computeOrphans(thinkings, messages, false);
  assert.equal(live, undefined);
  assert.equal(history.length, 1); // 历史恢复时仍渲染（即便状态是 thinking）
});
