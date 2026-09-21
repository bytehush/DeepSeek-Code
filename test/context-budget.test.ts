/**
 * 上下文降详（③）纯函数回归测试。
 *
 * 为什么单独测纯函数：fitContext 的每条安全约束都要用「大体积 + 特定 outcome」
 * 的组合才能触发，走内核反而造不出这些形状（内核里的失败文本只有一句话，
 * 达不到 MIN_COLLAPSE_BYTES，于是断言会变成「永远为真」的空断言——
 * 这个坑是变异测试抓出来的：把豁免逻辑整个关掉，e2e 仍 30/30 通过）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { ToolRegistry, defineTool } from '../src/core/tools/registry.ts';
import {
  fitContext,
  estimateTokens,
  MIN_COLLAPSE_BYTES,
  PRESSURE_RATIO,
} from '../src/core/loop/context-budget.ts';
import { assistantMsg, toolMsg, userMsg, type Msg, type ToolOutcome } from '../src/core/types.ts';

const BIG = 'x'.repeat(MIN_COLLAPSE_BYTES + 500);

function reg(): ToolRegistry {
  const r = new ToolRegistry();
  for (const name of ['read_file', 'search_files', 'list_files'] as const) {
    r.register(defineTool({
      name, label: name, description: name, capability: 'read', risk: 'low',
      parameters: z.object({ path: z.string().optional(), query: z.string().optional() }),
      async execute() { return { content: '' }; },
    }));
  }
  for (const name of ['write_file', 'edit_file'] as const) {
    r.register(defineTool({
      name, label: name, description: name, capability: 'write', risk: 'low',
      parameters: z.object({ path: z.string().optional(), content: z.string().optional(), old: z.string().optional(), new: z.string().optional() }),
      async execute() { return { content: '' }; },
    }));
  }
  r.register(defineTool({
    name: 'bash', label: 'bash', description: 'bash', capability: 'exec', risk: 'low',
    parameters: z.object({ command: z.string().optional() }),
    async execute() { return { content: '' }; },
  }));
  return r;
}

/** 造一段「调用 → 结果」历史 */
function turn(id: string, name: string, args: Record<string, unknown>, content: string, outcome?: ToolOutcome): Msg[] {
  return [
    assistantMsg('', [{ type: 'tool_call', id, name, args }]),
    outcome === undefined
      ? toolMsg(id, name, content)
      : toolMsg(id, name, content, outcome),
  ];
}

const CALM = { system: 'sys', toolsJson: '[]', contextWindow: 1_000_000 };

test('已过时的读结果被降详：读过后同路径成功写入', () => {
  const msgs: Msg[] = [
    userMsg('改 A'),
    ...turn('r1', 'read_file', { path: 'a.ts' }, BIG),
    ...turn('e1', 'edit_file', { path: 'a.ts', old: 'A', new: 'B' }, '已编辑 a.ts'),
  ];
  const plan = fitContext(msgs, reg(), CALM);
  assert.equal(plan.collapsed, 1, '那条 read 应被降详');
  assert.match(plan.messages[2]!.content, /已降详/);
  assert.match(plan.messages[2]!.content, /已过时/, '引用须说明为什么可以折');
  assert.ok(!plan.messages[2]!.content.includes(BIG.slice(0, 200)), '原文不得残留');
  assert.ok(plan.savedBytes > 1000, '省下的字节须是真实收益');
});

test('无矛盾风险不得被制造出来：写入失败时，之前的读结果仍然成立', () => {
  const msgs: Msg[] = [
    userMsg('改 A'),
    ...turn('r1', 'read_file', { path: 'a.ts' }, BIG),
    ...turn('e1', 'edit_file', { path: 'a.ts', old: 'x', new: 'y' }, '工具执行失败：old 不匹配', 'failed'),
  ];
  const plan = fitContext(msgs, reg(), CALM);
  assert.equal(plan.collapsed, 0, '写没成功 → 文件状态未变 → 读结果仍是最新事实');
});

test('不可再生的正文一律豁免（失败 / 被拒 / 结构错误 / 内核交代），即使体积够大', () => {
  for (const outcome of ['failed', 'denied', 'error', 'notice'] as const) {
    const msgs: Msg[] = [
      userMsg('读'),
      ...turn('r1', 'read_file', { path: 'a.ts' }, BIG, outcome),
      ...turn('e1', 'edit_file', { path: 'a.ts', old: 'x', new: 'y' }, '已编辑'),
    ];
    const plan = fitContext(msgs, reg(), CALM);
    assert.equal(plan.collapsed, 0, `outcome=${outcome} 时不得折叠——正文不可再生`);
    assert.equal(plan.messages[2]!.content, BIG);
  }
});

