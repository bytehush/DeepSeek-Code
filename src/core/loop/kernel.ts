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
/** 周期检测：允许的最大周期长度（A/B、A/B/C… 形式的交替地转） */
const CYCLE_MAX_PERIOD = 4;
/** 连续多少次「失败类」结果就判定无进展并停手（对齐 chat.ts 的 no_progress 文案） */
const NO_PROGRESS_LIMIT = 3;
/** 输出被 max_tokens 截断后，最多给几次「分块续写」的改策略机会 */
const TRUNCATION_RECOVERIES = 2;

/**
 * 调用签名归一化：对象键排序后序列化。
 * 不做归一化的话，`{"a":1,"b":2}` 与 `{"b":2,"a":1}` 会被当成两次不同调用，
 * 模型只要调整参数书写顺序就能逃出周期检测——这是真实出现过的规避形态。
 */
function stableArgs(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableArgs).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableArgs(o[k])}`).join(',')}}`;
}

/**
 * 地转检测：最近 tail 是否由同一长度 p 的块重复构成（p ≤ CYCLE_MAX_PERIOD，重复 ≥3 轮）。
 *
 * 为什么不用「连续 3 次字节相同」——那只抓得住最僵硬的重复。真实地转通常是
 * A/B/A/B 交替（读一下、改一下、再读一下），模型每次都在「有点进展」的错觉里
 * 烧 token。同时签名含完整 args，故对同一文件的合法连续编辑不会误判（old/new 不同）。
 */
function detectCycle(sigs: string[]): boolean {
  for (let p = 1; p <= CYCLE_MAX_PERIOD; p++) {
    const need = p * REPEAT_LIMIT;
    if (sigs.length < need) continue;
    const tail = sigs.slice(-need);
    let same = true;
    for (let i = p; i < need; i++) {
      if (tail[i] !== tail[i - p]) { same = false; break; }
    }
    if (same) return true;
  }
  return false;
}


