/**
 * Eval runner（P0 重建版）。
 *
 * 用法：
 *   npx tsx eval/run-eval.ts --tier code            # 无密钥，mock 理想轨迹，出骨架健康基线
 *   npx tsx eval/run-eval.ts --tier code --real     # 真模型跑 code 档（需已存凭证）
 *   npx tsx eval/run-eval.ts --tier llm             # 真模型 + DeepSeek 裁判打分
 *   npx tsx eval/run-eval.ts --tier all --k 3       # pass@k
 *
 * 与旧版的根本区别：被测对象就是产品本体（AgentKernel + ModelHub + ToolRegistry +
 * OutboundLedger），不再另搭一条私有循环；mock 模式注入的是 ProviderAdapter 层，
 * kernel/权限/工具/记账全部真实运行。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

import { ModelHub, type HubConfig, type ProviderAdapter, type ProviderStreamEvent, type StreamRequest } from '../src/core/provider/hub.ts';
import { createOpenAICompatAdapter } from '../src/core/provider/openai-compat.ts';
import { OutboundLedger } from '../src/core/provider/ledger.ts';
import { ToolRegistry } from '../src/core/tools/registry.ts';
import { createCoreTools } from '../src/core/tools/atomic.ts';
import { AgentKernel, type KernelRunOptions } from '../src/core/loop/kernel.ts';
import type { CoreEvent } from '../src/core/loop/events.ts';
import { getMode } from '../src/config/model-mode.ts';
import { loadStoredCredentials, type Credentials } from '../src/auth/credentials.ts';
import { CASES } from './cases.ts';
import type { CaseResult, GoldenCase, ToolCallRecord } from './types.ts';
import { planStep } from './mock-agent.ts';

// ---- CLI ----
const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  return i + 1 < argv.length && !argv[i + 1]!.startsWith('--') ? argv[i + 1] : '1';
}
const tierFilter = flag('tier') ?? 'code';
const wantReal = argv.includes('--real');
const k = Number(flag('k') ?? 1);

// ---- 出站记账隔离：评测数据不得污染用户真实账本 ----
const EVAL_HOME = path.join(tmpdir(), `dsa-eval-home-${process.pid}`);
mkdirSync(path.join(EVAL_HOME, '.dsa'), { recursive: true });
const realHomedir = osHomedir();
function osHomedir(): string { return homedir(); }
process.env.HOME = EVAL_HOME;
process.env.USERPROFILE = EVAL_HOME;

// ---- mock adapter：把理想轨迹注入到 provider 边界 ----
class MockAdapter implements ProviderAdapter {
  id = 'mock';
  models = [{ id: 'mock-actor', label: 'Mock', contextWindow: 100_000, supportsThinking: false }];
  private step = 0;
  private lastToolResult = '';
  private sandbox = '';

  setContext(sandbox: string): void {
    this.sandbox = sandbox;
    this.step = 0;
    this.lastToolResult = '';
  }

  noteToolResult(text: string): void {
    this.lastToolResult = text;
  }

  endpoint(): string {
    return 'mock://eval/local';
  }

  serialize(req: StreamRequest): string {
    return JSON.stringify({ model: req.modelId, messages: req.messages, tools: req.tools });
  }

  async *stream(req: StreamRequest, _apiKey: string, _body: string): AsyncGenerator<ProviderStreamEvent> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
    this.step++;
    const plan = planStep(text, this.step, this.sandbox, this.lastToolResult);
    const usage = { inputTokens: 0, outputTokens: 0 };
    if (plan.text) {
      yield { type: 'text_delta', text: plan.text };
    }
    yield {
      type: 'message_end',
      toolCalls: (plan.toolCalls ?? []).map((tc) => ({ id: tc.id, name: tc.name, args: tc.args })),
      finishReason: plan.toolCalls?.length ? 'tool_calls' : 'stop',
      usage,
    };
  }
}

// ---- transcript：事件流 → 可读记录（消费者与设计稿一致：一条流三用途） ----
function eventsToTranscript(events: CoreEvent[]): string {
  const lines: string[] = [];
  for (const ev of events) {
    if (ev.type === 'assistant_text' && ev.reactPhase !== 'thought' && ev.text) lines.push(ev.text);
    else if (ev.type === 'tool_call') lines.push(`[TOOL_CALL ${ev.toolName}] ${JSON.stringify(ev.args ?? {})}`);
    else if (ev.type === 'tool_result') lines.push(`[TOOL_RESULT ${ev.toolName}] ${ev.result ?? ''}`);
    else if (ev.type === 'permission' && ev.granted === false) lines.push(`[DENIED ${ev.toolName}] ${ev.text ?? ''}`);
    else if (ev.type === 'error') lines.push(`[ERROR] ${ev.error ?? ''}`);
  }
  return lines.join('\n');
}

// ---- 跑一个 case（一次） ----
async function runCaseOnce(c: GoldenCase, real: boolean): Promise<{ events: CoreEvent[]; ledger: OutboundLedger; sandbox: string; mock: MockAdapter | null }> {
  const sandbox = await mkdtemp(path.join(tmpdir(), `ds-eval-${c.id}-`));
  if (c.setup) await c.setup(sandbox);

  // 每 case 独立账本目录：outboundRequests 断言的是"本 case"的出站条数
  const ledger = new OutboundLedger({ dir: path.join(EVAL_HOME, '.dsa', 'outbound', c.id) });
  const registry = new ToolRegistry();
  for (const t of createCoreTools()) registry.register(t);

  let mock: MockAdapter | null = null;
  let hub: ModelHub;
  if (real) {
    const creds = await loadStoredCredentials();
    if (!creds) throw new Error('--real 需要先登录存凭证（npm start 首次会引导）');
    hub = realHub(creds, ledger);
  } else {
    const cfg: HubConfig = {
      routing: {
        actor: { provider: 'mock', model: 'mock-actor' },
        critic: { provider: 'mock', model: 'mock-actor' },
        cheap: { provider: 'mock', model: 'mock-actor' },
      },
      keys: { mock: 'eval-no-key-needed' },
    };
    hub = new ModelHub(cfg, ledger);
    mock = new MockAdapter();
    mock.setContext(sandbox);
    hub.register(mock);
  }

  const kernel = new AgentKernel({
    hub,
    registry,
    cwd: sandbox,
    protectedRoots: [],
    modelName: () => (real ? 'real-actor' : 'mock-actor'),
  });

  const permission = c.permission ?? 'execute';
  const allEvents: CoreEvent[] = [];
  for (const turn of c.turns) {
    mock?.setContext(sandbox);
    const opts: KernelRunOptions = {
      permission,
      planMode: false,
      maxIterations: c.maxIterations ?? 12,
      ask: async () => c.confirm !== false,
    };
    const evs: CoreEvent[] = [];
    for await (const ev of kernel.prompt(turn, opts)) {
      evs.push(ev);
      if (ev.type === 'tool_result') {
        // 供 mock 收尾回显（真模型无需此桥接）
        mock?.noteToolResult(ev.result ?? '');
      }
    }
    allEvents.push(...evs);
  }
  const errored = allEvents.some((e) => e.type === 'error');
  if (errored) throw new Error('case 以模型/传输错误收尾');
  return { events: allEvents, ledger, sandbox, mock };
}

function realHub(creds: Credentials, ledger: OutboundLedger): ModelHub {
  const baseURL = creds.baseURL || 'https://api.deepseek.com/v1';
  const cfg: HubConfig = {
    routing: {
      actor: { provider: 'deepseek', model: creds.model || 'deepseek-v4-flash', thinking: getMode() === 'pro' ? 'high' : 'off' },
      critic: { provider: 'deepseek', model: creds.model || 'deepseek-v4-flash' },
      cheap: { provider: 'deepseek', model: creds.model || 'deepseek-v4-flash' },
    },
    keys: { deepseek: creds.apiKey },
  };
  const hub = new ModelHub(cfg, ledger);
  hub.register(
    createOpenAICompatAdapter({
      id: 'deepseek',
      baseURL,
      models: [{ id: creds.model || 'deepseek-v4-flash', label: 'eval', contextWindow: 128_000, supportsThinking: false }],
    }),
  );
  return hub;
}

// ---- 裁判（llm 档，走 hub，成本自动进隔离 ledger） ----
async function judge(hub: ModelHub, c: GoldenCase, transcript: string, finalText: string): Promise<{ score: number; detail: string }> {
  const system =
    '你是严格的编程 Agent 能力评测裁判。根据用户指令、Agent 的工具调用记录与最终回复，按评分标准给出 1-5 分（5 为最佳）。只输出一个 JSON 对象，不要任何额外文字：{"score":<整数>,"detail":"<中文理由，≤80字>"}。detail 字段内禁止使用英文双引号，一律用中文引号「」。';
  const user = `评测目标: ${c.title}\n评分标准: ${c.rubric}\n\n=== 交互记录 ===\n${transcript.slice(0, 8000)}\n=== Agent 最终回复 ===\n${finalText}\n\n请评分并给出中文理由。`;
  const { text } = await hub.complete('actor', { system, messages: [{ role: 'user', content: user }] });
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]);
      return { score: Number(o.score) || 0, detail: String(o.detail ?? '').slice(0, 200) };
    } catch { /* fallthrough */ }
  }
  const sm = text.match(/"score"\s*:\s*(\d+)/);
  return { score: sm ? Number(sm[1]) : 0, detail: `裁判解析失败: ${text.slice(0, 120)}` };
}

