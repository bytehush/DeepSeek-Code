/**
 * P3 循环解耦验收：内核接缝 + 异常降级（safeSeam）。
 *
 * 验证两项核心不变量：
 *  1. buildAgentMiddlewares() 装配出 5 组接缝链（beforeLLM/afterLLM/afterFinal/afterDispatch/onRoundEnd）且数量符合方案；
 *  2. 任一中间件抛出异常时，内核的 safeSeam 边界将其降级为日志、绝不冒泡，
 *     循环继续直到正常结束（产出 done 事件），不丢消息、不崩进程。
 *
 * 直接驱动真实的 runCore（src/agent/core.ts），用 mock LLM 客户端与 mock 工具，
 * 不依赖真实 API key / 网络。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runCore } from '../src/agent/core.ts';
import type { AfterLLM, MiddlewareChain } from '../src/agent/core.ts';
import { buildAgentMiddlewares } from '../src/agent/middleware/index.ts';
import type { DeepSeekClient, ChatMessage } from '../src/llm/deepseek.ts';
import type { ConversationHistory } from '../src/context/history.ts';
import type { ToolDef } from '../src/tools/index.ts';

const FINAL = '这是最终答复：任务已完成。';

function makeMockClient(turns: Array<Array<{ type: string; text?: string; tools?: unknown }>>) {
  let i = 0;
  const client = {
    primaryModel: 'mock-model',
    async *streamChat() {
      const turn = turns[Math.min(i, turns.length - 1)];
      i++;
      for (const ev of turn) yield ev as unknown as { type: string; text?: string; tools?: unknown };
    },
  };
  return client as unknown as DeepSeekClient;
}

function makeMockHistory() {
  const store: ChatMessage[] = [];
  const history = {
    addUser: (c: string) => store.push({ role: 'user', content: c }),
    addAssistant: (c: string) => store.push({ role: 'assistant', content: c }),
    addToolResult: (_id: string, _name: string, _res: string) => {},
    getMessages: () => store.map((m) => ({ ...m })),
    compact: async () => {},
    estimateTotalTokens: () => 0,
  };
  return history as unknown as ConversationHistory;
}

function baseOpts(client: DeepSeekClient, history: ConversationHistory, tools: ToolDef[]) {
  return {
    client,
    history,
    permission: 'execute' as const,
    cwd: process.cwd(),
    ask: async () => false,
    tools,
    autoPlan: false, // 跳过复杂度评估的额外 LLM 调用
  };
}

const thrower: AfterLLM = () => {
  throw new Error('middleware boom');
};

describe('buildAgentMiddlewares 装配形状', () => {
  test('5 组接缝齐全且数量符合方案 §1.2', () => {
    const chain = buildAgentMiddlewares();
    assert.equal(chain.beforeLLM.length, 3, 'beforeLLM: 风格/计划提醒/轮次预警');
    assert.equal(chain.afterLLM.length, 2, 'afterLLM: self-review / ReviewCommons');
    assert.equal(chain.afterFinal.length, 3, 'afterFinal: 递减/未完成/短答复');
    assert.equal(chain.afterDispatch.length, 1, 'afterDispatch: 成功路径验证提示');
    assert.equal(chain.onRoundEnd.length, 4, 'onRoundEnd: 失败/停滞/replan/compact+todo');
  });
});

describe('safeSeam 异常降级：中间件抛错不崩内核', () => {
  test('afterLLM 抛错 → 降级为日志，无工具调用的最终答复仍正常完成', async () => {
    const client = makeMockClient([[{ type: 'content', text: FINAL }]]);
    const history = makeMockHistory();
    const chain: MiddlewareChain = {
      beforeLLM: [],
      afterLLM: [thrower], // 仅在 afterLLM 注入抛错
      afterFinal: [],
      afterDispatch: [],
      onRoundEnd: [],
    };
    const events: string[] = [];
    let done = false;
    for await (const ev of runCore('跑一次', baseOpts(client, history, []), chain)) {
      if (ev.type) events.push(ev.type);
      if (ev.type === 'done') done = true;
    }
    assert.ok(done, 'runCore 应正常产出 done（异常未冒泡）');
    assert.ok(events.includes('assistant_text'), '最终答复文本事件应照常产出');
    assert.ok(events.includes('assistant_phase'), '阶段标记应照常产出');
  });

  test('afterDispatch + onRoundEnd + afterLLM 同时抛错 → 含工具轮的完整循环仍完成', async () => {
    const client = makeMockClient([
      // 第 1 轮：模型决定调用工具
      [{ type: 'tool_use', tools: [{ id: '1', name: 'read_file', arguments: { path: 'x' } }] }],
      // 第 2 轮：最终答复（无工具）
      [{ type: 'content', text: FINAL }],
    ]);
    const history = makeMockHistory();
    const tools: ToolDef[] = [
      {
        name: 'read_file',
        description: 'read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
        risk: 'low',
        execute: async () => ({ ok: true, output: 'file content' }),
      },
    ];
    const chain: MiddlewareChain = {
      beforeLLM: [],
      afterLLM: [thrower],
      afterFinal: [],
      afterDispatch: [thrower], // 第 1 轮 dispatch 后触发
      onRoundEnd: [thrower], // 第 1 轮 roundEnd 触发
    };
    const events: string[] = [];
    let done = false;
    for await (const ev of runCore('读文件然后总结', baseOpts(client, history, tools), chain)) {
      if (ev.type) events.push(ev.type);
      if (ev.type === 'done') done = true;
    }
    assert.ok(done, '含工具轮的循环应正常完成（多接缝异常均被降级）');
    assert.ok(events.includes('tool_call'), '工具调用事件应照常产出');
    assert.ok(events.includes('tool_result'), '工具结果事件应照常产出');
    assert.ok(events.includes('assistant_text'), '第 2 轮最终答复应照常产出');
  });
});

/** 空中间件链：隔离验证 runCore 的工具分发已统一收口到 ToolOrchestrator（消息驱动） */
const noMw: MiddlewareChain = {
  beforeLLM: [],
  afterLLM: [],
  afterFinal: [],
  afterDispatch: [],
  onRoundEnd: [],
};

