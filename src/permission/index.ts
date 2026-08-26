/**
 * 权限模块（src/permission）
 *
 * 从 agent/loop.ts 与 tools/index.ts 提拔的「权限模式枚举」与「破坏性操作判定」单一事实源。
 * - PermissionMode：全局权限模式枚举（explore / ask / execute）。
 * - isDestructive：破坏性 shell 命令静态检测，供权限闸门与安全护栏使用。
 *
 * 本模块为纯函数 + 纯类型，不依赖 tools/*，避免循环引用。
 * 闸门决策逻辑（decide）见后续 S4.3 的 permission-system.ts。
 */

export type PermissionMode = 'explore' | 'ask' | 'execute';

/**
 * 工具风险档位（low/mid/high）。
 * 原定义于 src/tools/types.ts，P2 自研领域工具清理时迁入本权限模块
 * —— 它是权限闸门决策（permission-system.ts）的核心输入，与具体工具实现无关。
 */
export type Risk = 'low' | 'mid' | 'high';

// 破坏性命令静态检测（安全底线：即使 execute 模式也升级为 high 并确认）
const DESTRUCTIVE_PATTERNS = [
  /rm\s+-rf\s+\//,
  /rm\s+-rf\s+~\//,
  /mkfs/,
  /dd\s+if=/,
  /git\s+push\s+--force/,
  /git\s+push\s+-f\s/,
  /drop\s+table/i,
  /drop\s+database/i,
  /shutdown/,
  /reboot/,
  />\s*\/dev\/sd/,
  /taskkill\s+\/f\s+\/im/, // 强杀全进程（可能误杀 Agent 自身）
];

export function isDestructive(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(command));
}

// 权限闸门决策（纯政策权威），S4.3 自 loop.ts 内联闸门提拔而来。
export { decide } from './permission-system.ts';
export type { PermissionVerdict, DecideInput } from './permission-system.ts';
