/**
 * 框架无关的编排核心（trace-first TUI 重做后的形态）。
 *
 * 对话循环收敛为最小集：命令优先 / 调用 kernel.prompt / 事件进 UI 事件日志。
 * 事件契约 CoreEvent 与旧 AgentEvent 逐字段一致 → UI fold、trace 落盘、
 * eval 记录共用同一条流（三个消费者，一份形状）。
 *
 * 与旧版的关键差别：这里不再做「事件 → 气泡操作」的命令式映射
 * （beginTool/appendStreaming 那套）——事件原样交给 ctx.uiEv，
 * 由 app/timeline.ts 的 fold 决定如何呈现。编排层管"发生什么"，
 * 呈现层管"怎么说"，两层各改各的。
 */
import type { PermissionMode } from '../core/permission/engine.ts';
import type { OutputStyle } from '../core/loop/output-style.ts';
import { styleLabel, parseStyle, saveStyle, styleInstruction } from '../core/loop/output-style.ts';
import { getMode, setMode, parseMode, modeLabel } from '../config/model-mode.ts';
import { msgOf } from '../utils/logger.ts';
import { rollbackManager } from '../utils/rollback.ts';
import type { UiEvent } from './timeline.ts';
import type { AppProps } from './types.ts';

/**
 * UI 抽象契约：编排核心只通过它产生副作用，具体渲染由实现方决定（CLI/TUI 用 ink）。
 * 事件驱动——实现方的全部呈现状态由 uiEv 追加的事件日志派生。
 */
export interface ChatContext {
  props: AppProps;
  cwd: string;
  /** 追加一条 UI 事件（CoreEvent 或 UI 侧合成事件），渲染由 fold 决定 */
  uiEv(ev: UiEvent): void;
  /** 直接写一行系统提示（/help、模式切换等命令反馈） */
  systemText(text: string): void;
  /** 清空事件日志（/clear；呈现层归零，内核列由调用方同步清空） */
  resetEvents(): void;
  setBusy(b: boolean): void;
  getState(): { mode: PermissionMode; planMode: boolean; outputStyle: OutputStyle };
  maxIterations: number;
  setMode(m: PermissionMode): void;
  setPlanMode(b: boolean): void;
  setOutputStyle(s: OutputStyle): void;
  /** 注册当前活跃的 AbortController，供 ctx.abort() 中断 */
  setActiveAbort(ac: AbortController | null): void;
  /** 中断当前 Agent 运行 */
  abort(): void;
  /** 权限确认：agent 挂起等待用户 y/n */
  requestConfirm(prompt: string): Promise<boolean>;
  /** 模型主动 awaitUser：agent 挂起等待用户自由文本 */
  requestAskText(prompt: string): Promise<string>;
  /** 更换 API Key（UI 专属；未实现则给提示） */
  requestKeyChange?(): void;
  /** 退出（/exit）：实现方决定如何结束（CLI=process.exit，后端=关连接） */
  onExit?(): void;
}

// ── 模块级可变状态（单活跃对话假设） ──
/** 本轮任务起点（毫秒），用于结束后回显耗时 */
let taskStart = 0;

/** 单轮用户输入的默认步数上限（一步 = 一次模型调用 + 其工具执行） */
export const DEFAULT_MAX_ITERATIONS = 30;

const SHORTCUTS = [
  '命令：',
  '  /mode explore|ask|execute   切换权限模式',
  '  /plan                       开/关规划模式（只输出计划不执行）',
  '  /style human|professional|raw   切换最终答复风格（人话/专业语言/原始）',
  '  /model flash|pro            切换主推理模型：Flash（日常/轻量）| PRO（开发/严肃工程）',
  '  /clear                      清空对话上下文与持久化会话',
  '  /set-key 或 /login          更换 API Key（保存后下次启动生效）',
  '  /rollback [n]               回退最近 n 次文件变更（默认 1；仅当前工作目录）',
  '  /outbound                   查看出站数据留档摘要（外传了什么、体积、目的地）',
  '  Ctrl+O                      展开/收起过程细节（工具参数与结果）',
  '  Ctrl+C                      中断当前思考 / 工具执行（退出请用 /exit）',
  '  /help 或 ?                  显示本面板',
  '  /exit 或 /quit              退出',
].join('\n');