test('写类与执行类结果永不折叠：它们是一次性事实', () => {
  const msgs: Msg[] = [
    userMsg('跑'),
    ...turn('b1', 'bash', { command: 'npm test' }, BIG),
    ...turn('w1', 'write_file', { path: 'b.ts' }, '已创建 b.ts'),
    ...turn('w2', 'write_file', { path: 'b.ts' }, '已覆盖 b.ts'),
  ];
  const plan = fitContext(msgs, reg(), CALM);
  assert.equal(plan.collapsed, 0, 'bash 输出与写入结果都不可重跑还原');
});

test('小结果不折叠：省不到东西，只会多一条噪声引用', () => {
  const msgs: Msg[] = [
    userMsg('读'),
    ...turn('r1', 'read_file', { path: 'a.ts' }, 'tiny'),
    ...turn('e1', 'edit_file', { path: 'a.ts', old: 'x', new: 'y' }, '已编辑'),
  ];
  const plan = fitContext(msgs, reg(), CALM);
  assert.equal(plan.collapsed, 0);
});

test('窗口压力下折叠较早读结果，但最近一条必须保住', () => {
  const registry = reg();
  // 每条 4500 字符 ≈ 1125 token（ASCII/4）。窗口 3000 时压力线（60%）= 1800：
  // 两条共约 2250 越过压力线，一条（1125）在线下。数字要真算过，别凭感觉填。
  const big = 'x'.repeat(4_500);
  const msgs: Msg[] = [
    userMsg('读两个文件'),
    ...turn('r1', 'read_file', { path: 'a.ts' }, big),
    ...turn('r2', 'read_file', { path: 'b.ts' }, big),
  ];
  const window = 3_000;
  const plan = fitContext(msgs, registry, { system: 'sys', toolsJson: '[]', contextWindow: window });
  assert.ok(plan.pressured, '估算须越过压力阈值');
  assert.equal(plan.collapsed, 1, '只让位较早的那条');
  assert.match(plan.messages[2]!.content, /已降详/);
  assert.equal(plan.messages[4]!.content, big, '最近读到的内容折掉就等于逼模型幻觉');
});

test('降详是纯函数：同一输入两次调用产出完全相同（前缀缓存与可复现性的前提）', () => {
  const msgs: Msg[] = [
    userMsg('读'),
    ...turn('r1', 'read_file', { path: 'a.ts' }, BIG),
    ...turn('e1', 'edit_file', { path: 'a.ts', old: 'x', new: 'y' }, '已编辑'),
    ...turn('r2', 'read_file', { path: 'c.ts' }, BIG),
    ...turn('w1', 'write_file', { path: 'c.ts', content: 'z' }, '已覆盖 c.ts'),
  ];
  const a = fitContext(msgs, reg(), CALM);
  const b = fitContext(msgs, reg(), CALM);
  assert.deepEqual(a.messages.map((m) => m.content), b.messages.map((m) => m.content));
  assert.equal(a.collapsed, 2);
});

test('不改动传入的消息对象（模型视图与用户视图必须是两份东西）', () => {
  const read = toolMsg('r1', 'read_file', BIG);
  const msgs: Msg[] = [userMsg('读'), assistantMsg('', [{ type: 'tool_call', id: 'r1', name: 'read_file', args: { path: 'a.ts' } }]), read,
    ...turn('e1', 'edit_file', { path: 'a.ts', old: 'x', new: 'y' }, '已编辑')];
  const snapshot = JSON.stringify(msgs);
  const plan = fitContext(msgs, reg(), CALM);
  assert.equal(plan.collapsed, 1);
  assert.equal(JSON.stringify(msgs), snapshot, '入参必须逐字节不变');
  assert.equal(read.content, BIG, '原对象不得被就地改写');
});

test('引用文本只陈述可推出的事实，不含内容摘要', () => {
  const content = 'export const SECRET = 42;\n' + BIG;
  const msgs: Msg[] = [
    userMsg('读'),
    ...turn('r1', 'read_file', { path: 'a.ts' }, content),
    ...turn('e1', 'edit_file', { path: 'a.ts', old: 'x', new: 'y' }, '已编辑'),
  ];
  const plan = fitContext(msgs, reg(), CALM);
  const ref = plan.messages[2]!.content;
  assert.ok(!ref.includes('SECRET'), '不得把原文里的标识符带进引用');
  assert.match(ref, /重新调用 read_file 取回/, '须给出找回路径');
  assert.match(ref, new RegExp(String(content.split('\n').length)), '须给出行数（模型据此判断取回代价）');
});

test('token 估算对 CJK 与 ASCII 分别计价，且偏保守', () => {
  assert.equal(estimateTokens('中文字符'), 4);
  assert.equal(estimateTokens('abcdefgh'), 2); // 8 字符 / 4
  // 阈值本身要能被读懂：压力比例须在 (0,1) 内，否则闸门永不触发或永远触发
  assert.ok(PRESSURE_RATIO > 0 && PRESSURE_RATIO < 1);
});
