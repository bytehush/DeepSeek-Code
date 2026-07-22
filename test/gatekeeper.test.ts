import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultGatekeeper, type Gatekeeper } from '../src/tools/gatekeeper.ts';
import type { ToolDef } from '../src/tools/types.ts';

function makeDef(over: Partial<ToolDef> = {}): ToolDef {
  return {
    name: 'echo',
    description: 'echo tool',
    parameters: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
    risk: 'low',
    execute: async () => ({ ok: true, output: '' }),
    ...over,
  };
}

const gk: Gatekeeper = new DefaultGatekeeper();

test('inspect: 合法 JSON 字符串 → ok, 风险=工具默认', () => {
  const r = gk.inspect('echo', '{"msg":"hi"}', makeDef());
  assert.equal(r.ok, true);
  assert.deepEqual(r.repairedArgs, { msg: 'hi' });
  assert.equal(r.effectiveRisk, 'low');
  assert.equal(r.errors, undefined);
});

test('inspect: 已是对象的参数(如 MCP) → 直接采用', () => {
  const r = gk.inspect('echo', { msg: 'hi' }, makeDef());
  assert.equal(r.ok, true);
  assert.deepEqual(r.repairedArgs, { msg: 'hi' });
});

test('inspect: 真正不可解析的 JSON → 解析失败 ok:false 且带 error', () => {
  // 注意：extractArguments 的 repair() 能修复尾随逗号等轻微畸形，
  // 此处用结构错误的输入（非合法 JSON 且无括号可补）才能触发解析失败。
  const r = gk.inspect('echo', '{bad json', makeDef());
  assert.equal(r.ok, false);
  assert.ok(r.errors && r.errors.length > 0, '应返回解析错误');
});

test('inspect: 缺必填字段 → validateArgs 拦截, 风险仍 low', () => {
  const r = gk.inspect('echo', '{}', makeDef());
  assert.equal(r.ok, false);
  assert.ok(r.errors && r.errors.some((e) => e.includes('msg')));
  assert.equal(r.effectiveRisk, 'low');
});

test('inspect: run_command 破坏性命令 → effectiveRisk 升级 high', () => {
  const def = makeDef({
    name: 'run_command',
    risk: 'mid',
    parameters: { type: 'object', properties: { command: { type: 'string' } } },
  });
  const r = gk.inspect('run_command', { command: 'rm -rf /' }, def);
  assert.equal(r.ok, true);
  assert.equal(r.effectiveRisk, 'high');
});

test('inspect: run_command 非破坏性 → 风险=工具默认', () => {
  const def = makeDef({
    name: 'run_command',
    risk: 'mid',
    parameters: { type: 'object', properties: { command: { type: 'string' } } },
  });
  const r = gk.inspect('run_command', { command: 'ls -la' }, def);
  assert.equal(r.ok, true);
  assert.equal(r.effectiveRisk, 'mid');
});
