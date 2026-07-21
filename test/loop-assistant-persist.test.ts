/**
 * 验收：修复「切任务 / 重登录后 agent 输出丢失」。
 *
 * 直接驱动真实的 runAgent（src/agent/loop.ts）跑一轮对话，用 mock LLM 客户端，
 * 验证最终纯文本答复（以及中断时的部分答复）会被写入 trace 的 assistant_message，
 * 从而在回放（replayAll）时恢复——这正是用户「我的消息在、agent 输出消失」的根因。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runAgent } from '../src/agent/loop.ts';
import { TraceLogger } from '../src/context/trace.ts';
import type { DeepSeekClient, ChatMessage } from '../src/llm/deepseek.ts';
import type { ConversationHistory } from '../src/context/history.ts';

const FINAL_ANSWER = '闭包（closure）是函数与其定义时词法作用域的组合，使函数能访问外层变量。';

function makeMockClient(events: Array<{ type: string; text?: string }>) {
  const client = {
    primaryModel: 'mock-model',
    async *streamChat() {
      for (const ev of events) yield ev as unknown as { type: string; text?: string };
    },
  };
  return client as unknown as DeepSeekClient;
}

function makeMockHistory() {
  const store: ChatMessage[] = [];
  const history = {
    addUser: (c: string) => store.push({ role: 'user', content: c }),
    addAssistant: (c: string) => store.push({ role: 'assistant', content: c }),
    getMessages: () => store.map((m) => ({ ...m })),
    compact: async () => {},
    estimateTotalTokens: () => 0,
  };
  return history as unknown as ConversationHistory;
}

async function runAndReplay(
  userInput: string,
  clientEvents: Array<{ type: string; text?: string }>,
): Promise<{ replayed: Awaited<ReturnType<typeof TraceLogger.replayAll>>; dir: string }> {
  const dir = mkdtempSync(join(process.cwd(), '.looppersist_'));
  const trace = new TraceLogger({ workspaceDir: dir });
  const client = makeMockClient(clientEvents);
  const history = makeMockHistory();
  for await (const _ev of runAgent(userInput, {
    client,
    history,
    permission: 'execute',
    cwd: dir,
    ask: async () => false,
    tools: [],
    autoPlan: false, // 跳过复杂度评估的额外 LLM 调用
    trace,
  })) {
    /* drain */
  }
  await trace.end(); // 刷出缓冲（含修复后新增的 assistant_message）
  const replayed = await TraceLogger.replayAll(dir);
  return { replayed, dir };
}

describe('loop 最终答复落盘（修复 agent 输出丢失）', () => {
  test('纯文本最终答复写入 assistant_message，replayAll 可恢复', async () => {
    const { replayed, dir } = await runAndReplay('什么是闭包？', [
      { type: 'content', text: FINAL_ANSWER },
    ]);
    try {
      assert.ok(replayed, 'replayAll 应返回非空消息');
      const userMsg = replayed!.messages.find((m) => m.role === 'user');
      const asstMsg = replayed!.messages.find(
        (m) => m.role === 'assistant' && !(m as { tool_calls?: unknown[] }).tool_calls?.length,
      );
      assert.ok(userMsg, '应包含 user 消息');
      assert.ok(asstMsg, '应包含无 tool_calls 的最终 assistant 消息（修复前此处缺失）');
      assert.ok(
        String(asstMsg!.content).includes('闭包'),
        '最终答复文本应被持久化，回放后可见',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('中断时的部分答复也落盘（aborted 分支）', async () => {
    const { replayed, dir } = await runAndReplay('请写一段长文', [
      { type: 'content', text: '部分回复：这是中断前已生成的内容。' },
      { type: 'aborted' },
    ]);
    try {
      assert.ok(replayed, 'replayAll 应返回非空消息');
      const asstMsg = replayed!.messages.find(
        (m) => m.role === 'assistant' && !(m as { tool_calls?: unknown[] }).tool_calls?.length,
      );
      assert.ok(asstMsg, '中断时的部分答复也应落盘（修复前此处缺失）');
      assert.ok(
        String(asstMsg!.content).includes('部分回复'),
        '中断回复文本应被持久化',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
