/**
 * 工具编排者（Tool Orchestrator · S2.1，v2 纯 dispatcher）。
 *
 * 定位：agent 系统(loop.ts) 与「工具」之间的纯调度中介层。
 * 只干四件事，自身不持有任何判定逻辑：
 *   ① 路由：按名字找到 ToolDef（含 MCP 前缀模糊回退）
 *   ② 委托 Gatekeeper.inspect —— 问「参数合法吗、风险多高」
 *   ③ 委托 PermissionSystem.decide —— 问「政策上让不让跑」
 *   ④ 执行 def.execute + 把结果截断/包成 ToolCallResult（消息适配）
 *
 * 设计铁律（见 deepseek-code-agent-工具编排者方案.md v2）：
 *   - 编排者「被指挥」而非「既当裁判又当调度员」：能不能跑、参数对不对，
 *     由 Gatekeeper / PermissionSystem 两个独立权威反向告知。
 *   - 编排者绝不调用 history.addToolResult / yield —— 那是 agent 侧职责
 *     （涉及对话 API 的 tool 消息顺序，错则 400），必须留在 loop.ts。
 *   - ask 只是「把话问出去、把回答拿回来」的机械动作；问不问、问什么由权限系统决定。
 *
 * 注意：本模块当前未被 loop.ts 接线（loop 重写属 P3 循环解耦）；
 * 此处先作为独立、可单测的纯调度层交付，由 P3 的 runCore 中间件接管。
 */

import type { PermissionMode } from '../permission/index.ts';
import { decide } from '../permission/permission-system.ts';
import { isDestructive } from '../permission/index.ts';
import type { Risk, ToolContext, ToolDef, ToolResult } from './types.ts';
import type { Gatekeeper } from './gatekeeper.ts';

/** —— agent ↔ 编排者（对外契约，不变） —— */
export interface ToolCallRequest {
  id: string;
  name: string; // 可能含 MCP 前缀 server__name
  rawArguments: string | Record<string, unknown>; // 模型原始 arguments
  ctx: ToolContext; // cwd / signal / onProgress
}

/** —— 编排者 → agent 系统（响应） —— */
export interface ToolCallResult {
  ok: boolean;
  output: string;
  /** 把关失败 → 模型应据 errors 纠正后重试 */
  needSelfHeal: boolean;
  /** 权限被拒绝 */
  denied?: boolean;
  /** 字段级错误明细（把关失败时存在） */
  errors?: string[];
}

/** 编排者依赖（外部注入，自身不实现任何判定） */
export interface OrchestratorDeps {
  tools: ToolDef[]; // 来自 createTools / mcp manager 的全量工具
  gatekeeper: Gatekeeper; // ← 把关系统
  /** 仅为执行权限系统的 require_confirm 决策（问话的机械动作） */
  ask: (prompt: string) => Promise<boolean>;
  mode: PermissionMode;
  cwd: string;
  signal?: AbortSignal;
  onToolProgress?: (text: string) => void;
  trace?: { log: (type: string, data: unknown) => Promise<void> | void };
}

// —— 消息适配：工具输出截断（与 loop.ts::clampToolOutput 同预算，留 P3 统一）—— //
const TOOL_RESULT_BUDGET = 12_000;
const TOOL_RESULT_HEAD = 8_000;
const TOOL_RESULT_TAIL = 3_000;

function clampToolOutput(output: string): string {
  if (output.length <= TOOL_RESULT_BUDGET) return output;
  const head = output.slice(0, TOOL_RESULT_HEAD);
  const tail = output.slice(output.length - TOOL_RESULT_TAIL);
  const cut = output.length - TOOL_RESULT_HEAD - TOOL_RESULT_TAIL;
  return `${head}\n…[工具结果过长，已省略中段 ${cut} 字符 — 如需完整内容请缩小范围重试]…\n${tail}`;
}

/** 文件写前 diff 审批提示（与 loop.ts 同语义；P3 接线时统一为共享 helper） */
function buildFileReviewPrompt(
  toolName: string,
  args: Record<string, unknown>,
  diff: string,
  risk: Risk,
): string {
  return (
    `[系统自动] 工具 ${toolName} 即将修改文件（风险 ${risk}）。请确认以下变更预览是否无误：\n\n` +
    diff +
    `\n\n变更参数摘要：${JSON.stringify(args)}\n若同意请确认，否则拒绝。`
  );
}

/**
 * 纯调度编排者：路由 → 委托把关 → 委托授权 → 执行 → 消息适配。
 * 五步均不含判定逻辑，判定全在 Gatekeeper / PermissionSystem 两个权威。
 */
export class ToolOrchestrator {
  private readonly tools: Map<string, ToolDef>;
  private readonly deps: OrchestratorDeps;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.tools = new Map(deps.tools.map((t) => [t.name, t]));
  }

  /** ① 路由：精确匹配 → 否则对无前缀的 MCP 工具做 __name 后缀模糊回退 */
  private route(name: string): ToolDef | undefined {
    const exact = this.tools.get(name);
    if (exact) return exact;
    if (name.includes('__')) return undefined; // 已是带前缀名，没找到即真缺失
    for (const def of this.tools.values()) {
      if (def.name.endsWith(`__${name}`)) return def; // MCP server__tool 模糊回退
    }
    return undefined;
  }

  async dispatch(req: ToolCallRequest): Promise<ToolCallResult> {
    // ① 路由
    const def = this.route(req.name);
    if (!def) {
      return { ok: false, needSelfHeal: true, output: '', errors: [`未知工具: ${req.name}`] };
    }

    // ② 委托把关：参数合法吗、风险多高
    const gate = this.deps.gatekeeper.inspect(req.name, req.rawArguments, def);
    if (!gate.ok) {
      return { ok: false, needSelfHeal: true, output: '', errors: gate.errors };
    }

    // ③ 委托授权：政策上让不让跑（destructive / isFileWrite 由编排者从 def+args 派生交给决策权威）
    const args = gate.repairedArgs as Record<string, unknown>;
    const destructive = def.name === 'run_command' && isDestructive(String(args.command ?? ''));
    const isFileWrite = !!def.preview;
    const verdict = decide({
      mode: this.deps.mode,
      effectiveRisk: gate.effectiveRisk,
      isFileWrite,
      destructive,
      toolName: def.name,
    });

    if (verdict.action === 'deny') {
      return { ok: false, denied: true, output: verdict.reason, needSelfHeal: false };
    }
    if (verdict.action === 'require_confirm') {
      let approved: boolean;
      if (verdict.channel === 'risk_prompt') {
        approved = await this.deps.ask(`即将执行高风险操作 ${def.name}，是否继续？`);
      } else {
        // file_review：编排者负责生成 diff 预览（它持有 def + args + cwd），但「要不要问」由权限系统决定
        const diff = def.preview
          ? await def.preview(args, {
              cwd: this.deps.cwd,
              signal: this.deps.signal,
              onProgress: this.deps.onToolProgress,
            })
          : '';
        approved = await this.deps.ask(buildFileReviewPrompt(def.name, args, diff, verdict.risk));
      }
      if (!approved) {
        return { ok: false, denied: true, output: `用户拒绝执行 ${def.name}`, needSelfHeal: false };
      }
    }

    // ④ 执行（用把关系统修复后的参数）
    const res: ToolResult = await def.execute(args, req.ctx);

    // ⑤ 消息适配（截断 + 包成响应）
    return { ok: res.ok, output: clampToolOutput(res.output), needSelfHeal: false };
  }
}
