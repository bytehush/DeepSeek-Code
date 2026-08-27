/**
 * 行级切片工具：把一条消息的文本切成「显示行」，支持按行区间切片并加省略标记。
 *
 * 背景：M1-M4 的消息窗口模型只能整条消息切换（selectViewWindow），滚轮滚动是
 * 「跳 N 条整消息」→ 大段空白 + 截断怪异。优化 A 改为行级滚动：scrollOffset
 * 单位是「行」，本模块提供精确的行级切分，保证渲染行数严格 ≤ sliceArea。
 *
 * 注意：displayWidth 与 viewport.ts 保持同步（避免循环依赖，此处自带实现）。
 * 纯函数、无 React 依赖。
 */

/** 终端显示宽度（CJK 等双宽字符按 2 列计，与 viewport.ts displayWidth 同源） */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      (c >= 0x1100 && c <= 0x115f) || // Hangul Jamo
      (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) || // CJK 部首/符号/文字
      (c >= 0xac00 && c <= 0xd7a3) || // Hangul 音节
      (c >= 0xf900 && c <= 0xfaff) || // CJK 兼容
      (c >= 0xfe10 && c <= 0xfe6f) || // 竖排/兼容形式
      (c >= 0xff00 && c <= 0xff60) || // 全角
      (c >= 0xffe0 && c <= 0xffe6); // 全角符号
    w += wide ? 2 : 1;
  }
  return w;
}

/**
 * 把一条消息的文本按显示宽度折行成行数组（不含前缀）。
 *
 * 渲染语义：ink 的 <Text wrap="wrap"> 把「前缀 + 文本」整体按容器宽度折行，
 * 前缀只占首行宽度。因此：
 * - 首段（text 的第 1 段）实际可用宽度 = innerW - prefixW（前缀占掉的部分）
 * - 首段折行后的后续行 + 其余段落均按 innerW 折行
 *
 * 返回的行数与渲染行数精确一致（不含任何 +1 保险），供行级切片精确消费。
 */
export function splitTextToLines(text: string, innerW: number, prefixW = 0): string[] {
  if (innerW <= 0) innerW = 1;
  const rows: string[] = [];
  const parts = text.split('\n');
  parts.forEach((para, idx) => {
    if (para.length === 0) {
      rows.push('');
      return;
    }
    // 首段首行可用宽度扣除前缀占位；其余段落按 innerW
    const firstLineBudget = idx === 0 ? Math.max(1, innerW - prefixW) : innerW;
    let cur = '';
    let w = 0;
    let budget = firstLineBudget;
    for (const ch of para) {
      const cw = displayWidth(ch);
      if (w + cw > budget) {
        rows.push(cur);
        cur = ch;
        w = cw;
        budget = innerW; // 换行后恢复全宽
      } else {
        cur += ch;
        w += cw;
      }
    }
    rows.push(cur);
  });
  return rows;
}

/**
 * 省略标记按可用宽度压缩：标记行渲染时可能带前缀（首行 headMark 会被加
 * "Agent> "/"你> " 等前缀），若超出预算会折行成 2 行 → 实际渲染行数比声明
 * 多 1 → 溢出。因此标记必须保证「前缀 + 标记」单行放得下。
 * 压缩策略：…(省略前 N 行) → …(略N) → …N
 */
function fitMark(mark: string, budget: number): string {
  if (displayWidth(mark) <= budget) return mark;
  const n = mark.match(/\d+/)?.[0] ?? '';
  const short = `…(略${n})`;
  if (displayWidth(short) <= budget) return short;
  return `…${n}`;
}

/**
 * 按行区间切片消息文本，加省略标记（标记替换可见区间首/末行，不额外占行）：
 * - 仅裁头部：`…(省略前 N 行)` + 可见行（头部标记替换第一行）
 * - 仅裁尾部：可见行 + `…(省略后 M 行)`（尾部标记替换最后一行）
 * - 头尾都裁：标记 + 中间可见行 + 标记
 * - 未裁：原样返回
 *
 * 保证：返回文本的渲染行数 == (visEnd - visStart) 行，精确不溢出。
 * 标记文本按「前缀预算」压缩（headMark 首行带前缀 → 预算 innerW-prefixW；
 * tailMark 中间行无前缀 → 预算 innerW），避免折行。
 */
export function clipMessageRows(
  text: string,
  innerW: number,
  prefixW: number,
  visStart: number,
  visEnd: number,
): { text: string; isClipped: boolean } {
  const rows = splitTextToLines(text, innerW, prefixW);
  if (visStart <= 0 && visEnd >= rows.length) return { text, isClipped: false };
  const total = rows.length;
  const keepStart = Math.max(0, Math.min(visStart, total));
  const keepEnd = Math.max(keepStart, Math.min(visEnd, total));
  const visible = rows.slice(keepStart, keepEnd);
  if (visible.length === 0) return { text: '', isClipped: true };

  const headBudget = Math.max(1, innerW - prefixW); // 首行带前缀
  const tailBudget = Math.max(1, innerW); // 中间/末尾行无前缀
  const headMark = keepStart > 0 ? fitMark(`…(省略前 ${keepStart} 行)`, headBudget) : null;
  const tailMark = keepEnd < total ? fitMark(`…(省略后 ${total - keepEnd} 行)`, tailBudget) : null;

  // 标记替换首/末行：head 占第 0 行，tail 占最后一行；若同时存在且只够 1 行，合并
  if (headMark && tailMark) {
    if (visible.length === 1) {
      // 合并行位于首行，也按前缀预算压缩
      const merged = fitMark(`${headMark} ${tailMark}`, headBudget);
      return { text: merged, isClipped: true };
    }
    visible[0] = headMark;
    visible[visible.length - 1] = tailMark;
    return { text: visible.join('\n'), isClipped: true };
  }
  if (headMark) {
    visible[0] = headMark;
    return { text: visible.join('\n'), isClipped: true };
  }
  if (tailMark) {
    visible[visible.length - 1] = tailMark;
    return { text: visible.join('\n'), isClipped: true };
  }
  return { text: visible.join('\n'), isClipped: true };
}
