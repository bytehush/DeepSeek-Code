/**
 * scrollFollow 单测：锁住「流式渲染时拖拽 / 上滑接管」逻辑，防止回归。
 *
 * 核心 bug：原实现里流式 rAF 跟随循环依赖 [state.busy, outputting]，依赖抖动触发 effect 重跑
 * 时会重新 `followRef = pinnedRef`，把用户刚上滑接管的 follow 重新打开 → 弹回底部。
 * 这里直接验证 ScrollFollowController 的决策，覆盖「拖拽上滑 → 流式中途依赖抖动不重设 → 不弹回底」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScrollFollowController } from '../src/gui/web/scrollFollow.ts';

/** 构造指标：给定 scrollTop / 内容高 / 视口高（threshold 默认 20）。 */
function m(scrollTop: number, scrollHeight: number, clientHeight: number): { scrollTop: number; scrollHeight: number; clientHeight: number } {
  return { scrollTop, scrollHeight, clientHeight };
}

test('贴底开始流式 → 自动跟随开启', () => {
  const c = new ScrollFollowController(20);
  // scrollTop=500, scrollHeight=1000, clientHeight=500 → 距底 0 < 20 → 贴底
  c.notifyActive(true, m(500, 1000, 500));
  assert.equal(c.shouldFollow(), true);
  // 非贴底开始则不跟随（用户在看历史）
  const d = new ScrollFollowController(20);
  d.notifyActive(true, m(0, 1000, 500)); // 距底 500 → 未贴底
  assert.equal(d.shouldFollow(), false);
});

test('BAIL-根因回归：拖拽上滑接管后，流式中途依赖抖动(notifyActive)不得重设 follow', () => {
  const c = new ScrollFollowController(20);
  // 流式开始，用户在底部
  c.notifyActive(true, m(500, 1000, 500));
  assert.equal(c.shouldFollow(), true, '开始流式且贴底 → 跟随');

  // 流式输出使内容变长，rAF 程序化贴底触发 scroll 事件（仍在底部）
  const rProg = c.onScroll(m(700, 1200, 500)); // 距底 0 → 贴底，follow 保持
  assert.equal(c.shouldFollow(), true);
  assert.equal(rProg, false, '已在底部，无需再滚');

  // 用户拖拽上滑（滚轮/拖滑块都会派发 scroll，scrollTop 减小）
  c.onScroll(m(200, 1200, 500)); // 距底 500 → 离底，方向向上
  assert.equal(c.shouldFollow(), false, '用户上滑 → 接管，跟随关闭');

  // 关键：流式期间 [state.busy, outputting] 抖动导致 notifyActive 再次以 active=true 调用
  // （这正是原 bug 触发点）。此刻用户仍在上滑位置，必须保持不跟随。
  c.notifyActive(true, m(200, 1500, 500));
  assert.equal(c.shouldFollow(), false, '流式中途依赖抖动不得重设 follow → 不弹回底');

  // 即便后续又有新内容到达、再次 notifyActive，仍不可恢复跟随
  c.notifyActive(true, m(200, 1800, 500));
  assert.equal(c.shouldFollow(), false, '多次抖动仍不重设');

  // 并且 rAF / [messages] 据 shouldFollow() 不会去动 scrollTop
  assert.equal(c.shouldFollow(), false);
});

test('拖拽上滑期间有程序化滚动尝试也不会误判为「用户回底」', () => {
  const c = new ScrollFollowController(20);
  c.notifyActive(true, m(500, 1000, 500)); // 开始，贴底
  c.onScroll(m(300, 1200, 500)); // 用户上滑
  assert.equal(c.shouldFollow(), false);
  // 即便某次 scroll 事件 scrollTop 与上一次相同（无移动），也不应恢复
  const r = c.onScroll(m(300, 1200, 500));
  assert.equal(c.shouldFollow(), false, '无位移不改变接管状态');
  assert.equal(r, false);
});

test('回到贴底 → 恢复自动跟随（标准语义）', () => {
  const c = new ScrollFollowController(20);
  c.notifyActive(true, m(500, 1000, 500)); // 开始贴底
  c.onScroll(m(100, 1300, 500)); // 用户上滑
  assert.equal(c.shouldFollow(), false);
  // 用户手动滚回底部
  c.onScroll(m(800, 1300, 500)); // 距底 0 → 贴底 → 恢复
  assert.equal(c.shouldFollow(), true, '回到底部 → 恢复跟随');
});

test('滚轮/pointerdown 即时意图：onUserIntent 立即关跟随', () => {
  const c = new ScrollFollowController(20);
  c.notifyActive(true, m(500, 1000, 500));
  c.onUserIntent();
  assert.equal(c.shouldFollow(), false, '主动意图立即接管');
  // 流式中途 notifyActive 不得恢复
  c.notifyActive(true, m(500, 1000, 500));
  assert.equal(c.shouldFollow(), false);
});

test('新一轮流式：用户在看历史（未贴底）→ 不自动跟随（不抢视野）', () => {
  const c = new ScrollFollowController(20);
  // 上一轮结束，用户滚上去看历史
  c.notifyActive(true, m(500, 1000, 500));
  c.onScroll(m(50, 1200, 500)); // 上滑接管
  assert.equal(c.shouldFollow(), false);
  c.notifyActive(false, m(50, 1200, 500)); // 上一轮结束
  // 新一轮流式开始，用户仍在历史位置（未贴底）
  c.notifyActive(true, m(50, 1500, 500));
  assert.equal(c.shouldFollow(), false, '新一轮开始但用户在看历史 → 不跟随');
});

test('新一轮流式：用户已回到底部 → 重新自动跟随', () => {
  const c = new ScrollFollowController(20);
  c.notifyActive(true, m(500, 1000, 500));
  c.onScroll(m(50, 1200, 500)); // 上滑接管
  assert.equal(c.shouldFollow(), false);
  c.notifyActive(false, m(50, 1200, 500)); // 上一轮结束
  // 用户已回到底部，新一轮开始
  c.notifyActive(true, m(700, 1200, 500)); // 距底 0 → 贴底
  assert.equal(c.shouldFollow(), true, '新一轮且贴底 → 恢复跟随');
});
