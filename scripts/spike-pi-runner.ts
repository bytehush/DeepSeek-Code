/**
 * Spike: 验证 P1 适配层 runPiAgent（src/agent/pi-agent.ts）端到端。
 * 用 faux provider 无 API key 跑一轮「思考 + 调 read_file + 总结」，
 * 确认：① text_delta 路由到最终答案气泡（reactPhase: 'final'）；
 * ② thinking_delta 进思考盒（reactPhase: 'thought'）；
 * ③ tool_execution_update 经 onToolProgress 实时输出；
 * ④ tool_call / tool_result / done 事件形状正确。
 * 运行见仓库根：先 esbuild 转 .mjs 再 node（tsx 解析不了 Pi 的 exports）。
 */
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAtomicTools } from '../src/agent/pi-tools.ts';
import { runPiAgent } from '../src/agent/pi-agent.ts';

async function main(): Promise<void> {
  const models = createModels();
  // 用 faux provider 模拟 deepseek/deepseek-v4-flash（与生产 deepseekProvider 同 id），
  // 这样 runPiAgent 内部的 models.getModel('deepseek', modelId) 能解析到 mock 模型。
  const faux = fauxProvider({
    provider: 'deepseek',
    models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }],
  });
  models.setProvider(faux.provider);
  // 脚本化一轮：思考 → 调 read_file(package.json) → 总结
  faux.setResponses([
    fauxAssistantMessage([
      fauxThinking('I should read package.json to answer.'),
      fauxToolCall('read_file', { path: 'package.json' }),
    ]),
    fauxAssistantMessage('The project name is deepseek-code-agent.'),
  ]);
  const model = faux.getModel();
  const agent = new Agent({
    initialState: {
      systemPrompt: 'You are a concise coding agent.',
      model,
      thinkingLevel: 'off',
      tools: createAtomicTools({ cwd: process.cwd() }),
    },
    streamFn: models.streamSimple.bind(models),
    toolExecution: 'sequential',
  });

  console.log('[spike-runner] input: "Read package.json and tell me the project name"\n');
  const types: string[] = [];
  for await (const ev of runPiAgent('Read package.json and tell me the project name', {
    agent,
    models,
    permission: 'execute',
    memory: undefined,
    signal: undefined,
    onToolProgress: (t: string, s: string) => console.log(`  [progress] ${t}: ${s.replace(/\n/g, ' ').slice(0, 40)}`),
    ask: async () => true,
  })) {
    if (ev.type === 'assistant_text') {
      console.log(`  assistant_text(reactPhase=${ev.reactPhase ?? '-'})> ${(ev.text ?? '').slice(0, 60)}`);
    } else if (ev.type === 'tool_call') {
      console.log(`  tool_call> ${ev.toolName}(${JSON.stringify(ev.args)})`);
    } else if (ev.type === 'tool_result') {
      console.log(`  tool_result> ${(String(ev.result ?? '')).slice(0, 60)}`);
    } else if (ev.type === 'error') {
      console.log(`  error> ${ev.error}`);
    } else if (ev.type === 'done') {
      console.log(`  done> reason=${ev.reason}`);
    } else {
      console.log(`  ${ev.type}`);
    }
    types.push(ev.type);
  }
  console.log('\n[spike-runner] event sequence: ' + types.join(' -> '));
}

main().catch((e) => {
  console.error('[spike-runner] ERROR:', e);
  process.exit(1);
});
