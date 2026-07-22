import type { DeepSeekClient } from '../llm/deepseek.ts';
import type { ToolDef } from './types.ts';
import { createReviewTool } from './review.ts';
import { createAuditTool } from './audit.ts';
import { createGitStatusTool, createGitDiffTool, createGitCommitMsgTool } from './git.ts';
import { createTerminologyTool, createProjectDiscoverTool } from './discovery.ts';
import { createVerifyCodeTool } from './verify-code.ts';
import { createVerifyAnswerTool } from './verify-answer.ts';
import { createDeepGenTool } from './deep-gen.ts';
import { createBaseTools } from './implementations.ts';

// 薄 barrel（S1.2 拆分后）：保留原公开 API 路径，外部 10+ 处引用零改动。
// 类型契约统一来自 ./types.ts；isDestructive 来自 src/permission（S4.2 提拔）。
export type { Risk, ToolContext, ToolResult, ToolDef } from './types.ts';
export { isDestructive } from '../permission/index.ts';
export { fuzzyMatchBlock } from './validation.ts';
export { isSourceMutating } from './security.ts';

// 工具总装：基础编程动作 + Git 工具 + 差异化复合工具。
export function createTools(client: DeepSeekClient): ToolDef[] {
  return [
    ...createBaseTools(client),
    createGitStatusTool(),
    createGitDiffTool(),
    createGitCommitMsgTool(client),
    createReviewTool(client),
    createAuditTool(client),
    createTerminologyTool(client),
    createProjectDiscoverTool(client),
    createVerifyCodeTool(client),
    createVerifyAnswerTool(client),
    createDeepGenTool(client),
  ];
}
