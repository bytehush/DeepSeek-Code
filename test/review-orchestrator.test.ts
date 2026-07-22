/**
 * S5.1 测试：ReviewOrchestrator 调度顺序（Format → Reflection）+ 递进闭环。
 * 用 mock Reviewer 隔离，不依赖真实 LLM / zod。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewOrchestrator } from '../src/review/orchestrator.ts';
import type { Reviewer, ReviewReport } from '../src/review/types.ts';

function makeFormat(pass: boolean, feedback = ''): Reviewer {
  return {
    name: 'mock-format',
    async review(): Promise<ReviewReport> {
      return { passed: pass, depthScore: 0, newThemes: [], deeperThanPrior: false, gaps: [], feedback };
    },
  };
}

function makeReflection(opts: {
  deeper: boolean;
  depth: number;
  feedback?: string;
  themes?: string[];
  gaps?: string[];
}): Reviewer {
  return {
    name: 'mock-reflection',
    async review(): Promise<ReviewReport> {
      return {
        passed: true,
        depthScore: opts.depth,
        newThemes: opts.themes ?? ['t1'],
        deeperThanPrior: opts.deeper,
        gaps: opts.gaps ?? [],
        feedback: opts.feedback ?? 'dig deeper',
      };
    },
  };
}

/** 第一次不递进(深2)，第二次递进(深4>2)。 */
function makeProgressiveReflection(): Reviewer {
  let calls = 0;
  return {
    name: 'prog-reflection',
    async review(): Promise<ReviewReport> {
      calls += 1;
      if (calls === 1) {
        return { passed: true, depthScore: 2, newThemes: ['shallow'], deeperThanPrior: false, gaps: ['gap'], feedback: 'v1' };
      }
      return { passed: true, depthScore: 4, newThemes: ['deep'], deeperThanPrior: true, gaps: [], feedback: 'v2' };
    },
  };
}

test('S5.1 Format 不过 → 直接拦截，Reflection 不执行', async () => {
  const o = new ReviewOrchestrator({
    format: makeFormat(false, 'missing field x'),
    reflection: makeReflection({ deeper: true, depth: 5 }),
  });
  const v = await o.review('hello');
  assert.equal(v.released, false);
  assert.equal(v.format?.passed, false);
  assert.equal(v.reflection, undefined, 'Format 失败不应触发 Reflection');
  assert.equal(v.guidance, 'missing field x');
  assert.equal(o.round, 0, '未递进（被 Format 拦下）state 不应推进');
});

test('S5.1 Format 过 + Reflection 递进 → 放行', async () => {
  const o = new ReviewOrchestrator({
    format: makeFormat(true),
    reflection: makeReflection({ deeper: true, depth: 4 }),
  });
  const v = await o.review('answer');
  assert.equal(v.released, true);
  assert.equal(v.reflection?.deeperThanPrior, true);
  assert.equal(o.round, 0, '达标放行，state 不推进');
});

test('S5.1 Reflection 未递进 → 不放行 + state 推进', async () => {
  const o = new ReviewOrchestrator({
    format: makeFormat(true),
    reflection: makeReflection({ deeper: false, depth: 2 }),
  });
  const v = await o.review('shallow');
  assert.equal(v.released, false);
  assert.equal(o.round, 1);
  assert.equal(v.guidance, 'dig deeper');
  assert.equal(v.reasons.some((r) => r.includes('round 1/')), true);
});

test('S5.1 递进闭环：两轮共享 state，第二轮更深则放行', async () => {
  const o = new ReviewOrchestrator({
    format: makeFormat(true),
    reflection: makeProgressiveReflection(),
  });
  const v1 = await o.review('shallow');
  assert.equal(v1.released, false);
  assert.equal(o.round, 1);

  const v2 = await o.review('deep answer');
  assert.equal(v2.released, true, '第二轮比第一轮深(4>2)应放行');
  assert.equal(o.round, 1, '达标后不再推进');

  // reset 后回到初始态
  o.reset();
  assert.equal(o.round, 0);
});
