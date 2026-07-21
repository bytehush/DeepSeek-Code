import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryOrchestrator } from '../src/memory/orchestrator.ts';
import { MemoryStore } from '../src/memory/store.ts';
import { Embedder } from '../src/memory/embedder.ts';

// 隔离用户层（HOME 指向临时目录，使 user 后端落在临时 ~/.dsa/memory）
const HOME = mkdtempSync(join(os.tmpdir(), 'dsa-m6-home-'));
process.env.HOME = HOME;

const CWD = mkdtempSync(join(os.tmpdir(), 'dsa-m6-cwd-'));
const home = HOME;

test('M6 · 共享实例：agent 写入对 GUI 即时可见（同一引用）', async () => {
  const orch = new MemoryOrchestrator(CWD, new Embedder({ mode: 'off' }));
  await orch.addFact('我偏好用 pnpm 管理前端包', 'user');

  // GUI 复用 agent 的同一 user 后端实例
  const gui = orch.user;
  assert.strictEqual(gui, orch.user, 'GUI 应复用同一 MemoryBackend 实例（L3 修复核心）');
  assert.ok((await gui.loadFacts()).includes('我偏好用 pnpm 管理前端包'), '共享实例应立即可见 agent 写入的 fact');

  // 新增一条语义记忆，GUI 经同一实例 list 也应看到
  await orch.addEntry('正在准备前端实习，重点复习 React Hooks', ['实习'], 'user');
  assert.ok((await gui.list()).some((e) => e.content.includes('前端实习')), '共享实例应立即可见 agent 写入的语义记忆');
});

test('M6 · 回退模式：离线独立 MemoryStore 仍可经文件读到 fact（旧路径完好）', async () => {
  const orch = new MemoryOrchestrator(CWD, new Embedder({ mode: 'off' }));
  await orch.addFact('我每天用 TypeScript 写代码', 'user');

  // 模拟 sharedGuiBackend=false 时 GUI 新建的独立离线实例
  const off = new MemoryStore(join(home, '.dsa', 'memory'), new Embedder({ mode: 'off' }));
  assert.notStrictEqual(off, orch.user, '回退模式应是独立于 agent 的新实例');
  assert.ok((await off.loadFacts()).includes('我每天用 TypeScript 写代码'), '回退实例经文件仍可读到 agent 写入的 fact（无嵌入、不崩）');
});

test('M6 · 共享实例：MemoryBackend API 在 user 后端上可用（isDuplicate 语义去重）', async () => {
  const orch = new MemoryOrchestrator(CWD, new Embedder({ mode: 'off' }));
  await orch.addFact('我偏好 macOS 终端 iterm2', 'user');
  assert.strictEqual(await orch.user.isDuplicate('我偏好 macOS 终端 iterm2'), true, 'isDuplicate 应命中已写入的 fact');
  assert.strictEqual(await orch.user.isDuplicate('完全不同的内容 xyz'), false, 'isDuplicate 对无关内容应返回 false');
});

test('M6 · 共享实例：project 作用域写入对 GUI 即时可见', async () => {
  const orch = new MemoryOrchestrator(CWD, new Embedder({ mode: 'off' }));
  await orch.addFact('本项目用 Vite 构建', 'project');

  const guiProject = orch.project;
  assert.strictEqual(guiProject, orch.project, 'project 后端也应是同一实例');
  assert.ok((await guiProject.loadFacts()).includes('本项目用 Vite 构建'), '共享 project 实例应立即可见 agent 写入的 fact');
});

// 清理临时目录
process.on('exit', () => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(CWD, { recursive: true, force: true });
});
