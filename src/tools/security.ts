// 安全工具函数（S1.2 从 index.ts 拆分）：秘钥过滤 + 源码改写拦截。
// 注：isDestructive/DESTRUCTIVE_PATTERNS 已在 S4.2 提拔至 src/permission/，此处不再重复。

/**
 * 安全环境变量过滤：复制 process.env 但移除敏感秘钥，
 * 防止通过子进程（run_command / MCP）泄露 API Key 等凭据。
 */
/** 密钥类环境变量名正则：凡是疑似秘钥/令牌/密码的变量都不透传给子进程与 MCP server */
const SECRET_ENV_RE =
  /(API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_?KEY|CREDENTIALS?|ACCESS_?TOKEN|SESSION_?SECRET)$/i;

/**
 * 安全环境变量过滤：复制 process.env 但移除疑似秘钥的变量，
 * 防止通过子进程（run_command / MCP）泄露 API Key 等凭据。
 * 比硬编码 4 个 key 更稳——任何新增的 *_KEY / *_SECRET / *_TOKEN 都会自动被剥离。
 */
export function safeEnv(): Record<string, string | undefined> {
  const env = process.env as Record<string, string | undefined>;
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_ENV_RE.test(k)) continue; // 剥离疑似秘钥
    out[k] = v;
  }
  return out;
}

/**
 * 安全护栏：检测命令是否通过 run_command 改写项目源码文件。
 * 修改源码应使用 edit_file 工具，禁止用终端命令（如 node -e 正则替换、sed -i、
 * 重定向/tee 写源码、git checkout -- 丢弃改动）绕过，避免无 diff 审批的破坏性改动。
 */
export function isSourceMutating(command: string): boolean {
  const SRC = 'ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|json|md|css|html|vue';
  // node -e/--eval/--input-type 内联脚本且含文件写操作（如 readFileSync(...).replace / writeFileSync）
  if (
    /\bnode(?:\.exe)?\s+(?:-[ep]|--eval|--input-type)/.test(command) &&
    /writeFileSync|writeFile\(|appendFileSync|createWriteStream|copyFileSync|fs\.writeFile|readFileSync\([^)]*\)\s*\.replace/.test(command)
  ) {
    return true;
  }
  // sed -i / perl -i 原地改写
  if (/\bsed\b[^|]*\s-i\b/.test(command)) return true;
  if (/\bperl\b[^|]*\s-i\b/.test(command)) return true;
  // 重定向 / tee 写入源码文件
  if (new RegExp(`(?:>>?|>)\\s*['"]?[\\w./\\\\-]+\\.(?:${SRC})`).test(command)) return true;
  if (new RegExp(`\\btee\\b.+\\.(?:${SRC})`).test(command)) return true;
  // git checkout -- 丢弃工作区源码改动
  if (/\bgits*\s+checkout\s+--\s+/.test(command)) return true;
  return false;
}
