/**
 * src/agent/middleware/before-llm.ts — beforeLLM 接缝中间件
 *
 * 承载关注点（来自循环解耦方案 §1.2）：
 *   #1 输出风格指令注入   #2 计划合规对齐注入   #3 轮次额度预警注入   #19 压缩后身份重注（见 on-round-end）
 * 仅修改传入的 messages 本地副本（不写回 history/trace），或返回需 yield 的旁路事件。
 */
import type { ChatMessage } from '../../llm/deepseek.ts';
import type { AgentEvent, BeforeLLM, CoreApi } from '../core.ts';
import { styleInstruction } from '../output-style.ts';

/** #1 输出风格指令注入（本地副本，不污染 history/trace） */
export const styleInjection: BeforeLLM = (api: CoreApi, messages: ChatMessage[]) => {
  const { opts } = api;
  if (opts.outputStyle && opts.outputStyle !== 'raw') {
    const instr = styleInstruction(opts.outputStyle);
    if (instr) {
      const last = messages[messages.length - 1];
      if (last && last.role === 'user') {
        last.content = `${last.content || ''}\n\n${instr}`;
      } else {
        messages.push({ role: 'user', content: instr });
      }
    }
  }
};

/** #2 计划合规对齐提醒（每 3 轮附加一条简短对齐，不污染 history/trace） */
export const planReminder: BeforeLLM = (api: CoreApi, messages: ChatMessage[]) => {
  const { ctx } = api;
  if (ctx.planText && ctx.iteration % 3 === 0 && ctx.iteration > 1) {
    const reminder = `[系统提醒] 你正在按计划执行（第 ${ctx.iteration} 轮）。请简要确认当前操作与计划步骤一致，如有偏离请主动说明。`;
    const last = messages[messages.length - 1];
    if (last && last.role === 'user') {
      last.content = `${last.content || ''}\n\n${reminder}`;
    } else {
      messages.push({ role: 'user', content: reminder });
    }
  }
};

/** #3 轮次额度预警（模型侧注入 + 用户侧 system 事件） */
export const roundWarning: BeforeLLM = (api: CoreApi, messages: ChatMessage[]): AgentEvent[] | void => {
  const { opts, ctx } = api;
  const maxIter = opts.maxIterations ?? 0;
  const limited = maxIter > 0;
  const WARN_AHEAD = 2;
  if (limited && ctx.iteration >= maxIter - WARN_AHEAD) {
    const workLeft = maxIter - ctx.iteration;
    messages.push({
      role: 'user',
      content:
        `[系统预警] 轮次额度即将耗尽：你仅剩 ${workLeft} 轮可调用工具（当前第 ${ctx.iteration} 轮，第 ${maxIter} 轮为强制总结轮、不能调工具）。请立即收尾：\n` +
        `- 优先确保核心目标已落盘/已验证；\n` +
        `- 不要开启新的大块工作，避免被强制截断在半途；\n` +
        `- 未完成的次要事项，留到总结轮的「待完成工作规划」里列出具体下一步，不要硬撑执行。`,
    });
    return [
      {
        type: 'system',
        text:
          `⏳ 轮次预警：任务仅剩 ${workLeft} 轮工作机会（第 ${maxIter} 轮将自动生成进展总结）。如需调整范围，现在可补充指令。`,
      },
    ];
  }
};
