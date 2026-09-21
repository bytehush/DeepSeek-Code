/**
 * 权限引擎（内核基座 P0 版）—— 权限的唯一事实源。
 *
 * 取代重构前的 src/permission/：
 *   - decide()（单轴：PermissionMode × 风险）语义逐分支等价保留，
 *     旧 TUI 的 /mode explore|ask|execute 交互不变；
 *   - 新增 **三维能力闸门 decide3()**：read / write / exec / net 四个
 *     能力维度各自独立授权（数据安全第 4 条：权限分离 + 不可信仓库默认禁网）。
 *
 * 延续的好传统：纯函数、零 I/O、决策与执行分离——副作用（询问用户、
 * 生成 diff、拦截请求）全部在调用方。
 */

/** 工具风险档位 */
export type Risk = 'low' | 'mid' | 'high';

/** 权限模式（旧单轴，P0 交互契约不变） */
export type PermissionMode = 'explore' | 'ask' | 'execute';

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
 * 单轴裁决：explore 仅放行 low；ask 对文件写/高风险确认；
 * execute 对 destructive/文件写确认（安全底线），其余放行。
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

// ── 三维能力闸门 ──────────────────────────────────────────────

/** 能力维度：读文件 / 写与编辑 / 执行命令 / 网络外发 */
export type Capability = 'read' | 'write' | 'exec' | 'net';

/** 单维授权档位 */
export type Tier = 'auto' | 'confirm' | 'block';

/** 四维权限矩阵（会话级状态；P0 由旧 mode 派生，P2 支持逐维交互调整） */
export interface CapabilityMatrix {
  read: Tier;
  write: Tier;
  exec: Tier;
  net: Tier;
}

export function isMutatingCapability(cap: Capability): boolean {
  return cap === 'write' || cap === 'exec' || cap === 'net';
}

/**
 * 从旧的单轴模式派生矩阵（迁移期兼容层）。
 * explore → 全部写/执行/网络 block；ask → confirm；execute → auto（destructive 仍强制确认）。
 */
export function matrixFromMode(mode: PermissionMode): CapabilityMatrix {
  if (mode === 'explore') {
    return { read: 'auto', write: 'block', exec: 'block', net: 'auto' };
  }
  if (mode === 'ask') {
    return { read: 'auto', write: 'confirm', exec: 'confirm', net: 'confirm' };
  }
  return { read: 'auto', write: 'auto', exec: 'auto', net: 'auto' };
}

export interface Decide3Input {
  matrix: CapabilityMatrix;
  capability: Capability;
  toolName: string;
  /** 已含 destructive 升级的有效风险 */
  effectiveRisk: Risk;
  destructive: boolean;
  /** 当前仓库是否可信（P2 接工作区信任；false 时 net 维度强制 confirm） */
  repoTrusted?: boolean;
}

/**
 * 三维裁决。优先级（高→低）：
 *   destructive（任何模式）→ block 档位 → 不可信仓库的 net → confirm 档位
 *   → high 风险在 auto 档位下升级为 confirm → 放行。
 * 与 decide() 同为纯函数：只吐决策。
 */
export function decide3(input: Decide3Input): PermissionVerdict {
  const { matrix, capability, toolName, effectiveRisk, destructive, repoTrusted } = input;
  const tier = matrix[capability];

  // 安全底线：破坏性操作任何档位都要人确认（block 时直接拒绝）
  if (destructive) {
    if (tier === 'block') return { action: 'deny', reason: `${capability} 维度已封锁，拒绝 ${toolName}` };
    return { action: 'require_confirm', channel: 'risk_prompt', risk: 'high' };
  }

  if (tier === 'block') {
    return { action: 'deny', reason: `${capability} 维度处于封锁档，拦截 ${toolName}` };
  }

  // 不可信仓库：网络外发需显式确认（数据边界第 4 条）
  if (capability === 'net' && repoTrusted === false) {
    return { action: 'require_confirm', channel: 'risk_prompt', risk: effectiveRisk };
  }

  if (tier === 'confirm') {
    const channel = capability === 'write' ? 'file_review' : 'risk_prompt';
    return { action: 'require_confirm', channel, risk: effectiveRisk };
  }

  // auto 档位下 high 风险仍升级确认（与旧 decide(execute) 语义一致）
  if (effectiveRisk === 'high' && isMutatingCapability(capability)) {
    return { action: 'require_confirm', channel: 'risk_prompt', risk: effectiveRisk };
  }

  return { action: 'allow' };
}

/**
 * 破坏性命令静态检测（安全底线：即使 execute/auto 档也升级 high 并确认）。
 * 自旧 src/permission/index.ts 迁移，补 POSIX 形态。
 */
const DESTRUCTIVE_PATTERNS = [
  /rm\s+-rf\s+\//,
  /rm\s+-rf\s+~\//,
  /rm\s+(-[a-z]*)?rf\s+(-[a-z]*)?\s*(\/|\*|~)(\s|$)/i,
  /mkfs/,
  /dd\s+if=/,
  /git\s+push\s+--force/,
  /git\s+push\s+-f\s/,
  /drop\s+table/i,
  /drop\s+database/i,
  /shutdown/,
  /reboot/,
  />\s*\/dev\/sd/,
  /taskkill\s+\/f\s+\/im/i,
  /chmod\s+-R\s+777\s+\//,
  /curl[^|]*\|\s*(sudo\s+)?(ba)?sh/,
  /wget[^|]*\|\s*(sudo\s+)?(ba)?sh/,
];

export function isDestructive(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(command));
}

