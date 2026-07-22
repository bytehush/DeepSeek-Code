/**
 * src/agent/middleware/index.ts — 组装 Agent 中间件链
 *
 * 把 23 个外部关注点（来自 循环解耦方案 §1.2）挂入内核的 5 个接缝：
 *   beforeLLM   → #1 风格 / #2 计划提醒 / #3 轮次预警
 *   afterLLM    → #8 self-review / #7 ReviewCommons（phase 标记前）
 *   afterFinal  → #13 递减 / #14 未完成 / #15 短答复（最终答复路径）
 *   afterDispatch → #16 成功路径验证提示
 *   onRoundEnd  → #10 全失败 / #11 停滞 / #12 replan / #17 todo / #18 compact / #19 身份重注
 *   （#4 权限 / #5 文件 diff / #6 awaitUser / #22 失败反思 属 ReAct 第④步 dispatch 内在机制，保留内核）
 *   （#9 指纹 / #23 重复检测 由 DriftTracker 在 runCore 落库，onRoundEnd 消费其判定）
 */
import type { MiddlewareChain } from '../core.ts';
import { styleInjection, planReminder, roundWarning } from './before-llm.ts';
import { selfReview, reviewCommons, diminishingCheck, unfinishedCheck, shortAnswerCheck } from './after-llm.ts';
import { guardFailStreak, guardStall, guardReplan, compactAndTodo } from './on-round-end.ts';
import { insertSuccessChecks } from './after-dispatch.ts';

/** 构建默认 Agent 中间件链。中间件全部无状态（共享状态在 CoreCtx），可独立替换/测试。 */
export function buildAgentMiddlewares(): MiddlewareChain {
  return {
    beforeLLM: [styleInjection, planReminder, roundWarning],
    afterLLM: [selfReview, reviewCommons],
    afterFinal: [diminishingCheck, unfinishedCheck, shortAnswerCheck],
    afterDispatch: [insertSuccessChecks],
    onRoundEnd: [guardFailStreak, guardStall, guardReplan, compactAndTodo],
  };
}

export { styleInjection, planReminder, roundWarning } from './before-llm.ts';
export { selfReview, reviewCommons, diminishingCheck, unfinishedCheck, shortAnswerCheck } from './after-llm.ts';
export { guardFailStreak, guardStall, guardReplan, compactAndTodo } from './on-round-end.ts';
export { insertSuccessChecks } from './after-dispatch.ts';