/** 退出原因 → 面向用户的交代（每条退出路径都要说清为什么停） */
const STOP_LABELS: Record<string, string> = {
  user_abort: '⏹ 已因用户中断而停止',
  no_progress: '⚠️ 工具连续失败，已停止尝试并向你说明现状',
  repeat_loop: '⚠️ 检测到周期性重复调用，疑似空转，已提前结束',
  max_iterations: '⏱ 已达单轮步数上限（默认 30 步）并结束；若任务未完成，请把大目标拆成几步分别下达',
  token_limit: '📏 输出被长度上限截断且分块续写仍未成功（上下文压缩能力 P1 上线前的临时终态）',
};

/**
 * 斜杠命令处理；返回 true 表示已处理（不跑 agent）。
 * 与渲染无关的纯逻辑，所有副作用走 ctx。
 */
export async function handleSlashCommand(text: string, ctx: ChatContext): Promise<boolean> {
  if (text === '/exit' || text === '/quit') {
    ctx.onExit?.();
    return true;
  }
  if (text === '/help' || text === '?' || text === '？') {
    ctx.systemText(SHORTCUTS);
    return true;
  }
  if (text === '/clear') {
    ctx.props.kernel.clear();
    ctx.props.session.clear();
    ctx.resetEvents();
    ctx.systemText('已清空对话上下文与持久化会话（下次启动不再恢复）');
    return true;
  }
  if (text.startsWith('/mode')) {
    const m = text.split(' ')[1];
    if (m === 'explore' || m === 'ask' || m === 'execute') {
      ctx.setMode(m);
      const label: Record<string, string> = {
        ask: '任务助理（对话 / 提问，需要你确认才动手）',
        explore: '研究模式（只读探索，不会改动任何文件）',
        execute: '自动执行（Agent 直接干活，无需逐步确认）',
      };
      ctx.systemText(`🔐 权限模式已切换为：${label[m] ?? m}`);
    } else {
      ctx.systemText('用法: /mode explore|ask|execute');
    }
    return true;
  }
  if (text === '/plan') {
    const next = !ctx.getState().planMode;
    ctx.setPlanMode(next);
    ctx.systemText(`规划模式已${next ? '开启（Agent 将先输出计划）' : '关闭（正常执行）'}`);
    return true;
  }
  if (text === '/style' || text.startsWith('/style ')) {
    const arg = text.slice('/style'.length).trim();
    const cur = ctx.getState().outputStyle;
    if (!arg) {
      ctx.systemText(`当前输出风格：${styleLabel(cur)}  （可选：human 人话 / professional 专业语言 / raw 原始）`);
    } else {
      const s = parseStyle(arg);
      if (!s) {
        ctx.systemText('用法：/style human | professional | raw');
      } else {
        ctx.setOutputStyle(s);
        saveStyle(ctx.cwd, s);
        ctx.systemText(`输出风格已切换为：${styleLabel(s)}`);
      }
    }
    return true;
  }
  if (text === '/model' || text.startsWith('/model ')) {
    const arg = text.slice('/model'.length).trim();
    const cur = getMode();
    if (!arg) {
      ctx.systemText(
        `当前模型模式：${modeLabel(cur)}\n` +
          `  /model flash   日常/轻量：快速问答、解释代码、简单改错、跑命令看输出、成本敏感多轮（不触发强推理）\n` +
          `  /model pro     开发/严肃工程：架构设计、跨文件重构、深度审查、依赖审计、多步规划、需深度推理的生成（触发强推理）\n` +
          `  提示：coding agent 里几乎所有事都是开发，「日常」指轻量交互而非「非开发」；拿不准要深度就切 pro。`,
      );
    } else {
      const m = parseMode(arg);
      if (!m) {
        ctx.systemText('用法：/model flash | pro');
      } else {
        setMode(ctx.cwd, m);
        ctx.systemText(`模型模式已切换为：${modeLabel(m)}`);
      }
    }
    return true;
  }
  if (text === '/set-key' || text === '/login') {
    if (ctx.requestKeyChange) ctx.requestKeyChange();
    else ctx.systemText('更换 API Key 需在终端版执行 /set-key，或编辑 ~/.dsa/credentials.json');
    return true;
  }
  if (text === '/outbound') {
    ctx.systemText(ctx.props.ledger.summarize());
    return true;
  }
  if (text === '/rollback' || text.startsWith('/rollback ')) {
    const arg = text.split(/\s+/)[1];
    const steps = arg ? parseInt(arg, 10) : 1;
    const report = await rollbackManager.rollback(Number.isFinite(steps) ? steps : 1, ctx.cwd);
    ctx.systemText(report);
    return true;
  }
  return false;
}

