/**
 * UI 源码 Ambiguous 字符扫描测试。
 *
 * 背景（docs/Bug修复-Windows中文终端Ambiguous字符宽度错位.md）：
 * Windows 中文 conhost 把 EAW=Ambiguous 的字符（`█` `╍` `•` `…` `↑` `●` `·`、
 * box-drawing、geometric shapes 等）按 2 列渲染，而 string-width 默认按 1 列
 * （ambiguousIsNarrow: true）——估算层与渲染层分歧 → 布局错位 → 右侧散布伪影。
 * 修复策略：UI 自绘字符全部改用「明确 1 列」的 ASCII / EAW=N / 背景色空格。
 *
 * 本测试扫描 UI 源码的字符串字面量，断言不含 Ambiguous 字符——防止未来有人
 * 把 `-` 换回 `─`、把 `*` 换回 `•` 等回归（这类 bug 在沙箱 Linux 测不出来，
 * 只有 Windows 中文终端可见）。
 *
 * 排除项：
 * - 注释（`//` 行内注释 / `/* ... *​/` 块注释）
 * - whaleArt.ts（`█` 是 art 数据源，app.tsx WhaleMascot 消费时已转为背景色空格）
 * - 中文文本（明确 2 列，string-width 与 Windows 渲染一致，不冲突）
 * - RGI emoji（明确 2 列，一致，不冲突）
 */
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// UI 文件（whaleArt.ts 除外——数据源，消费端已转换）
const FILES = [
  'src/cli/app.tsx',
  'src/cli/login.tsx',
  'src/cli/Markdown.tsx',
  'src/cli/thinkingIndicator.tsx',
  'src/cli/sanitize.ts',
  'src/app/markdown-lines.ts',
  'src/app/timeline.ts',
];

// EAW=Ambiguous 的 UI 常用字符（覆盖 UI 装饰/符号范围；非完整 EAW=A 表）
const AMBIGUOUS_RE =
  /[\u00B7\u2014\u2022\u2026\u203A\u2190-\u21FF\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2B00-\u2BFF]/;

test('UI 源码字符串字面量不含 EAW=Ambiguous 字符（Windows 中文终端宽度稳定）', () => {
  const violations: string[] = [];
  for (const f of FILES) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf-8');
    // 先整体剥离块注释（跨行），再逐行剥离行注释
    const withoutBlocks = src.replace(/\/\*[\s\S]*?\*\//g, '');
    const lines = withoutBlocks.split('\n');
    lines.forEach((line, idx) => {
      // 注意：CRLF 文件的 `\r` 是行终止符，`.`/`$` 锚定会失效——
      // 用 `[^\r\n]*` 匹配 `//` 之后到行尾的所有字符（不依赖 `$`）
      const code = line.replace(/\/\/[^\r\n]*/, '');
      // 只查字符串字面量内的字符：粗略用「行内 Ambiguous 字符在引号内」过滤，
      // 简单起见直接查剥离注释后的整行（正则/颜色码等不含这些字符，误报率低）
      const m = code.match(AMBIGUOUS_RE);
      if (m) {
        const ch = m[0];
        violations.push(
          `${f}:${idx + 1}: ${JSON.stringify(ch)} (U+${ch.codePointAt(0)!.toString(16).toUpperCase()}) in: ${line.trim().slice(0, 70)}`,
        );
      }
    });
  }
  assert.deepEqual(
    violations,
    [],
    'UI 源码不应含 Ambiguous 字符（Windows 中文终端按 2 列渲染 → 布局错位）:\n' +
      violations.join('\n'),
  );
});

test('已知 UI 装饰字符宽度 = 字符数（全 1 列，供回归对比）', async () => {
  const { default: stringWidth } = await import('string-width');
  const uiChars = ['-', '|', '+', '*', '^', 'v', '.', '=', ' '];
  for (const ch of uiChars) {
    assert.equal(stringWidth(ch), 1, `${JSON.stringify(ch)} 应占 1 列`);
  }
});
