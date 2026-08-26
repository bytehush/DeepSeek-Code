/**
 * 框架无关的编排核心（极简模式）。
 *
 * 把「单次事实来源」的对话循环收敛为最小集：命令优先 / 调用 runAgent / 流式事件映射到 ctx。
 * 不再包含记忆、技能、Trace、多 Agent 会话、用量统计等附加层——那些在减法阶段已移除。
 */
import { runAgent, type AgentEvent, type PermissionMode } from '../agent/loop.ts';
import type { OutputStyle } from '../agent/output-style.ts';
import { styleLabel, parseStyle, saveStyle } from '../agent/output-style.ts';
import { getMode, setMode, parseMode, modeLabel } from '../config/model-mode.ts';
import { msgOf } from '../utils/logger.ts';
import { rollbackManager } from '../utils/rollback.ts';
import type { AppProps, MsgRole, UiMessage } from './types.ts';

/**
 * UI 抽象契约：编排核心只通过它产生副作用，具体渲染由实现方决定（CLI/TUI 用 ink）。
 */
export interface ChatContext {
  props: AppProps;
  cwd: string;
  /** 新增一条消息，返回其 id */
  push(role: MsgRole, text: string): number;
  /** 向指定 id 的消息追加文本 */
  appendTo(id: number, chunk: string): void;
  /** 流式 assistant 文本：首段建消息，后续追加 */
  appendStreaming(chunk: string, reactPhase?: 'thought' | 'action' | 'observation' | 'final' | 'progress'): void;
  /** 本轮流式文本收尾 */
  endStreaming(phase?: 'progress' | 'final', interrupted?: boolean): void;
  /** 把当前思考轮次已实时流到的文本晋升为最终答案气泡（清空思考盒） */
  prometeThinkingToFinal(): void;
  /** 开始一次工具调用：收束流 + 新建工具消息，返回 id 并记为 current tool */
  beginTool(toolName: string): void;
  /** 实时工具输出（实现方自行加 `  › ` 前缀） */
  appendTool(out: string): void;
  /** 工具调用结束 */
  endTool(): void;
  /** 把本轮错误附加到思考盒——不创建新气泡、不清除已记录的思考 */
  appendError(msg: string): void;
  setBusy(b: boolean): void;
  setCost(cny: number): void;
  getState(): { mode: PermissionMode; planMode: boolean; outputStyle: OutputStyle };
  maxIterations: number;
  setMaxIterations(n: number): void;
  getIterations(): number;
  setBrowserWatch(b: boolean): void;
  getBrowserWatch(): boolean;
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
  getMessages(): UiMessage[];
  setMessages(ms: UiMessage[]): void;
  /** 更换 API Key（UI 专属；未实现则给提示） */
  requestKeyChange?(): void;
  /** 退出（/exit）：实现方决定如何结束（CLI=process.exit，后端=关连接） */
  onExit?(): void;
}

// ── 模块级可变状态（单活跃对话假设） ──
/** 本轮任务起点（毫秒），用于结束后回显耗时 */
let taskStart = 0;

const SHORTCUTS = [
  '命令：',
  '  /mode explore|ask|execute   切换权限模式',
  '  /plan                       开/关规划模式（只输出计划不执行）',
  '  /style human|professional|raw   切换最终答复风格（人话/专业语言/原始）',
  '  /model flash|pro            切换主推理模型：Flash（日常/轻量）| PRO（开发/严肃工程）',
  '  /clear                      清空对话上下文',
  '  /set-key 或 /login          更换 API Key（保存后下次启动生效）',
  '  /rollback [n]               回退最近 n 次文件变更（默认 1；仅当前工作目录）',
  '  Ctrl+C                      中断当前思考 / 工具执行（退出请用 /exit）',
  '  /help 或 ?                  显示本面板',
  '  /exit 或 /quit              退出',
].join('\n');

/** 时长 → 中文单位（内联，避免从 ink 组件文件导出带来渲染层依赖） */
function formatDuration(sec: number): string {
  if (sec < 60) return sec.toFixed(1) + '秒';
  if (sec < 3600) return `${Math.floor(sec / 60)}分${Math.floor(sec % 60)}秒`;
  return `${Math.floor(sec / 3600)}时${Math.floor((sec % 3600) / 60)}分${Math.floor(sec % 60)}秒`;
}

