/**
 * ReviewCommons 审查共同体 · 统一契约
 *
 * 位置：src/review/types.ts
 * 职责：定义 Reviewer / ReviewReport / ReviewVerdict / ReflectionState 等审查层契约。
 * 与工具侧 ToolOrchestrator 正交：本层审「agent 最终输出内容」的质量深度 + 格式，
 * 而非工具调用（工具编排者管）也非源码（src/tools/review.ts 管）。
 *
 * 设计来源：deepseek-code-agent-审查编排者方案.md §3 / §4.2
 */

/** 递进式反思跨轮深度指纹（编排者跨 agent loop 轮次维护）。 */
export interface ReflectionState {
  /** 第几轮反思（首轮=1，初始态 round=0）。 */
  round: number;
  /** 上轮已覆盖的洞察主题。 */
  priorThemes: string[];
  /** 上轮深度评分 1–5。 */
  priorDepth: number;
  /** 上轮遗留、尚未深挖的点（下轮输入）。 */
  priorGaps: string[];
}

/** 单轮审查输入：待审内容 + 上一轮状态（首轮为初始态）。 */
export interface ReviewInput {
  content: string;
  priorState: ReflectionState;
}

/** 单个审查系统（Format Validator / Reflection）的统一报告。 */
export interface ReviewReport {
  /** 本轮是否达标。 */
  passed: boolean;
  /** 本轮深度 1–5（仅 Reflection 用，Format 可置 0）。 */
  depthScore: number;
  /** 本轮新洞察（用于比对递进）。 */
  newThemes: string[];
  /** 是否比上轮深。 */
  deeperThanPrior: boolean;
  /** 仍待深挖点（传给下轮）。 */
  gaps: string[];
  /** 给 agent 的深化/修正指引。 */
  feedback: string;
}

/** 编排者汇总后的统一结论。 */
export interface ReviewVerdict {
  /** 是否放行。 */
  released: boolean;
  /** 不放行原因（供日志/UI）。 */
  reasons: string[];
  /** Format Validator 报告。 */
  format?: ReviewReport;
  /** Reflection 报告。 */
  reflection?: ReviewReport;
  /** 给 agent 的下一轮指引（深化/修正格式）；released=false 时回灌。 */
  guidance?: string;
}

/** 审查系统统一接口：Format Validator 与 Reflection 都实现它。 */
export interface Reviewer {
  name: string;
  review(input: ReviewInput): Promise<ReviewReport>;
}

/** 递进深度上限默认值（记录表 S5 五问答复：上限=3）。 */
export const MAX_REFLECTION_ROUNDS = 3;

/** 构造跨轮初始态。 */
export function initialReflectionState(): ReflectionState {
  return { round: 0, priorThemes: [], priorDepth: 0, priorGaps: [] };
}