describe('runCore 经 ToolOrchestrator 统一分发（消息驱动接线路验证）', () => {
  test('ask 模式文件写被拒绝 → 编排者→onPermission 产出 permission(denied) + 拒绝结果', async () => {
    const client = makeMockClient([
      [{ type: 'tool_use', tools: [{ id: '1', name: 'write_file', arguments: { path: 'a.txt', content: 'x' } }] }],
      [{ type: 'content', text: FINAL }],
    ]);
    const history = makeMockHistory();
    const tools: ToolDef[] = [
      {
        name: 'write_file',
        description: 'write a file',
        parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
        risk: 'low',
        preview: async () => '--- a.txt ---\n+x',
        execute: async () => ({ ok: true, output: 'written' }),
      },
    ];
    const events: Array<{ type: string; granted?: boolean; result?: string }> = [];
    let done = false;
    for await (const ev of runCore('写个文件', { ...baseOpts(client, history, tools), permission: 'ask', ask: async () => false }, noMw)) {
      events.push({ type: ev.type, granted: ev.granted, result: ev.result });
      if (ev.type === 'done') done = true;
    }
    assert.ok(done, '应正常结束');
    const perm = events.find((e) => e.type === 'permission');
    assert.ok(perm, '应经编排者→onPermission 回调产出 permission 事件');
    assert.equal(perm!.granted, false, '拒绝应 granted:false');
    const tr = events.find((e) => e.type === 'tool_result');
    assert.ok(tr, '应产出 tool_result');
    assert.ok(String(tr!.result).includes('拒绝'), '结果应说明被拒绝（execute 未被执行）');
  });

  test('execute 模式普通工具放行 → 编排者路由并执行、回灌结果', async () => {
    const client = makeMockClient([
      [{ type: 'tool_use', tools: [{ id: '1', name: 'read_file', arguments: { path: 'x' } }] }],
      [{ type: 'content', text: FINAL }],
    ]);
    const history = makeMockHistory();
    const tools: ToolDef[] = [
      {
        name: 'read_file',
        description: 'read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
        risk: 'low',
        execute: async () => ({ ok: true, output: 'file content' }),
      },
    ];
    const events: string[] = [];
    let done = false;
    for await (const ev of runCore('读文件', baseOpts(client, history, tools), noMw)) {
      if (ev.type) events.push(ev.type);
      if (ev.type === 'done') done = true;
    }
    assert.ok(done, '应正常结束');
    assert.ok(events.includes('tool_call'), '编排者应产出 tool_call');
    assert.ok(events.includes('tool_result'), '编排者应执行 read_file 并回灌 tool_result');
  });
});

