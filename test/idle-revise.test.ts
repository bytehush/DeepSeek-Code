/**
 * M10 idleRevise 测试：scheduleIdleRevise 构建块（事件循环空闲调度治理）。
 *
 * 锁定：
 * - 用注入 scheduler 时，调用方不被治理阻塞（调用即返回，revise 在调度后执行）。
 * - 默认 setImmediate 让出事件循环（先返回、后执行治理）。
 * - 治理失败安全降级为 null。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleIdleRevise, type IdleScheduler, type ReviseResult } from '../src/memory/revise.ts';
import type { MemoryService } from '../src/memory/service.ts';
import type { DeepSeekClient } from '../llm/deepseek.ts';

const fakeClient = {} as DeepSeekClient;
const okResult: ReviseResult = { deleted: 1, merged: 0, summary: 'cleaned', skipped: false };

test('scheduleIdleRevise 用注入 scheduler 延后调用 store.revise（不阻塞调用方）', async () => {
  let scheduledFn: (() => void) | null = null;
  const scheduler: IdleScheduler = (fn) => {
    scheduledFn = fn;
  };
  let reviseCalled = false;
  const store = {
    revise: async () => {
      reviseCalled = true;
      return okResult;
    },
  } as unknown as MemoryService;

  const p = scheduleIdleRevise(fakeClient, store, { scheduler });
  assert.equal(reviseCalled, false, '调用后应立刻返回，不阻塞（revise 尚未执行）');
  assert.ok(scheduledFn, 'scheduler 应被调用来安排延时任务');

  scheduledFn!();
  const res = await p;
  assert.equal(reviseCalled, true, '调度后应执行 revise');
  assert.equal(res, okResult);
});

test('scheduleIdleRevise 默认 setImmediate 让出事件循环（先返回、后执行）', async () => {
  const order: string[] = [];
  const store = {
    revise: async () => {
      order.push('revise');
      return okResult;
    },
  } as unknown as MemoryService;

  const p = scheduleIdleRevise(fakeClient, store);
  order.push('after-call');
  const res = await p;
  order.push('after-await');
  assert.deepEqual(order, ['after-call', 'revise', 'after-await'], '调用方不被治理阻塞');
  assert.equal(res, okResult);
});

test('scheduleIdleRevise 治理失败安全降级为 null', async () => {
  const store = {
    revise: async () => {
      throw new Error('boom');
    },
  } as unknown as MemoryService;
  let scheduledFn: (() => void) | null = null;
  const scheduler: IdleScheduler = (fn) => {
    scheduledFn = fn;
  };

  const p = scheduleIdleRevise(fakeClient, store, { scheduler });
  scheduledFn!();
  const res = await p;
  assert.equal(res, null, '失败应安全降级为 null');
});
