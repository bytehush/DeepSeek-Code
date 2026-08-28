#!/usr/bin/env node
// 实测 displayWidth（src/app/markdown-lines.ts）vs string-width 库
// （ink 的 wrap-ansi 底层宽度判定 = string-width）的真实差距。
// 这是「为什么 sanitize 修了 box-drawing 但散布还在」的根因诊断。
// 修复后：displayWidth 已委托 string-width，本 spike 复测应 0 差异。

import stringWidth from 'string-width';
import { displayWidth } from '../src/app/markdown-lines.ts';

// 修复后 displayWidth === string-width，无需近似；直接对比真实库
const stringWidthApprox = (s) => stringWidth(s);

// 真实截图里出现过的字符样本 + agent 工具输出常见字符
const samples = [
  ['⏹ (停止)', '\u23F9'],
  ['💡 (提示)', '\u{1F4A1}'],
  ['🔐 (锁)', '\u{1F510}'],
  ['💬 (聊)', '\u{1F4AC}'],
  ['✅ (对勾)', '\u2705'],
  ['⏳ (沙漏)', '\u23F3'],
  ['📁 (文件夹)', '\u{1F4C1}'],
  ['⠋ (braille spinner)', '\u280B'],
  ['›', '\u203A'],
  ['—', '\u2014'],
  ['·', '\u00B7'],
  ['╍ (虚线)', '\u254D'],
  ['│ (box-drawing 已修)', '\u2502'],
  ['┌ (box-drawing 已修)', '\u250C'],
  ['> (普通)', '>'],
  ['中 (CJK)', '中'],
  ['x (ASCII)', 'x'],
  ['─ (box-drawing 已修)', '\u2500'],
  ['∙ (点)', '\u2219'],
  ['⭐ (星)', '\u2B50'],
];

console.log('字符 | displayWidth(ours) | stringWidthApprox(ink近似) | 一致?');
console.log('-----|-------------------|-----------------------------|------');
let diffCount = 0;
for (const [name, ch] of samples) {
  const ours = displayWidth(ch);
  const ink = stringWidthApprox(ch);
  const same = ours === ink;
  if (!same) diffCount++;
  console.log(`${name.padEnd(28)} | ${String(ours).padEnd(17)} | ${String(ink).padEnd(27)} | ${same ? 'OK' : '⚠️ DIFF'}`);
}
console.log(`\n差异数 = ${diffCount} / ${samples.length}`);

// 关键：把一条实际可能出现的 agent 消息文本塞进去，看整条 width 差异
const realMessages = [
  '⏹ 已发送中断信号，正在停止当前请求...',
  '💡 输入 /exit 可退出程序（Ctrl+C 不绑定退出）',
  'Agent 完成 ✓',
  '🟢 任务已成功',
  '你能看到 ⭐ 这个字符吗？',
];
console.log('\n真实消息样本的整条宽度差异：');
for (const m of realMessages) {
  const a = displayWidth(m);
  const b = stringWidthApprox(m);
  const delta = b - a;
  console.log(`  [delta=${delta.toString().padStart(3)}] ours=${a} ink=${b}  ${JSON.stringify(m)}`);
}

// 实测对真实 chat 内容（sliceArea=20, innerW=63）：估算行数 vs 实际行数
console.log('\n=== 关键场景：assistant 长回复含 emoji ===');
const longText = '好的，我来执行你的命令。这是一个包含 emoji 的回复，比如 ⏹ 已发送、💡 提示、✅ 完成、⏳ 等待、📁 文件、⭐ 重要等。我们继续吧。先创建目录: 好的';
console.log('消息:', longText);
console.log('估算行数 (ours, innerW=63):', Math.ceil(displayWidth(longText) / 63));
console.log('估算行数 (ink近似, innerW=63):', Math.ceil(stringWidthApprox(longText) / 63));