function finalTextOf(events: CoreEvent[]): string {
  const done = [...events].reverse().find((e) => e.type === 'done');
  if (done?.text) return done.text;
  return events.filter((e) => e.type === 'assistant_text' && e.reactPhase !== 'thought').map((e) => e.text ?? '').join('');
}

// ---- 判定 ----
async function grade(c: GoldenCase, events: CoreEvent[], ledger: OutboundLedger, sandbox: string): Promise<CaseResult> {
  const toolCalls: ToolCallRecord[] = events
    .filter((e) => e.type === 'tool_call')
    .map((e) => ({ name: e.toolName!, args: e.args }));
  const permissionDenied: string[] = events
    .filter((e) => e.type === 'permission' && e.granted === false)
    .map((e) => e.toolName!);
  const finalText = finalTextOf(events);
  const transcript = eventsToTranscript(events);
  const outboundRequests = ledger.read().length;
  const ctx = { cwd: sandbox, toolCalls, finalText, permissionDenied, transcript, outboundRequests };
  const base = { id: c.id, title: c.title, category: c.category, tier: c.tier, transcript };

  if (c.tier === 'code' || c.tier === 'human') {
    const r = c.check?.(ctx) ?? { pass: true, detail: c.tier === 'human' ? '需人工复核（transcript 已留存）' : '无 check()' };
    return { ...base, pass: r.pass, score: null, detail: r.detail };
  }
  // llm 档
  const hub = await judgeHub();
  if (!hub) return { ...base, pass: false, score: null, detail: 'llm 档需 --real + 凭证' };
  const { score, detail } = await judge(hub, c, transcript, finalText);
  return { ...base, pass: score >= 3, score, detail };
}

