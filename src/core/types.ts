/**
 * 内核公共类型（自研基座 P0）。
 *
 * 这里只放「跨子系统共享」的纯类型：消息、用量、运行选项。
 * 不含任何 provider / 工具实现，避免成为依赖汇聚点。
 */

export type MsgRole = 'system' | 'user' | 'assistant' | 'tool';

/** 工具调用块（assistant 消息携带） */
export interface ToolCallBlock {
  type: 'tool_call';
  /** provider 分配的调用 id，工具结果需按此回填 */
  id: string;
  name: string;
  args: unknown;
}

/**
 * 内核统一消息形状。
 * 采用「扁平 content + 可选 toolCalls」而非 Anthropic 式 block 数组：
 * 与 OpenAI-compatible 协议零转换成本，多模型路由时不必为每家做消息归一化。
 */
export interface Msg {
  role: MsgRole;
  /** 文本内容；role==='tool' 时为工具结果文本 */
  content: string;
  toolCalls?: ToolCallBlock[];
  /** role==='tool'：对应的调用 id */
  toolCallId?: string;
  /** role==='tool'：工具名（展示与 trace 用） */
  name?: string;
  /** 该消息产生时间（ISO），trace / 审计用 */
  ts?: string;
}

/** 单次模型调用用量 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** 思考档位（provider 不支持时由适配器降级忽略） */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

/** 停止原因：每条退出路径可判定（可观测性要求） */
export type StopReason =
  | 'model_stop'
  | 'user_abort'
  | 'no_progress'
  | 'repeat_loop'
  | 'max_iterations'
  | 'token_limit';

export function userMsg(content: string): Msg {
  return { role: 'user', content, ts: new Date().toISOString() };
}

export function toolMsg(toolCallId: string, name: string, content: string): Msg {
  return { role: 'tool', content, toolCallId, name, ts: new Date().toISOString() };
}

export function assistantMsg(content: string, toolCalls?: ToolCallBlock[]): Msg {
  return {
    role: 'assistant',
    content,
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    ts: new Date().toISOString(),
  };
}
