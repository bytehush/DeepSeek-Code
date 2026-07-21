/**
 * MemoryOrchestrator 实例守卫单测（M3 · 解决 L1）。
 *
 * 锁定「同实例只抽取/整理一次」「onDispose 后不再抽取」的行为，证明实例级守卫
 * 替代旧 chat.ts 模块级守卫后，长驻 GUI 每任务独立、且释放后安全降级。
 *
 * 隔离：模块顶层把 HOME 指向临时目录，使 user 层不污染真实 ~/.dsa/memory。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { MemoryOrchestrator } from '../src/memory/orchestrator.ts';
import { Embedder } from '../src/memory/embedder.ts';
import type { ConversationHistory } from '../src/context/history.ts';
import type { DeepSeekClient } from '../src/llm/deepseek.ts';

const SHARED_HOME = mkdtempSync(join(os.tmpdir(), 'dsa-home-'));
const REAL_HOME = process.env.HOME;
process.env.HOME = SHARED_HOME;
process.on('exit', () => {
  process.env.HOME = REAL_HOME;
  rmSync(SHARED_HOME, { recursive: true, force: true });
});

/** 一段足够长（>200 字符）的对话历史，确保 extractUserMemories 不会因过短跳过。 */
function makeHistory(): ConversationHistory {
  return {
    getMessages: () => [
      {
        role: 'user',
        content:
          '我平时都用 pnpm 来管理前端的包，因为 pnpm 比较快而且省磁盘空间，我不太喜欢 npm 的扁平 node_modules 结构。' +
          '我们团队内部也约定了提交信息要用 Conventional Commits 规范，并且 CI 必须全绿才能合并主干分支。',
      },
      { role: 'assistant', content: '明白了，我会记住你偏好 pnpm 而不是 npm，并且提交信息遵循 Conventional Commits 规范、CI 必须全绿才合并。' },
      {
        role: 'user',
        content:
          '另外我们项目统一用 React 加 TypeScript，组件全部用函数式写法，不要写 class 组件，状态用 hooks 管理。' +
          '样式方面偏好 CSS Modules 而不是 styled-components，测试用 Vitest 而不是 Jest，构建用 Vite。',
      },
      {
        role: 'user',
        content:
          '还有一点，代码注释和文档我都希望用中文写，变量名可以用英文，但面向用户的提示文案一律中文，方便团队其他同事阅读。',
      },
    ],
  } as unknown as ConversationHistory;
}

/** 假 client：complete 返回一条 fact 的 JSON，记录调用次数。 */
function makeClient() {
  const calls: unknown[][] = [];
  const client = {
    primaryModel: 'deepseek-v4-flash',
    async complete(...args: unknown[]): Promise<string> {
      calls.push(args);
      return JSON.stringify([{ content: '偏好使用 pnpm 包管理器', kind: 'fact', tags: ['工具'] }]);
    },
    _calls: calls,
  };
  return client as unknown as DeepSeekClient & { _calls: unknown[][] };
}

function tmpCwd(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(os.tmpdir(), 'dsa-cwd-'));
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test('MemoryOrchestrator: 同实例只抽取一次（实例级守卫）', async () => {
  const { cwd, cleanup } = tmpCwd();
  try {
    const orch = new MemoryOrchestrator(cwd, new Embedder({ mode: 'off' }));
    const client = makeClient();
    const n1 = await orch.extractAtTurnEnd(makeHistory(), client);
    assert.strictEqual(n1, 1, '首次抽取应沉淀 1 条');
    const n2 = await orch.extractAtTurnEnd(makeHistory(), client);
    assert.strictEqual(n2, 0, '同实例第二次抽取应被守卫拦截');
    assert.strictEqual(client._calls.length, 1, '模型只应被调用一次');
  } finally {
    cleanup();
  }
});

test('MemoryOrchestrator: onDispose 后不再抽取', async () => {
  const { cwd, cleanup } = tmpCwd();
  try {
    const orch = new MemoryOrchestrator(cwd, new Embedder({ mode: 'off' }));
    const client = makeClient();
    await orch.onDispose();
    const n = await orch.extractAtTurnEnd(makeHistory(), client);
    assert.strictEqual(n, 0, '释放后应直接降级为 0');
    assert.strictEqual(client._calls.length, 0, '释放后不应调用模型');
  } finally {
    cleanup();
  }
});

test('MemoryOrchestrator: revise 非 force 守卫只跑一次', async () => {
  const { cwd, cleanup } = tmpCwd();
  try {
    const orch = new MemoryOrchestrator(cwd, new Embedder({ mode: 'off' }));
    const client = makeClient();
    const r1 = await orch.revise(client, {});
    assert.ok(r1, '首次整理应返回结果（条目不足 → skipped，但非 null）');
    assert.strictEqual(r1!.skipped, true);
    const r2 = await orch.revise(client, {});
    assert.strictEqual(r2, null, '同实例第二次自动整理应被守卫拦截为 null');
  } finally {
    cleanup();
  }
});

test('MemoryOrchestrator: /dream 的 force 整理不受守卫阻断', async () => {
  const { cwd, cleanup } = tmpCwd();
  try {
    const orch = new MemoryOrchestrator(cwd, new Embedder({ mode: 'off' }));
    const client = makeClient();
    // 先自动整理一次（置守卫）
    await orch.revise(client, {});
    // /dream 强制整理应仍执行（force 跳过守卫）
    const forced = await orch.revise(client, { force: true });
    assert.ok(forced, 'force 整理应跳过守卫执行（条目不足 → skipped 但非 null）');
  } finally {
    cleanup();
  }
});
