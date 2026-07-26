import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { VERIFY_CODE_JSON_SCHEMA } from '../src/tools/code-verify.ts';
import { REVIEW_JSON_SCHEMA } from '../src/tools/review.ts';
import { AUDIT_JSON_SCHEMA } from '../src/tools/audit.ts';
import { VERIFY_ANSWER_JSON_SCHEMA } from '../src/tools/verify-answer.ts';

// 未导出（const 而非 export）的 3 个 strict schema 源文件，用文本扫描防回归
const UNEXPORTED_SCHEMA_FILES = [
  '../src/tools/discovery.ts',
  '../src/tools/verify-task.ts',
  '../src/review/reflection.ts',
];

/**
 * 递归遍历 strict json_schema，断言：
 * 1) `type` 字段不能是数组（strict 模式仅支持单一 type 字符串；
 *    原 bug `type: ['number', 'null']` 正是数组型 + 直接 null，API 会 400 或静默忽略）；
 * 2) 字段级 `type` 不能是裸 'null'（可空必须用 anyOf 分支表达）；
 *    但 `anyOf` / `oneOf` 分支内部的 `type: 'null'` 是合法写法，需放行。
 */
const SKIP_KEYS = new Set(['enum', 'anyOf', 'oneOf']);

function assertNoArrayType(node: unknown, path: string, insideAnyOf = false): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) assertNoArrayType(node[i], `${path}[${i}]`, insideAnyOf);
    return;
  }
  const obj = node as Record<string, unknown>;

  // anyOf / oneOf 分支内部允许 type:'null'，但分支里的 type 仍不能是数组
  if ('anyOf' in obj || 'oneOf' in obj) {
    const branches = (obj.anyOf ?? obj.oneOf) as unknown[];
    if (Array.isArray(branches)) {
      branches.forEach((b, i) => assertNoArrayType(b, `${path}.branch[${i}]`, true));
    }
    for (const [k, v] of Object.entries(obj)) {
      if (SKIP_KEYS.has(k)) continue;
      assertNoArrayType(v, `${path}.${k}`, false);
    }
    return;
  }

  if ('type' in obj && obj.type !== undefined) {
    const t = obj.type;
    assert.equal(
      Array.isArray(t),
      false,
      `strict schema 字段 ${path}.type 不能是数组（实为 ${JSON.stringify(t)}）——strict 模式仅支持单一 type 字符串，可空请用 anyOf`,
    );
    if (!insideAnyOf) {
      assert.notEqual(
        t,
        'null',
        `strict schema 字段 ${path}.type 不能直接为 'null'，必须用 anyOf 表达可空`,
      );
    }
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'enum') continue; // enum 是合法数组，跳过
    assertNoArrayType(v, `${path}.${k}`, false);
  }
}

test('导出的 strict json_schema 不允许 type 为数组或裸 null', () => {
  const cases = [
    ['VERIFY_CODE', VERIFY_CODE_JSON_SCHEMA],
    ['REVIEW', REVIEW_JSON_SCHEMA],
    ['AUDIT', AUDIT_JSON_SCHEMA],
    ['VERIFY_ANSWER', VERIFY_ANSWER_JSON_SCHEMA],
  ] as const;
  for (const [name, schema] of cases) {
    assert.equal(schema.strict, true, `${name} 应为 strict 模式`);
    assertNoArrayType(schema.schema, name);
  }
});

test('未导出的 strict schema 源文件不得再出现 type:[...] 数组型', () => {
  const root = dirname(fileURLToPath(import.meta.url));
  for (const f of UNEXPORTED_SCHEMA_FILES) {
    const src = readFileSync(join(root, f), 'utf8');
    assert.equal(
      /type:\s*\[/.test(src),
      false,
      `${f} 不应包含数组型 type（如 type: ['number', 'null'] 等非法写法，应改用 anyOf）`,
    );
  }
});
