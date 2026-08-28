/**
 * 工作空间解析（docs/UX优化-工作空间路径规划与源码目录保护.md 方案 A）。
 *
 * 问题：agent 的 4 个原子工具（read/write/edit/bash）工作根 = workspace，
 * 旧实现默认 workspace = process.cwd()（启动目录）——用户在源码目录 npm start
 * 时，agent 会直接读写/修改自己的源码，危险（R1/R4）。
 *
 * 本模块提供**纯函数**解析（无 IO，便于单测）：
 *   优先级：--workspace flag > DSA_WORKSPACE env > (cwd ∈ sourceRoot ? 默认 : cwd)
 *   - cwd 在源码目录内 → 警告 + 切到用户级安全工作区 ~/.dsa/workspace（自动创建）
 *   - 其余 → cwd 即工作区（用户从任意项目目录启动的常规语义）
 *
 * 源码目录（sourceRoot）= 项目根（package.json 所在）——由 main.ts 用
 * import.meta.dirname 计算传入，本模块不做磁盘探测。
 */
import { resolve, normalize } from 'node:path';
import { homedir } from 'node:os';

/** 默认安全工作区目录名（挂在 ~/.dsa 下，与 credentials/accounts 同层） */
export const DEFAULT_WORKSPACE_SUBDIR = 'workspace';

/** 工作区解析结果 */
export interface WorkspaceConfig {
  /** 最终工作区绝对路径（已 normalize；可能需 mkdir，由调用方负责） */
  workspace: string;
  /** 源码根（受保护目录，写操作禁止落点）——绝对路径 */
  sourceRoot: string;
  /** 启动警告文案（检测到 cwd 在源码目录内时非空），由 CLI 打印 */
  warn: string | null;
}

/** Windows 下比较路径忽略大小写（D:/ vs d:/）；POSIX 严格区分 */
function pathKey(p: string): string {
  const norm = normalize(p);
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

/** a 是否在 b 内部（或等于 b）——路径级判定，不做磁盘 exists 探测 */
export function isWithin(a: string, b: string): boolean {
  const ka = pathKey(a);
  const kb = pathKey(b);
  return ka === kb || ka.startsWith(kb.endsWith('\\') || kb.endsWith('/') ? kb : kb + '/') || ka.startsWith(kb.endsWith('\\') || kb.endsWith('/') ? kb : kb + '\\');
}

/**
 * 解析最终工作区（纯函数，无文件系统副作用）。
 *
 * @param opts.flag   --workspace 命令行参数值（已从 argv 抽出；null=未提供）
 * @param opts.env    DSA_WORKSPACE 环境变量值（null=未设置）
 * @param opts.cwd    启动目录（process.cwd()）
 * @param opts.sourceRoot 源码根（受保护目录）
 * @param opts.defaultRoot 用户级数据根（~/.dsa）——cwd 在源码目录内时的默认工作区挂载点
 */
export function resolveWorkspace(opts: {
  flag: string | null;
  env: string | null;
  cwd: string;
  sourceRoot: string;
  defaultRoot?: string;
}): WorkspaceConfig {
  const { flag, env, cwd, sourceRoot } = opts;
  const defaultRoot = opts.defaultRoot ?? resolve(homedir(), '.dsa');

  // 1. flag 最优先（用户显式指定 = 知情同意，即使指向源码目录也放行）
  if (flag && flag.trim()) {
    return { workspace: resolve(flag.trim()), sourceRoot, warn: null };
  }
  // 2. env 次优
  if (env && env.trim()) {
    return { workspace: resolve(env.trim()), sourceRoot, warn: null };
  }
  // 3. cwd 在源码目录内 → 警告 + 默认安全工作区
  if (isWithin(cwd, sourceRoot)) {
    const ws = resolve(defaultRoot, DEFAULT_WORKSPACE_SUBDIR);
    return {
      workspace: ws,
      sourceRoot,
      warn:
        `⚠️  检测到当前目录是 Agent 源码目录（${sourceRoot}），在此直接工作可能误改自身代码。\n` +
        `    已自动切换到安全工作区：${ws}\n` +
        `    如需指定其他工作区，请用 --workspace <路径> 启动。`,
    };
  }
  // 4. 常规语义：启动目录即工作区
  return { workspace: resolve(cwd), sourceRoot, warn: null };
}

/**
 * 从 argv 抽出 --workspace 值（支持 `--workspace <p>` 与 `--workspace=<p>`）。
 * 未提供返回 null；提供但缺值返回 null（不报错，走默认）。
 */
export function parseWorkspaceFlag(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workspace') {
      const v = argv[i + 1];
      if (v && !v.startsWith('-')) return v;
      return null;
    }
    if (a.startsWith('--workspace=')) {
      const v = a.slice('--workspace='.length);
      return v || null;
    }
  }
  return null;
}
