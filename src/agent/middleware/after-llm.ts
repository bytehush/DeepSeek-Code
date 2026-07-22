/**
 * src/agent/middleware/after-llm.ts — afterLLM / afterFinal 接缝中间件
 *
 * 承载关注点（来自循环解耦方案 §1.2）：
 *   #7 Elevate（→ ReviewCommons 审查共同体）   #8 Flash 自检 self-review
 *   #13 输出递减检测   #14 未完成措辞检测   #15 短答复（答一半）检测
 *
 * 分组：
 *   - group A（afterLLM，phase 标记前）：selfReview + reviewCommons
 *   - group B（afterFinal，phase 标记后最终答复路径）：diminishing + unfinished + shortCheck
 */
import type { AfterLLM, CoreApi } from '../core.ts';
import { errMsg } from '../../llm/deepseek.ts';
import { logger } from '../../utils/logger.ts';
import { runTaskFidelity } from '../../tools/verify-task.ts';
import { MAX_REFLECTION_ROUNDS } from '../../review/types.ts';

/** 计算 canElevate / willElevate（与原 loop.ts:630-633 一致） */
function elevateFlags(api: CoreApi): { canElevate: boolean; willElevate: boolean } {
  const { opts, ctx } = api;
  const maxIter = opts.maxIterations ?? 0;
  const limited = maxIter > 0;
  const canElevate = !ctx.gotToolUse && !ctx.didElevate && (!limited || ctx.iteration < maxIter - 1);
  const willElevate = canElevate && (ctx.everMutated || ctx.totalToolRounds >= 3);
  return { canElevate, willElevate };
}

/** #8 Flash 自检：中等规模任务（未被 Elevate 覆盖）注入一条自检提示，下一轮修正 */
export const selfReview: AfterLLM = (api: CoreApi) => {
  const { ctx, history } = api;
  const { canElevate, willElevate } = elevateFlags(api);
  if (!willElevate && !ctx.gotToolUse && !ctx.selfReviewed && ctx.totalToolRounds >= 2) {
    ctx.selfReviewed = true;
    const reviewPrompt =
      '[系统自动] 在输出最终答复前，请用一句话自我核对：\n' +
      '① 是否遗漏了用户的任何要求？② 答复中是否有事实错误或前后矛盾？\n' +
      '如果有问题，请在下一轮输出中修正；如果确认无误，直接输出最终答复。';
    history.addUser(reviewPrompt);
    void api.tlog('self_review', { totalToolRounds: ctx.totalToolRounds });
    return { control: 'continue' };
  }
  return {};
};

/** #7 Elevate（→ ReviewCommons 审查共同体，S5.4）：对最终答复做 Format→Reflection 审查，未放行则回灌深化 */
export const reviewCommons: AfterLLM = async (api: CoreApi) => {
  const { ctx, history, opts } = api;
  const { willElevate } = elevateFlags(api);
  if (!willElevate) return {};

  // 任务级语义保真审计（仅写操作触发；独立于答复质量审查，失败不阻断）
  if (ctx.everMutated) {
    try {
      const fidelityNote = await runTaskFidelity(opts.client, opts.history, { signal: opts.signal });
      if (fidelityNote) {
        history.addUser(
          '[系统自动] 任务级交付审计已完成，结果如下。在输出最终答复前，请先处理其中的 must_fix（必须修复项）；若 pass=false，不要声称任务已完成。\n\n' +
            fidelityNote,
        );
        void api.tlog('task_fidelity', { triggered: true });
      }
    } catch (e: unknown) {
      logger.warn('[agent core] task fidelity check failed: ' + errMsg(e));
    }
  }

  const verdict = await ctx.reviewOrchestrator.review(ctx.accContent);
  void api.tlog('review_commons', {
    released: verdict.released,
    round: ctx.reviewOrchestrator.round,
    hasGuidance: !!verdict.guidance,
  });
  if (!verdict.released) {
    if (ctx.reviewOrchestrator.round < MAX_REFLECTION_ROUNDS) {
      history.addUser(
        '[系统自动·审查共同体] 你的答复未通过审查：\n' +
          verdict.guidance +
          '\n请根据以上指引修订后，重新输出最终答复。',
      );
      return { control: 'continue' };
    }
    history.addUser(
      '[系统自动·审查共同体] 已达递进深度上限（' +
        MAX_REFLECTION_ROUNDS +
        ' 轮）仍不达标，放行当前答复供你定夺：\n' +
        (verdict.guidance ?? ''),
    );
  }
  return {};
};

/** #13 输出递减检测：模型不调工具但文本持续缩短 → 疑似无意义重复，提前结束 */
export const diminishingCheck: AfterLLM = (api: CoreApi) => {
  const { ctx } = api;
  if (ctx.gotToolUse) return {};
  const outLen = ctx.accContent.trim().length;
  if (outLen < ctx.lastOutputLen && outLen < 80) ctx.diminishingCount++;
  else ctx.diminishingCount = 0;
  ctx.lastOutputLen = outLen;
  const DIMINISHING_LIMIT = 4;
  if (ctx.diminishingCount >= DIMINISHING_LIMIT) {
    const msg = `连续 ${DIMINISHING_LIMIT} 轮文本输出递减且均不足 80 字，疑似陷入无意义重复。提前结束。`;
    void api.tlog('early_exit', { reason: 'diminishing_output', streak: ctx.diminishingCount });
    // 注：runCore 已在 phase 标记产出 assistant_phase final，此处再补一次以匹配原 loop 行为
    return {
      control: 'stop',
      events: [
        { type: 'assistant_phase', phase: 'final' },
        { type: 'assistant_text', text: msg },
        { type: 'done', reason: 'no_progress' },
      ],
    };
  }
  return {};
};

/** #14 未完成措辞检测：模型说「可以继续」但被判为完成 → 注入继续提示 */
export const unfinishedCheck: AfterLLM = (api: CoreApi) => {
  const { ctx, history } = api;
  if (ctx.gotToolUse) return {};
  const unfinishedHints = /可以继续|还需要|接下来|下一[步轮]|剩余(步骤|工作|任务)/;
  if (unfinishedHints.test(ctx.accContent) && !ctx.selfReviewed && !ctx.didElevate) {
    history.addUser('[系统提示] 你的答复暗示任务还未完成。如有剩余步骤，请继续调用工具执行；如已完成，请明确说明。');
    return { control: 'continue' };
  }
  return {};
};

/** #15 短答复检测：声称完成但此前多轮工具操作、最终答复过短 → 告警（仍正常结束） */
export const shortAnswerCheck: AfterLLM = (api: CoreApi) => {
  const { ctx } = api;
  if (ctx.gotToolUse) return {};
  if (ctx.totalToolRounds >= 2 && ctx.everMutated && ctx.accContent.trim().length < 20) {
    const warn = '⚠️ 模型给出的结束答复过短，任务可能未完成（此前已进行多轮工具操作）。建议复核结果。';
    void api.tlog('early_exit', {
      reason: 'model_stop_short',
      finalLen: ctx.accContent.trim().length,
      toolRounds: ctx.totalToolRounds,
    });
    return { events: [{ type: 'assistant_text', text: warn }] };
  }
  return {};
};
