/**
 * 行级切片工具：把一条消息的文本切成「显示行」，支持按行区间切片并加省略标记。
 *
 * 背景：M1-M4 的消息窗口模型只能整条消息切换（selectViewWindow），滚轮滚动是
 * 「跳 N 条整消息」→ 大段空白 + 截断怪异。优化 A 改为行级滚动：scrollOffset
 * 单位是「行」，本模块提供精确的行级切分，保证渲染行数严格 ≤ sliceArea。
 *
 * Markdown 感知（2026-08-27 修复）：行内标记（**bold** / *italic* / `code` /
 * ~~del~~）在渲染时符号本身不可见（占 0 列），但旧实现按 displayWidth 把它们
 * 当普通字符计宽 → ①估算宽度偏大 → 折行点错位、右边缘散布碎片；②wrap 切断
 * 配对 marker → 可见切片含孤儿 `**` → MarkdownMessage 把它当字面文本泄漏。
 * 修复：maskMarkdownMarkers 生成等长掩码（marker 符号→零宽 U+200B）测宽，
 * 且 splitTextToLines 把成对 marker 当「原子单元」整对放置，绝不在 pair 中间换行。
 *
 * 注意：displayWidth 统一委托 string-width（与 ink 渲染同源），不再手写宽度表。
 * 纯函数、无 React 依赖。
 */
import stringWidth from 'string-width';

/** 行内标记正则（与 Markdown.tsx renderInline 同源，仅取全匹配定位区间） */
const INLINE_MARK_RE = /(\*\*[\s\S]+?\*\*|\*[\s\S]+?\*|`[^`]+`|~~[\s\S]+?~~)/g;

/**
 * 终端显示宽度：委托 string-width（与 ink 的 wrap-ansi 同源），彻底消除「估算层 vs
 * 渲染层」双宽度系统分歧（docs/Bug修复-TUI渲染层双宽度系统导致右侧散布视觉污染.md）。
 *
 * 为什么不用手写宽度表：旧手写实现只覆盖 13 个 Unicode 区段，emoji（💡🔐💬📁 等
 * RGI emoji 双宽）、组合字符、ZWJ 序列都会与 ink 的实际渲染宽度不一致，导致
 * splitTextToLines 低估行数 → selectRowWindow 选错区间 → Box 不剪裁 → 右侧散布碎片。
 * string-width 走 Intl.Segmenter grapheme 聚类 + East_Asian_Width + RGI emoji 判定，
 * 与终端渲染一致；零宽字符（U+200B 等）天然计 0 列，marker 掩码语义不破。
 */
export function displayWidth(s: string): number {
  return stringWidth(s);
}

/**
 * 生成与原文等长的「掩码文本」：行内标记的符号部分（**、*、`、~~ 两端的成对符号）
 * 替换为零宽空格 U+200B，内容字符原样保留。
 * - 长度与原文逐字符一致 → 可把掩码上的折行点 1:1 映射回原文；
 * - displayWidth(掩码) == 该段渲染后的真实宽度（marker 占 0 列、内容按实际宽度）。
 * 嵌套 marker（如 `**bold *italic* bold**` 内层星号）不处理——与文档 §4.1 一致。
 */
export function maskMarkdownMarkers(text: string): string {
  const chars = Array.from(text);
  const masked = [...chars];
  const re = new RegExp(INLINE_MARK_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const full = m[0];
    const openLen = full.startsWith('**') || full.startsWith('~~') ? 2 : 1;
    const closeLen = full.endsWith('**') || full.endsWith('~~') ? 2 : 1;
    const startCp = Array.from(text.slice(0, m.index)).length;
    const fullCp = Array.from(full);
    for (let i = 0; i < openLen; i++) masked[startCp + i] = '\u200B';
    for (let i = 0; i < closeLen; i++) masked[startCp + fullCp.length - 1 - i] = '\u200B';
  }
  return masked.join('');
}

/** 定位文本中所有成对 marker 的码点区间 [startCp, endCp)，供原子放置使用 */
function markerPairRanges(text: string): Map<number, [number, number]> {
  const ranges = new Map<number, [number, number]>();
  const re = new RegExp(INLINE_MARK_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const startCp = Array.from(text.slice(0, m.index)).length;
    const endCp = startCp + Array.from(m[0]).length;
    ranges.set(startCp, [startCp, endCp]);
  }
  return ranges;
}

