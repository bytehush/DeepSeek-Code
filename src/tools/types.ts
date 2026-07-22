export type Risk = 'low' | 'mid' | 'high';

export interface ToolContext {
  cwd: string;
  /** 可选的流式输出回调。工具执行期间可调用此函数实时推送输出片段 */
  onProgress?: (text: string) => void;
  /** 可选的中断信号。当外层 Agent 被用户取消时，工具应尽力终止当前操作 */
  signal?: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema，给 DeepSeek 模型
  risk: Risk;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
  /**
   * P0-② 写前 diff 审批：返回「将要发生什么变更」的可读预览（不落盘）。
   * 仅文件写类工具实现。Agent 在执行前会展示此预览并要求用户确认。
   */
  preview?: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string> | string;
}
