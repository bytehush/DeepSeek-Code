/**
 * context-audit —— 上下文来源拆桶审计器（只读，不改任何行为）。
 *
 * 它只做一件事：把「模型每一步实际收到的那串字节」按**来源**拆开计量。
 * 有了这张表，"上下文是不是一团糟""该压哪一桶"才是可讨论的事实问题。
 *
 * 为什么探针挂在 provider.serialize()：
 *   StreamRequest 是结构化的 { system, messages, tools }，而 serialize 是每次外发的
 *   必经点（hub 两段式记账）。挂别处都可能漏，挂这里结构性等于全量。
 *
 * 为什么按 capability 判定可再生性，而不是比对输出文本：
 *   「能否重跑得到同样内容」是工具的固有属性（read 可重跑 / write 是一次性事实），
 *   而输出字符串格式会随文案改动漂移。审计工具若依赖格式，就会给出自信的错误数字。
 *
 * 用法：
 *   npx tsx scripts/context-audit.ts                      # 默认场景
 *   npx tsx scripts/context-audit.ts --scenario all       # 四个场景全跑
 *   npx tsx scripts/context-audit.ts --pretty             # 附逐桶明细
 *   npx tsx scripts/context-audit.ts --scenario all --json  # 每场景一行 JSON（图表数据源）
 *     文档里的柱状图必须从这里取数，不要手抄人读输出——抄一次就会漂一个基线。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelHub, type HubConfig, type ProviderAdapter, type StreamRequest } from '../src/core/provider/hub.ts';
import { OutboundLedger } from '../src/core/provider/ledger.ts';
import { ToolRegistry } from '../src/core/tools/registry.ts';
import { createCoreTools } from '../src/core/tools/atomic.ts';
import { type PromptEnv } from '../src/core/loop/system-prompt.ts';
import { AgentKernel, type KernelRunOptions } from '../src/core/loop/kernel.ts';

// ---------- token 估算（标明方法，不假装精确）：CJK≈1 字/token，ASCII≈4 字/token ----------
function estTokens(s: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (/[ \u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}
function kb(n: number): string {
  return `${(n / 1024).toFixed(1)}K`;
}
function pct(part: number, total: number): string {
  return total === 0 ? '   0%' : `${((part / total) * 100).toFixed(1)}%`.padStart(6);
}

// ---------- 桶定义：三条轴（挥发度 / 可信级 / 可再生性） ----------
const BUCKETS = [
  { name: '人格与准则', vol: '版本级', trust: 'S 最高', regen: '固定文本' },
  { name: '工具 schema', vol: '会话级', trust: 'S 最高', regen: '注册表派生' },
  { name: '环境段', vol: '启动级', trust: 'S 最高', regen: '运行时探测' },
  { name: '模式段', vol: '回合级', trust: 'S 最高', regen: '现场重算' },
  { name: '风格指令', vol: '回合级', trust: 'S 最高', regen: '读配置文件' },
  { name: '内核反馈(一次性)', vol: '单步', trust: 'S 最高', regen: '不可再生' },
  { name: '历史:用户消息', vol: '单调增', trust: 'A 用户断言', regen: '不可再生' },
  { name: '历史:模型结论', vol: '单调增', trust: 'D 未验证', regen: '不可再生' },
  { name: '历史:工具结果(可重跑)', vol: '单调增', trust: 'D 不可信', regen: 'read 类可重跑' },
  { name: '历史:工具结果(一次性)', vol: '单调增', trust: 'D 不可信', regen: 'write/exec 不可重跑' },
] as const;
type BucketName = (typeof BUCKETS)[number]['name'];
const GROWING = (n: string): boolean => n.startsWith('历史') || n.startsWith('内核');

interface Cell {
  bytes: number;
  tokens: number;
}
interface StepRecord {
  step: number;
  totalBytes: number;
  buckets: Map<BucketName, Cell>;
  issues: string[];
  systemSha: string;
}

function add(rec: StepRecord, b: BucketName, text: string): void {
  const bytes = Buffer.byteLength(text, 'utf-8');
  const cur = rec.buckets.get(b) ?? { bytes: 0, tokens: 0 };
  cur.bytes += bytes;
  cur.tokens += estTokens(text);
  rec.buckets.set(b, cur);
}
const bytesOf = (rec: StepRecord, b: BucketName): number => rec.buckets.get(b)?.bytes ?? 0;

/**
 * 把 system 文本按「标题」精确定位切开。
 *
 * 定位失败即如实报错而不是估算：本脚本一旦与生产端装配逻辑脱节，必须立刻暴露，
 * 否则它给的每个数字都是假的。
 *
 * 注：工具清单已从 system 里删除（工具描述的唯一来源是请求的 tools 字段），
 * 因此这里只剩「准则段 / 环境段 / 模式段」三块，按标题切即可，无需再派生文本比对。
 */
