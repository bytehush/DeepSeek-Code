/**
 * SSE 流解析器（OpenAI-compatible /chat/completions 协议）。
 *
 * Pi SDK 原本代偿了这层，自研后必须自己保证边界正确——这是风险登记里的头号项。
 * 处理的边界情形（每种均有单测，见 test/sse-parser.test.ts）：
 *   1. 一个 SSE 事件被 TCP 分片切成多块；
 *   2. UTF-8 多字节字符（中文）被切断在字节中间 → TextDecoder stream 模式缓冲；
 *   3. CRLF 行结束、事件间空行；
 *   4. 同块内多行 data（含多事件连发）；
 *   5. [DONE] 终止帧；
 *   6. 流中途报错帧 / HTTP 非 2xx（抛错，由 hub 分类）。
 */

/** 解析器产出的最小单元：一条 data 帧负载（已去 "data: " 前缀） */
export type SseFrame = string;

/**
 * 把字节流解码并切分为 SSE data 帧。增量状态机，可反复 feed，最后 flush。
 */
export class SseParser {
  private decoder = new TextDecoder('utf-8');
  /** 未完成的行（跨块） */
  private lineBuf = '';
  /** 当前事件累积的 data 行（多行 data 以 \n 连接，SSE 规范） */
  private dataLines: string[] = [];

  *feed(chunk: Uint8Array): Generator<SseFrame> {
    // stream:true 保证被切断的多字节字符留到下一个 chunk
    const text = this.decoder.decode(chunk, { stream: true });
    for (const ch of text) {
      if (ch === '\r') continue; // CRLF 与 LF 等价处理
      if (ch === '\n') {
        const line = this.lineBuf;
        this.lineBuf = '';
        yield* this.consumeLine(line);
        continue;
      }
      this.lineBuf += ch;
    }
  }

  /** 流结束时调用：把残行与残事件吐出（部分服务端不发尾部空行） */
  *flush(): Generator<SseFrame> {
    if (this.lineBuf) {
      const line = this.lineBuf;
      this.lineBuf = '';
      yield* this.consumeLine(line);
    }
    yield* this.emitEvent();
  }

  private *consumeLine(line: string): Generator<SseFrame> {
    if (line === '') {
      // 空行 = 事件边界
      yield* this.emitEvent();
      return;
    }
    if (line.startsWith(':')) return; // 注释行
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.dataLines.push(value);
    // event:/id:/retry: 字段本协议不需要，忽略
  }

  private *emitEvent(): Generator<SseFrame> {
    if (this.dataLines.length === 0) return;
    const payload = this.dataLines.join('\n');
    this.dataLines = [];
    yield payload;
  }
}

/** [DONE] 终止帧判定（允许前导空格） */
export function isDoneFrame(payload: string): boolean {
  return payload.trim() === '[DONE]';
}

/**
 * 从已 JSON.parse 的 chunk 中提取增量（文本 / 思考 / 工具调用 / 用量）。
 * 返回归一化的 delta，供 OpenAICompatAdapter 组装 ProviderStreamEvent。
 */
export interface ChunkChoiceDelta {
  content?: string;
  reasoning?: string;
  toolCalls?: Array<{ id?: string; name?: string; argsFragment?: string; index: number }>;
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null;
  usage?: { inputTokens: number; outputTokens: number };
}

export function parseChunkDelta(json: unknown): ChunkChoiceDelta {
  const root = json as Record<string, unknown>;
  const usageRaw = root.usage as
    | { prompt_tokens?: number; completion_tokens?: number }
    | undefined;
  const usage = usageRaw
    ? {
        inputTokens: usageRaw.prompt_tokens ?? 0,
        outputTokens: usageRaw.completion_tokens ?? 0,
      }
    : undefined;

  const choices = root.choices as Array<Record<string, unknown>> | undefined;
  if (!choices || choices.length === 0) return { usage };
  const choice = choices[0]!;
  const delta = (choice.delta ?? choice.message ?? {}) as Record<string, unknown>;
  const out: ChunkChoiceDelta = { usage };

  if (typeof delta.content === 'string' && delta.content.length > 0) out.content = delta.content;
  // 推理模型思考链：DeepSeek reasoner 放 reasoning_content，部分放 reasoning
  const rc = delta.reasoning_content ?? delta.reasoning;
  if (typeof rc === 'string' && rc.length > 0) out.reasoning = rc;

  const tcs = delta.tool_calls as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(tcs) && tcs.length > 0) {
    out.toolCalls = tcs.map((tc, i) => {
      const fn = (tc.function ?? {}) as Record<string, unknown>;
      return {
        index: typeof tc.index === 'number' ? tc.index : i,
        id: typeof tc.id === 'string' ? tc.id : undefined,
        name: typeof fn.name === 'string' ? fn.name : undefined,
        argsFragment: typeof fn.arguments === 'string' ? fn.arguments : undefined,
      };
    });
  }

  const fr = choice.finish_reason;
  if (fr === 'stop' || fr === 'tool_calls' || fr === 'length' || fr === 'content_filter') {
    out.finishReason = fr;
  } else if (fr === null) {
    out.finishReason = null;
  }
  return out;
}

/** 工具调用增量累加器：把分片的 name/arguments 拼成完整调用 */
export class ToolCallAccumulator {
  private calls = new Map<number, { id: string; name: string; args: string }>();

  add(frag: NonNullable<ChunkChoiceDelta['toolCalls']>[number], fallbackId: string): void {
    const cur = this.calls.get(frag.index) ?? {
      id: frag.id ?? `${fallbackId}-${frag.index}`,
      name: '',
      args: '',
    };
    if (frag.id) cur.id = frag.id;
    if (frag.name) cur.name += frag.name;
    if (frag.argsFragment) cur.args += frag.argsFragment;
    this.calls.set(frag.index, cur);
  }

  /** 完整调用列表；args JSON 解析失败时原样给 { __raw } 交由上层报错回灌 */
  done(): Array<{ id: string; name: string; args: unknown }> {
    return [...this.calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => {
        let args: unknown = {};
        const trimmed = c.args.trim();
        if (trimmed) {
          try {
            args = JSON.parse(trimmed);
          } catch {
            args = { __raw: c.args, __error: '工具参数不是合法 JSON' };
          }
        }
        return { id: c.id, name: c.name, args };
      });
  }

  get size(): number {
    return this.calls.size;
  }
}
