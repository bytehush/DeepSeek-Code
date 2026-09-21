/**
 * 上下文预算与降详（③）——「模型视图」与「用户视图」分叉的唯一发生地。
 *
 * 为什么需要它：内核原先把整列历史原样发出（零裁剪、零窗口、零预算），
 * hub.actorContextWindow() 存在却从没人调用。于是「该压了」没有触发条件，
 * token_limit 只能被动等服务商报错——报错时用户看到的是一整轮白烧。
 *
 * 折叠的判据不是「这条太长」，而是**这条已经与后来的事实矛盾**：
 *   读结果 X 之后，若有一次对同一路径的成功写入，则 X 描述的文件状态已不成立。
 * 这正是判据 3（无矛盾：同一事实不得存在两个版本）点名的结构性风险——旧 read
 * 结果与新 edit 结果并存，模型只能猜哪个算数。所以这条规则同时省字节和去矛盾，
 * 而「按新旧/长短裁剪」只省字节、还可能把模型刚读到的东西折掉逼它幻觉。
 *
 * 三条安全约束（每条对应一种会真实发生的失败）：
 * 1. 只折叠可重跑的读类结果（registry capability 判定，不按输出文案猜——文案会漂移）。
 *    写入/执行的结果是一次性事实，失败与被拒的结果里的错误正文是「为什么失败」的
 *    唯一载体，二者一律豁免：折掉就把事实变成缺席。
 * 2. 引用化，不复述化。折叠文本只陈述从这条消息本身可推出的事实（调了哪个工具、
 *    什么参数、返回多少字节多少行、被哪次写入取代、怎么取回），绝不摘要内容——
 *    摘要一旦写错，模型就基于假事实行动，比截断更糟。安全边界是「不新增断言」。
 * 3. 不改 this.messages。产出的是仅供本次请求使用的副本；原文永远留在内核历史、
 *    trace、session 与 TUI 折叠层里。有了这条边界，模型侧才敢激进降详。
 *
 * 窗口压力（估算输入 > 60% 窗口）是第二条独立触发路径：那时连「仍然成立」的读结果
 * 也得让位，只保留最近一条——因为撞上 token_limit 的代价是一整轮白烧。
 */
import type { Msg, ToolOutcome } from '../types.ts';
import type { ToolRegistry } from '../tools/registry.ts';

/**
 * 不可重跑的性质标记。
 *
 * 注意不能写成「有 outcome 就豁免」——toolMsg 默认给 'ok'，那样每条都被豁免，
 * 降详会静默变成空转（这个 bug 是测试抓出来的，不是我想到的）。
 * 只有 failed / denied / error / notice 才代表「正文不可再生」。
 */
const NON_REGENERABLE: ReadonlySet<ToolOutcome | undefined> = new Set(['failed', 'denied', 'error', 'notice']);
const nonRegenerable = (m: Msg): boolean => NON_REGENERABLE.has(m.outcome);

/** 单条结果小于此字节数时不折叠：省不到什么，反而多一条噪声引用 */
export const MIN_COLLAPSE_BYTES = 4096;
/** 压力下仍保留最近 N 条读结果原文 */
export const KEEP_RECENT_PRESSURED = 1;
/** 估算输入超过窗口的这个比例即视为有压力（余量给思考与输出） */
export const PRESSURE_RATIO = 0.6;

/**
 * token 估算：CJK 每字约 1 token，其余每 4 字符约 1 token。
 *
 * 只用于阈值判断，不当账单用——且宁可估高：估高最多多折一条可重跑引用，
 * 估低则撞上服务商报错。
 */
