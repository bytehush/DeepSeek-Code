import { DeepSeekClient, StreamErrorCategory } from '../llm/deepseek.ts';
import { ToolDef } from '../tools/index.ts';
import { ConversationHistory } from '../context/history.ts';
import { TraceLogger } from '../context/trace.ts';
import type { PermissionMode } from '../permission/index.ts';
import { type OutputStyle } from './output-style.ts';
import { runCore } from './core.ts';
import { buildAgentMiddlewares } from './middleware/index.ts';
export type { PermissionMode };

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
   * 同一轮中的 thought → action → observation 共享相同的 step，下一轮 step+1。
   */
  step?: number;
  /**
   * ReAct 可观测：当前事件的显式推理阶段标签。
   * - 'thought'：模型在思考/推理（assistant_text 在 tool_use 之前）
   * - 'action'：模型决定调用工具（tool_call 事件）
   * - 'observation'：工具执行结果（tool_result 事件）
   * - 'final'：最终答复（assistant_phase final）
   * - 'progress'：过程叙述（assistant_phase progress）
   */
  reactPhase?: 'thought' | 'action' | 'observation' | 'final' | 'progress';
  /**
   * P2-⑨ 任务级 progress/final 标记：仅 assistant_phase 事件携带。
   * - 'progress'：该轮 assistant 文本是「过程叙述」（本轮后续会调用工具）
   * - 'final'：该轮 assistant 文本是「最终答复」（本轮不再调用工具）
   */
  phase?: 'progress' | 'final';
  /**
   * 停止原因（P1-⑤ 增强）：标记每条退出路径的判定来源，使循环为何停止可观测。
   * - model_stop：模型本轮未调工具，主动结束
   * - user_abort：用户通过 signal 中断
   * - no_progress：工具连续全部失败/被拒
   * - no_observable_progress：连续多轮既无世界状态变更、又反复观察相同目标（空转）
   * - repeat_loop：连续多轮发出字节完全相同的工具调用（死循环）
   * - max_iterations：达到迭代轮数硬上限
   */
  reason?: 'model_stop' | 'user_abort' | 'no_progress' | 'no_observable_progress' | 'repeat_loop' | 'max_iterations' | 'repeated_tool_no_progress';
}

export interface RunOptions {
  client: DeepSeekClient;
  history: ConversationHistory;
  permission: PermissionMode;
  tools?: ToolDef[];
  cwd: string;
  ask: (prompt: string) => Promise<boolean>;
  maxIterations?: number;
  /** P2-1: Trace 日志记录器（可选，不传则不记录） */
  trace?: TraceLogger;
  /** P2-3: Plan Mode 开关。true 时 Agent 只输出计划不执行工具 */
  planMode?: boolean;
  /** P-Auto: 全自动 Plan & Act 开关（默认 true）。
   *  true：未手动开 planMode 时，对每个新请求做一次轻量复杂度分类，
   *        复杂任务自动生成计划并直接执行（不弹确认框）。
   *  false：关闭自动规划，仅手动 /plan 触发（保留确认框）。
   *  注意：手动 /plan 始终保留确认框（用户终审权），与 autoPlan 无关。 */
  autoPlan?: boolean;
  /** P2-3: 最大自我重试次数（Reflection 深化） */
  maxRetries?: number;
  /** P4-UX: 工具执行期间的实时流式输出回调（如 run_command 的 stdout） */
  onToolProgress?: (toolName: string, text: string) => void;
  /** P1-⑥: 模型主动 awaitUser 时的自由文本回复回调（区别于权限确认的布尔 ask） */
  askText?: (prompt: string) => Promise<string>;
  /** 可取消当前 Agent 运行的 AbortSignal */
  signal?: AbortSignal;
  /** P6 输出风格：把风格指令按轮注入到最后一条 user 消息（本地副本，不污染 history/trace） */
  outputStyle?: OutputStyle;
  /** B·harness：每轮工具调用数上限（默认 16）。超限本轮停止派发，注入收敛提示（通用限制，不识工具语义）。 */
  maxToolCallsPerRound?: number;
  /** B·harness：同工具 + 相同参数签名重复调用上限（默认 4）。超限终止本轮以避免活锁（通用计数，不识「为何空输出」）。 */
  maxRepeatedToolCalls?: number;
}

/**
 * Agent 运行时层：Agent Loop 兼容壳（P3 循环解耦）。
 *
 * 内核逻辑已迁移至 src/agent/core.ts::runCore（极简 ReAct 5 步 + 7 接缝），
 * 23 个外部关注点外移为 src/agent/middleware/* 中间件。本函数仅作兼容壳：
 * 组装默认中间件链并委托内核，对外签名（userInput/opts/AsyncGenerator<AgentEvent>）不变。
 *
 * 循环不变式：while stop_reason == 'tool_use': 调模型 → 追加 assistant → 权限闸门 → 执行工具 → 回灌结果 → 继续
 */
export async function* runAgent(userInput: string, opts: RunOptions): AsyncGenerator<AgentEvent> {
  // 薄壳：委托极简内核 runCore（P3 循环解耦），中间件链由 buildAgentMiddlewares 组装。
  // 内核签名不变，外部调用方（session/chat/host）行为一致。
  yield* runCore(userInput, opts, buildAgentMiddlewares());
}
