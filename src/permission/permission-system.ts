/**
 * 权限闸门政策决策（纯函数，无 I/O）。
 *
 * 把 loop.ts 内联的 if-else 权限闸门（原约 780-826 行）提拔为单一政策权威。
 * 仅吐决策（allow / deny / require_confirm），不涉及：
 *   - 询问用户（由调用方用 opts.ask 执行）
 *   - 生成文件 diff（由调用方用 def.preview 执行）
 *   - 发送 AgentEvent / 写 trace（由调用方执行）
 *
 * 有效风险 effectiveRisk 已由调用方完成 destructive 升级（destructive ? 'high' : def.risk），
 * 本函数只消费最终风险，不做破坏性二次判定。
 */

import type { PermissionMode } from './index.ts';
import type { Risk } from '../tools/index.ts';

export type PermissionVerdict =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'require_confirm'; channel: 'file_review' | 'risk_prompt'; risk: Risk };

export interface DecideInput {
  mode: PermissionMode;
  /** 已含 destructive 升级后的有效风险 */
  effectiveRisk: Risk;
  isFileWrite: boolean;
  destructive: boolean;
  toolName: string;
}

/**
 * 依据权限模式 + 有效风险 + 是否文件写，产出权限裁决。
 * 行为与原 loop.ts 内联闸门逐分支等价：
 * - explore：仅 low 风险放行，其余一律拦截。
 * - ask：文件写 → 弹 diff 确认；high 风险 → 弹风险确认；其余放行。
 * - execute：destructive / 文件写 → 弹确认（安全底线）；其余放行。
 */
export function decide(input: DecideInput): PermissionVerdict {
  const { mode, effectiveRisk, isFileWrite, destructive, toolName } = input;

  if (mode === 'explore') {
    if (effectiveRisk !== 'low') {
      return { action: 'deny', reason: `explore 模式拦截 ${toolName}（风险 ${effectiveRisk}）` };
    }
    return { action: 'allow' };
  }

  if (mode === 'ask') {
    if (isFileWrite) return { action: 'require_confirm', channel: 'file_review', risk: effectiveRisk };
    if (effectiveRisk === 'high') return { action: 'require_confirm', channel: 'risk_prompt', risk: effectiveRisk };
    return { action: 'allow' };
  }

  // execute
  if (destructive) return { action: 'require_confirm', channel: 'risk_prompt', risk: effectiveRisk };
  if (isFileWrite) return { action: 'require_confirm', channel: 'file_review', risk: effectiveRisk };
  return { action: 'allow' };
}
