// 端到端验证 workspace 路径规划（docs/UX优化-工作空间路径规划与源码目录保护.md 方案 A）
// 用真实项目根做 sourceRoot，模拟「在源码目录内 npm start」的解析链路
import { resolve } from 'node:path';
import { resolveWorkspace, parseWorkspaceFlag, isWithin } from '../src/config/workspace.ts';
import { buildSystemPrompt } from '../src/agent/system-prompt.ts';

const projectRoot = resolve(import.meta.dirname ?? '.', '..'); // scripts/.. = 项目根
let fail = 0;
const check = (name, cond) => {
  console.log(`[ws] ${cond ? 'ok ' : 'FAIL'} ${name}`);
  if (!cond) fail++;
};

// 场景 1：在源码目录内启动 → 警告 + 默认安全工作区
{
  const r = resolveWorkspace({ flag: null, env: null, cwd: projectRoot, sourceRoot: projectRoot });
  check('源码目录内启动产生警告', !!r.warn && r.warn.includes('源码目录'));
  check('警告说明已切换安全工作区', !!r.warn && r.warn.includes('安全工作区'));
  check('工作区 ≠ 源码目录', r.workspace !== projectRoot);
  console.log('[ws]   workspace =', r.workspace);
  console.log('[ws]   warn =', r.warn?.split('\n')[0]);
}

// 场景 2：--workspace flag 指向外部目录 → 无警告
{
  const r = resolveWorkspace({ flag: 'D:/work/foo', env: null, cwd: projectRoot, sourceRoot: projectRoot });
  check('flag 指定工作区无警告', r.warn === null);
  check('flag 工作区生效', isWithin(r.workspace, 'D:/work/foo'));
}

// 场景 3：正常项目目录启动 → cwd 即工作区
{
  const r = resolveWorkspace({ flag: null, env: null, cwd: 'D:/work/other-project', sourceRoot: projectRoot });
  check('正常目录无警告', r.warn === null);
  check('正常目录用 cwd', isWithin(r.workspace, 'D:/work/other-project'));
}

// 场景 4：buildSystemPrompt 注入 workspace + 保护规则
{
  const p = buildSystemPrompt('D:/work/foo', [projectRoot]);
  check('prompt 注入 workspace', p.includes('D:/work/foo'));
  check('prompt 注入保护目录', p.includes(projectRoot));
  check('prompt 含只读保护规则', p.includes('禁止向其中写入'));
  check('prompt 不含占位符', !p.includes('{{WORKSPACE}}') && !p.includes('{{PROTECTED_ROOTS}}'));
}

// 场景 5：parseWorkspaceFlag 两种形式
{
  check('flag 空格形式', parseWorkspaceFlag(['node', 'x', '--workspace', 'D:/a']) === 'D:/a');
  check('flag 等号形式', parseWorkspaceFlag(['node', 'x', '--workspace=D:/a']) === 'D:/a');
  check('flag 缺失返回 null', parseWorkspaceFlag(['node', 'x']) === null);
}

console.log(fail === 0 ? '\n[ws] ALL PASS' : `\n[ws] ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
