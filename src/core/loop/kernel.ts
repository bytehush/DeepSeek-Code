/**
 * AgentKernel —— 自研 ReAct 循环（内核基座的心脏）。
 *
 * 取代 @earendil-works/pi-agent-core 的 Agent：
 *   - 持久化 messages（跨轮累积上下文，等价旧 initialState 语义）；
 *   - 模型调用只走 ModelHub（因此出站记账不可绕过）；
 *   - 工具执行只走 ToolRegistry（因此权限维度来自工具自述，不按名字硬编码）；
 *   - 权限：decide3 纯函数裁决，副作用（询问/展示 diff）在调用方注入的 ask；
 *   - 事件输出 CoreEvent，形状与旧 AgentEvent 一致 → UI 契约零改动。
 *
 * 循环不变式（沿用旧内核验证过的四条）：
 *   1. 失败即回灌：工具 throw → 错误文本作为 tool 结果回灌模型，不静默跳过；
 *   2. 每步可中断：AbortSignal 贯通 hub 与工具，abort 后以 user_abort 收尾；
 *   3. 防空转：同工具+同参数连续重复 ≥3 次 → repeat_loop 停止；
 *   4. 退出路径全打标签：done.reason 覆盖 正常/中断/空转/超限/token。
 */
import type { ModelHub } from '../provider/hub.ts';
import type { PermissionMode, Risk } from '../permission/engine.ts';
import { decide3, matrixFromMode } from '../permission/engine.ts';
import type { ToolRegistry, ToolSpec } from '../tools/registry.ts';
import { buildSystemPrompt } from './system-prompt.ts';
import type { CoreEvent } from './events.ts';
import {
  assistantMsg,
  toolMsg,
  userMsg,
  type Msg,
  type StopReason,
  type Usage,
} from '../types.ts';

export interface KernelRunOptions {
  permission: PermissionMode;
  planMode: boolean;
  /** 输出风格指令（loop/output-style 的产物），以系统消息注入本轮 */
  styleInstruction?: string | null;
  signal?: AbortSignal;
  /** 权限确认：agent 挂起等待用户 y/n */
  ask?: (prompt: string) => Promise<boolean>;
  /** 工具实时输出回调（bash stdout） */
  onToolProgress?: (toolName: string, text: string) => void;
  /** 每轮（step）上限；0/缺省 = 无上限 */
  maxIterations?: number;
}

export interface KernelDeps {
  hub: ModelHub;
  registry: ToolRegistry;
  cwd: string;
  protectedRoots: string[];
  /** trace 消费者（可空） */
  trace?: {
    beginTurn(input: string): number;
    event(ev: CoreEvent): void;
    record(kind: string, detail?: unknown): void;
  };
  /** 当前 actor 模型显示名（惰性函数：/model 切换后下一轮即反映） */
  modelName(): string;
}

const REPEAT_LIMIT = 3;

export class AgentKernel {
  /** 持久化对话（跨轮累积）；system 不入列，每轮现场生成 */
  private messages: Msg[] = [];
  private totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  private aborted = false;

  constructor(private deps: KernelDeps) {}

  get history(): readonly Msg[] {
    return this.messages;
  }

  get usage(): Usage {
    return { ...this.totalUsage };
  }

  /** 清空上下文（/clear） */
  clear(): void {
    this.messages = [];
  }

  /**
   * 跑一轮用户输入，产出 CoreEvent 流。
   * 生成器被消费完（或 return）前不落终态——UI 按 done 收尾。
   */
  async *prompt(input: string, opts: KernelRunOptions): AsyncGenerator<CoreEvent> {
    this.aborted = false;
    this.deps.trace?.beginTurn(input);
    this.messages.push(userMsg(input));

    const signal = opts.signal;
    if (signal) {
      if (signal.aborted) this.aborted = true;
      else signal.addEventListener('abort', () => { this.aborted = true; }, { once: true });
    }

    let step = 0;
    let lastFinalText = '';
    /** 重复检测窗口：`name|JSON(args)` */
    const recentCalls: string[] = [];
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };

    const matrix = matrixFromMode(opts.permission);