let _judgeHub: ModelHub | null = null;
async function judgeHub(): Promise<ModelHub | null> {
  if (!wantReal) return null;
  if (_judgeHub) return _judgeHub;
  const creds = await loadStoredCredentials();
  if (!creds) return null;
  _judgeHub = realHub(creds, new OutboundLedger({ dir: path.join(EVAL_HOME, '.dsa', 'outbound') }));
  return _judgeHub;
}

// ---- 主流程 ----
function main(): void {
  const selected = tierFilter === 'all' ? CASES : CASES.filter((c) => c.tier === tierFilter);
  if (selected.length === 0) {
    console.error(`无匹配档位 ${tierFilter}（code|llm|human|all）`);
    process.exit(1);
  }
  console.log(`== eval: tier=${tierFilter} real=${wantReal ? '模型' : 'mock轨迹'} k=${k} cases=${selected.length} ==\n`);
  void run(selected).catch((e) => {
    console.error('eval 运行失败：', e instanceof Error ? e.stack : e);
    process.exitCode = 1;
  }).finally(() => {
    process.env.HOME = realHomedir;
    rmSync(EVAL_HOME, { recursive: true, force: true });
  });
}

async function run(selected: GoldenCase[]): Promise<void> {
  const results: CaseResult[] = [];
  for (const c of selected) {
    let ok = false;
    let last: CaseResult | null = null;
    for (let i = 0; i < k && !ok; i++) {
      try {
        const { events, ledger, sandbox } = await runCaseOnce(c, wantReal);
        last = await grade(c, events, ledger, sandbox);
        await rm(sandbox, { recursive: true, force: true });
        ok = last.pass;
      } catch (e: unknown) {
        last = { id: c.id, title: c.title, category: c.category, tier: c.tier, pass: false, score: null, detail: `运行异常: ${e instanceof Error ? e.message : String(e)}`, transcript: '' };
      }
    }
    const r = last!;
    results.push(r);
    console.log(`${r.pass ? '✅' : '❌'} ${r.id} ${r.title} — ${r.detail}`);
  }
  const pass = results.filter((r) => r.pass).length;
  const scored = results.filter((r) => r.score != null);
  const avg = scored.length ? (scored.reduce((a, b) => a + (b.score ?? 0), 0) / scored.length).toFixed(2) : '—';
  console.log(`\n== pass@${k}: ${pass}/${results.length}（${((pass / results.length) * 100).toFixed(0)}%） 裁判均分: ${avg}/5 ==`);

  writeFileSync(path.join(import.meta.dirname, 'results.json'), JSON.stringify(results, null, 2));
  const lines = [
    '# Eval 结果',
    '',
    `- 时间: ${new Date().toISOString()}`,
    `- 配置: tier=${tierFilter} mode=${wantReal ? 'real-model' : 'mock-trace'} k=${k}`,
    `- pass@${k}: ${pass}/${results.length}`,
    '',
    '| Case | 类别 | 档位 | 结果 | 详情 |',
    '|------|------|------|------|------|',
    ...results.map((r) => `| ${r.id} ${r.title} | ${r.category} | ${r.tier} | ${r.pass ? '✅' : '❌'} ${r.score ?? ''} | ${r.detail.replace(/\|/g, '\\|').slice(0, 120)} |`),
    '',
  ];
  writeFileSync(path.join(import.meta.dirname, 'RESULTS.md'), lines.join('\n'));
  console.log('已写入 eval/results.json + eval/RESULTS.md');
}

main();
