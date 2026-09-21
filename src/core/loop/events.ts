/**
 * CoreEvent —— 内核对外的事件契约（唯一输出面）。
 *
 * 形状与重构前的 AgentEvent（src/agent/loop.ts）逐字段一致，仅更名。
 * 这是「全量重写但不重写 UI」的支点：
 *   - src/app/chat.ts 的 applyRunAgentEvent 分支逻辑零改动；
 *   - trace 落盘、eval 记录、TUI 渲染共用同一条事件流（三个消费者，一份形状）。
 *
 * 新增事件类型须同步三处消费者，禁止为单一消费者私造事件。
 */
import type { StopReason, Usage } from '../types.ts';

export interface CoreEvent {
  type:
    | 'assistant_text'
    | 'assistant_phase'
    | 'assistant_promote'
    | 'tool_call'
    | 'tool_result'
    | 'tool_stream'
    | 'permission'
    | 'error'
    | 'done'
    | 'system';
  text?: string;
  toolName?: string;
  args?: unknown;
  result?: string;
  granted?: boolean;
  error?: string;
  /** 服务端错误分类（仅 type==='error' 有意义），供 chat.ts friendlyErrorMessage 差异化提示 */
  errorCategory?: string;
  /** 当前推理-行动循环的步数（从 1 开始递增） */
  step?: number;
  /**
   * 显式推理阶段标签：
   * thought=模型推理 / action=决定调用工具 / observation=工具结果 /
   * final=最终答复 / progress=过程叙述
   */
  reactPhase?: 'thought' | 'action' | 'observation' | 'final' | 'progress';
  /** 每条退出路径的判定来源 */
  reason?: StopReason;
  /** 阶段标记（assistant_phase 携带） */
  phase?: 'progress' | 'final';
  /** 本次调用的 token 用量（done 事件携带；provider 未返回时为 0） */
  usage?: Usage;
}