    for (;;) {
      if (this.aborted) {
        yield* this.finish(opts, 'user_abort', usage);
        return;
      }
      step++;
      if (opts.maxIterations && opts.maxIterations > 0 && step > opts.maxIterations) {
        yield* this.finish(opts, 'max_iterations', usage);
        return;
      }

      // —— 组装本轮请求 ——
      const system = buildSystemPrompt(this.deps.registry, {
        workspace: this.deps.cwd,
        protectedRoots: this.deps.protectedRoots,
        planMode: opts.planMode,
        modelName: this.deps.modelName(),
      });
      const messages = this.messagesForModel(opts);

      // —— 调模型（唯一出口：hub）——
      let text = '';
      let toolCalls: Array<{ id: string; name: string; args: unknown }> = [];
      let streamError: { message: string; category: string } | null = null;
      try {
        for await (const ev of this.deps.hub.stream('actor', {
          system,
          messages,
          tools: this.deps.registry.wireSpecs(),
          signal,
        })) {
          if (this.aborted && ev.type !== 'message_end') continue;
          if (ev.type === 'reasoning_delta') {
            yield this.emit({ type: 'assistant_text', text: ev.text, reactPhase: 'thought', step });
          } else if (ev.type === 'text_delta') {
            text += ev.text;
            yield this.emit({
              type: 'assistant_text',
              text: ev.text,
              reactPhase: toolCalls.length > 0 || opts.planMode ? 'final' : 'progress',
              step,
            });
          } else if (ev.type === 'warn') {
            yield this.emit({ type: 'system', text: `⚠ ${ev.text}`, step });
          } else if (ev.type === 'message_end') {
            toolCalls = ev.toolCalls;
            if (ev.usage) {
              // 逐步累加：一轮内多次模型调用的用量必须全部计入
              // （此前直接赋值会让多步任务只统计最后一次调用）
              usage = {
                inputTokens: usage.inputTokens + ev.usage.inputTokens,
                outputTokens: usage.outputTokens + ev.usage.outputTokens,
              };
            }
            if (ev.finishReason === 'length') {
              streamError = { message: '响应过长被截断（max_tokens）', category: 'token_limit' };
            }
          }
        }
      } catch (e: unknown) {
        const err = e as { category?: string; message?: string };
        streamError = {
          message: err.message ?? String(e),
          category: err.category ?? 'unknown',
        };
        yield this.emit({
          type: 'error',
          error: streamError.message,
          errorCategory: streamError.category,
          step,
        });
        yield* this.finish(opts, 'model_stop', usage);
        return;
      }

      if (this.aborted) {
        if (text) this.messages.push(assistantMsg(text));
        yield* this.finish(opts, 'user_abort', usage);
        return;
      }
      if (streamError) {
        yield this.emit({ type: 'error', error: streamError.message, errorCategory: streamError.category, step });
        yield* this.finish(opts, 'token_limit', usage);
        return;
      }

      // —— 无工具调用 = 最终答复 ——
      if (toolCalls.length === 0) {
        lastFinalText = text;
        this.messages.push(assistantMsg(text));
        if (text) yield this.emit({ type: 'assistant_phase', phase: 'final', step });
        yield* this.finish(opts, 'model_stop', usage, lastFinalText);
        return;
      }

      // —— 有工具调用：先入列 assistant(toolCalls)，再逐个执行 ——
      this.messages.push(
        assistantMsg(
          text,
          toolCalls.map((tc) => ({ type: 'tool_call' as const, id: tc.id, name: tc.name, args: tc.args })),
        ),
      );

      for (const tc of toolCalls) {
        if (this.aborted) {
          this.messages.push(toolMsg(tc.id, tc.name, '（用户中断，未执行）'));
          yield* this.finish(opts, 'user_abort', usage);
          return;
        }
        const spec = this.deps.registry.get(tc.name);
        yield this.emit({ type: 'tool_call', toolName: tc.name, args: tc.args, reactPhase: 'action', step });

        const sig = `${tc.name}|${JSON.stringify(tc.args ?? {})}`;
        recentCalls.push(sig);
        if (
          recentCalls.length >= REPEAT_LIMIT &&
          recentCalls.slice(-REPEAT_LIMIT).every((s) => s === sig)
        ) {
          yield this.emit({ type: 'system', text: `检测到重复调用 ${tc.name} ≥${REPEAT_LIMIT} 次，提前结束`, step });
          this.messages.push(toolMsg(tc.id, tc.name, '（系统干预：重复调用已中止，请换思路）'));
          yield* this.finish(opts, 'repeat_loop', usage);
          return;
        }

        const outcome = await this.runTool(spec, tc, matrix, opts);
        if (outcome.aborted) {
          yield* this.finish(opts, 'user_abort', usage);
          return;
        }
        this.messages.push(toolMsg(tc.id, tc.name, outcome.text));
        if (outcome.denied) {
          yield this.emit({ type: 'permission', toolName: tc.name, granted: false, text: outcome.text, reactPhase: 'observation', step });
        }
        yield this.emit({ type: 'tool_result', toolName: tc.name, result: outcome.text.slice(0, 2000), reactPhase: 'observation', step });
      }
    }
  }

  /** 工具执行（权限闸门 + diff 预览确认 + 失败回灌文本化） */
  private async runTool(
    spec: ToolSpec | undefined,
    tc: { id: string; name: string; args: unknown },
    matrix: ReturnType<typeof matrixFromMode>,
    opts: KernelRunOptions,
  ): Promise<{ text: string; denied?: boolean; aborted?: boolean }> {
    if (!spec) {
      // 结构性防御：provider 幻觉出未注册工具时，回灌而不是崩溃
      return { text: `错误：工具 ${tc.name} 不存在于注册表。可用工具见系统提示。` };
    }
    const parsed = spec.parameters.safeParse(tc.args ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return { text: `参数校验失败：${issues}` };
    }
    const args = parsed.data as Record<string, unknown>;

    const destructive = spec.isDestructiveArgs?.(args) ?? false;
    const effectiveRisk: Risk = destructive ? 'high' : spec.risk;
    const verdict = decide3({
      matrix,
      capability: spec.capability,
      toolName: spec.name,
      effectiveRisk,
      destructive,
    });

    if (verdict.action === 'deny') return { text: `权限拦截：${verdict.reason}`, denied: true };
    if (verdict.action === 'require_confirm') {
      const preview = spec.preview?.(args, this.toolCtx(opts));
      const prompt = [
        `允许执行 ${spec.name}？`,
        preview ? `预览：\n${preview}` : '',
        verdict.channel === 'risk_prompt' ? `（风险等级：${verdict.risk}${destructive ? '，疑似破坏性操作' : ''}）` : '',
      ].filter(Boolean).join('\n');
      const ok = opts.ask ? await opts.ask(prompt) : false;
      if (!ok) return { text: '用户拒绝了本次操作', denied: true };
    }

    try {
      const res = await spec.execute(args, this.toolCtx(opts));
      return { text: res.content + (res.details ? `\n[details] ${JSON.stringify(res.details)}` : '') };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/abort/i.test(msg) && this.aborted) return { text: '（已中断）', aborted: true };
      // 失败即回灌：错误文本作为工具结果给模型自我纠正
      return { text: `工具执行失败：${msg}` };
    }
  }

  private toolCtx(opts: KernelRunOptions) {
    return {
      cwd: this.deps.cwd,
      protectedRoots: this.deps.protectedRoots,
      signal: opts.signal,
      onProgress: (text: string) => opts.onToolProgress?.('', text),
    };
  }

  /** 发给模型的消息序列（追加风格指令为临时末条，不入持久列） */
  private messagesForModel(opts: KernelRunOptions): Msg[] {
    if (!opts.styleInstruction) return this.messages;
    return [...this.messages, { role: 'system' as const, content: String(opts.styleInstruction) }];
  }

  private emit(ev: CoreEvent): CoreEvent {
    this.deps.trace?.event(ev);
    return ev;
  }

  private *finish(
    opts: KernelRunOptions,
    reason: StopReason,
    usage: Usage,
    finalText?: string,
  ): Generator<CoreEvent> {
    this.totalUsage.inputTokens += usage.inputTokens;
    this.totalUsage.outputTokens += usage.outputTokens;
    this.deps.trace?.record('end', { reason, usage });
    yield {
      type: 'done',
      reason,
      usage: { ...this.totalUsage },
      ...(finalText !== undefined ? { text: finalText } : {}),
    };
  }
}
