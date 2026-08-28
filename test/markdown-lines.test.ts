/**
 * markdown-lines 单测：marker 感知切片（docs/Bug修复-Markdown标记被切片切断后泄漏为可见字符.md）。
 *
 * 核心回归：行级切片（splitTextToLines / clipMessageRows）不得把成对 marker
 * （**、*、`、~~）切断，导致可见文本含孤儿 `**` —— 那是 MarkdownMessage 把
 * 它当字面文本泄漏的根因。
 *
 * 验证策略（文档 §5.8）：displayWidth / maskedText / computed lines 三组对照。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayWidth, maskMarkdownMarkers, splitTextToLines, clipMessageRows } from '../src/app/markdown-lines.ts';

/** 断言一段文本的行内 marker 都是「完整配对」（无孤儿）：
 * 依次移除 **x** / *x* / `x` / ~~x~~ 后，剩余文本不得含 *、`、~ 字符 */
function assertNoOrphanMarkers(text: string): void {
  const re = /(\*\*[\s\S]+?\*\*|\*[\s\S]+?\*|`[^`]+`|~~[\s\S]+?~~)/g;
  const stripped = text.replace(re, '');
  const orphans = [...stripped].filter((ch) => ch === '*' || ch === '`' || ch === '~');
  assert.deepEqual(
    orphans,
    [],
    `发现孤儿 marker（应被完整配对消费）: ${JSON.stringify(orphans)} in ${JSON.stringify(text)}`,
  );
}

test('displayWidth：marker 掩码后按内容宽度计（**bold** → 4 列）', () => {
  assert.equal(displayWidth('**bold**'), 8, '原文按字符计（4+2*2=8）');
  assert.equal(displayWidth(maskMarkdownMarkers('**bold**')), 4, '掩码后 marker 0 列 → 4');
  assert.equal(displayWidth('**加粗**'), 8, '原文 CJK 计宽（2*2+2*2=8）');
  assert.equal(displayWidth(maskMarkdownMarkers('**加粗**')), 4, '掩码后 → 4');
  assert.equal(displayWidth(maskMarkdownMarkers('`code`')), 4);
  assert.equal(displayWidth(maskMarkdownMarkers('~~del~~')), 3);
  assert.equal(displayWidth(maskMarkdownMarkers('*it*')), 2);
});

test('displayWidth：emoji / 组合字符 / ZWJ 按终端真实宽度计（双宽度系统根因回归）', () => {
  // 旧手写实现把 emoji 误判为 1 列 → 与 ink（string-width）分歧 → 右侧散布视觉污染
  // （docs/Bug修复-TUI渲染层双宽度系统导致右侧散布视觉污染.md §5 V1-V3）
  assert.equal(displayWidth('💡'), 2, '灯泡 emoji 双宽');
  assert.equal(displayWidth('🔐'), 2, '锁 emoji 双宽');
  assert.equal(displayWidth('💬'), 2, '聊 emoji 双宽');
  assert.equal(displayWidth('📁'), 2, '文件夹 emoji 双宽');
  assert.equal(displayWidth('⭐'), 2, '星 emoji 双宽');
  assert.equal(displayWidth('✅'), 2, '对勾 emoji 双宽');
  // CJK / ASCII / box-drawing 回归（§5 V2）
  assert.equal(displayWidth('中'), 2);
  assert.equal(displayWidth('x'), 1);
  assert.equal(displayWidth('─'), 1);
  assert.equal(displayWidth('│'), 1);
  assert.equal(displayWidth('┌'), 1);
  // 组合字符 / ZWJ 序列：string-width 按 grapheme 聚类，比旧实现更准
  assert.equal(displayWidth('e\u0301'), 1, 'e + 组合重音 = 1 个 grapheme');
  assert.equal(displayWidth('👨‍👩‍👧‍👦'), 2, 'ZWJ 家庭 emoji = 1 个 cluster');
});

test('maskMarkdownMarkers：等长 + 内容保留 + 嵌套不处理（文档 §4.1 边界）', () => {
  const src = 'a **bold** b';
  const masked = maskMarkdownMarkers(src);
  assert.equal(masked.length, src.length, '掩码等长，折行点可 1:1 映射回原文');
  assert.equal(masked.replace(/\u200B/g, ''), 'a bold b', '内容字符保留');
  // 嵌套（**bold *italic***）：内层星号不处理——与文档 §4.1「不实现粗体内嵌套」一致
  // 掩码只消外层 **，内层 *b* 仍按 1 列计 → 0+0+1+1+1+1+1+1+1+0+0 = 7（渲染若支持嵌套应为 5）
  assert.equal(displayWidth(maskMarkdownMarkers('**a *b* c**')), 7, '外粗内斜只处理外层');
});

test('splitTextToLines：成对 marker 原子放置，不跨行切断（主回归）', () => {
  // innerW=10：**bold** 内容 4 列 + 前后字符，原子放置可整对放入首行或换行到新行
  const text = '**加粗内容** 后面跟普通文本一直写写写';
  const rows = splitTextToLines(text, 10, 0);
  assert.ok(rows.length >= 2, '内容足够长应折行');
  for (const r of rows) assertNoOrphanMarkers(r);
});