function splitSystem(system: string, rec: StepRecord): void {
  const envAt = system.indexOf('# 环境说明');
  const delivAt = system.indexOf('# 交付标准');
  if (envAt < 0 || delivAt < envAt) {
    rec.issues.push('标题「# 环境说明」/「# 交付标准」定位失败——环境段未能单独计量');
  }
  const planAt = system.indexOf('**规划模式已开启**');
  if (planAt >= 0 && planAt < delivAt) rec.issues.push('规划模式条款出现在交付段之前，归属判定失效');

  const envSeg = envAt >= 0 && delivAt > envAt ? system.slice(envAt, delivAt) : '';
  const planSeg = planAt >= 0 ? system.slice(planAt) : '';
  // 准则 + 交付标准（交付标准属稳定人格文本，与准则同桶）
  const personaText =
    system.slice(0, envAt >= 0 ? envAt : system.length) +
    system.slice(delivAt >= 0 ? delivAt : system.length, planAt >= 0 ? planAt : system.length);

  add(rec, '人格与准则', personaText);
  add(rec, '环境段', envSeg);
  add(rec, '模式段', planSeg);

  // 自检：三段必须能无重叠无遗漏地拼回原文，否则说明边界判定已失真
  const rebuilt = personaText.length + envSeg.length + planSeg.length;
  if (envAt >= 0 && delivAt > envAt && rebuilt !== system.length) {
    rec.issues.push(`切片重拼后长度 ${rebuilt} ≠ system 原长 ${system.length}，有内容未归桶`);
  }
}

// ---------- 场景脚本（确定性，不联网） ----------
type Plan = { text?: string; toolCalls?: Array<{ id: string; name: string; args: unknown }> };
const mk = (n: number, name: string, args: unknown) => ({ id: `s${n}-${name}`, name, args });

interface Scenario {
  id: string;
  title: string;
  input: string;
  style?: string | null;
  planMode?: boolean;
  steps: Record<number, Plan>;
}

