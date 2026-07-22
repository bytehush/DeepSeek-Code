/**
 * src/agent/middleware/on-round-end.ts — onRoundEnd 接缝中间件
 *
 * 承载关注点（来自循环解耦方案 §1.2）：
 *   #9 世界状态指纹（DriftTracker.record 已在 runCore 调用，此处消费其判定）
 *   #10 守卫1 连续全失败终止   #11 守卫2 无进展停滞终止   #12 守卫3 replan 重规划
 *   #17 Todo 进度 nag   #18 上下文 compact   #19 压缩后身份重注
 *   #23 重复调用检测（DriftTracker 归并，stall 判定消费）
 *
 * 运行时机：每轮工具执行完毕、drift.record 已落库之后。
 */
import type { OnRoundEnd, CoreApi } from '../core.ts';

/** #10 守卫1：连续全失败 → 终止 */
export const guardFailStreak: OnRoundEnd = (api: CoreApi) => {
  const { ctx, opts } = api;
  const maxRetries = opts.maxRetries ?? 3;
  if (ctx.drift.failStreak >= maxRetries) {
    const msg = `连续 ${ctx.drift.failStreak} 轮工具调用全部失败或被拒绝，提前结束。`;
    void api.tlog('early_exit', { reason: 'no_progress', streak: ctx.drift.failStreak });
    return {
      control: 'stop',
      events: [{ type: 'assistant_text', text: msg }, { type: 'done', reason: 'no_progress' }],
    };
  }
  return {};
};

/** #11 守卫2：DriftTracker 无新进展（未读新文件且未写文件）→ 停滞终止 */
export const guardStall: OnRoundEnd = (api: CoreApi) => {
  const { ctx } = api;
  const hasProgress = ctx.drift.hasRecentProgress();
  if (!hasProgress) {
    ctx.drift.stallWarnings++;
    if (ctx.drift.stallWarnings === 3) {
      api.history.addUser('[系统提醒] 已连续 3 轮未探索新文件或产生文件变更。建议确认当前方向是否正确，或换一个角度重新审视问题。');
    } else if (ctx.drift.stallWarnings === 5) {
      const msg = '已连续 5 轮无新进展（未读新文件、未写文件）。任务可能陷入停滞，提前结束。';
      void api.tlog('early_exit', { reason: 'no_observable_progress', warnings: ctx.drift.stallWarnings });
      return {
        control: 'stop',
        events: [{ type: 'assistant_text', text: msg }, { type: 'done', reason: 'no_observable_progress' }],
      };
    }
  } else {
    ctx.drift.stallWarnings = 0;
  }
  return {};
};

/** #12 守卫3：replan 重规划注入 */
export const guardReplan: OnRoundEnd = (api: CoreApi) => {
  const { ctx } = api;
  if (!ctx.replanAttempted && ctx.drift.failStreak >= 2 && ctx.drift.stallWarnings >= 2 && ctx.totalToolRounds >= 3) {
    ctx.replanAttempted = true;
    ctx.drift.failStreak = 0;
    ctx.drift.stallWarnings = 0;
    const replanMsg =
      `[系统自动] 当前任务已进行 ${ctx.totalToolRounds} 轮，但最近几轮出现连续失败且无实质进展。\n` +
      `请暂停当前路径，重新规划剩余步骤：\n` +
      `1. 梳理已完成的成果（哪些文件/功能已经就绪？）\n` +
      `2. 识别卡住的原因（工具参数错误？缺少前置条件？方向错了？）\n` +
      `3. 给出新的执行计划（用编号列表列出剩余步骤）\n` +
      `不要重复已失败的相同操作。如果新计划仍不奏效，系统会提前结束以避免死循环。`;
    api.history.addUser(replanMsg);
    void api.tlog('early_exit', { reason: 'replan_injected' });
    return { control: 'continue' };
  }
  return {};
};

/** #17 Todo 进度 nag / #18 compact / #19 身份重注（仅本轮调过工具时） */
export const compactAndTodo: OnRoundEnd = (api: CoreApi) => {
  const { ctx, opts } = api;
  if (!ctx.gotToolUse) return {};
  const TODO_NAG_AFTER = 3;

  void opts.history.compact({ signal: opts.signal });
  void api.tlog('context_compact', { estimateTokens: opts.history.estimateTotalTokens() });

  // #17 Todo 进度 nag
  const todoToolCall = ctx.roundTargets.find((t) => t.startsWith('todo_write:'));
  const todosFromTool = todoToolCall ? parseInt(todoToolCall.split(':')[1] || '0', 10) : -1;
  const todosFromText = (ctx.accContent.match(/\[x\]/g) || []).length + (ctx.accContent.match(/\[>\]/g) || []).length;
  const todosDone = todosFromTool >= 0 ? todosFromTool : todosFromText;
  const updatedTodo = todosFromTool >= 0 || todosFromText !== ctx.lastTodoCount;
  if (!updatedTodo) {
    ctx.roundsWithoutTodo++;
    if (ctx.roundsWithoutTodo >= TODO_NAG_AFTER) {
      api.history.addUser(`[系统提醒] 已 ${ctx.roundsWithoutTodo} 轮未更新进度。请确认当前进度并更新 Todo 清单（用 [x] 标记已完成项）。`);
      ctx.roundsWithoutTodo = 0;
    }
  } else {
    ctx.roundsWithoutTodo = 0;
    ctx.lastTodoCount = todosDone;
  }

  // #19 压缩后身份重注
  const currentMsgs = opts.history.getMessages();
  if (currentMsgs.length <= 3) {
    api.history.addUser(
      `[身份恢复] 你是 DeepSeek 编程助手。当前工作目录: ${opts.cwd}。正在执行的任务计划已保留在对话中。请继续你的工作。`,
    );
  }
  return {};
};
