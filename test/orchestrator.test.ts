import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolOrchestrator, type OrchestratorDeps } from '../src/tools/orchestrator.ts';
import { DefaultGatekeeper } from '../src/tools/gatekeeper.ts';
import type { ToolDef, ToolContext } from '../src/tools/types.ts';
import type { PermissionMode } from '../src/permission/index.ts';

interface Ctx {
  asks: string[];
  answer: boolean;
  mode: PermissionMode;
}
function makeOrchestrator(tools: ToolDef[], ctx: Ctx): ToolOrchestrator {
  const deps: OrchestratorDeps = {
    tools,
    gatekeeper: new DefaultGatekeeper(),
    ask: async (p: string) => {
      ctx.asks.push(p);
      return ctx.answer;
    },
    mode: ctx.mode,
    cwd: '/tmp',
  };
  return new ToolOrchestrator(deps);
}

const baseCtx: ToolContext = { cwd: '/tmp' };

function writeFileTool(): ToolDef {
  return {
    name: 'write_file',
    description: 'write',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    risk: 'mid',
    execute: async () => ({ ok: true, output: 'written' }),
    preview: async () => '--- a\n+++ b',
  };
}
function runCmdTool(): ToolDef {
  return {
    name: 'run_command',
    description: 'run',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    risk: 'mid',
    execute: async () => ({ ok: true, output: 'ran' }),
  };
}
function echoTool(): ToolDef {
  return {
    name: 'echo',
    description: 'echo',
    parameters: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
    risk: 'low',
    execute: async () => ({ ok: true, output: 'echoed' }),
  };
}

test('dispatch: 未知工具 → needSelfHeal + 错误', async () => {
  const ctx: Ctx = { asks: [], answer: true, mode: 'execute' };
  const o = makeOrchestrator([echoTool()], ctx);
  const r = await o.dispatch({ id: '1', name: 'nope', rawArguments: {}, ctx: baseCtx });
  assert.equal(r.ok, false);
  assert.equal(r.needSelfHeal, true);
  assert.ok(r.errors && r.errors[0].includes('未知工具'));
});

test('dispatch: 把关失败(缺参) → needSelfHeal + 字段级错误', async () => {
  const ctx: Ctx = { asks: [], answer: true, mode: 'execute' };
  const o = makeOrchestrator([echoTool()], ctx);
  const r = await o.dispatch({ id: '1', name: 'echo', rawArguments: '{}', ctx: baseCtx });
  assert.equal(r.ok, false);
  assert.equal(r.needSelfHeal, true);
  assert.ok(r.errors && r.errors.some((e) => e.includes('msg')));
});

test('dispatch: explore 模式拦截 mid 风险文件写 → denied', async () => {
  const ctx: Ctx = { asks: [], answer: true, mode: 'explore' };
  const o = makeOrchestrator([writeFileTool()], ctx);
  const r = await o.dispatch({ id: '1', name: 'write_file', rawArguments: '{"path":"a"}', ctx: baseCtx });
  assert.equal(r.ok, false);
  assert.equal(r.denied, true);
  assert.equal(ctx.asks.length, 0, 'explore 直接拦截，不应弹确认');
});

test('dispatch: ask 模式文件写 → file_review 确认通过 → 执行', async () => {
  const ctx: Ctx = { asks: [], answer: true, mode: 'ask' };
  const o = makeOrchestrator([writeFileTool()], ctx);
  const r = await o.dispatch({ id: '1', name: 'write_file', rawArguments: '{"path":"a"}', ctx: baseCtx });
  assert.equal(r.ok, true);
  assert.equal(r.output, 'written');
  assert.equal(ctx.asks.length, 1, '应弹一次 diff 确认');
  assert.ok(ctx.asks[0].includes('即将修改文件'));
});

test('dispatch: ask 模式文件写 → file_review 用户拒绝 → denied', async () => {
  const ctx: Ctx = { asks: [], answer: false, mode: 'ask' };
  const o = makeOrchestrator([writeFileTool()], ctx);
  const r = await o.dispatch({ id: '1', name: 'write_file', rawArguments: '{"path":"a"}', ctx: baseCtx });
  assert.equal(r.ok, false);
  assert.equal(r.denied, true);
  assert.equal(r.output, '用户拒绝执行 write_file');
});

test('dispatch: ask 模式破坏性命令 → risk_prompt 确认通过 → 执行', async () => {
  const ctx: Ctx = { asks: [], answer: true, mode: 'ask' };
  const o = makeOrchestrator([runCmdTool()], ctx);
  const r = await o.dispatch({ id: '1', name: 'run_command', rawArguments: '{"command":"rm -rf /"}', ctx: baseCtx });
  assert.equal(r.ok, true);
  assert.equal(r.output, 'ran');
  assert.equal(ctx.asks.length, 1);
  assert.ok(ctx.asks[0].includes('高风险操作'));
});

test('dispatch: execute 模式低风险工具 → allow 直接执行', async () => {
  const ctx: Ctx = { asks: [], answer: true, mode: 'execute' };
  const o = makeOrchestrator([echoTool()], ctx);
  const r = await o.dispatch({ id: '1', name: 'echo', rawArguments: '{"msg":"hi"}', ctx: baseCtx });
  assert.equal(r.ok, true);
  assert.equal(r.output, 'echoed');
  assert.equal(ctx.asks.length, 0, '低风险 execute 不应弹确认');
});
