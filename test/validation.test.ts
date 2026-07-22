/**
 * P1.3 validation.ts 单测：validateArgs（JSON Schema 轻量校验）+ extractArguments（容错解析）。
 * 不依赖网络/模型，纯函数可单测。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateArgs, extractArguments } from '../src/tools/validation.ts';

const objSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    n: { type: 'integer' },
    mode: { enum: ['a', 'b'] },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['path'],
} as const;

test('validateArgs: 通过', () => {
  const r = validateArgs({ path: '/a', n: 3, mode: 'a', tags: ['x'] }, objSchema);
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
});

test('validateArgs: 缺必填字段', () => {
  const r = validateArgs({ n: 3 }, objSchema);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /缺少必填字段/);
});

test('validateArgs: 类型错误', () => {
  const r = validateArgs({ path: '/a', n: 'x' }, objSchema);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /期望类型 integer/);
});

test('validateArgs: enum 越界', () => {
  assert.equal(validateArgs({ path: '/a', mode: 'c' }, objSchema).ok, false);
  assert.equal(validateArgs({ path: '/a', mode: 'b' }, objSchema).ok, true);
});

test('validateArgs: 数组元素类型', () => {
  const r = validateArgs({ path: '/a', tags: ['ok', 1] }, objSchema);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /tags\[1\]/);
});

test('extractArguments: 正常 JSON', () => {
  const r = extractArguments('{"x":1}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { x: 1 });
});

test('extractArguments: markdown 代码围栏', () => {
  const r = extractArguments('```json\n{"x":1}\n```');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { x: 1 });
});

test('extractArguments: 尾随逗号修复', () => {
  const r = extractArguments('{"x":1,}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { x: 1 });
});

test('extractArguments: 彻底失败返回 error（不静默降级）', () => {
  const r = extractArguments('not json at all {');
  assert.equal(r.ok, false);
  assert.ok(r.error && r.error.length > 0);
});

test('extractArguments: 空串视为无参对象', () => {
  const r = extractArguments('');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, {});
});

test('extractArguments: null/undefined 明确报错', () => {
  assert.equal(extractArguments(null).ok, false);
  assert.equal(extractArguments(undefined).ok, false);
});