/**
 * 回合收尾交代（仅 CLI 消费的事件扩展，不入内核契约）：
 * 耗时 + 非正常退出原因——trace/eval 各自按 CoreEvent 语义处理，互不影响。
 */
export interface TurnSummaryEvent {
  type: 'turn_summary';
  durationSec: number;
  /** 非 model_stop 退出时的交代文案；正常收尾为 undefined */
  label?: string;
}

/**
 * 跑一轮对话（CLI 与后续 UI 实现共用）。
 * 负责：命令优先 / 调用内核循环 / 事件进 UI 事件日志。
 */
export async function runChatTurn(raw: string, ctx: ChatContext): Promise<void> {
  const text = raw.trim();
  if (!text) return;

  const isCommand = text.startsWith('/');
  if (!isCommand) {
    ctx.uiEv({ type: 'user_input', text });
  }

  if (isCommand) {
    const handled = await handleSlashCommand(text, ctx);
    if (handled) return;
  }

  ctx.setBusy(true);
  const abortController = new AbortController();
  ctx.setActiveAbort(abortController);
  taskStart = Date.now();

  try {
    for await (const ev of ctx.props.kernel.prompt(text, {
      permission: ctx.getState().mode,
      planMode: ctx.getState().planMode,
      styleInstruction: styleInstruction(ctx.getState().outputStyle),
      // 真实步数上限：此前该字段声明了却从未传入内核，等于无上限——
      // 任何未被 repeat/no_progress 抓住的失败模式都会无限烧 token。
      maxIterations: ctx.maxIterations > 0 ? ctx.maxIterations : DEFAULT_MAX_ITERATIONS,
      signal: abortController.signal,
      ask: ctx.requestConfirm,
      onToolProgress: (_toolName: string, out: string) => {
        ctx.uiEv({ type: 'tool_progress', text: out });
      },
    })) {
      ctx.uiEv(ev);
      if (ev.type === 'done') {
        const summary: TurnSummaryEvent = {
          type: 'turn_summary',
          durationSec: (Date.now() - taskStart) / 1000,
        };
        if (ev.reason && ev.reason !== 'model_stop') {
          summary.label = STOP_LABELS[ev.reason] ?? `⚠️ 停止原因: ${ev.reason}`;
        }
        ctx.uiEv(summary);
      }
    }
  } catch (e: unknown) {
    ctx.uiEv({ type: 'error', error: msgOf(e), errorCategory: 'local' });
  } finally {
    // 回合结束即快照内核消息列（含中断/报错收尾——那些也是有价值的上下文）。
    // 在 finally 而非 done 事件里：生成器被提前 return 时也要落盘，
    // 保存的正是"此刻内核真实记得的东西"，与 UI 显示无涉。
    ctx.props.session.save(ctx.props.kernel.history);
    ctx.setBusy(false);
    ctx.setActiveAbort(null);
  }
}
