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
 * 注意：本模块现已由 src/agent/core.ts::runCore 的 dispatch 内循环接线为
 * 工具执行的唯一入口（S2.1 接线，见 commit）。core 仍负责事件/yield/history/异常，
 * 编排者严守「被指挥」铁律：不写 history、不 yield、只消费 Gatekeeper / PermissionSystem 的判定。
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
  /**
   * 权限观测回调：编排者在「问用户」或「直接拒绝」时调用（granted=false 表示拒绝/拦截）。
   * 编排者自身不 yield / 不写 history——由调用方（core.ts）借此回调把权限事件转交 UI。
   */
  onPermission?: (toolName: string, granted: boolean) => void;
  trace?: { log: (type: string, data: unknown) => Promise<void> | void };
}

function riskBadge(risk: Risk): string {
  return risk === 'high' ? '[高危]' : risk === 'mid' ? '[中危]' : '[低危]';
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

/** 文件写前 diff 审批提示（统一为编排者单一事实源，P3 接线后 loop 不再自带副本） */
function buildFileReviewPrompt(
  toolName: string,
  args: Record<string, unknown>,
  diff: string,
  risk: Risk,
): string {
  let detail = '';
  if (toolName === 'delete_file' || toolName === 'edit_file' || toolName === 'create_file') {
    detail = `\n  路径: ${String(args.path ?? '')}`;
  }
  return (
    `🔍 写前审批 ${toolName} ${riskBadge(risk)}：即将修改文件${detail}\n` +
    (diff ? `${diff}\n` : '') +
    `  是否允许此文件变更？(yes/no) `
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
      this.deps.onPermission?.(def.name, false);
      return { ok: false, denied: true, output: verdict.reason, needSelfHeal: false };
    }
    if (verdict.action === 'require_confirm') {
      let approved: boolean;
      if (verdict.channel === 'risk_prompt') {
        approved = await this.deps.ask(`${riskBadge(verdict.risk)} 即将执行高风险操作 ${def.name}，是否继续？`);
      } else {
        // file_review：编排者负责生成 diff 预览（它持有 def + args + cwd），但「要不要问」由权限系统决定
        const diff = def.preview
          ? await def.preview(args, {
              cwd: this.deps.cwd,
              signal: this.deps.signal,
              onProgress: req.ctx.onProgress,
            })
          : '';
        approved = await this.deps.ask(buildFileReviewPrompt(def.name, args, diff, verdict.risk));
      }
      this.deps.onPermission?.(def.name, approved);
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
