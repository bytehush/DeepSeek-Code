/**
 * thinkingCard-render 渲染测试：在 Node 里用 renderToStaticMarkup 真正把「思考盒」组件跑起来，
 * 验证 thinkings 数据是否真的被渲染成可见的思考盒 HTML。
 *
 * 这是之前所有 e2e 一直缺的那一层——e2e 只验证「WS 协议里有没有 thinkings 数据」，
 * 从没验证「前端 React 有没有把盒子画出来」。用户在本机看到的「丢失」发生在浏览器渲染层，
 * 本测试在沙箱里一锤定音：组件逻辑对不对。
 *
 * 不需要浏览器/jsdom：ThinkingCard 自包含（无 css / 无 react-markdown / 无 window 依赖）；
 * useTypewriter 在历史/已完成条目直接 return text，同步渲染即得完整文字。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThinkingCard } from '../src/gui/web/ThinkingCard.tsx';
import type { ThinkingTurn, ThinkingEntry } from '../src/gui/web/App.tsx';

function turn(turnId: number, status: ThinkingTurn['status'], entries: ThinkingEntry[]): ThinkingTurn {
  return { turnId, status, collapsed: false, entries };
}

test('done 孤儿轮 → 渲染出思考盒 + 思考文字（历史恢复场景）', () => {
  const t = turn(1, 'done', [{ id: 1, kind: 'reason', text: '闭包 = 函数 + 词法环境', status: 'done' }]);
  const html = renderToStaticMarkup(<ThinkingCard turn={t} onToggle={() => {}} />);
  assert.match(html, /思考过程/, '应出现「思考过程」标题');
  assert.match(html, /闭包 = 函数 \+ 词法环境/, '应出现思考文字');
  assert.match(html, /thinking-card/, '应携带 thinking-card 类名（即盒子本体）');
});

test('interrupted 孤儿轮 → 渲染出「生成中断」徽章', () => {
  const t = turn(2, 'interrupted', [{ id: 1, kind: 'reason', text: '中断前的推理', status: 'done' }]);
  const html = renderToStaticMarkup(<ThinkingCard turn={t} onToggle={() => {}} />);
  assert.match(html, /生成中断/, '应出现「生成中断」');
  assert.match(html, /中断前的推理/, '应出现思考文字');
});

test('思考中轮 → 渲染出「思考中…」且含流式文字', () => {
  const t = turn(3, 'thinking', [{ id: 1, kind: 'reason', text: '正在推导', status: 'streaming' }]);
  const html = renderToStaticMarkup(<ThinkingCard turn={t} onToggle={() => {}} />);
  assert.match(html, /思考中/, '应出现「思考中」');
  assert.match(html, /正在推导/, '流式条目在同步渲染初值也应可见');
});

test('工具类观察条目 → 渲染出工具名与结果', () => {
  const t = turn(4, 'done', [
    { id: 1, kind: 'tool', title: 'read_file', text: 'path/to/a.ts', status: 'done' },
    { id: 2, kind: 'tool_result', text: '文件内容…', status: 'done' },
  ]);
  const html = renderToStaticMarkup(<ThinkingCard turn={t} onToggle={() => {}} />);
  assert.match(html, /read_file/, '应出现工具名');
  assert.match(html, /文件内容/, '应出现工具结果');
});
