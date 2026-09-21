/**
 * OpenAI-compatible provider 适配器。
 *
 * 一套代码覆盖 DeepSeek / Qwen / GLM / Kimi / Moonshot / 自托管 vLLM —— 这是
 * 「架构第一天支持换模型」的落地方式：不写 N 个 SDK 封装，写 1 个协议 + N 份配置。
 * 需要非兼容协议（如 Anthropic 原生 messages API）时新增一个 ProviderAdapter 实现即可。
 *
 * 安全要点：apiKey 是显式参数，绝不读 process.env（重构前 assemble 写
 * process.env.DEEPSEEK_API_KEY，会被 bash 工具子进程继承，属泄漏面）。
 */
import type { Msg, Usage } from '../types.ts';
import type { ProviderAdapter, ProviderStreamEvent, StreamRequest } from './hub.ts';
import { SseParser, isDoneFrame, parseChunkDelta, ToolCallAccumulator } from './sse.ts';

export interface OpenAICompatConfig {
  /** provider 逻辑名（进 ledger / trace），如 deepseek、qwen */
  id: string;
  /** 端点，如 https://api.deepseek.com/v1 */
  baseURL: string;
  /** 展示用模型清单（路由与配置校验用） */
  models: Array<{ id: string; label: string; contextWindow: number; supportsThinking: boolean }>;
  /** 单次响应最大 token */
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}

/** provider 层错误：带分类，供上层 friendlyErrorMessage 差异化提示 */
export class ProviderError extends Error {
  readonly category: string;
  readonly status?: number;
  constructor(message: string, category: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.category = category;
    this.status = status;
  }
}

/** HTTP 状态 / 报文 → 错误分类（与 chat.ts friendlyErrorMessage 的 key 对齐） */
export function classifyProviderError(message: string, status?: number): string {
  const r = message.toLowerCase();
  if (status === 401 || /authentication|api[ _-]?key|unauthorized|invalid key/.test(r)) return 'auth';
  if (status === 402 || /insufficient|balance|quota|欠费|余额/.test(r)) return 'quota';
  if (/moderation|sensitive|content.*policy|违规/.test(r)) return 'moderation';
  if (/context length|maximum context|token.*limit|too many tokens|input is too long/.test(r))
    return 'token_limit';
  if (status === 429 || /rate limit|too many|server is busy|overloaded|503|502|timeout|timed out|fetch failed|network|econn/.test(r))
    return 'server_unavailable';
  return 'unknown';
}

interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
}

/** 内核 Msg → OpenAI wire 格式 */
export function toWireMessages(system: string, messages: Msg[]): WireMessage[] {
  const out: WireMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', content: m.content, tool_call_id: m.toolCallId, name: m.name });
    } else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.content || null,
        ...(m.toolCalls && m.toolCalls.length > 0
          ? {
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
              })),
            }
          : {}),
      });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

export function createOpenAICompatAdapter(cfg: OpenAICompatConfig): ProviderAdapter {
  const doFetch = cfg.fetchImpl ?? fetch;

  return {
    id: cfg.id,
    models: cfg.models,
    // model 由 ledger 记录在独立字段，endpoint 返回实际请求 URL
    endpoint(): string {
      return `${cfg.baseURL.replace(/\/+$/, '')}/chat/completions`;
    },

    // 两段式（见 hub 注释）：serialize 由 hub 调用并记账，stream 只发送既定字节。
    // 签名不含 apiKey——结构上不可能把密钥带进被留档的 body。
    serialize(req: StreamRequest): string {
      const model = cfg.models.find((m) => m.id === req.modelId);
      if (!model) throw new ProviderError(`未注册模型: ${cfg.id}/${req.modelId}`, 'unknown');
      const body: Record<string, unknown> = {
        model: req.modelId,
        messages: toWireMessages(req.system, req.messages),
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: req.maxTokens ?? cfg.maxTokens ?? 8192,
      };
      if (req.tools && req.tools.length > 0) {
        body.tools = req.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
        body.tool_choice = 'auto';
      }
      // 思考档位：DeepSeek 用 thinking.type；不支持思考的模型静默忽略
      const thinking = req.thinking && req.thinking !== 'off';
      if (thinking && model.supportsThinking) {
        body.thinking = { type: 'enabled' };
        body.reasoning_effort = req.thinking;
      }
      return JSON.stringify(body);
    },

    async *stream(req: StreamRequest, apiKey: string, payload: string): AsyncGenerator<ProviderStreamEvent> {
      let res: Response;
      try {
        res = await doFetch(this.endpoint(), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
            accept: 'text/event-stream',
          },
          body: payload,
          signal: req.signal,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new ProviderError(msg, classifyProviderError(msg), undefined);
      }

      if (!res.ok) {
        let detail = '';
        try {
          detail = await res.text();
        } catch {
          /* 忽略读体失败 */
        }
        const category = classifyProviderError(detail || `HTTP ${res.status}`, res.status);
        throw new ProviderError(
          `HTTP ${res.status}${detail ? `: ${detail.slice(0, 600)}` : ''}`,
          category,
          res.status,
        );
      }
      if (!res.body) throw new ProviderError('响应无 body（非流式？）', 'unknown');

      const parser = new SseParser();
      const acc = new ToolCallAccumulator();
      let usage: Usage | undefined;
      let finishReason: string | undefined;
      const reader = res.body.getReader();

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const frame of parser.feed(value)) {
            if (isDoneFrame(frame)) continue;
            let json: unknown;
            try {
              json = JSON.parse(frame);
            } catch {
              continue; // 非 JSON 帧（心跳/代理注入）跳过
            }
            // 服务端在 SSE 体内报错（DeepSeek 对 429/内容审核有时走 200 + error 字段）
            const errObj = (json as { error?: { message?: string; code?: string } }).error;
            if (errObj) {
              const m = errObj.message ?? '服务端返回错误';
              throw new ProviderError(m, classifyProviderError(m));
            }
            const d = parseChunkDelta(json);
            if (d.usage) usage = d.usage;
            if (d.reasoning) yield { type: 'reasoning_delta', text: d.reasoning };
            if (d.content) yield { type: 'text_delta', text: d.content };
            if (d.toolCalls) {
              for (const tc of d.toolCalls) acc.add(tc, `call_${Date.now().toString(36)}`);
            }
            if (d.finishReason) finishReason = d.finishReason;
          }
        }
        for (const frame of parser.flush()) {
          if (isDoneFrame(frame)) continue;
          try {
            const d = parseChunkDelta(JSON.parse(frame));
            if (d.usage) usage = d.usage;
            if (d.content) yield { type: 'text_delta', text: d.content };
            if (d.reasoning) yield { type: 'reasoning_delta', text: d.reasoning };
            if (d.toolCalls) for (const tc of d.toolCalls) acc.add(tc, `call_${Date.now().toString(36)}`);
            if (d.finishReason) finishReason = d.finishReason;
          } catch {
            /* 残帧非 JSON，忽略 */
          }
        }
      } finally {
        reader.releaseLock();
      }

      const toolCalls = acc.done().map((c) => ({ id: c.id, name: c.name, args: c.args }));
      if (finishReason === 'length') {
        yield { type: 'warn', text: '响应被 max_tokens 截断，可提高档位或改用短任务' };
      }
      yield { type: 'message_end', toolCalls, finishReason, usage };
    },
  };
}
