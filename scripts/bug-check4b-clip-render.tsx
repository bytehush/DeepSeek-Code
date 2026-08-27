/**
 * bug-check4b：clipMessageRows 切片 → MarkdownMessage 渲染的行数一致性（核心 DoD）。
 * 对含大量 **marker** 的长文本，任意 [visStart, visEnd) 切片后：
 *   声明行数（clipMessageRows 的 text 经 splitTextToLines 的行数）== 真实渲染行数
 * 且渲染结果不含孤儿 `**`。
 * 真实宽度 innerW=115 为主场景，另测 innerW=60/40 中宽。
 */
import { render } from 'ink-testing-library';
import React from 'react';
import { Box } from 'ink';
import { MarkdownMessage } from '../src/cli/Markdown.tsx';
import { splitTextToLines, clipMessageRows } from '../src/app/markdown-lines.ts';

function renderReal(text: string, innerW: number): string[] {
  const { lastFrame } = render(
    <Box width={innerW} flexDirection="column">
      <MarkdownMessage text={text} role="assistant" phase="final" />
    </Box>,
  );
  const frame = lastFrame() ?? '';
  const clean = frame.replace(/\u001b\[[0-9;]*m/g, '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  return clean.split('\n').filter((l) => l.trim().length > 0);
}

/** 断言渲染结果不含孤儿 marker（** * ` ~ 都应是成对的） */
function assertNoOrphan(text: string): void {
  const re = /(\*\*[\s\S]+?\*\*|\*[\s\S]+?\*|`[^`]+`|~~[\s\S]+?~~)/g;
  const stripped = text.replace(re, '');
  const orphans = [...stripped].filter((ch) => ch === '*' || ch === '`' || ch === '~');
  if (orphans.length > 0) {
    console.log('  !! 孤儿 marker:', JSON.stringify(orphans), 'in', JSON.stringify(text.slice(0, 60)));
  }
}

const text =
  '一个直连 DeepSeek 官方 API 的中文编程 Agent，它把 **DeepSeek** 当作一等公民来设计 Harness，' +
  '提供代码阅读、编辑、运行、审查、依赖审计、Git 集成等能力，并同时提供 **MCP 工具**。' +
  '—**双模型路由**:主循环用 `deepseek-v4-flash`（非思考模式，负责工具调度，快、省）；' +
  '审查 / 审计 / 术语 / 项目发现 / 提交信息 / 深度生成 / 校验等复杂分析统一走推理模型 ~~pro~~。' +
  '项目发现工具可以生成项目图谱，用它来分析项目结构更高效。' +
  '还有 **加粗**、*斜体*、`行内代码`、~~删除线~~ 混排，验证多类型 marker 共存。';

let total = 0;
let fail = 0;
for (const innerW of [115, 60, 40]) {
  const prefixW = 7;
  const rows = splitTextToLines(text, innerW, prefixW);
  const full = renderReal(text, innerW).length;
  const statusFull = full === rows.length ? 'OK' : 'FAIL';
  if (full !== rows.length) fail++;
  console.log(`innerW=${innerW} 全文: declared=${rows.length} real=${full} ${statusFull}`);
  total++;

  // 采样所有切片起点 × 3 种长度
  let sliceFail = 0;
  let sliceCount = 0;
  for (let s = 0; s < rows.length; s += Math.max(1, Math.floor(rows.length / 8))) {
    for (const len of [2, 4, 8]) {
      const e = Math.min(rows.length, s + len);
      if (e <= s) continue;
      sliceCount++;
      const { text: sliced } = clipMessageRows(text, innerW, prefixW, s, e);
      if (sliced.length === 0) continue;
      const declared = splitTextToLines(sliced, innerW, prefixW).length;
      const real = renderReal(sliced, innerW).length;
      assertNoOrphan(sliced);
      if (declared !== real) {
        sliceFail++;
        if (sliceFail <= 3) {
          console.log(`  !! slice [${s},${e}) declared=${declared} real=${real} :: ${JSON.stringify(sliced.slice(0, 50))}`);
        }
      }
    }
  }
  console.log(`  slices: ${sliceCount} 个切片, 不一致 ${sliceFail}`);
  total += sliceCount;
  fail += sliceFail;
}

console.log(`\nTOTAL=${total} FAIL=${fail}`);
process.exit(fail > 0 ? 1 : 0);
