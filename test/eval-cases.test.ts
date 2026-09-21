import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CASES } from '../eval/cases.ts';
import { createCoreTools } from '../src/core/tools/atomic.ts';

const VALID_TIERS = new Set(['code', 'llm', 'human']);

/** 评测集只允许断言真实注册的工具——幽灵工具曾是旧版最大的谎，此处结构性封堵 */
const REAL_TOOLS = new Set(createCoreTools().map((t) => t.name));

test('评测集: 共 22 个黄金 case', () => {
  assert.equal(CASES.length, 22, `期望 22 个 case，实际 ${CASES.length}`);
});

test('评测集: 每个 case 结构合法', () => {
  const ids = new Set<string>();
  for (const c of CASES) {
    assert.ok(c.id, 'case 缺少 id');
    assert.ok(!ids.has(c.id), `case id 重复: ${c.id}`);
    ids.add(c.id);
    assert.ok(c.title, `case ${c.id} 缺少 title`);
    assert.ok(c.category, `case ${c.id} 缺少 category`);
    assert.ok(VALID_TIERS.has(c.tier), `case ${c.id} 档位非法: ${c.tier}`);
    assert.ok(Array.isArray(c.turns) && c.turns.length > 0, `case ${c.id} turns 非法`);
    // code 档必须有确定性断言
    if (c.tier === 'code') {
      assert.equal(typeof c.check, 'function', `code 档 case ${c.id} 缺少 check()`);
    }
    if (c.tier === 'llm') {
      assert.ok(c.rubric && c.rubric.length > 0, `llm 档 case ${c.id} 缺少 rubric`);
    }
  }
});

test('评测集: check() 源码只引用注册表内真实工具名', () => {
  const ghost = /create_file|run_command|search_code|delete_file|review_code|audit_dependencies|project_discover|terminology|delegate|use_skill/;
  for (const c of CASES) {
    if (!c.check) continue;
    const src = c.check.toString();
    assert.ok(!ghost.test(src), `case ${c.id} 的 check() 引用了已删除的幽灵工具`);
    for (const m of src.matchAll(/hasTool\(\s*'([a-z_]+)'/g)) {
      assert.ok(REAL_TOOLS.has(m[1]!), `case ${c.id} 断言了不存在的工具: ${m[1]}`);
    }
    for (const m of src.matchAll(/name === '([a-z_]+)'/g)) {
      assert.ok(REAL_TOOLS.has(m[1]!), `case ${c.id} 断言了不存在的工具: ${m[1]}`);
    }
  }
});
