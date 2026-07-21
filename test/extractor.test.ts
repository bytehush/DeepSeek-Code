/**
 * extractor fact 作用域路由单测（M4 · P1b 修复 L4）。
 *
 * 锁定：抽出 kind=fact 的记忆按 loadMemoryConfig().factScopeUser 路由到 user/project 层；
 * kind=semantic 始终写 project 层。flag 默认 false（=写 project，与旧路径逐字节一致）。
 *
 * 隔离：每个用例独立临时 HOME（user 层 ~/.dsa/memory）与临时 cwd（project 层
 * <cwd>/.dsa/memory），避免跨用例污染；并隔离 DSA_MEMORY_FLAGS 环境变量。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { MemoryOrchestrator } from '../src/memory/orchestrator.ts';
import { Embedder } from '../src/memory/embedder.ts';
import { extractUserMemories } from '../src/memory/extractor.ts';
import type { ConversationHistory } from '../src/context/history.ts';
import type { DeepSeekClient } from '../src/llm/deepseek.ts';

/** 一段足够长（>200 字符）的对话历史，确保 extractUserMemories 不因过短跳过。 */
function makeHistory(): ConversationHistory {
  return {
    getMessages: () => [
      {
        role: 'user',
        content:
          '我平时都用 pnpm 来管理前端的包，因为 pnpm 比较快而且省磁盘空间，我不太喜欢 npm 的扁平 node_modules 结构。' +
          '我们团队内部也约定了提交信息要用 Conventional Commits 规范，并且 CI 必须全绿才能合并主干分支。',
      },
      { role: 'assistant', content: '明白了，我会记住你偏好 pnpm 而不是 npm。' },
      {
        role: 'user',
        content:
          '另外我们项目统一用 React 加 TypeScript，组件全部用函数式写法，不要写 class 组件，状态用 hooks 管理。' +
          '样式方面偏好 CSS Modules，测试用 Vitest，构建用 Vite，这些是当前阶段的学习重点。',
      },
    ],
  } as unknown as ConversationHistory;
}

/** 假 client：返回 1 条 fact + 1 条 semantic 的 JSON（覆盖两种作用域路由）。 */
function makeClient() {
  const calls: unknown[][] = [];
  const client = {
    primaryModel: 'deepseek-v4-flash',
    async complete(...args: unknown[]): Promise<string> {
      calls.push(args);
      return JSON.stringify([
        { content: '偏好使用 pnpm 包管理器', kind: 'fact', tags: ['工具'] },
        { content: '正在准备前端实习', kind: 'semantic', tags: ['学习'] },
      ]);
    },
    _calls: calls,
  };
  return client as unknown as DeepSeekClient & { _calls: unknown[][] };
}

/** 在隔离 HOME/cwd 下，按给定 flag 运行断言，结束恢复环境。 */
async function withIsolatedEnv(
  flags: string | undefined,
  fn: (orch: MemoryOrchestrator) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(os.tmpdir(), 'dsa-m4-home-'));
  const cwd = mkdtempSync(join(os.tmpdir(), 'dsa-m4-cwd-'));
  const prevHome = process.env.HOME;
  const prevFlags = process.env.DSA_MEMORY_FLAGS;
  process.env.HOME = home;
  if (flags === undefined) delete process.env.DSA_MEMORY_FLAGS;
  else process.env.DSA_MEMORY_FLAGS = flags;
  try {
    const orch = new MemoryOrchestrator(cwd, new Embedder({ mode: 'off' }));
    await fn(orch);
  } finally {
    process.env.HOME = prevHome;
    if (prevFlags === undefined) delete process.env.DSA_MEMORY_FLAGS;
    else process.env.DSA_MEMORY_FLAGS = prevFlags;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('M4 factScopeUser=true: fact 进 user 层, semantic 仍进 project 层', async () => {
  await withIsolatedEnv('factScopeUser', async (orch) => {
    const client = makeClient();
    const n = await extractUserMemories(client, makeHistory(), orch);
    assert.strictEqual(n, 2, '应沉淀 1 fact + 1 semantic');
    // fact → user
    assert.match(await orch.user.loadFacts(), /偏好使用 pnpm 包管理器/, 'fact 应写进 user 层');
    assert.doesNotMatch(await orch.project.loadFacts(), /偏好使用 pnpm 包管理器/, 'fact 不应写进 project 层');
    // semantic → project（user 层无语义记忆）
    assert.strictEqual((await orch.user.list()).length, 0, 'user 层不应有 semantic 条目');
    assert.ok(
      (await orch.project.list()).some((e) => e.content.includes('正在准备前端实习')),
      'semantic 应写进 project 层',
    );
  });
});

test('M4 factScopeUser=false (默认): fact 进 project 层, 与旧路径逐字节一致', async () => {
  await withIsolatedEnv(undefined, async (orch) => {
    const client = makeClient();
    const n = await extractUserMemories(client, makeHistory(), orch);
    assert.strictEqual(n, 2, '应沉淀 1 fact + 1 semantic');
    // 默认：fact → project
    assert.match(await orch.project.loadFacts(), /偏好使用 pnpm 包管理器/, '默认 fact 应写进 project 层');
    assert.doesNotMatch(await orch.user.loadFacts(), /偏好使用 pnpm 包管理器/, '默认 fact 不应写进 user 层');
    assert.strictEqual((await orch.user.list()).length, 0, 'user 层应为空（默认不写用户级）');
    // semantic → project
    assert.ok(
      (await orch.project.list()).some((e) => e.content.includes('正在准备前端实习')),
      'semantic 应写进 project 层',
    );
  });
});

test('M4 flag 显式关: factScopeUser=false 仍走 project（覆盖 env 默认值）', async () => {
  await withIsolatedEnv('factScopeUser=false', async (orch) => {
    const client = makeClient();
    const n = await extractUserMemories(client, makeHistory(), orch);
    assert.strictEqual(n, 2);
    assert.match(await orch.project.loadFacts(), /偏好使用 pnpm 包管理器/, '显式关 flag 时 fact 进 project');
    assert.doesNotMatch(await orch.user.loadFacts(), /偏好使用 pnpm 包管理器/, '显式关 flag 时 user 层无 fact');
  });
});
