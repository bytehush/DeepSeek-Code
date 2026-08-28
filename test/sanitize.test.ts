/**
 * sanitize 单测：box-drawing / block element → ASCII 等宽映射
 * （docs/Bug修复-长工具调用时右侧散布box-drawing视觉污染.md 方案 3）。
 *
 * 核心不变式：
 *   1. 映射 1:1（1 字符 → 1 字符），displayWidth 视角宽度不变 → 折行点不偏移
 *   2. 纯文本 / CJK / markdown 标记不误伤（零改动路径）
 *   3. agent 工具输出场景（tree / git log --graph 形态）全部落为 ASCII
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containsBoxDrawing, sanitizeBoxDrawing } from '../src/cli/sanitize.ts';
import { displayWidth } from '../src/app/markdown-lines.ts';

test('sanitizeBoxDrawing：宽度不变（1:1 映射核心不变式）', () => {
  // box-drawing 每个字符宽度 = 1，映射后 ASCII 宽度 = 1
  const box = '┌─┬┐│├┼┤└┴┘╔╦╗╠╬╣╚╩╝';
  assert.equal(displayWidth(box), box.length, 'box-drawing 全按 1 列计');
  const ascii = sanitizeBoxDrawing(box);
  assert.equal(displayWidth(ascii), box.length, '映射后宽度不变（折行点不偏移）');
  assert.ok(!containsBoxDrawing(ascii), '映射后不再含 box-drawing');
});

test('sanitizeBoxDrawing：关键字符映射正确', () => {
  // ┌─┐│└┘├┤┬┴┼ = 11 字符（┐ 是转角 → '+'，非横线）
  assert.equal(sanitizeBoxDrawing('┌─┐│└┘├┤┬┴┼'), '+-+|+++++++');
  assert.equal(sanitizeBoxDrawing('╔╦╗╠╬╣╚╩╝'), '+++++++++');
  assert.equal(sanitizeBoxDrawing('╭╮╯╰'), '++++');
  assert.equal(sanitizeBoxDrawing('╱╲╳'), '/\\x');
  assert.equal(sanitizeBoxDrawing('─━══'), '----');
  assert.equal(sanitizeBoxDrawing('│┃╎║'), '||||');
  // block elements（█▉▊▋▌▍▎▏▐▓ = 10 字符）
  assert.equal(sanitizeBoxDrawing('█▉▊▋▌▍▎▏▐▓'), '##########');
  assert.equal(sanitizeBoxDrawing('░▒'), '::');
  assert.equal(sanitizeBoxDrawing('▀▁▂▃▄▅▆▇▔'), '---------' + '', '9 个上半块字符 → 9 个 -');
  assert.equal(sanitizeBoxDrawing('▕'), '|');
});

test('sanitizeBoxDrawing：无 box-drawing 时原样返回（零拷贝路径）', () => {
  const plain = '这是一个普通的中文文本 **加粗** `code` 没有 box-drawing。';
  assert.equal(sanitizeBoxDrawing(plain), plain, '无相关字符不产生任何改动');
  assert.equal(containsBoxDrawing(plain), false);
});

test('sanitizeBoxDrawing：与 markdown 标记共存不破坏', () => {
  // 反引号 / 星号不在映射表，sanitize 不触碰；'┌─' 只有 1 个 ─
  const md = '**加粗** `inline` ┌─ 代码 ─┐';
  const out = sanitizeBoxDrawing(md);
  assert.equal(out, '**加粗** `inline` +- 代码 -+');
  assert.ok(out.includes('**加粗**'), 'markdown 标记保留');
  assert.ok(out.includes('`inline`'), '行内代码标记保留');
});

test('agent 工具输出场景：git log --graph 形态全部 ASCII 化', () => {
  // git log --graph 典型输出（tree/graph 分支线）
  const gitGraph = [
    '* 728c1b.mjs (HEAD -> master)',
    '*   merge branch',
    '|\\',
    '| * 8f1a1b.mjs',
    '* | 42c6fb.mjs',
    '|/',
    '* e7e4f3.mjs',
  ].join('\n');
  const out = sanitizeBoxDrawing(gitGraph);
  assert.ok(!containsBoxDrawing(out), 'graph 分支线（|\\ / |/）全部 ASCII 化');
  assert.ok(out.includes('|\\'), 'graph 线保留为 ASCII 斜线/竖线');
});

test('agent 工具输出场景：tree 命令树形字符全部 ASCII 化', () => {
  const tree = [
    'src',
    '├── cli',
    '│   ├── app.tsx',
    '│   └── main.ts',
    '└── app',
    '    └── viewport.ts',
  ].join('\n');
  const out = sanitizeBoxDrawing(tree);
  assert.ok(!containsBoxDrawing(out), 'tree 树形字符全部 ASCII 化');
  assert.ok(out.includes('+-- cli'), '转角 ├ → +');
  assert.ok(out.includes('|   +-- app.tsx'), '竖线 │ → |');
});

test('sanitizeBoxDrawing：CJK / emoji 不误伤', () => {
  const mixed = '混合 🐋 深蓝 #185FA5 ─ 正常文字';
  const out = sanitizeBoxDrawing(mixed);
  assert.ok(out.includes('🐋'), 'emoji 保留');
  assert.ok(out.includes('#185FA5'), 'ASCII 原样保留');
  assert.ok(out.includes('- 正常文字'), 'box-drawing 映射为 -，其余不动');
});

test('containsBoxDrawing：快速路径探测', () => {
  assert.equal(containsBoxDrawing('hello world'), false);
  assert.equal(containsBoxDrawing('a ─ b'), true);
  assert.equal(containsBoxDrawing('█'), true);
  assert.equal(containsBoxDrawing('a\u2500b'), true, 'U+2500 单字符也命中');
});
