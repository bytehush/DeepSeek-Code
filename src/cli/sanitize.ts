/**
 * box-drawing / block element 字符 → ASCII 等宽映射
 * （文档 Bug修复-长工具调用时右侧散布box-drawing视觉污染.md §4 方案 3）。
 *
 * 问题：agent 工具原始输出（tree / git log --graph / npm ls / 自定义 ASCII
 * 树形图）生来就用 box-drawing（U+2500-257F）与 block element（U+2580-259F）
 * 绘制。这些字符在 TUI 渲染层没有「UI 装饰 vs 内容瑕疵」的视觉隔离——
 * 用户 3 轮反馈都是同一形态：右侧散布蓝色短划/竖线，误当内容渲染瑕疵。
 *
 * 方案：1:1 映射为 ASCII 等宽字符，**宽度不变**（每个 box-drawing 字符
 * 显示宽度 = 1 列 → 映射为 1 个 ASCII 字符 = 1 列）——折行点 / 行宽估算
 * 完全不受影响（displayWidth 无需改）。
 *
 * 映射原则：
 *   - 横线类（─ ━ ═ 等）→ '-'（U+2500 / 2501 / 2504-2505 / 2508-2509 /
 *     254C-254D / 2550 / 2574 / 2576 / 2578 / 257A / 257E）
 *   - 竖线类（│ ┃ ║ 等）→ '|'（U+2502-2503 / 2506-2507 / 250A-250B /
 *     254E-254F / 2551 / 2575 / 2577 / 2579 / 257B）
 *   - 转角 / 交叉 / T 字形（┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼ ╬ ╭ ╮ ╯ ╰ 等）→ '+'
 *   - 斜线 ╱ → '/', ╲ → '\', ╳ → 'x'
 *   - block：█ 系 → '#', ░▒ → ':', ▀▁▂▃▄▅▆▇▔ → '-', ▕ → '|',
 *     ▖▗▘▙▚▛▜▝▞▟ → '+'
 *
 * 注意：Scrollbar thumb 用 '█'（U+2588）作为组件字面量，不经过本函数
 * （sanitize 只应用于「消息文本」，组件自绘字符不受影响）。
 */

/** 横线语义字符集（→ '-'） */
const H_LINE = new Set([
  0x2500, 0x2501, 0x2504, 0x2505, 0x2508, 0x2509, 0x254c, 0x254d, 0x2550,
  0x2574, 0x2576, 0x2578, 0x257a, 0x257e,
]);

/** 竖线语义字符集（→ '|'） */
const V_LINE = new Set([
  0x2502, 0x2503, 0x2506, 0x2507, 0x250a, 0x250b, 0x254e, 0x254f, 0x2551,
  0x2575, 0x2577, 0x2579, 0x257b,
]);

/** 斜线/叉号（→ 各自 ASCII） */
const DIAG: Record<number, string> = { 0x2571: '/', 0x2572: '\\', 0x2573: 'x' };

/** box-drawing（U+2500-257F）→ ASCII */
const BOX_TO_ASCII = new Map<number, string>();
for (let cp = 0x2500; cp <= 0x257f; cp++) {
  if (DIAG[cp]) BOX_TO_ASCII.set(cp, DIAG[cp]);
  else if (H_LINE.has(cp)) BOX_TO_ASCII.set(cp, '-');
  else if (V_LINE.has(cp)) BOX_TO_ASCII.set(cp, '|');
  else BOX_TO_ASCII.set(cp, '+');
}

/** block element（U+2580-259F）→ ASCII */
for (let cp = 0x2580; cp <= 0x259f; cp++) {
  if (cp >= 0x2580 && cp <= 0x2587) BOX_TO_ASCII.set(cp, '-'); // ▀▁▂▃▄▅▆▇
  else if (cp >= 0x2588 && cp <= 0x258f) BOX_TO_ASCII.set(cp, '#'); // █▉▊▋▌▍▎▏
  else if (cp === 0x2590) BOX_TO_ASCII.set(cp, '#'); // ▐
  else if (cp >= 0x2591 && cp <= 0x2592) BOX_TO_ASCII.set(cp, ':'); // ░▒
  else if (cp === 0x2593) BOX_TO_ASCII.set(cp, '#'); // ▓
  else if (cp === 0x2594) BOX_TO_ASCII.set(cp, '-'); // ▔
  else if (cp === 0x2595) BOX_TO_ASCII.set(cp, '|'); // ▕
  else BOX_TO_ASCII.set(cp, '+'); // ▖▗▘▙▚▛▜▝▞▟
}

/** 字符串是否含 box-drawing / block element 字符（快速路径短路） */
export function containsBoxDrawing(s: string): boolean {
  return /[\u2500-\u257F\u2580-\u259F]/.test(s);
}

/**
 * 把字符串里所有 box-drawing / block element 字符映射为 ASCII 等宽字符。
 * 不含相关字符时原样返回（零拷贝）；含时逐 code point 映射。
 */
export function sanitizeBoxDrawing(s: string): string {
  if (!containsBoxDrawing(s)) return s;
  const out: string[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    out.push(BOX_TO_ASCII.get(cp) ?? ch);
  }
  return out.join('');
}