/**
 * 把一条消息的文本按显示宽度折行成行数组（不含前缀）。
 *
 * 折行语义精确对齐 ink 的 <Text wrap="wrap">（其底层是 wrap-ansi，参数
 * trim:false + hard:true，2026-08-27 读 node_modules/wrap-ansi/index.js 实证）：
 * - 按空格分词；词间空格由算法补（每个词前自动加 1 空格，行尾保留——
 *   trim:false 不裁剪行尾空格）；
 * - 词放不下当前行剩余宽度 → 整词换到新行（新行不以空格开头）；
 * - 当前行宽 ≥ innerW（行满）→ 换行，空格去新行行首（` 的连续文本` 场景）；
 * - 超长词（宽 > innerW）→ wrapWord 强制换行 + 按字符硬拆（与
 *   wrap-ansi 的 breaksStartingThisLine/NextLine 判断一致）；
 * - 前缀占位：前缀只在整条消息第一个 block 前出现且与首行内容共享首行
 *   宽度，模型上「首行 w 从 prefixW 起计」；首行内容放不进剩余宽度时前缀
 *   独占一行（空行表示，渲染层补前缀），避免少算 1 行（低估 → 底部溢出）。
 * - Markdown 原子 pair：**x** / *x* / `x` / ~~x~~ 作为「一个词」整对放置，
 *   绝不在 pair 中间切断（否则可见切片含孤儿 `**` 泄漏，见文档
 *   Bug修复-Markdown标记被切片切断后泄漏为可见字符.md）。pair 内部空格不拆
 *   （与 wrap-ansi 会拆不同——文档 §6 已知边界，防泄漏优先）。
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
    const chars = Array.from(para);
    const masked = Array.from(maskMarkdownMarkers(para)); // 与 chars 等长
    const pairRanges = markerPairRanges(para);

    // 分词：与 wrap-ansi 的 string.split(' ') 语义完全一致（连续空格 → 空串词），
    // 但原子 pair 作为整体词（内部空格不拆）。
    // 实现：把 para 中的 pair 替换为「零宽占位符」再 split(' ')，占位符计数还原。
    // 更简单可靠的方案：逐字符切分，空格切段（空串保留），pair 合并进当前段。
    const segments: string[] = [];
    let curSeg = '';
    for (let k = 0; k < chars.length; ) {
      const pair = pairRanges.get(k);
      if (pair) {
        const [s, e] = pair;
        curSeg += chars.slice(s, e).join('');
        k = e;
      } else if (chars[k] === ' ') {
        segments.push(curSeg);
        curSeg = '';
        k++;
      } else {
        curSeg += chars[k];
        k++;
      }
    }
    segments.push(curSeg);
    // 每段渲染宽度：masked 测宽（marker 符号 0 列、内容正常）——逐字符精确映射
    const words: { text: string; width: number }[] = [];
    let segPtr = 0;
    let segOffset = 0; // 当前段在 chars 中的起始游标
    for (const seg of segments) {
      let width = 0;
      const segChars = Array.from(seg);
      let charPtr = segOffset;
      for (let c = 0; c < segChars.length; c++) {
        // 跳过占位（空格已切段，这里段内无空格；可能有 pair 占位）
        width += displayWidth(masked[charPtr] ?? ' ');
        charPtr++;
      }
      words.push({ text: seg, width });
      // 推进 segOffset：当前段长度 + 其后的 1 个空格（若有）
      segOffset += segChars.length + (segPtr < segments.length - 1 ? 1 : 0);
      segPtr++;
    }

    // wrap-ansi 折行主循环（trim:false → 行尾空格保留、行满换行、词间空格恒补）
    let cur = ''; // 当前行（原始字符，marker 保留）
    let w = idx === 0 ? prefixW : 0; // 首行前缀占位
    const pushRow = () => {
      rows.push(cur);
      cur = '';
      w = 0;
    };
    for (let wi = 0; wi < words.length; wi++) {
      const word = words[wi];
      // 词间空格（含空串词）：行满 → 换行，空格去新行行首；否则补到当前行尾
      if (wi > 0) {
        if (w >= innerW) pushRow(); // 行满 → 新行
        cur += ' ';
        w += 1;
      }
      // 超长词（宽 > innerW）→ wrapWord：强制整词换行 + 按字符硬拆
      if (word.width > innerW) {
        const remainingColumns = innerW - w;
        const breaksThis = 1 + Math.floor((word.width - remainingColumns - 1) / innerW);
        const breaksNext = Math.floor((word.width - 1) / innerW);
        if (breaksNext < breaksThis) pushRow(); // 整词换行更省行 → 前缀独占行场景
        // 按字符逐个放（wrapWord 语义），但 marker pair 保持原子（整对放置，
        // 防孤儿 `**` 泄漏——超长词里嵌套的短 pair 也不可拆）
        const wChars = Array.from(word.text);
        const wMasked = Array.from(maskMarkdownMarkers(word.text));
        const wPairs = markerPairRanges(word.text);
        let k = 0;
        while (k < wChars.length) {
          const pair = wPairs.get(k);
          if (pair) {
            const [ps, pe] = pair;
            let pw = 0;
            for (let t = ps; t < pe; t++) pw += displayWidth(wMasked[t]);
            if (pw > innerW) {
              // pair 本身超一整行（罕见）→ 逐字符（允许拆 marker，文档 §6 边界）
              const cw = displayWidth(wMasked[k]);
              if (w + cw > innerW) pushRow();
              cur += wChars[k];
              w += cw;
              k++;
              continue;
            }
            if (w + pw > innerW) pushRow(); // pair 放不下当前行剩余 → 整对换行
            cur += wChars.slice(ps, pe).join('');
            w += pw;
            k = pe;
            continue;
          }
          const cw = displayWidth(wMasked[k]);
          if (w + cw > innerW) pushRow();
          cur += wChars[k];
          w += cw;
          k++;
        }
        continue;
      }
      // 普通词/pair：放不下当前行剩余宽度 → 整词换新行
      if (w + word.width > innerW && w > 0) pushRow();
      cur += word.text;
      w += word.width;
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
