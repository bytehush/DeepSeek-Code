/**
 * src/agent/core.ts — Agent Loop 极简内核（P3 循环解耦）
 *
 * 设计目标（见 deepseek-code-agent-循环解耦方案.md）：
 *   1. 内核只做 ReAct 5 步，不认识权限/审查/trace/守卫/风格是什么；
 *   2. 改任一中间件不波及内核（中间件通过接缝挂入，内核签名不变）；
 *   3. 中间件异常不崩内核（每个接缝独立 onError 边界，异常降级为日志，循环继续）。
 *
 * 接缝（Seams）：beforeLLM / afterLLM / afterDispatch / onRoundEnd。
 * 权限闸门（decide）、文件 diff 审批、awaitUser、工具执行、clamp、失败反思
 * 属于 ReAct 第④步「执行工具」的内在机制，保留在内核的 dispatch 内循环，
 * 不视为可外移的「外部关注点」（与方案「dispatch 是 ReAct 固有步」一致）。
 */
import { DeepSeekClient, ChatMessage, ToolCall } from '../llm/deepseek.ts';
import { errMsg } from '../llm/deepseek.ts';
import { ToolDef, createTools } from '../tools/index.ts';
import { ConversationHistory } from '../context/history.ts';
import { TraceLogger, type TraceEventType } from '../context/trace.ts';
import { logger } from '../utils/logger.ts';
import { type OutputStyle, styleInstruction } from './output-style.ts';
import { regexExtractJSON } from '../tools/structured-parse.ts';
import { ToolOrchestrator, type ToolCallResult } from '../tools/orchestrator.ts';
import { DefaultGatekeeper } from '../tools/gatekeeper.ts';
import { z } from 'zod';
import { ReviewOrchestrator } from '../review/orchestrator.ts';
import { FormatValidator } from '../review/format-validator.ts';
import { ReflectionReviewer, createProReflectionAssessor } from '../review/reflection.ts';
import { MAX_REFLECTION_ROUNDS } from '../review/types.ts';
import type { PermissionMode } from '../permission/index.ts';
import type { AgentEvent, RunOptions } from './loop.ts';

export type { AgentEvent, RunOptions };
export type { PermissionMode };

// ════════════════════════════════════════════════════════════════
// 公开事件 / 选项类型（原定义于 loop.ts，内核与薄壳共用）
// ════════════════════════════════════════════════════════════════

// AgentEvent / RunOptions 的正式定义见 loop.ts（core 仅做类型再导出），
// 避免与薄壳循环依赖；此处保留运行期所需常量与 helper。

/** 会改变世界状态（文件 / 工作树 / 派生子 Agent）的工具，用于「可观测进展」判定。 */
const MUTATING_TOOLS = new Set([
  'write_file', 'create_file', 'edit_file', 'delete_file', 'run_command',
  'git_commit', 'git_add', 'git_reset', 'delegate',
]);

/**
 * 从一次工具调用提取「主要操作目标」键，用于世界状态指纹。
 */
function extractTarget(tc: { name: string; arguments: Record<string, unknown> }): string {
  const a = tc.arguments ?? {};
  switch (tc.name) {
    case 'read_file':
    case 'edit_file':
    case 'create_file':
    case 'write_file':
    case 'delete_file':
      return `${tc.name}:${String(a.path ?? '')}`;
    case 'grep':
    case 'search_content':
    case 'search_code':
      return `${tc.name}:${String(a.pattern ?? '')}:${String(a.path ?? a.dir ?? '')}`;
    case 'search_files':
      return `search_files:${String(a.pattern ?? '')}:${String(a.dir ?? '')}`;
    case 'run_command':
      return `run_command:${String(a.command ?? '').replace(/\s+/g, ' ').trim()}`;
    case 'list_dir':
      return `list_dir:${String(a.path ?? '')}`;
    case 'todo_write':
      return `todo_write:${((a.todos as Array<{ status: string }>) ?? []).filter((t) => t.status === 'completed').length}`;
    default:
      return tc.name;
  }
}

/**
 * 工具结果截断 / 权限提示文案 现由 src/tools/orchestrator.ts 单一持有（clampToolOutput /
 * buildFileReviewPrompt），core 不再保留副本——工具执行收敛到唯一消息通道（ToolOrchestrator）。
 */

const toModelTools = (tools: ToolDef[]) =>
  tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

// ════════════════════════════════════════════════════════════════
// DriftTracker：世界状态增量追踪器（关注点 #9/#10/#11/#12）
// ════════════════════════════════════════════════════════════════

