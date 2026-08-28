import stringWidth from 'string-width';

// UI 自绘字符的 EAW（East Asian Width）判定——Windows 中文 conhost 对 Ambiguous(A)
// 字符按 2 列渲染，而 string-width 默认按 1 列（ambiguousIsNarrow: true）
const chars = [
  ['█', 'Scrollbar thumb / WhaleMascot', 'U+2588'],
  ['╍', 'InputBar 虚线', 'U+254D'],
  ['─', 'ink 边框 single 横线', 'U+2500'],
  ['│', 'ink 边框 single 竖线', 'U+2502'],
  ['┌', 'ink 边框 single 左上', 'U+250C'],
  ['┐', 'ink 边框 single 右上', 'U+2510'],
  ['└', 'ink 边框 single 左下', 'U+2514'],
  ['┘', 'ink 边框 single 右下', 'U+2518'],
  ['⠋', 'ThinkingIndicator spinner', 'U+280B'],
  ['•', 'Markdown 列表前缀', 'U+2022'],
  ['…', '省略标记', 'U+2026'],
  ['·', '分隔点', 'U+00B7'],
  ['—', 'em dash', 'U+2014'],
  ['-', 'ASCII 横线', 'U+002D'],
  ['🛡', '锁 emoji 备选', 'U+1F6E1'],
];

for (const [ch, label, cp] of chars) {
  const w = stringWidth(ch);
  // East Asian Width 类别查询（简化：Ambiguous 范围标注）
  const c = ch.codePointAt(0) ?? 0;
  const isAmbiguous =
    (c >= 0x2500 && c <= 0x257f) || // box drawing
    (c >= 0x2580 && c <= 0x259f) || // block elements
    c === 0x00b7 || c === 0x2014 || c === 0x2022 || c === 0x2026 || c === 0x203a;
  console.log(
    cp.padEnd(8),
    '|',
    String(w).padStart(2),
    '列 |',
    (isAmbiguous ? '[EAW=Ambiguous]' : '            ').padEnd(16),
    '|',
    label,
  );
}
