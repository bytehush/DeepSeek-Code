/**
 * SSE 解析器边界测试（自研内核的头号风险点——Pi 原本代偿了这层）。
 *
 * 逐条对应 src/core/provider/sse.ts 文件头列出的边界情形：
 * 分片事件 / 多字节截断 / CRLF / 一帧多事件 / [DONE] / 残帧 flush。
 * 以及 chunk 载荷解析（delta、reasoning_content、tool_calls 分片拼接、usage）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SseParser, ToolCallAccumulator, isDoneFrame, parseChunkDelta } from '../src/core/provider/sse.ts';

const enc = new TextEncoder();

function feedAll(pieces: string[]): string[] {
  const p = new SseParser();
  const out: string[] = [];
  for (const piece of pieces) for (const f of p.feed(enc.encode(piece))) out.push(f);
  for (const f of p.flush()) out.push(f);
  return out;
}

test('完整事件：单块多帧', () => {
  const frames = feedAll(['data: {"a":1}\n\ndata: {"b":2}\n\n']);
  assert.deepEqual(frames, ['{"a":1}', '{"b":2}']);
});

test('事件被 TCP 分片切断（行中切、帧中切）', () => {
  const whole = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n';
  // 逐 3 字节喂入（不含多字节字符中间时，纯切 ASCII 边界也够狠）
  const pieces: string[] = [];
  for (let i = 0; i < whole.length; i += 3) pieces.push(whole.slice(i, i + 3));
  const frames = feedAll(pieces);
  assert.equal(frames.length, 1);
  assert.equal(JSON.parse(frames[0]!).choices[0].delta.content, '你好');
});

test('UTF-8 多字节字符被切断在字节中间', () => {
  const bytes = enc.encode('data: {"t":"中文测试"}\n\n');
  // '中' 的 UTF-8 首字节是 0xE4，在其第 2 字节处切断
  const cut = bytes.indexOf(0xe4) + 1;
  assert.ok(cut > 0 && bytes[cut]! >> 6 === 0b10); // 确认确实切在续字节上
  const a = bytes.slice(0, cut);
  const b = bytes.slice(cut);
  const p = new SseParser();
  const out: string[] = [];
  for (const f of p.feed(a)) out.push(f);
  for (const f of p.feed(b)) out.push(f);
  for (const f of p.flush()) out.push(f);
  assert.equal(out.length, 1);
  assert.equal(JSON.parse(out[0]!).t, '中文测试');
});

test('CRLF 行结束与注释行', () => {
  const frames = feedAll([': keep-alive\r\ndata: {"x":1}\r\n\r\n']);
  assert.deepEqual(frames, ['{"x":1}']);
});

test('流末尾无空行：flush 吐出残事件', () => {
  const frames = feedAll(['data: {"tail":true}']);
  assert.deepEqual(frames, ['{"tail":true}']);
});

test('data: 前缀无空格也接受（SSE 规范：单个前导空格才剥离）', () => {
  const frames = feedAll(['data:{"compact":1}\n\n']);
  assert.deepEqual(frames, ['{"compact":1}']);
});

test('[DONE] 帧判定', () => {
  assert.ok(isDoneFrame('[DONE]'));
  assert.ok(isDoneFrame(' [DONE] '));
  assert.ok(!isDoneFrame('{"choices":[]}'));
});

test('chunk 载荷：content / reasoning_content / usage / finish_reason', () => {
  const d = parseChunkDelta({
    choices: [{ delta: { content: 'hi', reasoning_content: 'thinking…' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 7, completion_tokens: 3 },
  });
  assert.equal(d.content, 'hi');
  assert.equal(d.reasoning, 'thinking…');
  assert.equal(d.finishReason, 'stop');
  assert.deepEqual(d.usage, { inputTokens: 7, outputTokens: 3 });
});

test('chunk 载荷：usage-only 帧（choices 缺失不炸）', () => {
  const d = parseChunkDelta({ usage: { prompt_tokens: 1, completion_tokens: 2 } });
  assert.equal(d.content, undefined);
  assert.deepEqual(d.usage, { inputTokens: 1, outputTokens: 2 });
});

test('工具调用分片拼接：id/name 首片、arguments 多片', () => {
  const acc = new ToolCallAccumulator();
  acc.add(parseChunkDelta({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'read_file', arguments: '{"pa' } }] } }] as never,
  }).toolCalls![0]!, 'fb');
  acc.add(parseChunkDelta({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } }] as never,
  }).toolCalls![0]!, 'fb');
  const calls = acc.done();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.id, 'call_9');
  assert.equal(calls[0]!.name, 'read_file');
  assert.deepEqual(calls[0]!.args, { path: 'a.ts' });
});

test('工具调用参数非法 JSON：__raw 回传而非崩溃', () => {
  const acc = new ToolCallAccumulator();
  acc.add({ index: 0, id: 'c1', name: 'bash', argsFragment: '{oops' }, 'fb');
  const calls = acc.done();
  assert.deepEqual(calls[0]!.args, { __raw: '{oops', __error: '工具参数不是合法 JSON' });
});

test('多工具并行分片按 index 分桶', () => {
  const acc = new ToolCallAccumulator();
  acc.add({ index: 1, id: 'b', name: 'write_file', argsFragment: '{"path":"b"}' }, 'fb');
  acc.add({ index: 0, id: 'a', name: 'read_file', argsFragment: '{"path":"a"}' }, 'fb');
  const calls = acc.done();
  assert.deepEqual(calls.map((c) => c.name), ['read_file', 'write_file']);
});