class DriftTracker {
  window: Array<{ reads: Set<string>; writes: Set<string>; allFailed: boolean }> = [];
  maxWindow = 5;
  failStreak = 0;
  stallWarnings = 0;

  record(reads: string[], writes: string[], allFailed: boolean): void {
    this.window.push({ reads: new Set(reads), writes: new Set(writes), allFailed });
    if (this.window.length > this.maxWindow) this.window.shift();
    if (allFailed) this.failStreak++;
    else this.failStreak = 0;
  }

  hasRecentProgress(): boolean {
    if (this.window.length < 2) return true;
    const recent = this.window.slice(-2);
    const prior = this.window.slice(0, -2);
    const priorReads = new Set(prior.flatMap((r) => [...r.reads]));
    const priorWrites = new Set(prior.flatMap((r) => [...r.writes]));
    const newReads = recent.flatMap((r) => [...r.reads]).filter((f) => !priorReads.has(f));
    if (newReads.length > 0) return true;
    const anyWrite = recent.some((r) => r.writes.size > 0);
    if (anyWrite) return true;
    return false;
  }
}

// ════════════════════════════════════════════════════════════════
// 复杂度分类器（Plan & Act 全自动升级，P3.7 effort 档位）
// ════════════════════════════════════════════════════════════════

const complexitySchema = z.object({
  complex: z.coerce.boolean(),
  reason: z.string().default(''),
  effort: z.enum(['small', 'medium', 'large']).default('medium'),
});

async function assessComplexity(
  client: DeepSeekClient,
  lastUser: string,
  signal?: AbortSignal,
): Promise<{ complex: boolean; reason: string; effort: 'small' | 'medium' | 'large' }> {
  const sys =
    '你是任务复杂度分类器。判断用户请求是否需要「先规划再执行」。\n' +
    '【需要规划】多步骤任务、涉及多个文件/模块、需要架构设计、重构、从零搭建功能、跨文件改动、破坏性较大的操作、需求有歧义需先澄清。\n' +
    '【不需要规划】读单个文件、查概念/问问题、改一个文件的一小处、一步就能完成的明确操作。\n' +
    '同时估算规模：small(1-3步)/medium(4-7步)/large(8+步)。\n' +
    '只输出一行 JSON：{"complex": true/false, "effort":"small|medium|large", "reason": "一句话理由"}。不要输出其他任何内容。';
  let raw = '';
  try {
    for await (const ev of client.streamChat(
      [
        { role: 'system', content: sys },
        { role: 'user', content: lastUser },
      ],
      [],
      { signal, timeoutMs: 20_000 },
    )) {
      if (ev.type === 'content' && ev.text) raw += ev.text;
      else if (ev.type === 'error') break;
    }
  } catch {
    return { complex: false, reason: 'classifier error, fallback to direct', effort: 'medium' };
  }
  const result = regexExtractJSON(raw, 'complex', complexitySchema);
  if (!result.ok) return { complex: false, reason: 'no valid json, fallback to direct', effort: 'medium' };
  return { complex: result.data!.complex, reason: result.data!.reason ?? '', effort: result.data!.effort ?? 'medium' };
}

// ════════════════════════════════════════════════════════════════
// 接缝（Seam）类型
// ════════════════════════════════════════════════════════════════

/** 内核提供给中间件的统一上下文（会话级 + 本轮级共享状态全在这里）。 */
export interface CoreCtx {
  // 会话级
  iteration: number;
  step: number;
  drift: DriftTracker;
  everMutated: boolean;
  totalToolRounds: number;
  lastOutputLen: number;
  diminishingCount: number;
  lastTodoCount: number;
  roundsWithoutTodo: number;
  perToolFailures: Map<string, number>;
  selfReviewed: boolean;
  replanAttempted: boolean;
  didElevate: boolean;
  planText: string;
  autoPlanned: boolean;
  reviewOrchestrator: ReviewOrchestrator;
  // 本轮级（每轮重置）
  accContent: string;
  gotToolUse: boolean;
  sawToolUse: boolean;
  hasRunTools: boolean;
  pendingToolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  iterToolResults: boolean[];
  roundMutated: boolean;
  roundTargets: string[];
  iterSigParts: string[];
  successChecks: string[];
}

export interface CoreApi {
  opts: RunOptions;
  history: ConversationHistory;
  client: DeepSeekClient;
  trace?: TraceLogger;
  ctx: CoreCtx;
  /** 旁路事件（trace 落盘代理）：不阻断主流程，仅记录。 */
  tlog: (type: TraceEventType, data: Record<string, unknown>) => Promise<void>;
}

