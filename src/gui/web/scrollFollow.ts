/**
 * ScrollFollowController —— 把「流式渲染时是否自动贴底跟随」的决策从 React effect 中抽出，
 * 做成无 DOM 依赖的纯逻辑，便于单测覆盖「用户拖拽 / 上滑接管」场景。
 *
 * ── 背景 bug（修复前）─────────────────────────────────────────────────────────
 * 原实现里，流式 rAF 跟随循环依赖 [state.busy, outputting]；流式期间这两个值一旦抖动触发
 * effect 重跑，就会重新执行 `followRef = pinnedRef`，把用户刚上滑接管的 follow 重新打开
 * → 下一帧 rAF 又把 scrollTop 钉回底部，表现为「拖上去松手又弹回底」。
 * 此外 onUserIntent 只听 wheel/pointerdown/touchmove，拖原生滚动条滑块不派发这些事件，
 * 纯靠它会在滑块拖拽场景漏判用户意图。
 *
 * ── 修复要点 ──────────────────────────────────────────────────────────────────
 *  1) 仅在「新一轮流式开始」（非活跃 → 活跃跳变）时按是否贴底初始化 follow；
 *     流式中途依赖抖动（活跃 → 活跃）不重设，避免覆盖用户已接管的状态。
 *  2) 用户意图用「滚动方向」判定（scrollTop 减小 = 上滑接管），而非仅依赖 wheel/pointerdown，
 *     拖原生滚动条滑块、键盘 PageUp 等不派发 wheel/pointerdown 的操作也能正确停跟随。
 *  3) 回到贴底后恢复跟随（标准「回到底部继续跟随」语义）。
 */
export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export class ScrollFollowController {
  private follow = true; // 是否自动跟随（用户上滑接管 → false）
  private pinned = true; // 是否贴底（距底 < threshold）
  private lastScrollTop = 0; // 上一次 scrollTop，用于判定滚动方向
  private active = false; // 当前是否处于流式活跃态（busy || outputting）
  readonly threshold: number;

  constructor(threshold = 20) {
    this.threshold = threshold;
  }

  /** 是否应自动跟随（贴底且未被用户接管）。rAF / [messages] effect 据此决定是否 scrollTop=scrollHeight。 */
  shouldFollow(): boolean {
    return this.follow && this.pinned;
  }

  /** 当前是否处于流式活跃态。 */
  isActive(): boolean {
    return this.active;
  }

  /**
   * 每帧 / 每次 [state.busy, outputting] 变化调用：通知当前活跃状态。
   * 仅当「非活跃 → 活跃」这一跳变（新一轮流式）才根据是否贴底初始化 follow；
   * 流式中途依赖抖动（活跃 → 活跃）不重设，避免覆盖用户已接管的状态（即本 bug 的根因）。
   */
  notifyActive(active: boolean, metrics: ScrollMetrics): void {
    if (!active) {
      this.active = false;
      return;
    }
    if (!this.active) {
      // 新一轮流式开始：仅当用户已在底部才自动跟随
      const atBottom = this.isAtBottom(metrics);
      this.pinned = atBottom;
      this.follow = atBottom;
    }
    this.active = true;
  }

  /** 用户主动滚动（wheel/pointerdown/touchmove）：立即停跟随并置离底。 */
  onUserIntent(): void {
    this.follow = false;
    this.pinned = false;
  }

  /**
   * 滚动事件（含程序化滚动）。根据方向判定用户是否接管：
   *  - scrollTop 减小（上滑）→ 用户接管，停跟随；
   *  - 到达底部（无论程序化还是用户）→ 恢复跟随；
   *  - 中部程序化 / 用户滚动不纠错。
   * 返回调用方是否需要把 scrollTop 设到 scrollHeight（仅在应跟随且当前未贴底时）。
   */
  onScroll(metrics: ScrollMetrics): boolean {
    const atBottom = this.isAtBottom(metrics);
    this.pinned = atBottom;
    if (metrics.scrollTop < this.lastScrollTop - 0.5) {
      // 向上移动：用户接管
      this.follow = false;
    } else if (atBottom) {
      // 到达 / 仍在底部：恢复跟随
      this.follow = true;
    }
    this.lastScrollTop = metrics.scrollTop;
    return this.shouldFollow() && !atBottom;
  }

  private isAtBottom(m: ScrollMetrics): boolean {
    return m.scrollHeight - m.scrollTop - m.clientHeight < this.threshold;
  }
}
