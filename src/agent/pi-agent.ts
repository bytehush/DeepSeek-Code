/**
 * Pi Agent 适配层（P1 引擎切换）。
 *
 * `runPiAgent` 驱动一个**持久化**的 Pi `Agent`（每次 `prompt` 累积上下文，
 * 等价取代旧的「每轮从 ConversationHistory 重建」语义，多轮对话不丢上下文）。
 * 产出与旧 `runAgent` 完全一致的 `AgentEvent` union → GUI 事件契约零改动。
 *
 * 权限闸：Pi 的 `beforeToolCall` 钩子映射自研 PermissionMode（explore/ask/execute）。
 * 极简模式：仅驱动引擎 + 4 原子工具，不做记忆/技能/多 Agent 等附加层。
 */
import { type Agent, type AgentTool, type BeforeToolCallResult, type AgentToolResult } from '@earendil-works/pi-agent-core';
import { type Models, type AssistantMessage } from '@earendil-works/pi-ai';
import { getMode } from '../config/model-mode.ts';
import type { AgentEvent, RunOptions } from './loop.ts';
import type { PermissionMode } from '../permission/index.ts';

/**
 * 把底层抛出的原始错误归类，便于上层（chat.ts friendlyErrorMessage）给出差异化友好提示。
 * 返回值对应 friendlyErrorMessage 的分支 key。
 */
function classifyError(raw: string): string | undefined {
  const r = raw.toLowerCase();
  if (/401|authentication fails|api[ _-]?key|unauthorized|incorrect api key/.test(r)) return 'auth';
  if (/moderation|sensitive|content.*policy/.test(r)) return 'moderation';
  if (/context length|maximum context|token.*limit|too many tokens/.test(r)) return 'token_limit';
  if (/429|rate limit|quota|503|502|server error|timeout|timed out|connection/.test(r))
    return 'server_unavailable';
  return undefined;
}

/** 破坏性工具判定（P1 内置，后续可迁出到 permission/ 复用） */
function isMutatingTool(toolName: string): boolean {
  return toolName === 'write_file' || toolName === 'edit_file' || toolName === 'bash';
}

function extractToolText(result: AgentToolResult<unknown> | undefined): string {
  if (!result || !result.content) return '';
  return result.content
    .map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : ''))
    .join('\n');
}

/**
 * 驱动持久化 Pi Agent 跑一轮，yield 与旧 runAgent 同形状的 AgentEvent。
 *
 * @param input   本轮用户输入
 * @param opts    见 RunOptions（需含 agent / models / permission）
 */
export async function* runPiAgent(input: string, opts: RunOptions): AsyncGenerator<AgentEvent> {
  const { agent, models, permission, signal, onToolProgress, ask } = opts;
  const aborted = { current: signal?.aborted ?? false };

  // —— 每轮按模式切换模型与思考档位 ——
  const reasoner = getMode() === 'pro';
  const modelId = reasoner ? 'deepseek-v4-pro' : 'deepseek-v4-flash';
  const model = models.getModel('deepseek', modelId);
  if (!model) throw new Error(`Pi 模型未找到: deepseek/${modelId}`);
  agent.state.model = model;
  agent.state.thinkingLevel = reasoner ? 'high' : 'off';

  // —— 权限闸：映射 PermissionMode ——
  agent.beforeToolCall = async ({ toolCall }): Promise<BeforeToolCallResult | undefined> => {
    if (permission === 'explore' && isMutatingTool(toolCall.name)) {
      return { block: true, reason: `当前为只读模式（explore），已拦截写操作: ${toolCall.name}`, terminate: true };
    }
    if (permission === 'ask' && isMutatingTool(toolCall.name)) {
      const ok = ask ? await ask(`允许执行 ${toolCall.name}？`) : false;
      if (!ok) return { block: true, reason: `用户拒绝了 ${toolCall.name}`, terminate: true };
    }
    return undefined;
  };

  // —— 中断接线 ——
  if (signal) {
    if (signal.aborted) aborted.current = true;
    else
      signal.addEventListener(
        'abort',
        () => {
          aborted.current = true;
          agent.abort();
        },
        { once: true },
      );
  }

  // —— 事件队列：Pi 订阅 → 翻译为 AgentEvent → 生成器 yield ——
  const queue: AgentEvent[] = [];
  let resolveNext: (() => void) | null = null;
  let settled = false;
  const push = (e: AgentEvent): void => {
    queue.push(e);
    resolveNext?.();
  };

  const unsubscribe = agent.subscribe((event) => {
    switch (event.type) {
      case 'message_update': {
        const ae = event.assistantMessageEvent;
        if (ae?.type === 'text_delta') {
          // 最终答案正文 → 路由到「最终答案气泡」（reactPhase: 'final'）
          push({ type: 'assistant_text', text: ae.delta, reactPhase: 'final' });
        } else if (ae?.type === 'thinking_delta') {
          // 推理过程 → 思考盒（reactPhase: 'thought'）
          push({ type: 'assistant_text', text: ae.delta, reactPhase: 'thought' });
        }
        break;
      }
      case 'tool_execution_start':
        push({ type: 'tool_call', toolName: event.toolName, args: event.args });
        break;
      case 'tool_execution_end':
        push({
          type: 'tool_result',
          toolName: event.toolName,
          result: extractToolText(event.result as AgentToolResult<unknown> | undefined),
        });
        break;
      case 'tool_execution_update': {
        // 实时工具输出（如 bash stdout）：经 opts.onToolProgress 推给 GUI 思考盒
        const content = event.partialResult?.content;
        if (Array.isArray(content) && onToolProgress) {
          const text = content
            .map((c: { type: string; text?: string }) => (c.type === 'text' ? c.text ?? '' : ''))
            .join('');
          if (text) onToolProgress(event.toolName, text);
        }
        break;
      }
      case 'message_end': {
        // event.message 是 AgentMessage(=Message)，需收窄到 AssistantMessage 取 stopReason
        const m = event.message as AssistantMessage;
        if (m.role === 'assistant' && m.stopReason === 'error') {
          const errText = m.errorMessage ?? '模型返回错误';
          push({ type: 'error', error: errText, errorCategory: classifyError(errText) });
        }
        break;
      }
      case 'agent_end':
        settled = true;
        // 唤醒消费者循环：settled 已置位但循环可能正 parked 在 resolveNext 上，
        // 不唤醒则拿到终态后无法 break，导致生成器悬挂（Node 事件循环空 → 静默退出）。
        resolveNext?.();
        break;
    }
  });

  try {
    const promptPromise = agent.prompt(input);
    // yield 循环：队列优先，收尾后退出
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (settled) break;
      await new Promise<void>((r) => {
        resolveNext = r;
      });
    }
    await promptPromise;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const cat = classifyError(msg);
    // 去重：若 message_end 已上报过 error，避免再补一条重复报错刷屏
    if (!queue.some((q) => q.type === 'error')) {
      push({ type: 'error', error: msg, errorCategory: cat });
    }
    // 把错误也 yield 出去
    while (queue.length > 0) yield queue.shift()!;
  } finally {
    unsubscribe();
  }

  // 收尾事件
  yield { type: 'done', reason: aborted.current ? 'user_abort' : 'model_stop' };
}