/** 服务端错误分类 → 面向用户的友好提示 */
function friendlyErrorMessage(category: string | undefined, raw: string): string {
  switch (category) {
    case 'moderation':
      return '🚫 内容审核未通过：服务端拒绝生成该内容（可能涉及敏感/违规话题）。请调整提问方式或措辞后重试。';
    case 'token_limit':
      return '📏 上下文 / token 超出上限：当前对话历史过长，已无法继续生成。建议新开一个会话再试。';
    case 'server_unavailable':
      return '🔌 服务端暂时不可用（限流或服务过载）：请稍候片刻后重试；若持续出现，请检查 API Key 配额或网络连通性。';
    case 'auth': {
      // 从脱敏后的报错里提取当前 Key 末尾 4 位（如 "Your api key: ****90c1 is invalid"）。
      // 该串由 DeepSeek 服务端脱敏，不含完整 Key，安全可展示。
      const tail = /api key:\s*\*+([0-9a-zA-Z]{4})/i.exec(raw);
      const tailText = tail ? `   当前使用的 Key 末尾 4 位：${tail[1]}（已由服务商脱敏，非完整 Key）` : '';
      return (
        '🔑 API Key 无效或未授权（DeepSeek 返回 401 鉴权失败）\n' +
        '   修复方式（任选其一）：\n' +
        '     · 修改项目根 .env 的 DEEPSEEK_API_KEY，或编辑 ~/.dsa/credentials.json\n' +
        '     · 输入 /set-key 按提示填新 Key（下次启动生效）\n' +
        '     · 确认该 Key 在 DeepSeek 后台处于「启用」状态且有可用额度\n' +
        tailText
      );
    }
    default:
      return `⚠️ 生成出错：${raw || '未知错误'}`;
  }
}

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
    ctx.push('system', SHORTCUTS);
    return true;
  }
  if (text === '/clear') {
    ctx.setMessages([]);
    ctx.push('system', '已清空对话上下文');
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
      ctx.push('system', `🔐 权限模式已切换为：${label[m] ?? m}`);
    } else {
      ctx.push('system', '用法: /mode explore|ask|execute');
    }
    return true;
  }
  if (text === '/plan') {
    const next = !ctx.getState().planMode;
    ctx.setPlanMode(next);
    ctx.push('system', `规划模式已${next ? '开启（Agent 将先输出计划）' : '关闭（正常执行）'}`);
    return true;
  }
  if (text === '/style' || text.startsWith('/style ')) {
    const arg = text.slice('/style'.length).trim();
    const cur = ctx.getState().outputStyle;
    if (!arg) {
      ctx.push('system', `当前输出风格：${styleLabel(cur)}  （可选：human 人话 / professional 专业语言 / raw 原始）`);
    } else {
      const s = parseStyle(arg);
      if (!s) {
        ctx.push('system', '用法：/style human | professional | raw');
      } else {
        ctx.setOutputStyle(s);
        saveStyle(ctx.cwd, s);
        ctx.push('system', `输出风格已切换为：${styleLabel(s)}`);
      }
    }
    return true;
  }
  if (text === '/model' || text.startsWith('/model ')) {
    const arg = text.slice('/model'.length).trim();
    const cur = getMode();
    if (!arg) {
      ctx.push(
        'system',
        `当前模型模式：${modeLabel(cur)}\n` +
          `  /model flash   日常/轻量：快速问答、解释代码、简单改错、跑命令看输出、成本敏感多轮（不触发强推理）\n` +
          `  /model pro     开发/严肃工程：架构设计、跨文件重构、深度审查、依赖审计、多步规划、需深度推理的生成（触发强推理）\n` +
          `  提示：coding agent 里几乎所有事都是开发，「日常」指轻量交互而非「非开发」；拿不准要深度就切 pro。`,
      );
    } else {
      const m = parseMode(arg);
      if (!m) {
        ctx.push('system', '用法：/model flash | pro');
      } else {
        setMode(ctx.cwd, m);
        ctx.push('system', `模型模式已切换为：${modeLabel(m)}`);
      }
    }
    return true;
  }
  if (text === '/set-key' || text === '/login') {
    if (ctx.requestKeyChange) ctx.requestKeyChange();
    else ctx.push('system', '更换 API Key 需在终端版执行 /set-key，或编辑 ~/.dsa/credentials.json');
    return true;
  }
  if (text === '/rollback' || text.startsWith('/rollback ')) {
    const arg = text.split(/\s+/)[1];
    const steps = arg ? parseInt(arg, 10) : 1;
    const report = await rollbackManager.rollback(Number.isFinite(steps) ? steps : 1, ctx.cwd);
    ctx.push('system', report);
    return true;
  }
  return false;
}

