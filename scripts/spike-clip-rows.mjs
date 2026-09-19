// 重现"长工具调用"产生的散布短划：模拟工具结果输出 + clipMessageRows 处理
// 输出 splitTextToLines 行数、box-drawing 字符检测、各滚动位置的切片结果
import { splitTextToLines, clipMessageRows, displayWidth } from '../src/app/markdown-lines.ts';

// 模拟 agent 工具调用的 13 行文件名（不含路径前缀，正是截图里所见）
const toolOutput = [
  '728c1b.mjs', '8f1a1b.mjs', '42c6fb.mjs', 'e7e4f3.mjs',
  'dbb014.mjs', '3dfc19.mjs', 'f898d4.mjs', 'e4ac63.mjs',
  'ed16cc.mjs', 'e77d87.mjs', '294ab9.mjs', 'cb7201.mjs',
].join('\n');

// 前置一段"长上下文"（模拟 agent 实际工具返回 270 行）
const prefixes = [];
for (let i = 1; i <= 270; i++) {
  prefixes.push('pref line ' + i + ' ' + 'x'.repeat(60));
}
const fullText = prefixes.join('\n') + '\n' + toolOutput;

const innerW = 80;
const prefixW = 7;  // "Agent> "
const rows = splitTextToLines(fullText, innerW, prefixW);
console.log('[diag] innerW=80 total rows =', rows.length);
console.log('[diag] tool output starts at row =', splitTextToLines(prefixes.join('\n'), innerW, prefixW).length);

// box-drawing 检测
let boxCount = 0;
const samples = [];
rows.forEach((r, i) => {
  const m = r.match(/[\u2500-\u257F\u2580-\u259F]/g);
  if (m) {
    boxCount += m.length;
    if (samples.length < 5) samples.push({ row: i, chars: m.map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase()).join(',') });
  }
});
console.log('[diag] box-drawing chars in rows count =', boxCount);
if (samples.length) console.log('[diag] samples:', samples);

// 模拟 scrollOffset = 216 行（截图 1）：视口装 24 行，最后可见行 = totalRows-216 = rows.length - 216
const sliceArea = 24;
const totalRows = rows.length;

for (const [name, linesAbove] of [['shot1', 216], ['shot2', 0], ['shot3', 33]]) {
  const hidden = Math.min(Math.max(0, linesAbove), Math.max(0, totalRows - sliceArea));
  const endRow = totalRows - hidden;
  const startRow = Math.max(0, endRow - sliceArea);
  console.log('\n=====', name, 'linesAbove=', linesAbove, 'startRow=', startRow, 'endRow=', endRow, '=====');
  // 用 selectRowWindow 同样的 visStart/visEnd
  const clip = clipMessageRows(fullText, innerW, prefixW, startRow, endRow);
  console.log('[diag] clip.isClipped=', clip.isClipped, 'text head=', JSON.stringify(clip.text.slice(0, 200)));
  console.log('[diag] clip text row count =', clip.text.split('\n').length);
  // box-drawing 在 clip 里
  const cm = clip.text.match(/[\u2500-\u257F\u2580-\u259F]/g);
  console.log('[diag] clip box chars count =', cm ? cm.length : 0, cm ? 'codes=' + cm.map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase()).slice(0, 5).join(',') : '');
}
