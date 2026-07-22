/**
 * S5.2 测试：FormatValidator 确定性格式校验（复用 zod）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { FormatValidator } from '../src/review/format-validator.ts';
import type { ReviewInput } from '../src/review/types.ts';

function input(content: string): ReviewInput {
  return { content, priorState: { round: 0, priorThemes: [], priorDepth: 0, priorGaps: [] } };
}

test('S5.2 无 schema：正常内容通过', async () => {
  const v = new FormatValidator();
  const r = await v.review(input('这是一段完整的最终答复。'));
  assert.equal(r.passed, true);
  assert.equal(r.feedback, '格式合规');
});

test('S5.2 无 schema：空内容不过', async () => {
  const v = new FormatValidator();
  const r = await v.review(input('   '));
  assert.equal(r.passed, false);
  assert.match(r.feedback, /内容过短/);
});

test('S5.2 无 schema：命中截断标记不过', async () => {
  const v = new FormatValidator();
  const r = await v.review(input('部分结论...(truncated)后续待补'));
  assert.equal(r.passed, false);
  assert.match(r.feedback, /截断/);
});

test('S5.2 有 schema：合法 JSON 通过', async () => {
  const schema = z.object({ pass: z.boolean(), risk: z.enum(['none', 'low', 'high']) });
  const v = new FormatValidator({ schema });
  const r = await v.review(input('{"pass":true,"risk":"low"}'));
  assert.equal(r.passed, true);
});

test('S5.2 有 schema：缺字段 + 类型错不过，并给出精确定位', async () => {
  const schema = z.object({ pass: z.boolean(), risk: z.enum(['none', 'low', 'high']) });
  const v = new FormatValidator({ schema });
  const r = await v.review(input('{"pass":"yes"}'));
  assert.equal(r.passed, false);
  assert.match(r.feedback, /pass/); // 类型错误定位到字段
  assert.match(r.feedback, /risk/); // 必填缺失定位到字段
});

test('S5.2 有 schema：非 JSON 文本不过', async () => {
  const schema = z.object({ pass: z.boolean() });
  const v = new FormatValidator({ schema });
  const r = await v.review(input('好吧，我认为是通过的。'));
  assert.equal(r.passed, false);
  assert.match(r.feedback, /JSON/);
});
