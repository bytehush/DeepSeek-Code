/**
 * ModelHub —— 模型中枢（多厂商路由 + 出站记账的唯一出口）。
 *
 * 两个不可绕过的职责：
 *   1. 角色路由：调用方按「角色」（actor/critic/cheap）而非厂商名请求模型，
 *      厂商与模型身份的绑定在配置里，换供应商不改一行调用代码。
 *   2. 出站记账：每一次外发必须过 OutboundLedger（数据安全第 3 条）。
 *      实现方式是把记账放在唯一的 stream() 出口上，适配器无法自行发请求。
 *
 * 错误分类（ProviderError.category）在 hub 层透传给上层，供 UI 差异化提示。
 */
import type { Msg, ThinkingLevel, Usage } from '../types.ts';
import type { OutboundLedger } from './ledger.ts';
import { ProviderError } from './openai-compat.ts';

/** provider 适配器的归一化流事件 */
export type ProviderStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'warn'; text: string }
  | {
      type: 'message_end';
      toolCalls: Array<{ id: string; name: string; args: unknown }>;
      finishReason?: string;
      usage?: Usage;
    };

export interface ToolSpecWire {
  name: string;
  description: string;
  /** JSON Schema（provider 无关） */
  parameters: Record<string, unknown>;
}

export interface StreamRequest {
  modelId: string;
  system: string;
  messages: Msg[];
  tools?: ToolSpecWire[];
  thinking?: ThinkingLevel;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ModelInfo {
  id: string;
  label: string;
  contextWindow: number;
  supportsThinking: boolean;
}

export interface ProviderAdapter {
  id: string;
  models: ModelInfo[];
  /** 实际请求 URL（ledger 记录目的地用） */
  endpoint(): string;
  /**
   * 把请求序列化为**即将上线的字节**。
   *
   * 为什么由 hub 主导而非适配器自己序列化后直接发：出站记账必须结构性不可绕过
   * （数据安全第 3 条）。若适配器自己 stringify 再发，一个不合作的适配器就能
   * 静默外发而不留档。改为两段式后，字节必经 hub 的 ledger，再交回适配器发送。
   *
   * 刻意**不接收 apiKey**：密钥只进 header，序列化签名上拿不到它，
   * 从结构上排除密钥被写进 body 进而被记账哈希/debug 落盘明文的可能。
   */
  serialize(req: StreamRequest): string;
  /** 发送 hub 已记账的 body（适配器不得自行改动或重新序列化） */
  stream(req: StreamRequest, apiKey: string, body: string): AsyncGenerator<ProviderStreamEvent>;
}

/** 模型角色：编排强模型 / 交叉评审异厂商 / 便宜执行与压缩 */
export type ModelRole = 'actor' | 'critic' | 'cheap';

/** 角色 → 模型绑定；可为函数（每调用现场解析，保证 /model 切换即时生效） */
export type ModelBinding =
  | { provider: string; model: string; thinking?: ThinkingLevel }
  | (() => { provider: string; model: string; thinking?: ThinkingLevel });

export interface HubConfig {
  /** 角色 → provider/model 绑定 */
  routing: Record<ModelRole, ModelBinding>;
  /** 每 provider 的 key（显式传参，不走 env） */
  keys: Record<string, string>;
}

export class ModelHub {
  private adapters = new Map<string, ProviderAdapter>();

  constructor(
    private cfg: HubConfig,
    private ledger: OutboundLedger,
  ) {}

  register(a: ProviderAdapter): this {
    this.adapters.set(a.id, a);
    return this;
  }

  /** 已配置且 provider 已注册的可选模型列表（配置界面 / /model 用） */
  available(): Array<{ role: ModelRole; provider: string; model: ModelInfo | undefined }> {
    const out: Array<{ role: ModelRole; provider: string; model: ModelInfo | undefined }> = [];
    for (const role of ['actor', 'critic', 'cheap'] as ModelRole[]) {
      let r: { provider: string; model: string } | undefined;
      try {
        r = this.binding(role);
      } catch {
        continue;
      }
      if (!r || !this.cfg.keys[r.provider]) continue;
      const a = this.adapters.get(r.provider);
      out.push({ role, provider: r.provider, model: a?.models.find((m) => m.id === r.model) });
    }
    return out;
  }

  private binding(role: ModelRole): { provider: string; model: string; thinking?: ThinkingLevel } {
    const b = this.cfg.routing[role];
    if (!b) throw new ProviderError(`未配置 ${role} 角色的模型路由`, 'unknown');
    return typeof b === 'function' ? b() : b;
  }

  resolve(role: ModelRole): { provider: string; modelId: string; thinking?: ThinkingLevel } {
    const r = this.binding(role);
    return { provider: r.provider, modelId: r.model, thinking: r.thinking };
  }

  /** 当前 actor 模型的上下文窗口（context 预算用） */
  actorContextWindow(): number {
    const { provider, modelId } = this.resolve('actor');
    return this.adapters.get(provider)?.models.find((m) => m.id === modelId)?.contextWindow ?? 64_000;
  }

  /**
   * 发起一次模型调用。**唯一**的外发路径。
   * 时序：serialize → 记账落盘（先记后发）→ stream 发送。
   * 失败补记一条 error——保证「发出去过的字节」永远可审计。
   */
  async *stream(
    role: ModelRole,
    req: Omit<StreamRequest, 'modelId'> & { modelId?: string },
  ): AsyncGenerator<ProviderStreamEvent> {
    const target = this.resolve(role);
    const adapter = this.adapters.get(target.provider);
    if (!adapter) throw new ProviderError(`provider 未注册: ${target.provider}`, 'unknown');
    const apiKey = this.cfg.keys[target.provider];
    if (!apiKey) throw new ProviderError(`未配置 ${target.provider} 的 API Key`, 'auth');

    const modelId = req.modelId ?? target.modelId;
    const full: StreamRequest = {
      ...req,
      modelId,
      thinking: req.thinking ?? target.thinking,
    };

    const endpoint = adapter.endpoint();
    const body = adapter.serialize(full);
    const baseRec = {
      provider: target.provider,
      model: modelId,
      endpoint,
      body,
      messages: req.messages,
      toolCount: req.tools?.length ?? 0,
    };
    // 先记后发：请求体已生成，无论后续成败都已留档
    this.ledger.append({ ...baseRec, status: 'sent' });

    try {
      yield* adapter.stream(full, apiKey, body);
    } catch (e) {
      const cat = e instanceof ProviderError ? e.category : 'unknown';
      this.ledger.append({ ...baseRec, status: 'error', errorCategory: cat });
      throw e;
    }
  }

  /** 收集模式：把一次调用跑完并返回拼装结果（压缩器 / critic 用） */
  async complete(
    role: ModelRole,
    req: Omit<StreamRequest, 'modelId'> & { modelId?: string },
  ): Promise<{ text: string; reasoning: string; toolCalls: Array<{ id: string; name: string; args: unknown }>; usage: Usage }> {
    let text = '';
    let reasoning = '';
    let toolCalls: Array<{ id: string; name: string; args: unknown }> = [];
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    for await (const ev of this.stream(role, req)) {
      if (ev.type === 'text_delta') text += ev.text;
      else if (ev.type === 'reasoning_delta') reasoning += ev.text;
      else if (ev.type === 'message_end') {
        toolCalls = ev.toolCalls;
        if (ev.usage) usage = ev.usage;
      }
    }
    return { text, reasoning, toolCalls, usage };
  }
}
