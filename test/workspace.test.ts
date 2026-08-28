/**
 * workspace 解析 + 源码目录写保护单测
 * （docs/UX优化-工作空间路径规划与源码目录保护.md 方案 A）。
 *
 * 覆盖：
 *   1. resolveWorkspace 优先级（flag > env > cwd∈sourceRoot ? 默认 : cwd）
 *   2. parseWorkspaceFlag 两种形式
 *   3. isWithin 路径包含判定（win32 大小写）
 *   4. 工具层写保护：write/edit 落 protectedRoots → throw；read 不拦（真实 tmp 目录执行）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspace, parseWorkspaceFlag, isWithin, DEFAULT_WORKSPACE_SUBDIR } from '../src/config/workspace.ts';
import { createAtomicTools } from '../src/agent/pi-tools.ts';

// ── 纯函数：resolveWorkspace ──

test('resolveWorkspace：flag 最优先（指向源码目录也放行 = 知情同意）', () => {
  const r = resolveWorkspace({
    flag: 'D:/work/explicit',
    env: 'D:/work/env',
    cwd: 'D:/work/cwd',
    sourceRoot: 'D:/work/src',
    defaultRoot: 'D:/data',
  });
  assert.equal(r.workspace, process.platform === 'win32' ? 'D:\\work\\explicit' : 'D:/work/explicit');
  assert.equal(r.warn, null, 'flag 显式指定不警告');
});

test('resolveWorkspace：env 次优（flag 缺失时生效）', () => {
  const r = resolveWorkspace({
    flag: null,
    env: 'D:/work/env',
    cwd: 'D:/work/cwd',
    sourceRoot: 'D:/work/src',
    defaultRoot: 'D:/data',
  });
  assert.match(r.workspace, /work[\\/]env$/);
  assert.equal(r.warn, null);
});

test('resolveWorkspace：cwd 在源码目录内 → 警告 + 默认安全工作区', () => {
  const r = resolveWorkspace({
    flag: null,
    env: null,
    cwd: 'D:/work/src', // 就是源码根
    sourceRoot: 'D:/work/src',
    defaultRoot: 'D:/data',
  });
  assert.match(r.workspace, new RegExp(`data[\\\\/]${DEFAULT_WORKSPACE_SUBDIR}$`), '默认工作区挂在 defaultRoot/workspace');
  assert.ok(r.warn && r.warn.includes('源码目录'), '应产生警告');
  assert.ok(r.warn && r.warn.includes('安全工作区'), '警告应说明已切换');
});

test('resolveWorkspace：cwd 在源码目录子目录内 → 同样警告 + 默认工作区', () => {
  const r = resolveWorkspace({
    flag: null,
    env: null,
    cwd: 'D:/work/src/sub/dir', // 源码根内部
    sourceRoot: 'D:/work/src',
    defaultRoot: 'D:/data',
  });
  assert.match(r.workspace, /data[\\/]workspace$/);
  assert.ok(r.warn, '子目录启动同样警告');
});

test('resolveWorkspace：cwd 正常（非源码目录）→ 用 cwd，无警告', () => {
  const r = resolveWorkspace({
    flag: null,
    env: null,
    cwd: 'D:/work/foo-project',
    sourceRoot: 'D:/work/src',
    defaultRoot: 'D:/data',
  });
  assert.match(r.workspace, /foo-project$/);
  assert.equal(r.warn, null);
});

test('resolveWorkspace：flag/env 空白值忽略', () => {
  const r = resolveWorkspace({
    flag: '  ',
    env: '',
    cwd: 'D:/work/normal',
    sourceRoot: 'D:/work/src',
    defaultRoot: 'D:/data',
  });
  assert.match(r.workspace, /normal$/);
});

// ── 纯函数：parseWorkspaceFlag ──

test('parseWorkspaceFlag：--workspace <path> 与 --workspace=<path>', () => {
  assert.equal(parseWorkspaceFlag(['node', 'x', '--workspace', 'D:/a/b']), 'D:/a/b');
  assert.equal(parseWorkspaceFlag(['node', 'x', '--workspace=D:/a/b']), 'D:/a/b');
  assert.equal(parseWorkspaceFlag(['node', 'x', '--workspace']), null, '缺值返回 null');
  assert.equal(parseWorkspaceFlag(['node', 'x', '--set-key']), null, '无 flag 返回 null');
  assert.equal(parseWorkspaceFlag(['node', 'x', '--workspace', '--set-key']), null, '下一个参数是 flag 视为缺值');
});

// ── 纯函数：isWithin ──

test('isWithin：路径包含判定（含 win32 大小写归一）', () => {
  assert.equal(isWithin('D:/a/b/c.ts', 'D:/a'), true, '子路径包含');
  assert.equal(isWithin('D:/a', 'D:/a'), true, '相等包含');
  assert.equal(isWithin('D:/ab', 'D:/a'), false, '前缀但非目录边界（ab vs a/）');
  assert.equal(isWithin('D:/a/b', 'D:/a/c'), false, '无关路径');
  if (process.platform === 'win32') {
    assert.equal(isWithin('d:/A/B/C.ts', 'D:/a'), true, 'win32 忽略大小写');
  }
});

// ── 工具层写保护（真实 tmp 目录执行）──

function setupTmp(): { root: string; ws: string; src: string; tools: ReturnType<typeof createAtomicTools> } {
  const root = mkdtempSync(join(tmpdir(), 'dsa-ws-test-'));
  const ws = join(root, 'ws');
  const src = join(root, 'src');
  mkdirSync(ws, { recursive: true });
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'protect.txt'), 'SOURCE', 'utf-8');
  const tools = createAtomicTools({ cwd: ws, protectedRoots: [src] });
  return { root, ws, src, tools };
}

function findTool(tools: ReturnType<typeof createAtomicTools>, name: string) {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `工具 ${name} 应存在`);
  return t;
}

test('write_file：相对路径 ../ 逃逸到受保护目录 → 拒绝', async () => {
  const { root, src, tools } = setupTmp();
  try {
    const tool = findTool(tools, 'write_file');
    await assert.rejects(
      () => tool.execute('id', { path: '../src/evil.ts', content: 'x' }),
      /拒绝写入受保护目录/,
      '相对逃逸应 throw 保护错误',
    );
    // 保护文件未被改动
    const { readFileSync } = await import('node:fs');
    assert.equal(readFileSync(join(src, 'protect.txt'), 'utf-8'), 'SOURCE', '源码目录文件未被写');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('write_file：绝对路径写入受保护目录 → 拒绝', async () => {
  const { root, src, tools } = setupTmp();
  try {
    const tool = findTool(tools, 'write_file');
    await assert.rejects(
      () => tool.execute('id', { path: join(src, 'evil.ts'), content: 'x' }),
      /拒绝写入受保护目录/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('write_file：工作区内正常写入 → 成功', async () => {
  const { root, ws, tools } = setupTmp();
  try {
    const tool = findTool(tools, 'write_file');
    await tool.execute('id', { path: 'hello.txt', content: 'hi' });
    const { readFileSync } = await import('node:fs');
    assert.equal(readFileSync(join(ws, 'hello.txt'), 'utf-8'), 'hi');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('edit_file：对受保护目录文件执行编辑 → 拒绝', async () => {
  const { root, src, tools } = setupTmp();
  try {
    const tool = findTool(tools, 'edit_file');
    await assert.rejects(
      () => tool.execute('id', { path: join(src, 'protect.txt'), old: 'SOURCE', new: 'HACKED' }),
      /拒绝写入受保护目录/,
    );
    const { readFileSync } = await import('node:fs');
    assert.equal(readFileSync(join(src, 'protect.txt'), 'utf-8'), 'SOURCE', '源码文件未被改');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('read_file：读取受保护目录 → 允许（读不拦）', async () => {
  const { root, src, tools } = setupTmp();
  try {
    const tool = findTool(tools, 'read_file');
    const r = await tool.execute('id', { path: join(src, 'protect.txt') });
    const text = r.content?.[0]?.type === 'text' ? r.content[0].text : '';
    assert.equal(text, 'SOURCE', '源码目录可读');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 回归：无 protectedRoots 时行为不变（旧调用兼容）──

test('createAtomicTools：未配置 protectedRoots 时写任意路径（旧语义兼容）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsa-ws-legacy-'));
  try {
    const tools = createAtomicTools({ cwd: root });
    const tool = findTool(tools, 'write_file');
    await tool.execute('id', { path: 'a/b.txt', content: 'x' });
    const { readFileSync } = await import('node:fs');
    assert.equal(readFileSync(join(root, 'a', 'b.txt'), 'utf-8'), 'x');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
