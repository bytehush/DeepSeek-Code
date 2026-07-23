/**
 * appendStreaming 最终答案首块延迟（P2-B）契约测试
 *
 * 复刻 agent-host.ts 中 appendStreaming 的 final 路径缓冲算法（避免直接 import
 * 重型 AgentHost / chat.ts 内核依赖），锁定以下不变量：
 *  1. 首个 chunk 创建「空气泡」（message, text=''）并立即 emit，同时进入 finalFirstPending。
 *  2. finalFirstPending 窗口内到达的 chunk 全部缓冲（不同步 emit update），保留自然顺序。
 *  3. 90ms 后定时器一次性 flush 缓冲文本（单条 update），并清除 finalFirstPending。
 *  4. 之后到达的 chunk 直接同步 emit update（不再延迟），保持流式流畅。
 *  5. 新轮 startThinkingTurn / abort 使残留定时器失效（代际 epoch 守卫），旧缓冲不污染新气泡。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const FIRST_CHUNK_DELAY = 90;

interface FakeHost {
  finalBubbleId: number | null;
  finalBuffer: string | null;
  finalFirstPending: boolean;
  finalFlushScheduled: boolean;
  finalEpoch: number;
  msgId: number;
  events: Array<{ type: string; payload: unknown }>;
  appendStreaming(chunk: string): void;
  startTurn(): void;
  appendTo(id: number, text: string): void;
}

function makeHost(): FakeHost {
  const h: FakeHost = {
    finalBubbleId: null,
    finalBuffer: null,
    finalFirstPending: false,
    finalFlushScheduled: false,
    finalEpoch: 0,
    msgId: 0,
    events: [],
    appendTo(id: number, text: string) {
      // 复刻 appendTo：找到气泡、累加、emit update
      const m = h.events.find((e) => e.type === 'message' && (e.payload as any).id === id);
      if (m) (m.payload as any).text += text;
      h.events.push({ type: 'update', payload: { id, text: (m?.payload as any)?.text ?? '' } });
    },
    startTurn() {
      h.finalBubbleId = null;
      h.finalBuffer = null;
      h.finalFirstPending = false;
      h.finalFlushScheduled = false;
      h.finalEpoch += 1;
    },
    appendStreaming(chunk: string) {
      if (h.finalBubbleId === null) {
        h.finalBubbleId = ++h.msgId;
        const m = { id: h.finalBubbleId, role: 'assistant', text: '' };
        h.events.push({ type: 'message', payload: m });
        h.finalFirstPending = true;
      }
      if (h.finalFirstPending) {
        h.finalBuffer = (h.finalBuffer ?? '') + chunk;
        if (!h.finalFlushScheduled) {
          h.finalFlushScheduled = true;
          const epoch = h.finalEpoch;
          setTimeout(() => {
            if (h.finalEpoch !== epoch) return; // 已进入新轮 → 丢弃残留 flush
            if (h.finalBubbleId !== null && h.finalBuffer !== null) {
              h.appendTo(h.finalBubbleId, h.finalBuffer);
            }
            h.finalBuffer = null;
            h.finalFlushScheduled = false;
            h.finalFirstPending = false;
          }, FIRST_CHUNK_DELAY);
        }
      } else {
        h.appendTo(h.finalBubbleId!, chunk);
      }
    },
  };
  return h;
}

test('首个 chunk 立即创建空气泡且进入 pending（不同步 emit update）', () => {
  const h = makeHost();
  h.appendStreaming('你好');
  const msg = h.events.find((e) => e.type === 'message');
  assert.ok(msg, '应 emit 空气泡 message');
  assert.strictEqual((msg!.payload as any).text, '', '空气泡文本为空');
  assert.strictEqual(h.events.filter((e) => e.type === 'update').length, 0, '首块延迟窗口内不应同步 emit update');
  assert.strictEqual(h.finalFirstPending, true);
});

test('延迟窗口内的多块被缓冲，90ms 后一次性 flush（顺序保留）', async () => {
  const h = makeHost();
  h.appendStreaming('你');
  h.appendStreaming('好');
  h.appendStreaming('世界');
  assert.strictEqual(h.events.filter((e) => e.type === 'update').length, 0, '窗口内无同步 update');
  await new Promise((r) => setTimeout(r, FIRST_CHUNK_DELAY + 30));
  const updates = h.events.filter((e) => e.type === 'update');
  assert.strictEqual(updates.length, 1, '应恰好一次 flush');
  assert.strictEqual((updates[0].payload as any).text, '你好世界', '缓冲文本顺序正确');
  assert.strictEqual(h.finalFirstPending, false, 'flush 后退出 pending');
});

test('延迟窗口后到达的 chunk 直接同步 emit update', async () => {
  const h = makeHost();
  h.appendStreaming('A');
  await new Promise((r) => setTimeout(r, FIRST_CHUNK_DELAY + 20));
  h.appendStreaming('B');
  const updates = h.events.filter((e) => e.type === 'update');
  assert.strictEqual(updates.length, 2, '首块 flush 一次 + 后续直发一次');
  assert.strictEqual((updates[1].payload as any).text, 'AB', '后续块与首块拼接正确');
});

test('新轮 startTurn 使残留定时器失效，旧缓冲不污染新气泡', async () => {
  const h = makeHost();
  h.appendStreaming('OLD');
  // 立即开新轮（模拟下一轮对话开始）
  h.startTurn();
  await new Promise((r) => setTimeout(r, FIRST_CHUNK_DELAY + 30));
  // 残留定时器应被 epoch 守卫丢弃：不应有任何 update 携带 OLD
  const updates = h.events.filter((e) => e.type === 'update');
  assert.strictEqual(updates.length, 0, '旧轮残留缓冲应被丢弃，不污染新轮');
});