export class AgentKernel {
  /** 持久化对话（跨轮累积）；system 不入列，每轮现场生成 */
  private messages: Msg[] = [];
  /**
   * 内核一次性反馈（截断改策略建议、无进展交代要求）。
   *
   * 它们只对被打断的那一步有效，却曾被 push 进 this.messages —— 于是第十轮、
   * 甚至用户换话题之后，模型仍在每步读到「不要再尝试任何操作」这类指令。
   * 那是正确性缺陷，不是容量问题：过期指令留在历史里会继续约束模型。
   *
   * 因此改住这里：装配下一步请求时取出并立即清空（消费即弃），
   * 永不进入 this.messages —— 顺带也就结构性满足了「system 不入列」不变式，
   * SessionStore 那侧的剥离逻辑从此只是防御性冗余。
   */
  private pendingSystem: string[] = [];
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
    this.pendingSystem = [];
  }

  /**
   * 装载既有上下文（会话恢复用）。
   *
   * 唯一入口而非开放 setter：恢复路径必须经过内核，才能守住
   * 「system 不入列」这条不变式（system 每轮现场生成，持久化或注入它都是错的）。
   */
  loadHistory(msgs: readonly Msg[]): void {
    this.messages = msgs.filter((m) => m.role !== 'system');
    // 恢复的是历史，不是上一进程里未被消费的内核指令
    this.pendingSystem = [];
  }

  /**
   * 跑一轮用户输入，产出 CoreEvent 流。
   * 生成器被消费完（或 return）前不落终态——UI 按 done 收尾。
   */
  async *prompt(input: string, opts: KernelRunOptions): AsyncGenerator<CoreEvent> {
    this.aborted = false;
    // 新回合开始：上一步攒下却未被消费的内核指令已过期（例如回合被中断），
    // 让它随回合一起作废，而不是漏进下一次对话。
    this.pendingSystem = [];
    this.deps.trace?.beginTurn(input);
    this.messages.push(userMsg(input));

    const signal = opts.signal;
    if (signal) {
      if (signal.aborted) this.aborted = true;
      else signal.addEventListener('abort', () => { this.aborted = true; }, { once: true });
    }

    let step = 0;
    let lastFinalText = '';
    /** 调用签名窗口（周期检测用）：`name|{有序 args}` */
    const recentCalls: string[] = [];
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    /** 连续「失败类」结果计数（工具报错 / 被拒），达阈值判 no_progress */
    let failStreak = 0;
    /** 截断改策略已给机会次数 */
    let truncationRetry = 0;
    /** 无进展触发：本轮起不再提供工具，强制模型产出总结 */
    let forceNoTools = false;

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
      const system = buildSystemPrompt({
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
      let truncated = false;
      try {
        for await (const ev of this.deps.hub.stream('actor', {
          system,
          messages,
          tools: forceNoTools ? undefined : this.deps.registry.wireSpecs(),
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
            if (ev.finishReason === 'length') truncated = true;
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

      // —— 输出被 max_tokens 截断：回灌而非暴停 ——
      //
      // 截断时 tool_call 的参数是被掐断的半截 JSON，执行它必然失败；而失败原因
      // （「内容太长」）与表象（「参数校验失败」）不一致，模型看不出该改策略，
      // 于是原样重试 → 再被掐断 → 确定性死循环。这是 P0 唯一一处违背
      // 「失败即回灌」不变式的路径，此处补正：明确告诉模型「你被掐断了、
      // 该怎么改」，并且**不执行这些残缺调用**（不入列带 toolCalls 的 assistant
      // 消息，避免对话结构里出现无结果的悬空调用）。
      if (truncated) {
        if (text) this.messages.push(assistantMsg(text));
        if (truncationRetry >= TRUNCATION_RECOVERIES) {
          yield this.emit({ type: 'system', text: `连续 ${TRUNCATION_RECOVERIES + 1} 次输出被长度上限截断，停止以免空耗`, step });
          yield* this.finish(opts, 'token_limit', usage, text);
          return;
        }
        truncationRetry++;
        const advice = toolCalls.length > 0
          ? '你刚才要调用的工具因输出过长被截断了，参数不完整，**本次未执行**。请改策略：把大改动拆成多次小输出——先 write_file 写入骨架/最小可运行版本，再用 edit_file 分若干次补全；每次输出只包含一个文件的一部分，切勿一次性写完整个文件。'
          : '你的回复因长度上限被截断了。请把它拆成若干次较短的输出继续讲，或先给结论再给细节。';
        this.pendingSystem.push(`（系统提示：${advice}）`);
        yield this.emit({ type: 'system', text: `✂ 输出被截断，已要求分块续写（第 ${truncationRetry}/${TRUNCATION_RECOVERIES} 次）`, step });
        continue;
      }

      // —— 无工具调用 = 最终答复 ——
      if (toolCalls.length === 0) {
        lastFinalText = text;
        this.messages.push(assistantMsg(text));
        if (text) yield this.emit({ type: 'assistant_phase', phase: 'final', step });
        // forceNoTools 收尾的这轮总结，退出原因如实标 no_progress 而非 model_stop
        yield* this.finish(opts, forceNoTools ? 'no_progress' : 'model_stop', usage, lastFinalText);
        return;
      }

      // —— 有工具调用：先入列 assistant(toolCalls)，再逐个执行 ——
      // forceNoTools 的收尾轮本不该再有工具；若模型仍幻觉出调用，不再执行，
      // 直接以 no_progress 收尾，保证「交代现状」这一轮能真正交付给用户。
      if (forceNoTools) {
        lastFinalText = text;
        this.messages.push(assistantMsg(text));
        if (text) yield this.emit({ type: 'assistant_phase', phase: 'final', step });
        yield* this.finish(opts, 'no_progress', usage, lastFinalText);
        return;
      }
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

        const sig = `${tc.name}|${stableArgs(tc.args)}`;
        recentCalls.push(sig);
        if (detectCycle(recentCalls)) {
          yield this.emit({ type: 'system', text: `检测到周期性重复调用（${tc.name} 等，已重复 ≥${REPEAT_LIMIT} 轮），提前结束`, step });
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

        // 无进展检测：连续 N 次「失败类」结果（工具报错 / 参数非法 / 被拒）即停手。
        // 这是过去那条「一直失败一直到用户手动 Ctrl+C」路径的兜底闸门。
        //
        // 停手不等于闭嘴：置 forceNoTools 让下一轮**不再提供工具**，模型只能产出
        // 中文现状总结，循环从「交代清楚」这条路径正常退出（reason 仍标
        // no_progress，标签不失真）。既不额外多烧一次调用，也不静默消失。
        failStreak = outcome.failed ? failStreak + 1 : 0;
        if (failStreak >= NO_PROGRESS_LIMIT) {
          yield this.emit({ type: 'system', text: `连续 ${failStreak} 次工具执行失败，停止调用工具并汇总现状`, step });
          this.pendingSystem.push(
            `（系统提示：已连续 ${failStreak} 次工具调用失败，本轮不再提供工具。请向用户如实说明：已经完成了什么、卡在哪一步、最后一次失败的具体错误，以及需要用户补充什么信息。用简体中文，不要再尝试任何操作。）`,
          );
          forceNoTools = true;
          failStreak = 0;
        }
      }
    }
  }

  /** 工具执行（权限闸门 + diff 预览确认 + 失败回灌文本化） */
  private async runTool(
    spec: ToolSpec | undefined,
    tc: { id: string; name: string; args: unknown },
    matrix: ReturnType<typeof matrixFromMode>,
    opts: KernelRunOptions,
  ): Promise<{ text: string; denied?: boolean; aborted?: boolean; failed?: boolean }> {
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
      // failed 标记供无进展计数——只有真正执行报错才算失败，
      // 权限拦截/用户拒绝是闸门在正常工作，不计入（模型换思路即有进展）
      return { text: `工具执行失败：${msg}`, failed: true };
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

  /**
   * 发给模型的消息序列。
   *
   * 末段依次拼上两类「不入历史」的临时 system：
   *   - pendingSystem：上一步攒下的内核一次性反馈（取出即清空 = 消费即弃）
   *   - styleInstruction：本轮的输出风格指令
   * 两者都只活在这次请求里，返回后不留在 this.messages。
   */
  private messagesForModel(opts: KernelRunOptions): Msg[] {
    const transient = this.pendingSystem.map((content) => ({ role: 'system' as const, content }));
    this.pendingSystem = [];
    if (opts.styleInstruction) transient.push({ role: 'system', content: String(opts.styleInstruction) });
    if (transient.length === 0) return this.messages;
    return [...this.messages, ...transient];
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