export function estimateTokens(s: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (/[ \u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

const utf8 = (s: string): number => Buffer.byteLength(s, 'utf-8');

/** 这条消息送上线的体积（含 assistant 携带的 tool_call 参数） */
function msgBytes(m: Msg): number {
  return (
    utf8(m.content) +
    (m.toolCalls ? utf8(JSON.stringify(m.toolCalls)) : 0) +
    (m.name ? utf8(m.name) : 0)
  );
}

/** 整个请求体的估算 token：system + tools 定义 + 全部消息 */
export function estimateRequestTokens(system: string, messages: readonly Msg[], toolsJson?: string): number {
  let n = estimateTokens(system);
  if (toolsJson) n += estimateTokens(toolsJson);
  for (const m of messages) {
    n += estimateTokens(m.content) + (m.toolCalls ? estimateTokens(JSON.stringify(m.toolCalls)) : 0);
  }
  return n;
}

/** 从历史里还原「这次调用的参数」——assistant 消息带 toolCalls，tool 消息带 toolCallId */
function callArgsByToolCallId(messages: readonly Msg[]): Map<string, { name: string; args: string }> {
  const map = new Map<string, { name: string; args: string }>();
  for (const m of messages) {
    for (const tc of m.toolCalls ?? []) {
      map.set(tc.id, { name: tc.name, args: JSON.stringify(tc.args ?? {}) });
    }
  }
  return map;
}

/** 取 path 参数（read_file / write_file / edit_file 都叫 path）；取不到返回 null */
function pathArg(args: string): string | null {
  try {
    const v = JSON.parse(args) as { path?: unknown };
    return typeof v.path === 'string' ? v.path : null;
  } catch {
    return null;
  }
}

export interface CollapsePlan {
  /** 仅供本次请求使用的消息副本；未折叠条目与传入对象同一引用 */
  messages: Msg[];
  collapsed: number;
  /** 省下的精确字节数 */
  savedBytes: number;
  beforeTokens: number;
  /** 是否由窗口压力触发（true 时连未过时的读结果也可能被折） */
  pressured: boolean;
  /** 被折叠条目的简述（给 UI 的一行交代） */
  notes: string[];
}

/**
 * 产出模型视图。纯函数：同一份历史 + 同一个窗口 → 同一份输出。
 * 这条性质不能丢，否则前缀缓存被折叠决策的抖动打穿，用户也无法复现
 * 模型当时看到的内容。
 */
export function fitContext(
  messages: readonly Msg[],
  registry: ToolRegistry,
  opts: { system: string; toolsJson?: string; contextWindow: number },
): CollapsePlan {
  const beforeTokens = estimateRequestTokens(opts.system, messages, opts.toolsJson);
  const pressured = beforeTokens > opts.contextWindow * PRESSURE_RATIO;
  const calls = callArgsByToolCallId(messages);

  // 每条 tool 结果的身份：工具名 + 调用参数 + 它读的哪个路径
  interface Info { name: string; args: string; path: string | null; isRead: boolean }
  const info = new Map<number, Info>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== 'tool' || !m.toolCallId) continue;
    const call = calls.get(m.toolCallId);
    const name = call?.name ?? m.name;
    if (!name) continue;
    info.set(i, {
      name,
      args: call?.args ?? '{}',
      path: call ? pathArg(call.args) : null,
      isRead: registry.get(name)?.capability === 'read',
    });
  }

  // 「已被同路径的成功写入取代」的位置集合
  const superseded = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    const a = info.get(i);
    if (!a?.isRead || !a.path) continue;
    for (let j = i + 1; j < messages.length; j++) {
      const b = info.get(j);
      const bm = messages[j]!;
      if (!b || b.isRead || b.path !== a.path) continue;
      if (nonRegenerable(bm)) continue; // 写没成功（失败/被拒），读仍然成立
      superseded.add(i);
      break;
    }
  }

  const readIdxAll = [...info.entries()]
    .filter(([i, v]) => v.isRead && msgBytes(messages[i]!) >= MIN_COLLAPSE_BYTES && !nonRegenerable(messages[i]!))
    .map(([i]) => i);
  const keepFrom = pressured ? KEEP_RECENT_PRESSURED : 0;
  const fresh = new Set(readIdxAll.slice(Math.max(0, readIdxAll.length - keepFrom)));

  const targets: number[] = [];
  const notes: string[] = [];
  for (const i of readIdxAll) {
    const stale = superseded.has(i);
    if (!stale && !pressured) continue;      // 无压力且仍成立 → 原样保留
    if (!stale && fresh.has(i)) continue;    // 有压力但仍是最近读到的 → 保住
    targets.push(i);
    notes.push(`${info.get(i)!.name} ${info.get(i)!.path ?? '?'}`);
  }
  if (targets.length === 0) {
    return { messages: [...messages], collapsed: 0, savedBytes: 0, beforeTokens, pressured, notes: [] };
  }

  const out = [...messages];
  let savedBytes = 0;
  for (const i of targets) {
    const orig = messages[i]!;
    const a = info.get(i)!;
    const ref = referenceText(a.name, a.args, orig.content, superseded.has(i));
    savedBytes += msgBytes(orig) - utf8(ref);
    out[i] = { ...orig, content: ref };
  }
  return { messages: out, collapsed: targets.length, savedBytes, beforeTokens, pressured, notes };
}

/** 引用化文本：只说「折了什么、多大、为何可折、怎么取回」，不概括内容 */
function referenceText(name: string, args: string, content: string, stale: boolean): string {
  const bytes = utf8(content);
  const lines = content.split('\n').length;
  return (
    `（历史工具结果已降详：${name} ${args} 曾返回 ${lines} 行 / ${bytes} 字节。` +
    (stale ? '此后对同一路径有成功写入，这份内容描述的状态已过时。' : '为腾出上下文窗口而降详。') +
    `原文未删除；需要其中内容请重新调用 ${name} 取回。）`
  );
}