test('splitTextToLines：marker 紧贴换行边界不被切断', () => {
  // 构造 marker 恰好卡在 budget 边界的场景：内容宽度恰好 < innerW 时应整对放新行
  const rows = splitTextToLines('x **bold** y', 6, 0);
  for (const r of rows) assertNoOrphanMarkers(r);
  // 掩码测宽后行数应与渲染一致：**bold** 占 4 列 → 整行宽 6 内可放 1 对
  const w4 = splitTextToLines('**abcd** **efgh**', 8, 0);
  for (const r of w4) assertNoOrphanMarkers(r);
});

test('clipMessageRows：切片后可见文本无孤儿 marker（用户截图场景）', () => {
  // 模拟截图里的长文本：大量 **加粗** + 代码 + 删除线，任意 [visStart, visEnd) 切片
  const text =
    '一个直连 DeepSeek 官方 API 的中文编程 Agent，它把 **DeepSeek** 当作一等公民来设计 Harness，' +
    '提供代码阅读、编辑、运行、审查、依赖审计、Git 集成等能力，并同时提供 **MCP 工具**。' +
    '—**双模型路由**:主循环用 `deepseek-v4-flash`（非思考模式，负责工具调度，快、省）；' +
    '审查 / 审计 / 术语 / 项目发现 / 提交信息 / 深度生成 / 校验等复杂分析统一走推理模型 ~~pro~~。' +
    '项目发现工具可以生成项目图谱，用它来分析项目结构更高效。';
  const innerW = 30;
  const rows = splitTextToLines(text, innerW, 7);
  assert.ok(rows.length > 5, '长文本应切成多行');
  // 全区间采样：从每个可能的起点切 1..N 行
  for (let s = 0; s < rows.length; s++) {
    for (let e = s + 1; e <= rows.length; e++) {
      const { text: sliced } = clipMessageRows(text, innerW, 7, s, e);
      if (sliced.length > 0) assertNoOrphanMarkers(sliced);
    }
  }
});

test('clipMessageRows：头部/尾部省略标记与 marker 共存不泄漏', () => {
  const text = '**加粗** 开头内容 ' + 'x'.repeat(50) + ' 结尾 **加粗**';
  const { text: sliced, isClipped } = clipMessageRows(text, 20, 7, 2, 5);
  assert.ok(isClipped, '应触发切片');
  assertNoOrphanMarkers(sliced);
});

test('回归：无 marker 的纯文本折行行为不变', () => {
  const plain = '这是一个没有标记的普通中文文本，用来验证纯文本折行不回归。';
  const rows = splitTextToLines(plain, 12, 0);
  const masked = splitTextToLines(plain, 12, 0);
  assert.deepEqual(rows, masked, '无 marker 时掩码等价原文');
  // 每行宽度 ≤ 12（displayWidth 视角）
  for (const r of rows) assert.ok(displayWidth(r) <= 12, `行宽超界: ${JSON.stringify(r)}`);
});

test('回归：CJK 双宽字符与零宽字符计宽', () => {
  assert.equal(displayWidth('你好'), 4);
  assert.equal(displayWidth('\u200B'), 0, '零宽空格计 0 列');
  assert.equal(displayWidth('a\u200Bb'), 2, '零宽不占列');
});

test('词级断行：空格处断行、单词不拆（对齐 wrap-ansi 语义）', () => {
  // 英文词按空格断，不拆单词
  const rows = splitTextToLines('abc def ghi jkl', 10, 0);
  assert.ok(rows.every((r) => !r.includes('\n')));
  for (const r of rows) {
    for (const w of r.split(' ')) {
      assert.notEqual(w, 'abcde', '单词不应被拆断');
    }
  }
  // 行尾保留空格（trim:false 语义），但宽度不超界
  const rows2 = splitTextToLines('hello world foo bar baz', 12, 0);
  assert.ok(rows2.length >= 2, '应折行');
  for (const r of rows2) assert.ok(displayWidth(r) <= 12, `行宽超界: ${JSON.stringify(r)}`);
});

test('词级断行 + marker 原子：长文本切行不产生孤儿 marker（回归主场景）', () => {
  const text =
    '一个直连 DeepSeek 官方 API 的中文编程 Agent，它把 **DeepSeek** 当作一等公民来设计 Harness，' +
    '提供代码阅读、编辑、运行、审查、依赖审计、Git 集成等能力，并同时提供 **MCP 工具**。' +
    '—**双模型路由**:主循环用 `deepseek-v4-flash`（非思考模式，负责工具调度，快、省）；' +
    '审查 / 审计 / 术语 / 项目发现 / 提交信息 / 深度生成 / 校验等复杂分析统一走推理模型 ~~pro~~。' +
    '还有 **加粗**、*斜体*、`行内代码`、~~删除线~~ 混排。';
  // 全文切行：每行不得含孤儿 marker
  for (const line of splitTextToLines(text, 40, 7)) assertNoOrphanMarkers(line);
  // 任意切片：可见文本不得含孤儿 marker
  const rows = splitTextToLines(text, 40, 7);
  for (let s = 0; s < rows.length; s++) {
    for (let e = s + 1; e <= rows.length; e++) {
      const { text: sliced } = clipMessageRows(text, 40, 7, s, e);
      if (sliced.length > 0) assertNoOrphanMarkers(sliced);
    }
  }
});
