// 端到端验证：模拟「长工具调用」完整链路（docs/Bug修复-长工具调用时右侧散布box-drawing视觉污染.md）
// 工具结果（tree / git log --graph 形态含 box-drawing）→ splitTextToLines 估行
// → clipMessageRows 切片 → sanitizeBoxDrawing 渲染层映射
// 断言：渲染后 0 box-drawing + 行数估算与渲染一致（1:1 映射不偏移折行点）
import { splitTextToLines, clipMessageRows } from '../src/app/markdown-lines.ts';
import { sanitizeBoxDrawing, containsBoxDrawing } from '../src/cli/sanitize.ts';

const treeOutput = [
  'src',
  '├── cli',
  '│   ├── app.tsx',
  '│   ├── Markdown.tsx',
  '│   └── main.ts',
  '├── app',
  '│   ├── viewport.ts',
  '│   └── types.ts',
  '└── agent',
  '    └── loop.ts',
].join('\n');

const graphOutput = [
  '* 728c1b.mjs (HEAD -> master)',
  '*   merge branch',
  '|\\',
  '| * 8f1a1b.mjs',
  '* | 42c6fb.mjs',
  '|/',
  '* e7e4f3.mjs',
].join('\n');

// 模拟 agent 的 270 行工具上下文 + tree + graph
const prefix = Array.from({ length: 270 }, (_, i) => `pref-line ${i + 1} ${'x'.repeat(60)}`).join('\n');
const fullText = prefix + '\n' + treeOutput + '\n' + graphOutput;

const innerW = 80;
const prefixW = 7;
const rows = splitTextToLines(fullText, innerW, prefixW);

console.log('[e2e] total rows =', rows.length);
console.log('[e2e] box-drawing in raw clip rows =', rows.filter((r) => containsBoxDrawing(r)).length);

// 3 个滚动位置切片 + sanitize（pos 越界时 clamp 到有效范围）
let fail = 0;
for (const pos of [216, 291, 33]) {
  const start = Math.max(0, Math.min(pos, rows.length - 24));
  const end = Math.min(rows.length, start + 24);
  const { text: clipped, isClipped } = clipMessageRows(fullText, innerW, prefixW, start, end);
  const safe = sanitizeBoxDrawing(clipped);
  const boxLeft = containsBoxDrawing(safe);
  const renderedLines = safe.split('\n').length;
  const expectedLines = end - start;
  console.log(
    `[e2e] pos=${pos} isClipped=${isClipped} clip-lines=${expectedLines}` +
    ` sanitized-box=${boxLeft ? 'REMAIN!' : 0} rendered-lines=${renderedLines}` +
    (boxLeft || renderedLines !== expectedLines ? '  <-- FAIL' : '  ok'),
  );
  if (boxLeft || renderedLines !== expectedLines) fail++;
}

// 单独验证 MarkdownMessage 代码块边框 ASCII 化（方案 2 的 flushCode 等价物）
const codeBlockRaw = ['```ts', 'const a = 1;', '┌─ nested box ─┐', '```'].join('\n');
const codeBlockSafe = sanitizeBoxDrawing(codeBlockRaw);
console.log('[e2e] code-block sanitized box-drawing =', containsBoxDrawing(codeBlockSafe) ? 'REMAIN!' : 0);
if (containsBoxDrawing(codeBlockSafe)) fail++;

console.log(fail === 0 ? '\n[e2e] ALL PASS' : `\n[e2e] ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
