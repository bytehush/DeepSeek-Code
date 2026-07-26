import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initModelMode,
  getMode,
  setMode,
  parseMode,
  modeLabel,
  resolveModelConfig,
  type ModelMode,
} from '../src/agent/model-mode.ts';

function freshCwd(): string {
  const d = mkdtempSync(join(tmpdir(), 'dsa-mode-'));
  return d;
}

test('默认模式为 flash（文件缺失时回退）', () => {
  const cwd = freshCwd();
  assert.equal(initModelMode(cwd), 'flash');
  assert.equal(getMode(), 'flash');
  rmSync(cwd, { recursive: true, force: true });
});

test('setMode 持久化并影响 getMode', () => {
  const cwd = freshCwd();
  initModelMode(cwd);
  setMode(cwd, 'pro');
  assert.equal(getMode(), 'pro');
  // 文件落盘
  const fp = join(cwd, '.dsa', 'model-mode.json');
  assert.equal(existsSync(fp), true);
  assert.deepEqual(JSON.parse(readFileSync(fp, 'utf8')), { mode: 'pro' });
  // 重新加载仍生效
  assert.equal(initModelMode(cwd), 'pro');
  rmSync(cwd, { recursive: true, force: true });
});

test('parseMode 仅接受 flash / pro', () => {
  assert.equal(parseMode('flash'), 'flash');
  assert.equal(parseMode('PRO'), 'pro');
  assert.equal(parseMode('pro '), 'pro');
  assert.equal(parseMode('daily'), null);
  assert.equal(parseMode(''), null);
  assert.equal(parseMode('reasoner'), null);
});

test('modeLabel 中文展示名', () => {
  assert.equal(modeLabel('flash'), 'Flash（日常）');
  assert.equal(modeLabel('pro'), 'PRO（开发）');
});

test('resolveModelConfig: flash 不触发思考', () => {
  const r = resolveModelConfig('flash', { model: 'm-flash', reasonerModel: 'm-pro' });
  assert.equal(r.model, 'm-flash');
  assert.equal(r.reasoning, undefined);
});

test('resolveModelConfig: pro 触发思考并取推理模型', () => {
  const r = resolveModelConfig('pro', { model: 'm-flash', reasonerModel: 'm-pro' });
  assert.equal(r.model, 'm-pro');
  assert.equal(r.reasoning, 'high');
});

test('resolveModelConfig: pro 缺 reasonerModel 回退默认', () => {
  const r = resolveModelConfig('pro', { model: 'm-flash' });
  assert.equal(r.model, 'deepseek-v4-pro');
  assert.equal(r.reasoning, 'high');
});

test('类型守卫：ModelMode 仅有两值', () => {
  const modes: ModelMode[] = ['flash', 'pro'];
  assert.equal(modes.length, 2);
});
