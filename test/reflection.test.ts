/**
 * S5.3 测试：ReflectionReviewer 递进判定（隔离 LLM，注入 mock assessor）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ReflectionReviewer,
  computeDeeperThanPrior,
  type RawReflection,
  type ReflectionAssessor,
} from '../src/review/reflection.ts';
import type { ReflectionState, ReviewReport } from '../src/review/types.ts';

const initial: ReflectionState = { round: 0, priorThemes: [], priorDepth: 0, priorGaps: [] };

test('S5.3 computeDeeperThanPrior 纯函数', () => {
  // 首轮 depth 3、有新主题 → 更深
  assert.equal(computeDeeperThanPrior(3, ['a'], initial), true);
  // depth 未超过 priorDepth → 不更深
  assert.equal(computeDeeperThanPrior(2, ['a'], { round: 1, priorThemes: [], priorDepth: 2, priorGaps: [] }), false);
  // depth 更深但主题全是旧主题子集 → 不更深
  assert.equal(computeDeeperThanPrior(3, ['a'], { round: 1, priorThemes: ['a'], priorDepth: 1, priorGaps: [] }), false);
  // depth 更深且有新主题 → 更深
  assert.equal(computeDeeperThanPrior(3, ['a', 'b'], { round: 1, priorThemes: ['a'], priorDepth: 1, priorGaps: [] }), true);
});

function fakeAssessor(raw: RawReflection): ReflectionAssessor {
  return { async assess() { return raw; } };
}

test('S5.3 首轮：质量可接受 + 深度递进 → passed & deeper', async () => {
  const r = new ReflectionReviewer(
    fakeAssessor({ passed: true, depthScore: 4, newThemes: ['根因'], gaps: [], feedback: 'ok' }),
  );
  const rep: ReviewReport = await r.review({ content: 'x', priorState: initial });
  assert.equal(rep.passed, true);
  assert.equal(rep.deeperThanPrior, true);
  assert.equal(rep.depthScore, 4);
});

test('S5.3 次轮：深度未超过 priorDepth → 不更深（即便质量可接受）', async () => {
  const r = new ReflectionReviewer(
    fakeAssessor({ passed: true, depthScore: 4, newThemes: ['根因'], gaps: [], feedback: 'same' }),
  );
  const rep = await r.review({
    content: 'x',
    priorState: { round: 1, priorThemes: [], priorDepth: 4, priorGaps: [] },
  });
  assert.equal(rep.passed, true);
  assert.equal(rep.deeperThanPrior, false, 'depth 4 未 > prior 4');
});

test('S5.3 质量不可接受 → passed=false（深度再深也不放行）', async () => {
  const r = new ReflectionReviewer(
    fakeAssessor({ passed: false, depthScore: 5, newThemes: ['根因'], gaps: [], feedback: '半成品' }),
  );
  const rep = await r.review({ content: 'x', priorState: initial });
  assert.equal(rep.passed, false);
});
