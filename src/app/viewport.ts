/**
 * 视口工具：估算消息在终端中的显示行数，供聊天区切片渲染、滚动与滚动条使用。
 * 纯函数、无 React 依赖，CLI 视图层与控制器共用。
 */
import type { UiMessage } from './types.ts';

/** 终端显示宽度（CJK 等双宽字符按 2 列计，近似 east-asian-width） */
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
 * 估算一条消息占用的终端行数：
 * - 按换行分段，每段按「显示宽度 / 内部列宽」向上取整（保守，防 wrap 换行漏算）；
 * - prefixW 为消息前缀（如 "你> "、"Agent> "）的显示宽度，仅首行计入；
 * - 末了 +1 行作为消息间距，避免消息间视觉粘连。
 */
export function estimateLines(text: string, innerW: number, prefixW = 0): number {
  if (innerW <= 0) innerW = 1;
  const parts = text.split('\n');
  let n = 0;
  parts.forEach((ln, idx) => {
    const w = displayWidth(ln) + (idx === 0 ? prefixW : 0);
    n += Math.max(1, Math.ceil(w / innerW));
  });
  return n + 1;
}

/**
 * 非聊天区固定行数估算（供计算消息区可用高度）：
 * - Banner 左列：标题 1 + 欢迎 1 + 鲸鱼 8 + 模型 1 + /model 1 + cwd 1 = 13，+ 上下边框 2 = 15
 *   （右列 7 + 2 = 9，取 max = 15）
 * - InputBar：上虚线 1 + 输入行 1 + 下虚线 1 + 提示行 1 = 4
 * - SAFETY：估算余量，防窄终端 wrap 把 Banner 撑高后内容溢出破坏边框
 */
export const BANNER_ROWS = 15;
export const INPUT_ROWS = 4;
export const SAFETY_ROWS = 2;

/** 消息区（圆角边框盒内部）可用行数；sliceArea 会在上层再扣掉指示器/思考行 */
export function computeAreaHeight(rows: number): number {
  return Math.max(3, rows - BANNER_ROWS - INPUT_ROWS - SAFETY_ROWS);
}

/** 消息前缀的显示宽度（按角色/阶段） */
export function prefixWidthOf(role: string, phase?: string): number {
  if (role === 'user') return 4; // "你> "
  if (role === 'assistant') return phase === 'progress' ? 3 : 7; // "⋯ " / "Agent> "
  return 0;
}

/**
 * 把文本按显示宽度折行成行；若行数超过 maxLines，保留尾部 maxLines 行并加省略标记。
 * ink 不会裁剪父容器溢出的子内容，单条消息超高时必须用本函数截断，否则会冲破边框。
 */
export function clipTextToLines(
  text: string,
  maxLines: number,
  innerW: number,
): { text: string; truncated: boolean } {
  if (innerW <= 0) innerW = 1;
  const rows: string[] = [];
  for (const para of text.split('\n')) {
    let cur = '';
    let w = 0;
    for (const ch of para) {
      const cw = displayWidth(ch);
      if (w + cw > innerW) {
        rows.push(cur);
        cur = ch;
        w = cw;
      } else {
        cur += ch;
        w += cw;
      }
    }
    rows.push(cur);
  }
  if (rows.length <= maxLines) return { text, truncated: false };
  const kept = rows.slice(rows.length - maxLines);
  kept[0] = '…(上文省略) ' + kept[0];
  return { text: kept.join('\n'), truncated: true };
}

export interface ViewWindowItem {
  msg: UiMessage;
  text: string;
  height: number;
  isClipped: boolean;
}

export interface ViewWindow {
  /** 视口内实际渲染的消息（旧→新顺序） */
  rendered: ViewWindowItem[];
  /** 视口上方被隐藏的估高行数 */
  linesAbove: number;
  /** 视口下方被隐藏的估高行数（上翻查看历史时 >0） */
  linesBelow: number;
}

/**
 * 尾窗选择：从「最新可见消息」往前贪心累积，总估高 ≤ sliceArea。
 * - 单条消息超高（唯一可见消息放不下）→ 截断其文本保留尾部 sliceArea 行；
 * - 其余情况：从 from 开始全部完整渲染，保证不会溢出边框（估算偏大 + 保守选择）。
 */
export function selectViewWindow(
  items: { msg: UiMessage; height: number }[],
  sliceArea: number,
  hiddenFromEnd: number,
  innerW: number,
): ViewWindow {
  if (items.length === 0) return { rendered: [], linesAbove: 0, linesBelow: 0 };
  const end = Math.max(0, items.length - 1 - hiddenFromEnd);

  let acc = 0;
  let from = end;
  for (let i = end; i >= 0; i--) {
    if (acc + items[i].height <= sliceArea || i === end) {
      from = i;
      acc += items[i].height;
    } else {
      break;
    }
  }

  let linesAbove = 0;
  for (let i = 0; i < from; i++) linesAbove += items[i].height;
  let linesBelow = 0;
  for (let i = end + 1; i < items.length; i++) linesBelow += items[i].height;

  // 单条超高：唯一可见消息放不下 → 截断保留尾部
  if (acc > sliceArea && from === end) {
    const clip = clipTextToLines(items[end].msg.text, sliceArea, innerW);
    return {
      rendered: [{ msg: items[end].msg, text: clip.text, height: sliceArea, isClipped: true }],
      linesAbove,
      linesBelow,
    };
  }

  const rendered: ViewWindowItem[] = [];
  for (let i = from; i <= end; i++) {
    rendered.push({ msg: items[i].msg, text: items[i].msg.text, height: items[i].height, isClipped: false });
  }
  return { rendered, linesAbove, linesBelow };
}
