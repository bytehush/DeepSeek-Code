/**
 * bug-check4：marker 感知切片的 ink 无头渲染实证（v2：走 MarkdownMessage 真实链路）。
 * 验证不变量：splitTextToLines 声明的行数 == ink 实际渲染行数（含 **bold** marker）。
 */
import { render } from 'ink-testing-library';
import React from 'react';
import { Box, Text } from 'ink';
import { splitTextToLines, displayWidth, maskMarkdownMarkers } from '../src/app/markdown-lines.ts';
import { MarkdownMessage } from '../src/cli/Markdown.tsx';

/** 走真实链路：MarkdownMessage 渲染（assistant 自带 "Agent> " 前缀 7 列）+ 消息列宽 innerW */
function renderReal(text: string, innerW: number): string[] {
  const { lastFrame } = render(
    <Box width={innerW} flexDirection="column">
      <MarkdownMessage text={text} role="assistant" phase="final" />
    </Box>,
  );
  const frame = lastFrame() ?? '';
  const clean = frame.replace(/\u001b\[[0-9;]*m/g, '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  // 忽略尾行（可能为空）
  return clean.split('\n').filter((l) => l.trim().length > 0);
}

function check(text: string, innerW: number, prefixW = 7): void {
  const declared = splitTextToLines(text, innerW, prefixW).length;
  const real = renderReal(text, innerW).length;
  const marker = /[*`~]/.test(text) ? '[marker]' : '[plain ]';
  const status = declared === real ? 'OK ' : 'FAIL';
  console.log(
    `${status} ${marker} innerW=${innerW} prefix=${prefixW} declared=${declared} real=${real} :: ${JSON.stringify(text.slice(0, 36))}`,
  );
  if (declared !== real) process.exitCode = 1;
}

console.log('=== 修复后：marker 文本声明行数 == 真实渲染行数（MarkdownMessage 链路）===');
check('一个直连 DeepSeek 官方 API 的中文编程 Agent，它把 **DeepSeek** 当作一等公民来设计 Harness', 30);
check('**加粗** 后面跟普通文本一直写写写写写写写写', 10);
check('x **bold** y **italic** z `code` w', 8);
check('**abcd** **efgh**', 8);
check('—**双模型路由**:主循环用 `deepseek-v4-flash`（非思考模式）', 24);
check('审查 / 审计 / 术语 / 项目发现 / 提交信息 / 深度生成 / 校验等复杂分析统一走推理模型 ~~pro~~。', 24);
check('这是一个没有标记的普通中文文本，用来验证纯文本折行不回归。', 12);
check('a**b**c**d**e**f**g**h**i**j**k**l**m**n**o**p**q**r**s**t**u**v**w**x**y**z**', 20);
check('**加粗**', 10);
check('**加粗**', 3);
check('`code` 与 **加粗** 混排，`另一个code` 结束。', 14);

console.log('');
console.log('=== 宽度对照（文档 §5.8 fixture）===');
console.log('displayWidth(**bold**) 原文 =', displayWidth('**bold**'), ' 掩码 =', displayWidth(maskMarkdownMarkers('**bold**')));
console.log('displayWidth(**加粗**) 原文 =', displayWidth('**加粗**'), ' 掩码 =', displayWidth(maskMarkdownMarkers('**加粗**')));

process.exit(process.exitCode ?? 0);
