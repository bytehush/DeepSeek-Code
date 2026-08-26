/**
 * Spike: 验证 P3 — composeForTurn 经 Pi transformContext 真正注入每轮上下文。
 *
 * 证据驱动：用 faux provider 无 key 跑一轮；fake memory.composeForTurn 返回哨兵召回串；
 * 包裹 models.streamSimple 捕获每次 LLM 调用的 Context.messages；
 * 断言捕获到的 messages 含召回哨兵 → 证明召回块进入了 Pi 每轮上下文（而非死在
 * ConversationHistory 里）。先 esbuild 转 .mjs 再 node（tsx 解析不了 Pi 的 exports）。
 */
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAtomicTools } from '../src/agent/pi-tools.ts';
import { runPiAgent } from '../src/agent/pi-agent.ts';

const RECALL_SENTINEL = '[记忆召回 · 本轮相关]\n- SENTINEL_MEMORY_ENTRY_XYZ';

async function main(): Promise<void> {
  // 开启每轮召回注入（等价于 ~/.dsa/memory-config.json 设 perTurnCompose:true）
  process.env.DSA_MEMORY_FLAGS = 'perTurnCompose';

  const models = createModels();
  const faux = fauxProvider({
    provider: 'deepseek',
    models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }],
  });
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('Here is the answer.')]);
  const model = faux.getModel();

  // 捕获每次 LLM 调用收到的 Context.messages（已是 transformContext 之后、convertToLlm 之后的形态）
  const captured: Array<Array<{ role: string; content: unknown }>> = [];
  const orig = models.streamSimple.bind(models) as (...a: unknown[]) => unknown;
  const wrapped = (m: unknown, ctx: { messages: Array<{ role: string; content: unknown }> }, opts?: unknown) => {
    captured.push(ctx.messages);
    return orig(m, ctx, opts);
  };

  const agent = new Agent({
    initialState: {
      systemPrompt: 'You are a concise coding agent.',
      model,
      thinkingLevel: 'off',
      tools: createAtomicTools({ cwd: process.cwd() }),
    },
    streamFn: wrapped as never,
    toolExecution: 'sequential',
  });

  // 只实现 runPiAgent 实际调用的 composeForTurn，其余不需要
  const fakeMemory = {
    composeForTurn: async (_base: string, _query: string, _k?: number) => RECALL_SENTINEL,
  } as never;

  const input = '请帮我修复登录页面的 bug';
  for await (const _ev of runPiAgent(input, {
    agent,
    models,
    permission: 'execute',
    memory: fakeMemory,
    signal: undefined,
    ask: async () => true,
  })) {
    /* drain events */
  }

  const flat = captured.flat().map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
  const hit = flat.some((s) => typeof s === 'string' && s.includes('SENTINEL_MEMORY_ENTRY_XYZ'));
  console.log(`[spike-memory-inject] captured ${captured.length} LLM call(s), ${flat.length} messages total`);
  console.log(`[spike-memory-inject] recall injected into Pi context? ${hit ? 'YES' : 'NO'}`);
  if (!hit) {
    console.log('[spike-memory-inject] sample messages:', flat.slice(0, 3));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[spike-memory-inject] ERROR:', e);
  process.exit(1);
});
