/**
 * 把关系统（Gatekeeper · S2.2）。
 *
 * 定位：工具编排者（Orchestrator）与「工具」之间的客观校验关。
 * 只做两件事，绝不涉及任何政策/授权判断：
 *   ① 参数解析兜底（extractArguments）+ JSON Schema 校验（validateArgs）
 *   ② 风险识别（isDestructive 升级为 high）
 *
 * 灭根因（对应 S1.1）：
 *   - #1 静默吞 JSON 错误 → 解析失败显式报错，模型可自愈。
 *   - #2 分发前无校验 → validateArgs 拦截缺参/类型错。
 *   - #4 缺参伪装成字面量 → 字段级错误不再流入 def.execute。
 *
 * 设计约束（见 deepseek-code-agent-工具编排者方案.md v2）：
 *   - Gatekeeper 不知道「政策」（explore/ask/execute、用户审批一概不管）。
 *   - 风险识别结果以 effectiveRisk 交给权限系统去决策。
 */

import type { Risk, ToolDef } from './types.ts';
import { extractArguments, validateArgs, type JsonSchemaLike } from './validation.ts';
import { isDestructive } from '../permission/index.ts';

/** 把关系统返回的审查报告：参数是否合法 + 修复后参数 + 识别出的有效风险。 */
export interface GateReport {
  ok: boolean;
  /** 解析/校验通过后、修复过的参数（如 regexExtractJSON 修复、缺参拦截后原样返回供模型纠正）。 */
  repairedArgs: Record<string, unknown>;
  /** 识别出的有效风险（含 isDestructive 升级）。 */
  effectiveRisk: Risk;
  /** 字段级错误明细（ok=false 时存在）。 */
  errors?: string[];
}

/** 把关系统接口：客观校验 + 风险识别。 */
export interface Gatekeeper {
  inspect(name: string, rawArgs: string | Record<string, unknown>, def: ToolDef): GateReport;
}

/**
 * 默认把关实现：validation（解析+校验）+ security（风险识别）的门面。
 * 纯同步、无 I/O、可单测。
 */
export class DefaultGatekeeper implements Gatekeeper {
  inspect(name: string, rawArgs: string | Record<string, unknown>, def: ToolDef): GateReport {
    // ① 参数解析兜底：模型可能给字符串(JSON)或已解析对象(MCP)。
    let parsed: { ok: boolean; value?: unknown; error?: string };
    if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
      // MCP 工具常直接传对象，无需再 JSON.parse（否则 String(obj) 会得到 '[object Object]'）。
      parsed = { ok: true, value: rawArgs };
    } else {
      parsed = extractArguments(rawArgs);
    }
    if (!parsed.ok) {
      return { ok: false, repairedArgs: {}, effectiveRisk: 'low', errors: [parsed.error ?? '参数无法解析'] };
    }
    const args = (parsed.value ?? {}) as Record<string, unknown>;

    // ② JSON Schema 校验（分发前拦下缺参/类型错）。
    const v = validateArgs(args, def.parameters as JsonSchemaLike);
    if (!v.ok) {
      // 原样返回 args，供权限/编排层决定如何把字段级错误回灌模型自愈。
      return { ok: false, repairedArgs: args, effectiveRisk: 'low', errors: v.errors };
    }

    // ③ 风险识别：破坏性命令升级为 high（无论工具默认风险）。
    const destructive =
      def.name === 'run_command' && isDestructive(String((args as Record<string, unknown>).command ?? ''));
    const effectiveRisk: Risk = destructive ? 'high' : def.risk;

    return { ok: true, repairedArgs: args, effectiveRisk };
  }
}