/** 把 runAgent 的一个事件映射到 ctx 的 UI 副作用（TUI 实现方共用） */
function applyRunAgentEvent(ev: AgentEvent, ctx: ChatContext): void {
  if (ev.type === 'assistant_text' && ev.text) {
    ctx.appendStreaming(ev.text, ev.reactPhase);
  } else if (ev.type === 'assistant_phase') {
    ctx.endStreaming(ev.phase);
  } else if (ev.type === 'assistant_promote') {
    ctx.prometeThinkingToFinal();
  } else if (ev.type === 'tool_call') {
    ctx.beginTool(ev.toolName ?? 'tool');
    if ((ev.toolName ?? '') === 'use_skill') {
      const argName = String((ev.args as { name?: unknown } | undefined)?.name ?? '').trim();
      ctx.push(
        'system',
        argName
          ? `📚 AI 已调用技能：${argName}（完整使用指引已加载，下一步将按其执行）`
          : '📚 AI 已调用技能加载工具。',
      );
    }
  } else if (ev.type === 'tool_result') {
    ctx.push('tool', `[工具结果] ${String(ev.result ?? '')}`);
  } else if (ev.type === 'error') {
    const isAuth = ev.errorCategory === 'auth';
    // auth 类错误：思考盒只放一句短提示（避免把原始 401 报文塞进折叠盒），完整修复指引走 system 消息
    ctx.appendError(isAuth ? '[鉴权失败] API Key 无效，请运行 /set-key 更换' : (ev.error ?? '未知错误'));
    ctx.push('system', friendlyErrorMessage(ev.errorCategory, ev.error ?? '未知错误'));
  } else if (ev.type === 'system') {
    ctx.push('system', ev.text ?? '');
  } else if (ev.type === 'done') {
    ctx.endStreaming(undefined, ev.reason === 'user_abort');
    const dur = (Date.now() - taskStart) / 1000;
    ctx.push('system', `⏱ 本次任务耗时 ${formatDuration(dur)}`);
    if (ev.reason && ev.reason !== 'model_stop') {
      const stopLabels: Record<string, string> = {
        user_abort: '⏹ 已因用户中断而停止',
        no_progress: '⚠️ 工具连续失败，已提前结束',
        no_observable_progress: '⚠️ 连续多轮无实质进展，疑似空转，已提前结束',
        repeat_loop: '⚠️ 检测到重复/周期工具调用，疑似死循环，已提前结束',
        max_iterations: '⏱ 已达最大迭代轮数上限，已结束',
      };
      ctx.push('system', stopLabels[ev.reason] ?? `⚠️ 停止原因: ${ev.reason}`);
    }
  }
}

/**
 * 跑一轮对话（CLI 与后续 UI 实现共用）。
 * 负责：命令优先 / 调用 runAgent 循环 / 流式事件映射到 ctx。
 */
export async function runChatTurn(raw: string, ctx: ChatContext): Promise<void> {
  const text = raw.trim();
  if (!text) return;

  const isCommand = text.startsWith('/');
  if (!isCommand) {
    ctx.push('user', text);
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
    for await (const ev of runAgent(text, {
      agent: ctx.props.agent,
      models: ctx.props.models,
      permission: ctx.getState().mode,
      signal: abortController.signal,
      ask: ctx.requestConfirm,
      askText: ctx.requestAskText,
      planMode: ctx.getState().planMode,
      outputStyle: ctx.getState().outputStyle,
      onToolProgress: (toolName: string, out: string) => {
        if (toolName) ctx.appendTool(out);
      },
    })) {
      applyRunAgentEvent(ev, ctx);
    }
  } catch (e: unknown) {
    ctx.appendError(msgOf(e));
  } finally {
    ctx.setBusy(false);
    ctx.setActiveAbort(null);
  }
}
