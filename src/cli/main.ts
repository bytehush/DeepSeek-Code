import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { startApp } from './app.tsx';
import { assembleAppProps } from '../app/assemble.ts';
import { resolveCredentials, saveCredentials, loadStoredCredentials, maskKey, type Credentials } from './auth.ts';
import { runLogin } from './login.tsx';
import { resolveWorkspace, parseWorkspaceFlag } from '../config/workspace.ts';

async function main(): Promise<void> {
  // 非交互终端（管道 / CI / 无 TTY 的远程会话）下 ink 无法接管 stdin，
  // 提前给出友好提示并退出，避免抛出 "Raw mode is not supported" 堆栈。
  if (!process.stdin.isTTY) {
    console.error(
      '⚠️  DeepSeek Code Agent 是一个终端交互程序（TUI），需要在交互式终端中运行。\n' +
        '    当前环境未检测到 TTY（stdin 不是终端），无法启动界面。\n' +
        '    请在你的本机终端（Windows Terminal / PowerShell / Git Bash 等）中执行：\n' +
        '        npm start\n' +
        '    即可看到蓝鲸聊天界面。',
    );
    process.exit(1);
  }

  // 项目根目录：全局命令可能在任意目录启动，但配置/凭证应锚定在项目根
  const projectRoot = resolve(import.meta.dirname ?? '.', '../../');
  const cwd = process.cwd();

  // ── 工作空间解析（方案 A：flag > env > (cwd∈源码根 ? 默认安全工作区 : cwd)）──
  // 源码根 = 项目根（agent 自身代码目录，受保护只读）——见
  // docs/UX优化-工作空间路径规划与源码目录保护.md
  const ws = resolveWorkspace({
    flag: parseWorkspaceFlag(process.argv),
    env: process.env.DSA_WORKSPACE ?? null,
    cwd,
    sourceRoot: projectRoot,
  });
  if (ws.warn) console.warn(ws.warn);
  // 默认安全工作区需确保存在（首次使用自动创建）
  try {
    mkdirSync(ws.workspace, { recursive: true });
  } catch {
    // 目录创建失败不阻塞启动（工具写入时仍会尝试创建父目录）
  }

  // ── 凭证解析 + 登录门禁 ──
  const forceSetKey = process.argv.includes('--set-key') || process.argv.includes('-k');
  let creds = await resolveCredentials(projectRoot, cwd);
  const firstRun = !creds;

  if (forceSetKey || !creds) {
    const entered = await runLogin(firstRun);
    if (!entered) {
      if (firstRun) {
        console.error('已取消登录，无法启动（需要 API Key）。');
        process.exit(1);
      }
      creds = await loadStoredCredentials();
      if (!creds) {
        console.error('已取消，且无可用凭证。');
        process.exit(1);
      }
    } else {
      creds = entered;
      await saveCredentials(creds);
      console.log('[auth] 已保存 API Key 到 ~/.dsa/credentials.json');
    }
  } else {
    console.log(`[auth] 使用已保存的 API Key（${maskKey(creds.apiKey)}）`);
  }

  // 内核装配（与网页后端共用同一份 assembleAppProps）
  const props = await assembleAppProps(creds as Credentials, {
    workspace: ws.workspace,
    protectedRoots: [ws.sourceRoot],
  });
  await startApp(props);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