const SCENARIOS: Scenario[] = [
  {
    id: 'explore-then-fix',
    title: '读大文件 → 改一处 → 收尾（真实任务最小切片）',
    input: '读 src/big.ts，把 MAX_ITEMS 改成 500，然后验证',
    steps: {
      1: { toolCalls: [mk(1, 'read_file', { path: 'src/big.ts' })] },
      2: { toolCalls: [mk(2, 'edit_file', { path: 'src/big.ts', old: 'export const MAX_ITEMS = 100;', new: 'export const MAX_ITEMS = 500;' })] },
      3: { text: '改动完成：MAX_ITEMS 已从 100 改为 500。验证方式：grep 新值 + tsc 类型检查。' },
    },
  },
  {
    id: 'failures',
    title: '同一编辑连续失败（五子棋那次空转的上下文形态）',
    input: '把 game.ts 里的 boardSize 改成 15 并验证',
    steps: {
      1: { toolCalls: [mk(1, 'read_file', { path: 'src/game.ts' })] },
      2: { toolCalls: [mk(2, 'edit_file', { path: 'src/game.ts', old: 'boardSize = 99', new: 'boardSize = 15' })] },
      3: { toolCalls: [mk(3, 'edit_file', { path: 'src/game.ts', old: 'boardSize = 99', new: 'boardSize = 15' })] },
      4: { toolCalls: [mk(4, 'edit_file', { path: 'src/game.ts', old: 'boardSize = 99', new: 'boardSize = 15' })] },
      5: { text: '已停止尝试并向用户说明卡点。' },
    },
  },
  {
    id: 'varying-failures',
    title: '每次参数不同的连续失败（绕过周期检测，逼出一次性内核反馈的堆积）',
    input: '把 game.ts 里的 boardSize 改成 15 并验证',
    steps: {
      1: { toolCalls: [mk(1, 'read_file', { path: 'src/game.ts' })] },
      2: { toolCalls: [mk(2, 'edit_file', { path: 'src/game.ts', old: 'boardSize = 99', new: 'boardSize = 15' })] },
      3: { toolCalls: [mk(3, 'edit_file', { path: 'src/game.ts', old: 'const boardSize = 99;', new: 'const boardSize = 15;' })] },
      4: { toolCalls: [mk(4, 'edit_file', { path: 'src/game.ts', old: 'boardSize: 99', new: 'boardSize: 15' })] },
      5: { toolCalls: [mk(5, 'edit_file', { path: 'src/game.ts', old: 'boardSize=99', new: 'boardSize=15' })] },
      6: { text: '已向用户说明卡点。' },
    },
  },
  {
    id: 'long-run',
    title: '12 步探索任务（固定开销与增长开销的比例演变）',
    input: '逐个读 src/big.ts 与 src/game.ts，汇报每个文件的关键常量',
    steps: Object.fromEntries(
      Array.from({ length: 12 }, (_, i): [string, Plan] => [
        String(i + 1),
        i % 2 === 0
          ? { toolCalls: [mk(i + 1, 'read_file', { path: i % 4 === 0 ? 'src/big.ts' : 'src/game.ts' })] }
          : { text: `第 ${i + 1} 步：已读到关键常量，继续下一个文件。` },
      ]),
    ) as Record<number, Plan>,
  },
];

// ---------- 探针 provider ----------
class ProbeAdapter implements ProviderAdapter {
  id = 'probe';
  models = [{ id: 'probe-actor', label: 'Probe', contextWindow: 128_000, supportsThinking: false }];
  readonly records: StepRecord[] = [];
  private step = 0;
  private readonly calls = new Map<string, { name: string; args: unknown }>();

  constructor(
    private readonly scenario: Scenario,
    private readonly registry: ToolRegistry,
    private readonly env: PromptEnv,
  ) {}

  resetTurn(): void {
    this.step = 0;
  }
  endpoint(): string {
    return 'probe://local/audit';
  }

  /** 唯一职责：在这里看见模型这一次真正被喂了什么。 */
  serialize(req: StreamRequest): string {
    this.step += 1;
    const rec: StepRecord = {
      step: this.step,
      totalBytes: 0,
      buckets: new Map(),
      issues: [],
      systemSha: createHash('sha256').update(req.system, 'utf-8').digest('hex').slice(0, 12),
    };

    splitSystem(req.system, rec);

    // tools 字段：模型可见的第二份工具真相（完整 JSON Schema）
    if (req.tools?.length) add(rec, '工具 schema', JSON.stringify(req.tools));

    for (const m of req.messages) {
      if (m.role === 'user') add(rec, '历史:用户消息', m.content);
      else if (m.role === 'assistant') {
        if (m.content) add(rec, '历史:模型结论', m.content);
        if (m.toolCalls) add(rec, '历史:模型结论', JSON.stringify(m.toolCalls));
      } else if (m.role === 'tool') {
        const call = m.toolCallId ? this.calls.get(m.toolCallId) : undefined;
        const cap = call ? this.registry.get(call.name)?.capability : undefined;
        add(rec, cap === 'read' ? '历史:工具结果(可重跑)' : '历史:工具结果(一次性)', m.content);
      } else {
        add(rec, /^（系统提示：/.test(m.content) ? '内核反馈(一次性)' : '风格指令', m.content);
      }
    }

    rec.totalBytes = [...rec.buckets.values()].reduce((a, c) => a + c.bytes, 0);
    this.records.push(rec);
    return JSON.stringify({ model: req.modelId, messages: req.messages, tools: req.tools });
  }

