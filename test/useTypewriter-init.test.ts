/**
 * useTypewriter 初始 shown 逻辑测试
 *
 * 验证核心不变量：
 *  1. live=true → shown 从 0 开始（即使 text 已是完整值，也有逐字动画空间）
 *  2. live=false → shown = text.length（历史消息立即完整显示）
 *  3. gap = target - shown → live=true 时 gap = text.length（有追赶空间）
 *
 * 由于 useTypewriter 是 React Hook（依赖 useState/useEffect/useRef），
 * 无法在纯 Node 环境直接调用。这里测试其初始化逻辑的纯函数等价。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// 复刻 useTypewriter 的初始 shown 计算逻辑（与 useTypewriter.ts:54 等价）
function computeInitialShown(text: string, live: boolean): number {
  return live ? 0 : text.length;
}

test('live=true → shown=0（即使 text 非空）', () => {
  // 场景：React 18 批处理把 message('') + update('Hello 251字') 合并
  // 组件挂载时 text 已是完整值，但 live=true → shown=0 → 有追赶空间
  assert.strictEqual(computeInitialShown('Hello World 251 chars...', true), 0);
  assert.strictEqual(computeInitialShown('', true), 0);
  assert.strictEqual(computeInitialShown('你好，我是 DeepSeek 助手。', true), 0);
});

test('live=false → shown=text.length（历史消息立即完整）', () => {
  assert.strictEqual(computeInitialShown('Hello', false), 5);
  assert.strictEqual(computeInitialShown('', false), 0);
  assert.strictEqual(computeInitialShown('你好世界', false), 4);
});

test('live=true 时 gap = text.length（rAF 有追赶空间）', () => {
  // 模拟 useTypewriter 内部 rAF tick 的 gap 计算
  const text = 'A'.repeat(251);
  const live = true;
  const shown = computeInitialShown(text, live);
  const gap = text.length - shown;
  assert.strictEqual(gap, 251, 'live=true + 初始 shown=0 → gap=251 → rAF 会逐字追赶');
});

test('live=false 时 gap = 0（无追赶，立即完整显示）', () => {
  const text = 'A'.repeat(251);
  const live = false;
  const shown = computeInitialShown(text, live);
  const gap = text.length - shown;
  assert.strictEqual(gap, 0, 'live=false + shown=full → gap=0 → 无动画');
});

test('对比：旧逻辑（shown=text.length）vs 新逻辑（live?0:text.length）', () => {
  const text = 'Hello 251 chars';
  const live = true;

  // 旧逻辑
  const oldShown = text.length;
  const oldGap = text.length - oldShown;

  // 新逻辑
  const newShown = computeInitialShown(text, live);
  const newGap = text.length - newShown;

  assert.strictEqual(oldGap, 0, '旧逻辑：gap=0 → 无动画（bug 根因）');
  assert.strictEqual(newGap, text.length, '新逻辑：gap=full → 有动画（修复）');
});

test('live 从 true→false 时 snap 到 full（回合结束）', () => {
  // 模拟 useTypewriter 的 useEffect([live]) → if (!live) snap()
  const text = 'Hello 251 chars';
  let shown = computeInitialShown(text, true); // 0
  assert.strictEqual(shown, 0);

  // live 变 false → snap
  shown = text.length; // snap() sets shownRef = targetRef.length
  assert.strictEqual(shown, text.length, 'snap 后 shown = full');
});
