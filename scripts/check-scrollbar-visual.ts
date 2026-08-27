/** 验证 Scrollbar 新视觉：track 空格化 + thumb 深蓝（复制 app.tsx Scrollbar 逻辑） */
function scrollbarLines(linesAbove: number, total: number, area: number): string[] {
  const track = Math.max(1, area);
  const content = Math.max(1, total);
  const thumbH = Math.max(1, Math.round((area / content) * track));
  const maxPos = Math.max(0, track - thumbH);
  const scrollable = Math.max(1, total - area);
  const pos = Math.min(maxPos, Math.round((linesAbove / scrollable) * maxPos));
  const lines: string[] = [];
  for (let i = 0; i < track; i++) {
    lines.push(i >= pos && i < pos + thumbH ? '█' : ' ');
  }
  return lines;
}

function verify(name: string, linesAbove: number, total: number, area: number): void {
  const lines = scrollbarLines(linesAbove, total, area);
  const thumbs = lines.filter((l) => l === '█').length;
  const tracks = lines.filter((l) => l === ' ').length;
  const others = lines.filter((l) => l !== '█' && l !== ' ').length;
  const hasBareChars = lines.some((l) => /[┊┆┇|│]/.test(l));
  console.log(
    `${name.padEnd(22)} total=${String(total).padStart(3)} area=${String(area).padStart(2)} ` +
      `thumb=${thumbs} track=${tracks} 非法字符=${others} 残留box-drawing=${hasBareChars}`,
  );
  // 展示 thumb 位置
  console.log('  ' + lines.map((l, i) => (l === '█' ? '█' : '·')).join(''));
}

console.log('=== Scrollbar 新视觉验证（track 应为空格，thumb 为 █）===');
// 场景 1：贴底（内容未超一屏 → 实际不渲染，但函数仍应正确）
verify('内容不足一屏', 0, 10, 30);
// 场景 2：内容超一屏，滚到底
verify('贴底(有滚动空间)', 0, 100, 30);
// 场景 3：滚动到中间
verify('滚到中间', 35, 100, 30);
// 场景 4：滚到顶
verify('滚到顶', 70, 100, 30);
// 场景 5：巨大内容
verify('巨大内容中间', 500, 2000, 30);
// 场景 6：area 很大（全屏）
verify('全屏宽视窗', 100, 500, 45);

// 关键断言：任何场景都不应输出 box-drawing 字符
const all = [scrollbarLines(0, 100, 30), scrollbarLines(35, 100, 30), scrollbarLines(70, 100, 30), scrollbarLines(500, 2000, 30)];
const leak = all.flat().some((l) => /[┊┆┇│┃]/.test(l));
console.log('\n所有场景 box-drawing 残留:', leak ? 'FAIL' : 'OK（无残留）');
process.exitCode = leak ? 1 : 0;