  async *stream(_req: StreamRequest, _key: string, _body: string) {
    const plan = this.scenario.steps[this.step] ?? { text: '（超出脚本步数，收尾）' };
    for (const tc of plan.toolCalls ?? []) this.calls.set(tc.id, { name: tc.name, args: tc.args });
    if (plan.text) yield { type: 'text_delta', text: plan.text } as const;
    yield {
      type: 'message_end',
      toolCalls: plan.toolCalls ?? [],
      finishReason: plan.toolCalls?.length ? 'tool_calls' : 'stop',
      usage: { inputTokens: 0, outputTokens: 0 },
    } as const;
  }
}

// ---------- 主流程 ----------
async function run(scenario: Scenario, pretty: boolean, json: boolean): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), 'dsa-ctxaudit-'));
  const home = mkdtempSync(join(tmpdir(), 'dsa-ctxaudit-home-'));
  try {
    mkdirSync(join(workspace, 'src'), { recursive: true });
    const big = Array.from(
      { length: 300 },
      (_, i) => `export const CONST_${i} = ${i}; // 第 ${i} 行说明，真实仓库里的注释与签名会撑开读文件结果`,
    ).join('\n');
    writeFileSync(join(workspace, 'src', 'big.ts'), `export const MAX_ITEMS = 100;\n${big}\n`, 'utf-8');
    writeFileSync(join(workspace, 'src', 'game.ts'), 'export const boardSize = 13;\n', 'utf-8');

    const registry = new ToolRegistry();
    for (const t of createCoreTools()) registry.register(t);
    const env: PromptEnv = { workspace, protectedRoots: [], planMode: scenario.planMode ?? false, modelName: 'probe-actor（审计档）' };
    const hub = new ModelHub(
      {
        routing: {
          actor: { provider: 'probe', model: 'probe-actor' },
          critic: { provider: 'probe', model: 'probe-actor' },
          cheap: { provider: 'probe', model: 'probe-actor' },
        },
        keys: { probe: 'audit-no-key' },
      } as HubConfig,
      new OutboundLedger({ dir: join(home, 'outbound') }),
    );
    const probe = new ProbeAdapter(scenario, registry, env);
    hub.register(probe);
    const kernel = new AgentKernel({ hub, registry, cwd: workspace, protectedRoots: [], modelName: () => env.modelName });
    const opts: KernelRunOptions = {
      permission: 'execute',
      planMode: scenario.planMode ?? false,
      styleInstruction: scenario.style ?? null,
      maxIterations: 20,
    };

    probe.resetTurn();
    let stopReason = '未知';
    for await (const ev of kernel.prompt(scenario.input, opts)) {
      if (ev.type === 'done' && ev.reason) stopReason = ev.reason;
    }
    print(scenario, probe, stopReason, pretty, json);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

function print(scenario: Scenario, probe: ProbeAdapter, stopReason: string, pretty: boolean, json: boolean): void {
  if (json) {
    // 给文档/脚本消费的稳定格式：字段名冻结，中文桶名不动。
    console.log(JSON.stringify({
      scenario: scenario.id,
      stopReason,
      steps: probe.records.map((r) => ({
        step: r.step,
        totalBytes: r.totalBytes,
        systemSha: r.systemSha.slice(0, 12),
        buckets: Object.fromEntries([...r.buckets].map(([n, c]) => [n, { bytes: c.bytes, tokens: c.tokens }])),
      })),
    }));
    return;
  }
  const recs = probe.records;
  console.log(`\n${'='.repeat(76)}`);
  console.log(`场景 ${scenario.id} —— ${scenario.title}`);
  console.log(`输入：${scenario.input}`);
  console.log(`模型调用 ${recs.length} 次；退出原因 ${stopReason}`);
  const first = recs[0];
  const last = recs[recs.length - 1];
  if (!first || !last) return;

  const sumOf = (r: StepRecord, f: (n: string) => boolean) =>
    [...r.buckets.entries()].reduce((a, [n, c]) => (f(n) ? a + c.bytes : a), 0);
  const fixedFirst = sumOf(first, (n) => !GROWING(n));
  console.log(`\n单步固定开销（第 1 步即为全量）：${kb(fixedFirst)} / 首步总量 ${kb(first.totalBytes)} = ${pct(fixedFirst, first.totalBytes)}`);
  const distinctSystem = new Set(recs.map((r) => r.systemSha)).size;
  console.log(`system 在 ${recs.length} 步中出现 ${distinctSystem} 个不同版本 —— ${distinctSystem === 1 ? '前缀完全稳定，服务商 prompt cache 可命中' : '前缀逐步变化，缓存必然失效'}`);

  console.log('\n【逐桶：首步 → 末步】');
  console.log('  桶名                        挥发度    可信度        可再生性          首步     末步      增量   末步占比');
  for (const b of BUCKETS) {
    const a = bytesOf(first, b.name);
    const z = bytesOf(last, b.name);
    if (a === 0 && z === 0) continue;
    console.log(
      `  ${b.name.padEnd(26)}${b.vol.padEnd(10)}${b.trust.padEnd(14)}${b.regen.padEnd(20)}${kb(a).padStart(8)} ${kb(z).padStart(8)} ${`+${kb(z - a)}`.padStart(8)}${pct(z, last.totalBytes).padStart(9)}`,
    );
  }
  console.log(`  ${'合计'.padEnd(26)}${''.padEnd(10)}${''.padEnd(14)}${''.padEnd(20)}${kb(first.totalBytes).padStart(8)} ${kb(last.totalBytes).padStart(8)} ${`+${kb(last.totalBytes - first.totalBytes)}`.padStart(8)}`);

  console.log('\n【每步送出的构成：= 固定开销  # 增长开销】');
  const W = 30;
  for (const r of recs) {
    const grow = sumOf(r, GROWING);
    const g = Math.min(W, Math.round((grow / r.totalBytes) * W));
    console.log(`  步${String(r.step).padStart(2)} ${'.'.repeat(W - g)}${'#'.repeat(g)} ${kb(r.totalBytes).padStart(8)}  固定${pct(r.totalBytes - grow, r.totalBytes)} 增长${pct(grow, r.totalBytes)}`);
  }

  const sent = recs.reduce((a, r) => a + r.totalBytes, 0);
  // 分母必须用「峰值步」而不是「末步」：末步最小/最大都可能，③ 生效后末步会因为
  // 降详而明显小于峰值步，用末步当分母会算出「重复投递 8.5 次」这种看上去变差、
  // 其实只是分母缩了的假指标。峰值步 = 这份历史最多的一次，比值才有「平均送了几遍」的含义。
  const peak = Math.max(...recs.map((r) => r.totalBytes));
  console.log(`\n累计送出 ${kb(sent)}，峰值步 ${kb(peak)} —— 平均每份内容被重复投递 ${(sent / peak).toFixed(1)} 次`);
  console.log(`（分母是峰值步，不是末步：③ 降详后末步会主动变小，用末步当分母会造出假指标）`);
  const reb = bytesOf(last, '历史:工具结果(可重跑)');
  const one = bytesOf(last, '历史:工具结果(一次性)');
  console.log(`末步工具结果：可重跑再生 ${kb(reb)}（${pct(reb, reb + one)}）/ 一次性事实不可再生 ${kb(one)}`);

  if (pretty) {
    console.log('\n【末步逐桶明细（估算 token，方法见文件头）】');
    for (const b of BUCKETS) {
      const c = last.buckets.get(b.name);
      if (!c?.bytes) continue;
      console.log(`  ${b.name.padEnd(26)}${kb(c.bytes).padStart(8)}  ~${c.tokens || Math.round(c.bytes / 3.6)} tok`);
    }
  }
  const issues = [...new Set(recs.flatMap((r) => r.issues))];
  console.log(issues.length ? `\n  ! 拆桶自检发现问题：\n    - ${issues.join('\n    - ')}` : '\n  拆桶自检：system 各段边界与生产端一致。');
}

const argv = process.argv.slice(2);
const si = argv.indexOf('--scenario');
const want = si >= 0 ? argv[si + 1] : 'explore-then-fix';
const chosen = want === 'all' ? SCENARIOS : SCENARIOS.filter((s) => s.id === want);
if (!chosen.length) {
  console.error(`未知场景 ${want}；可选：${SCENARIOS.map((s) => s.id).join(', ')} | all`);
  process.exit(1);
}
for (const s of chosen) await run(s, argv.includes('--pretty'), argv.includes('--json'));
