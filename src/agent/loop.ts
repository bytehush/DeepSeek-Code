/**
 * Agent 运行时层（P1 引擎切换后）。
 *
 * 旧版：runAgent 委托自研 ReAct 内核（core.ts）+ 7 中间件；现已迁移到 Pi Agent SDK
 * （@earendil-works/pi-agent-core 的 `Agent`）。本文件只保留对外的类型契约与
 * `runAgent` 别名，内部全部委托 src/agent/pi-agent.ts::runPiAgent。
 *
 * 关键不变量（保证 GUI 零改动）：
 *  - `runAgent(input, opts)` 仍是 `AsyncGenerator<AgentEvent>`，产出与旧版逐事件一致。
 *  - `AgentEvent` union 不变 → applyRunAgentEvent / AgentHost / 前端直接复用。
 */
import type { Agent } from '@earendil-works/pi-agent-core';
import type { Models } from '@earendil-works/pi-ai';
import type { StreamErrorCategory } from '../llm/deepseek.ts';
import type { PermissionMode } from '../permission/index.ts';
import type { OutputStyle } from './output-style.ts';
import type { MemoryService } from '../memory/service.ts';
import { runPiAgent } from './pi-agent.ts';

export type { PermissionMode };
export type { OutputStyle };

export interface AgentEvent {
  type: 'assistant_text' | 'assistant_phase' | 'assistant_promote' | 'tool_call' | 'tool_result' | 'tool_stream' | 'permission' | 'error' | 'done' | 'system';
  text?: string;
  toolName?: string;
  args?: unknown;
  result?: string;
  granted?: boolean;
  error?: string;
  /** 服务端错误分类（仅 type==='error' 时有意义），供上层差异化提示 */
  errorCategory?: StreamErrorCategory;
  /**
   * ReAct 可观测：当前推理-行动循环的步数（从 1 开始递增）。
   */
  step?: number;
  /**
   * 当前事件的显式推理阶段标签。
   * - 'thought'：模型在思考/推理（assistant_text 在 tool_use 之前）
   * - 'action'：模型决定调用工具（tool_call 事件）
   * - 'observation'：工具执行结果（tool_result 事件）
   * - 'final'：最终答复（assistant_phase final）
   * - 'progress'：过程叙述（assistant_phase progress）
   */
  reactPhase?: 'thought' | 'action' | 'observation' | 'final' | 'progress';
  /**
   * 停止原因（P1-⑤ 增强）：标记每条退出路径的判定来源，使循环为何停止可观测。
   */
  reason?: 'model_stop' | 'user_abort' | 'no_progress' | 'no_observable_progress' | 'repeat_loop' | 'max_iterations' | 'repeated_tool_no_progress';
  /**
   * 阶段标记（旧引擎 assistant_phase 事件携带；新 Pi 引擎不产出，保留以兼容 applyRunAgentEvent 既有分支）。
   */
  phase?: 'progress' | 'final';
}

/**
 * Pi 引擎运行选项（P1 起）。
 * 取代旧版依赖 DeepSeekClient / ToolDef[] / ConversationHistory 的形状：
 *  - `agent`：持久化 Pi Agent 实例（由 assemble.ts 创建，跨轮累积上下文）。
 *  - `models`：Pi Models 实例（provider 已设为 deepseekProvider）。
 *  - `permission`：权限模式（explore/ask/execute）。
 *  - `memory?`：RAG 记忆服务（P3 接入 transformContext）。
 */
export interface RunOptions {
  /** 持久化 Pi Agent（每次 prompt 累积上下文） */
  agent: Agent;
  /** Pi Models 实例，provider 已设 deepseekProvider */
  models: Models;
  /** 权限模式 */
  permission: PermissionMode;
  /** RAG 记忆服务（可选，P3 接入 per-turn 注入） */
  memory?: MemoryService;
  /** 可取消当前运行的 AbortSignal */
  signal?: AbortSignal;
  /** 工具执行期间的实时流式输出回调（如 bash stdout） */
  onToolProgress?: (toolName: string, text: string) => void;
  /** 权限确认：agent 挂起等待用户 y/n */
  ask?: (prompt: string) => Promise<boolean>;
  /** 模型主动 awaitUser 时的自由文本回复回调 */
  askText?: (prompt: string) => Promise<string>;
  /** Trace 日志记录器（可选，不传则不记录） */
  trace?: unknown;
  /** Plan Mode 开关。true 时 Agent 只输出计划不执行工具 */
  planMode?: boolean;
  /** 最大自我重试次数（Reflection 深化） */
  maxRetries?: number;
  /** P6 输出风格 */
  outputStyle?: OutputStyle;
  /** 每轮工具调用数上限 */
  maxToolCallsPerRound?: number;
  /** 同工具 + 相同参数重复调用上限 */
  maxRepeatedToolCalls?: number;
  /** agent 工作目录（工具路径解析基准） */
  cwd?: string;
}

/**
 * Agent 运行时入口（兼容壳）。
 * 委托 Pi Agent 适配层；对外签名（userInput / opts / AsyncGenerator<AgentEvent>）不变。
 */
export async function* runAgent(userInput: string, opts: RunOptions): AsyncGenerator<AgentEvent> {
  yield* runPiAgent(userInput, opts);
}
