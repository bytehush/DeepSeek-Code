/**
 * ReviewCommons 审查共同体 · ReviewOrchestrator
 *
 * 位置：src/review/orchestrator.ts
 * 职责：按序调度 Format → Reflection 两个审查系统，汇总统一 ReviewVerdict；
 *       跨 agent loop 轮次维护 ReflectionState（编排者持有，调用方无需传态）。
 *
 * 调度顺序（记录表 S5 五问答复）：Format → Reflection。
 *   - 先 Format（客观硬门槛，确定性强）→ 不过则直接返回修正指引，省去质量反思浪费。
 *   - 再 Reflection（质量深度 + 递进比对），未递进则推进 state、附 guidance 回灌。
 *
 * 设计来源：deepseek-code-agent-审查编排者方案.md §4
 */

import {
  initialReflectionState,
  MAX_REFLECTION_ROUNDS,
  type ReflectionState,
  type ReviewInput,
  type ReviewReport,
  type ReviewVerdict,
  type Reviewer,
} from './types.ts';

export interface ReviewOrchestratorDeps {
  /** 审查系统①：格式审查（zod 驱动，确定性）。 */
  format: Reviewer;
  /** 审查系统②：递进式质量深度审查（Pro 模型）。 */
  reflection: Reviewer;
  /** 递进深度上限，默认 MAX_REFLECTION_ROUNDS。 */
  maxRounds?: number;
}

export class ReviewOrchestrator {
  private readonly format: Reviewer;
  private readonly reflection: Reviewer;
  private readonly maxRounds: number;
  private state: ReflectionState;

  constructor(deps: ReviewOrchestratorDeps) {
    this.format = deps.format;
    this.reflection = deps.reflection;
    this.maxRounds = deps.maxRounds ?? MAX_REFLECTION_ROUNDS;
    this.state = initialReflectionState();
  }

  /** 当前已用递进轮次（调用方据此判断是否已触达上限，避免无限空转）。 */
  get round(): number {
    return this.state.round;
  }

  /** 取当前跨轮状态（供观测/测试断言）。 */
  getState(): ReflectionState {
    return this.state;
  }

  /** 重置跨轮状态（新会话/新任务开始时调用）。 */
  reset(): void {
    this.state = initialReflectionState();
  }

  /**
   * 对一轮 agent 输出做审查，返回统一结论。
   * 不修改 content，仅产出 verdict；未递进时推进内部 state，由调用方把 guidance 回灌下一轮。
   */
  async review(content: string): Promise<ReviewVerdict> {
    const input: ReviewInput = { content, priorState: this.state };

    // ① Format 硬门槛
    const formatReport: ReviewReport = await this.format.review(input);
    if (!formatReport.passed) {
      return {
        released: false,
        reasons: [`format: ${formatReport.feedback}`],
        format: formatReport,
        guidance: formatReport.feedback,
      };
    }

    // ② Reflection 质量深度 + 递进比对
    const reflectionReport: ReviewReport = await this.reflection.review(input);
    if (reflectionReport.passed && reflectionReport.deeperThanPrior) {
      return {
        released: true,
        reasons: [],
        format: formatReport,
        reflection: reflectionReport,
      };
    }

    // 未递进/不达标 → 推进 state 供下一轮比对（agent 下一轮产出更深内容后再次调用 review）
    this.state = {
      round: this.state.round + 1,
      priorThemes: reflectionReport.newThemes,
      priorDepth: reflectionReport.depthScore,
      priorGaps: reflectionReport.gaps,
    };

    return {
      released: false,
      reasons: [
        `reflection: 未递进/不达标 (depth=${reflectionReport.depthScore}, deeperThanPrior=${reflectionReport.deeperThanPrior})`,
        `round ${this.state.round}/${this.maxRounds}`,
      ],
      format: formatReport,
      reflection: reflectionReport,
      guidance: reflectionReport.feedback,
    };
  }
}