describe('B·harness 通用限制（不破坏解耦：不识工具语义、纯通用计数）', () => {
  test('每轮工具调用超上限即停止派发，下一轮可正常收尾', async () => {
    const calls = Array.from({ length: 20 }, (_, k) => ({
      id: String(k),
      name: 'read_file',
      arguments: { path: `p${k}` },
    }));
    const client = makeMockClient([
      [{ type: 'tool_use', tools: calls }],
      [{ type: 'content', text: FINAL }],
    ]);
    const history = makeMockHistory();
    const tools: ToolDef[] = [
      {
        name: 'read_file',
        description: 'read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
        risk: 'low',
        execute: async () => ({ ok: true, output: 'ok' }),
      },
    ];
    const events: Array<{ type: string; result?: string }> = [];
    let done = false;
    for await (const ev of runCore('批量读', { ...baseOpts(client, history, tools), maxToolCallsPerRound: 3 }, noMw)) {
      events.push({ type: ev.type, result: ev.result });
      if (ev.type === 'done') done = true;
    }
    const toolCalls = events.filter((e) => e.type === 'tool_call').length;
    assert.equal(toolCalls, 3, '超过上限后应只派发 3 个工具调用');
    const cap = events.find((e) => e.type === 'tool_result' && String(e.result).includes('每轮工具调用上限'));
    assert.ok(cap, '溢出调用应收到上限提示的 tool_result');
    assert.ok(done, '应正常结束（下一轮给出最终答复）');
  });

  test('同工具+相同参数重复超限 → 活锁熔断终止（repeated_tool_no_progress）', async () => {
    const calls = Array.from({ length: 6 }, (_, k) => ({
      id: String(k),
      name: 'read_file',
      arguments: { path: 'same' },
    }));
    const client = makeMockClient([
      [{ type: 'tool_use', tools: calls }],
      [{ type: 'content', text: FINAL }],
    ]);
    const history = makeMockHistory();
    const tools: ToolDef[] = [
      {
        name: 'read_file',
        description: 'read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
        risk: 'low',
        execute: async () => ({ ok: true, output: 'ok' }),
      },
    ];
    const events: Array<{ type: string; reason?: string }> = [];
    for await (const ev of runCore('重复读', { ...baseOpts(client, history, tools), maxRepeatedToolCalls: 4 }, noMw)) {
      events.push({ type: ev.type, reason: ev.reason });
    }
    const toolCalls = events.filter((e) => e.type === 'tool_call').length;
    assert.equal(toolCalls, 4, '应只执行 4 次相同调用，第 5 次被熔断');
    const brk = events.find((e) => e.type === 'done' && e.reason === 'repeated_tool_no_progress');
    assert.ok(brk, '应产出 done(reason=repeated_tool_no_progress) 活锁熔断');
  });
});