export type ControlSignal = { control?: 'continue' | 'stop'; events?: AgentEvent[] };

export type BeforeLLM = (api: CoreApi, messages: ChatMessage[]) => AgentEvent[] | void | Promise<AgentEvent[] | void>;
export type AfterLLM = (
  api: CoreApi,
  info: { accContent: string; pendingToolCalls: CoreCtx['pendingToolCalls']; gotToolUse: boolean; hasRunTools: boolean },
) => ControlSignal | Promise<ControlSignal>;
export type AfterDispatch = (api: CoreApi) => AgentEvent[] | void | Promise<AgentEvent[] | void>;
export type OnRoundEnd = (api: CoreApi) => ControlSignal | Promise<ControlSignal>;

export interface MiddlewareChain {
  beforeLLM: BeforeLLM[];
  afterLLM: AfterLLM[];
  /** 最终答复路径（phase 标记之后、compact 之前）的 afterLLM 关注点：递减/未完成/短答复。 */
  afterFinal: AfterLLM[];
  afterDispatch: AfterDispatch[];
  onRoundEnd: OnRoundEnd[];
}

// ════════════════════════════════════════════════════════════════
// 内核：runCore
// ════════════════════════════════════════════════════════════════

export async function* runCore(
  userInput: string,
  opts: RunOptions,
  mw: MiddlewareChain,
): AsyncGenerator<AgentEvent> {
  const trace = opts.trace;
  const tools = opts.tools ?? createTools(opts.client);
  opts.history.addUser(userInput);

  // 工具执行统一收口到 ToolOrchestrator（消息驱动：路由→把关→授权→执行→截断）。
  // 编排者不碰 history / yield / trace——core 仍负责事件、history 落盘、异常与业务状态。
  const permissionEvents: Array<{ toolName: string; granted: boolean }> = [];
  const toolOrchestrator = new ToolOrchestrator({
    tools,
    gatekeeper: new DefaultGatekeeper(),
    ask: opts.ask,
    mode: opts.permission,
    cwd: opts.cwd,
    signal: opts.signal,
    onPermission: (toolName, granted) => permissionEvents.push({ toolName, granted }),
  });

  if (trace) {
    await trace.log('session_start', { cwd: opts.cwd, permission: opts.permission, model: opts.client.primaryModel });
    await trace.log('user_input', { input: userInput.slice(0, 500) });
  }

  const tlog = async (type: TraceEventType, data: Record<string, unknown>) => {
    if (trace) await trace.log(type, data);
  };

  // ── 会话级状态 ──
  const ctx: CoreCtx = {
    iteration: 0,
    step: 0,
    drift: new DriftTracker(),
    everMutated: false,
    totalToolRounds: 0,
    lastOutputLen: 0,
    diminishingCount: 0,
    lastTodoCount: 0,
    roundsWithoutTodo: 0,
    perToolFailures: new Map(),
    selfReviewed: false,
    replanAttempted: false,
    didElevate: false,
    planText: '',
    autoPlanned: false,
    reviewOrchestrator: new ReviewOrchestrator({
      format: new FormatValidator(),
      reflection: new ReflectionReviewer(createProReflectionAssessor(opts.client, opts.signal)),
    }),
    accContent: '',
    gotToolUse: false,
    sawToolUse: false,
    hasRunTools: false,
    pendingToolCalls: [],
    iterToolResults: [],
    roundMutated: false,
    roundTargets: [],
    iterSigParts: [],
    successChecks: [],
  };

  const api: CoreApi = { opts, history: opts.history, client: opts.client, trace, ctx, tlog };

  // ═══════════════════════════════════════════════════════════════
  // Plan & Act（全自动升级）：复杂度分类 → 计划注入 → 确认/直接执行
  // ═══════════════════════════════════════════════════════════════
  let autoPlanned = false;
  let planText = '';
  if (!opts.planMode && opts.autoPlan !== false) {
    const msgs = opts.history.getMessages();
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    if (lastUser && lastUser.content) {
      const assessment = await assessComplexity(opts.client, String(lastUser.content), opts.signal);
      if (assessment.complex) {
        autoPlanned = true;
        await tlog('auto_plan', { reason: assessment.reason, effort: assessment.effort });
      }
    }
  }
  ctx.autoPlanned = autoPlanned;

  const doPlan = opts.planMode || autoPlanned;
  if (doPlan) {
    const planInstruction =
      '\n\n【规划模式】请先不要执行任何工具调用。用中文输出你的执行计划：\n' +
      '1. 目标：你打算做什么（一句话）\n' +
      '2. 步骤：分步列出每步要调用的工具、参数、预期结果（编号）\n' +
      '3. 验证：每步完成后如何验证\n' +
      '格式简洁，用编号列表即可。';

    const lastMsg = opts.history.getMessages();
    if (lastMsg.length > 0) {
      const last = lastMsg[lastMsg.length - 1];
      if (last.role === 'user') {
        last.content = (last.content || '') + planInstruction;
      }
    }

    const modelTools = toModelTools(tools);
    let planContent = '';
    for await (const ev of opts.client.streamChat(lastMsg, modelTools, { signal: opts.signal, timeoutMs: 180_000 })) {
      if (ev.type === 'content' && ev.text) {
        planContent += ev.text;
        yield { type: 'assistant_text', text: ev.text };
      } else if (ev.type === 'error') {
        yield { type: 'error', error: ev.error, errorCategory: ev.errorCategory };
        return;
      } else if (ev.type === 'aborted') {
        yield { type: 'done', reason: 'user_abort' };
        return;
      }
    }
    planText = planContent;
    ctx.planText = planText;

    opts.history.addAssistant(planContent, undefined);
    await tlog('plan_generated', { planLen: planContent.length, auto: autoPlanned });

    let confirmed = true;
    if (opts.planMode && !autoPlanned) {
      confirmed = await opts.ask(
        `执行计划已生成。是否按此计划执行？\n\n` +
          planContent.slice(0, 300) + (planContent.length > 300 ? '...' : '') +
          `\n\n选择「是」将自动进入执行模式，按计划逐步执行。选择「否」则保留计划在对话中（后续可继续确认）。`,
      );
      yield { type: 'permission', toolName: 'plan_confirm', granted: confirmed };
      await tlog('plan_decision', { confirmed, auto: false });
    } else {
      await tlog('plan_decision', { confirmed: true, auto: true });
    }

    if (!confirmed) {
      yield { type: 'assistant_text', text: '\n（计划已暂存。你可以说「按计划执行」或「确认执行」来继续。）' };
      yield { type: 'done', reason: 'model_stop' };
      return;
    }

    yield { type: 'assistant_text', text: '\n（已确认，进入执行模式...）\n' };
    opts.history.addUser(
      `[系统] 以下执行计划已${autoPlanned ? '由系统自动生成并确认' : '经用户确认'}。请严格按照计划步骤执行——\n` +
        `每完成一步做简要汇报，遇到问题及时反馈，不要跳过任何步骤。\n\n` +
        `执行计划:\n${planContent}`,
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // 主循环（ReAct）
  // ═══════════════════════════════════════════════════════════════
  const modelTools = toModelTools(tools);
  const maxIter = opts.maxIterations ?? 0;
  const limited = maxIter > 0;
  const effectiveMax = limited ? maxIter : Infinity;
  const WARN_AHEAD = 2;
  const maxRetries = opts.maxRetries ?? 3;
  const DIMINISHING_LIMIT = 4;
  const TODO_NAG_AFTER = 3;

  while (ctx.iteration < effectiveMax) {
    if (opts.signal?.aborted) {
      yield { type: 'assistant_phase', phase: 'final' };
      yield { type: 'done', reason: 'user_abort' };
      return;
    }
    ctx.iteration++;
    ctx.step++;
    logger.debug(`[agent core] iteration ${ctx.iteration}${limited ? `/${maxIter}` : ''}`);

    // 重置本轮级状态
    ctx.accContent = '';
    ctx.gotToolUse = false;
    ctx.sawToolUse = false;
    ctx.hasRunTools = false;
    ctx.pendingToolCalls = [];
    ctx.iterToolResults = [];
    ctx.roundMutated = false;
    ctx.roundTargets = [];
    ctx.iterSigParts = [];
    ctx.successChecks = [];

    // ── 总结轮（末轮强制总结）──
    if (limited && ctx.iteration === maxIter) {
      const summaryPrompt =
        `你已经用完了所有工作轮次（前 ${maxIter - 1} 轮）。现在是第 ${maxIter} 轮——**总结轮**，你不能调用任何工具。\n\n` +
        '请生成一份完整的项目进展报告，包含以下两部分：\n\n' +
        '## 一、已完成工作总结\n' +
        `回顾前 ${maxIter - 1} 轮的操作，逐条列出：\n` +
        '- 完成了哪些任务（具体到文件/功能/改动）\n' +
        '- 每项任务的结果（成功/部分完成/失败及原因）\n' +
        '- 做了哪些验证（构建/测试/审查）及其结果\n\n' +
        '## 二、待完成工作规划\n' +
        '对于尚未完成的任务：\n' +
        '- 列出剩余待办，按优先级排序（高/中/低）\n' +
        '- 每项给出具体的下一步操作建议（调什么工具、改什么文件、注意什么坑）\n' +
        '- 预估每个待办需要的工作量\n\n' +
        '要求：\n' +
        '- 用中文输出，格式清晰，用户能一目了然地知道进度和后续步骤\n' +
        '- 不要泛泛而谈，要具体到文件路径、函数名、命令等细节\n' +
        '- 如果某项任务失败，诚实标注并给出备选方案\n' +
        '- 不要写"我可以继续"之类的——直接告诉用户怎么继续';

      opts.history.addUser(summaryPrompt);
      const summaryMessages = [...opts.history.getMessages()];

      let summaryBuf = '';
      let summaryAborted = false;
      yield { type: 'assistant_phase', phase: 'final', step: ctx.step, reactPhase: 'final' };
      try {
        for await (const ev of opts.client.streamChat(summaryMessages, [], { signal: opts.signal, timeoutMs: 120_000 })) {
          if (ev.type === 'content' && ev.text) {
            summaryBuf += ev.text;
            yield { type: 'assistant_text', text: ev.text, step: ctx.step, reactPhase: 'final' };
          } else if (ev.type === 'tool_use') {
            logger.debug('[agent core] summary round ignored tool_use');
          } else if (ev.type === 'aborted') {
            summaryAborted = true;
            break;
          } else if (ev.type === 'error') {
            logger.error('[agent core] summary round stream error: ' + String(ev.error || 'unknown'));
            yield { type: 'error', error: ev.error, errorCategory: ev.errorCategory };
            return;
          }
        }
      } catch (e: unknown) {
        logger.error('[agent core] summary round exception: ' + (e instanceof Error ? e.message : String(e)));
        summaryBuf = `## 总结生成异常\n\n系统在处理总结时遇到异常，请查看前 ${maxIter - 1} 轮的操作记录。\n\n异常: ${e instanceof Error ? e.message : String(e)}`;
        yield { type: 'assistant_text', text: summaryBuf, step: ctx.step, reactPhase: 'final' };
      }

      if (summaryAborted) {
        opts.history.addAssistant(summaryBuf, undefined);
        await tlog('assistant_message', { content: summaryBuf, summaryRound: true, interrupted: true });
        yield { type: 'done', reason: 'user_abort' };
        return;
      }

      opts.history.addAssistant(summaryBuf, undefined);
      await tlog('assistant_message', { content: summaryBuf, summaryRound: true });
      await opts.history.compact({ signal: opts.signal });
      yield { type: 'done', reason: 'model_stop' };
      return;
    }

    // ── beforeLLM：messages 注入（风格/计划提醒/轮次预警/身份重注）──
    // 深拷贝每条消息对象，避免中间件改动 content 时污染 history（贴合原「本地副本」意图）
    const messages = opts.history.getMessages().map((m) => ({ ...m }));
    for (const m of mw.beforeLLM) {
      const events = await safeSeam(() => m(api, messages), 'beforeLLM');
      if (events) for (const e of events) yield e;
    }

    // ── ① 调 LLM（流式）──
    let accContent = '';
    let pendingToolCalls: CoreCtx['pendingToolCalls'] = [];
    let gotToolUse = false;
    let hasRunTools = false;
    for await (const ev of opts.client.streamChat(messages, modelTools, { signal: opts.signal, timeoutMs: 180_000 })) {
      if (ev.type === 'content' && ev.text) {
        accContent += ev.text;
        const rp: 'thought' | 'final' = hasRunTools ? 'final' : 'thought';
        yield { type: 'assistant_text', text: ev.text, step: ctx.step, reactPhase: rp };
      } else if (ev.type === 'tool_use' && ev.tools) {
        gotToolUse = true;
        hasRunTools = true;
        pendingToolCalls = ev.tools as CoreCtx['pendingToolCalls'];
        await tlog('model_tool_use', { tools: pendingToolCalls.map((t) => t.name) });
      } else if (ev.type === 'error') {
        await tlog('error', { phase: 'streaming', error: ev.error });
        yield { type: 'error', error: ev.error, errorCategory: ev.errorCategory };
        return;
      } else if (ev.type === 'aborted') {
        await tlog('cancelled', { phase: 'streaming' });
        yield { type: 'assistant_phase', phase: 'final' };
        if (accContent.trim()) {
          opts.history.addAssistant(accContent, undefined);
          await tlog('assistant_message', { content: accContent });
          yield { type: 'assistant_text', text: accContent };
        }
        yield { type: 'done', reason: 'user_abort' };
        return;
      }
    }
    ctx.accContent = accContent;
    ctx.gotToolUse = gotToolUse;
    ctx.hasRunTools = hasRunTools;
    ctx.pendingToolCalls = pendingToolCalls;

    // ── afterLLM（self-review / ReviewCommons / 递减 / 未完成 / 短答复）──
    const al = await runAfterLLM(api, mw.afterLLM);
    for (const e of al.events) yield e;
    if (al.control === 'continue') continue;
    if (al.control === 'stop') return;

    // ── 阶段标记（progress / final）──
    if (accContent.trim()) {
      if (gotToolUse) {
        yield { type: 'assistant_phase', phase: 'progress', step: ctx.step, reactPhase: 'progress' };
      } else {
        yield { type: 'assistant_promote' };
        yield { type: 'assistant_phase', phase: 'final', step: ctx.step, reactPhase: 'final' };
      }
    }

    if (!gotToolUse) {
      // afterFinal：最终答复路径的 afterLLM 关注点（递减/未完成/短答复）
      const af = await runAfterLLM(api, mw.afterFinal);
      for (const e of af.events) yield e;
      if (af.control === 'continue') continue;
      if (af.control === 'stop') return;

      // 收尾：落盘 + compact
      await opts.history.compact({ signal: opts.signal });
      await tlog('assistant_message', { content: accContent });
      yield { type: 'done', reason: 'model_stop' };
      return;
    }

    // ═══════════════════════════════════════════════════════════════
    // ④ 执行工具（ReAct 固有步：权限/awaitUser/执行/clamp/失败反思）
    // ═══════════════════════════════════════════════════════════════
    const assistantToolCalls: ToolCall[] = pendingToolCalls.map((t) => ({
      id: t.id,
      type: 'function',
      function: { name: t.name, arguments: JSON.stringify(t.arguments) },
    }));
    opts.history.addAssistant(accContent, assistantToolCalls);
    await tlog('assistant_message', {
      content: accContent,
      toolCalls: assistantToolCalls.map((t) => ({ id: t.id, name: t.function.name, arguments: t.function.arguments })),
    });

    const iterToolResults: boolean[] = [];
    const iterSigParts: string[] = [];
    const roundTargets: string[] = [];
    let roundMutated = false;
    const successChecks: string[] = [];

    for (const tc of pendingToolCalls) {
      try {
        // 模型主动 awaitUser：中途向用户提问（伪工具，不走编排者路由）
        if (tc.name === 'awaitUser') {
          const question = String((tc.arguments as Record<string, unknown>).question ?? '').trim();
          let reply: string;
          if (opts.askText) {
            reply = await opts.askText(question || '（模型未提供问题）');
          } else {
            const confirmed = await opts.ask(question || '（模型请求确认）');
            reply = confirmed ? '(yes)' : '(no)';
          }
          opts.history.addToolResult(tc.id, tc.name, JSON.stringify({ ok: true, output: reply }));
          await tlog('tool_result', { tool: tc.name, awaitUser: true, reply: reply.slice(0, 500) });
          yield { type: 'tool_result', toolName: tc.name, result: `用户回复: ${reply}`, step: ctx.step, reactPhase: 'observation' };
          iterToolResults.push(true);
          roundMutated = true;
          continue;
        }

        iterSigParts.push(`${tc.name}:${JSON.stringify(tc.arguments)}`);
        roundTargets.push(extractTarget(tc));

        // 工具调用事件（统一分发前发出）
        await tlog('tool_call', { tool: tc.name, args: tc.arguments });
        yield { type: 'tool_call', toolName: tc.name, args: tc.arguments, step: ctx.step, reactPhase: 'action' };

        // 统一消息驱动分发：路由→把关→授权→执行→截断 全经 ToolOrchestrator 单入口
        const outcome: ToolCallResult = await toolOrchestrator.dispatch({
          id: tc.id,
          name: tc.name,
          rawArguments: tc.arguments,
          ctx: {
            cwd: opts.cwd,
            signal: opts.signal,
            onProgress: opts.onToolProgress ? (text: string) => opts.onToolProgress!(tc.name, text) : undefined,
          },
        });

        // 排空调度期间产生的权限事件（deny / confirm 结果），转交 UI
        for (const pe of permissionEvents.splice(0)) {
          yield { type: 'permission', toolName: pe.toolName, granted: pe.granted };
          await tlog('permission_decision', { tool: pe.toolName, mode: opts.permission, granted: pe.granted });
        }

        if (outcome.denied) {
          const denyMsg = outcome.output || `用户拒绝执行 ${tc.name}（权限模式: ${opts.permission}）`;
          opts.history.addToolResult(tc.id, tc.name, JSON.stringify({ ok: false, output: denyMsg }));
          await tlog('tool_result', { tool: tc.name, toolCallId: tc.id, name: tc.name, denied: true, reason: denyMsg });
          yield { type: 'tool_result', toolName: tc.name, result: denyMsg, step: ctx.step, reactPhase: 'observation' };
          iterToolResults.push(false);
          continue;
        }

        if (outcome.needSelfHeal) {
          // 路由/把关失败：回灌字段级错误，模型自愈
          const healMsg = outcome.output || `[工具 ${tc.name} 参数校验失败]`;
          opts.history.addToolResult(tc.id, tc.name, JSON.stringify({ ok: false, output: healMsg }));
          await tlog('tool_result', { tool: tc.name, toolCallId: tc.id, name: tc.name, ok: false, needSelfHeal: true });
          yield { type: 'tool_result', toolName: tc.name, result: healMsg, step: ctx.step, reactPhase: 'observation' };
          iterToolResults.push(false);
          continue;
        }

        // 正常执行结果（outcome.output 已由编排者截断）
        const clampedOutput = outcome.output;
        if (!outcome.ok) {
          const failN = (ctx.perToolFailures.get(tc.name) ?? 0) + 1;
          ctx.perToolFailures.set(tc.name, failN);
          iterToolResults.push(false);

          let diagnostic: string;
          if (failN === 1) {
            diagnostic = `请分析失败原因（工具: ${tc.name}），调整策略后重试——可以换参数、换工具、或换方法。`;
          } else if (failN === 2) {
            diagnostic =
              `这个工具已连续失败 ${failN} 次。请深入思考：\n` +
              `- 参数是否正确？是否漏了必要的前置步骤？\n` +
              `- 换个工具能否达到相同目标？（如 read_file 失败可试试 search_code 定位）\n` +
              `- 是否需要先检查当前工作区状态？`;
          } else {
            diagnostic =
              `这个工具已失败 ${failN} 次。强烈建议停止对这个工具的尝试，并考虑：\n` +
              `- 向用户说明你遇到的问题并请求澄清或指示\n` +
              `- 调用 verify_code 或 review_code 检查已生成的代码是否有问题\n` +
              `- 重新审视用户原始需求，确认是否误解了任务方向`;
          }
          const reflectionMsg =
            `[工具执行失败 (第 ${failN} 次) — 请自我纠正]\n` +
            `工具: ${tc.name}\n参数: ${JSON.stringify(tc.arguments)}\n` +
            `错误: ${clampedOutput}\n\n${diagnostic}`;
          opts.history.addToolResult(tc.id, tc.name, JSON.stringify({ ok: false, output: reflectionMsg }));
          await tlog('tool_result', { tool: tc.name, toolCallId: tc.id, name: tc.name, ok: false, failCount: failN, reflected: true });
          yield { type: 'tool_result', toolName: tc.name, result: `[失败#${failN}] ${clampedOutput.slice(0, 300)}... → Agent 将自我纠正`, step: ctx.step, reactPhase: 'observation' };
        } else {
          ctx.perToolFailures.delete(tc.name);
          opts.history.addToolResult(tc.id, tc.name, JSON.stringify({ ok: true, output: clampedOutput }));
          await tlog('tool_result', { tool: tc.name, toolCallId: tc.id, name: tc.name, ok: true, output: clampedOutput.slice(0, 3000) });
          yield { type: 'tool_result', toolName: tc.name, result: clampedOutput, step: ctx.step, reactPhase: 'observation' };
          iterToolResults.push(true);
          if (MUTATING_TOOLS.has(tc.name)) roundMutated = true;
          if (MUTATING_TOOLS.has(tc.name) && outcome.ok) {
            successChecks.push(`[系统提示] ${tc.name} 已执行成功。请在下一轮给出推理时，用一句话确认：产出是否符合预期？（如「文件已创建，入口逻辑正确」）`);
          }
        }
      } catch (e: unknown) {
        const isAbort = opts.signal?.aborted || (e instanceof Error && e.name === 'AbortError');
        const err = isAbort ? '用户已中断此工具执行' : `工具执行异常: ${errMsg(e)}`;
        opts.history.addToolResult(tc.id, tc.name, JSON.stringify({ ok: false, output: err }));
        await tlog('tool_result', { tool: tc.name, toolCallId: tc.id, name: tc.name, ok: false, output: err });
        yield { type: 'tool_result', toolName: tc.name, result: err, step: ctx.step, reactPhase: 'observation' };
        iterToolResults.push(false);
        if (isAbort) {
          yield { type: 'assistant_phase', phase: 'final' };
          yield { type: 'done', reason: 'user_abort' };
          return;
        }
      }
    }

    ctx.iterToolResults = iterToolResults;
    ctx.roundMutated = roundMutated;
    ctx.roundTargets = roundTargets;
    ctx.iterSigParts = iterSigParts;
    ctx.successChecks = successChecks;

    // ── afterDispatch：成功路径验证提示插入 ──
    for (const m of mw.afterDispatch) {
      const events = await safeSeam(() => m(api), 'afterDispatch');
      if (events) for (const e of events) yield e;
    }

    // ── DriftTracker 世界状态增量记录 ──
    const anySuccess = iterToolResults.some(Boolean);
    ctx.drift.record(
      roundTargets.filter((t) => t.startsWith('read_file:') || t.startsWith('search_code:') || t.startsWith('search_files:') || t.startsWith('grep:') || t.startsWith('list_dir:')),
      roundTargets.filter((t) => t.startsWith('edit_file:') || t.startsWith('write_file:') || t.startsWith('create_file:') || t.startsWith('run_command:') || t.startsWith('delete_file:')),
      !anySuccess,
    );
    ctx.totalToolRounds++;
    if (roundMutated) ctx.everMutated = true;

    // ── onRoundEnd：守卫 1-3 / replan / compact / todo / 身份重注 ──
    const re = await runOnRoundEnd(api, mw.onRoundEnd);
    for (const e of re.events) yield e;
    if (re.control === 'continue') continue;
    if (re.control === 'stop') return;

    // 继续循环，把工具结果回灌给模型
  }

  // 兜底：正常流程在 iter===maxIter 时已进入总结轮并 return
  if (trace) await trace.end();
  await tlog('early_exit', { reason: 'max_iterations_fallback', iterations: maxIter });
  yield { type: 'assistant_phase', phase: 'final' };
  yield { type: 'assistant_text', text: `已达到最大迭代轮数上限（${maxIter} 轮），任务强制结束。如果结果未达预期，可以让我继续或调整指令。` };
  yield { type: 'done', reason: 'max_iterations' };
}

// ════════════════════════════════════════════════════════════════
// 接缝执行 + onError 边界
// ════════════════════════════════════════════════════════════════

/** 每个中间件调用的独立异常边界：异常降级为日志，绝不冒泡到内核。 */
async function safeSeam<T>(fn: () => Promise<T> | T, label: string): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e: unknown) {
    logger.warn(`[agent core] middleware ${label} threw, degraded: ${errMsg(e)}`);
    return undefined;
  }
}

async function runAfterLLM(api: CoreApi, fns: AfterLLM[]): Promise<{ control?: 'continue' | 'stop'; events: AgentEvent[] }> {
  const events: AgentEvent[] = [];
  for (const fn of fns) {
    const r = await safeSeam(() => fn(api, {
      accContent: api.ctx.accContent,
      pendingToolCalls: api.ctx.pendingToolCalls,
      gotToolUse: api.ctx.gotToolUse,
      hasRunTools: api.ctx.hasRunTools,
    }), 'afterLLM');
    if (r?.events) events.push(...r.events);
    if (r?.control === 'continue') return { control: 'continue', events };
    if (r?.control === 'stop') return { control: 'stop', events };
  }
  return { events };
}

async function runOnRoundEnd(api: CoreApi, fns: OnRoundEnd[]): Promise<{ control?: 'continue' | 'stop'; events: AgentEvent[] }> {
  const events: AgentEvent[] = [];
  for (const fn of fns) {
    const r = await safeSeam(() => fn(api), 'onRoundEnd');
    if (r?.events) events.push(...r.events);
    if (r?.control === 'continue') return { control: 'continue', events };
    if (r?.control === 'stop') return { control: 'stop', events };
  }
  return { events };
}
