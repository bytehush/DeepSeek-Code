import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// 文件遍历工具（S1.2 从 index.ts 拆分）：路径穿越守卫 + glob 文件名遍历 + 正则内容搜索。

export function resolve(p: string, cwd: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
  const rel = path.relative(cwd, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `路径遍历拒绝：${p} 不在工作目录内（cwd=${cwd}）。` +
      '文件工具仅允许访问当前项目目录下的文件。',
    );
  }
  return abs;
}

export async function walkFiles(
  dir: string,
  pattern: string,
  results: string[],
  counter: { n: number },
): Promise<void> {
  if (counter.n > 200) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // 转换 glob 为正则：**/* 前缀剥离（递归搜索已处理路径），* → [^/]*, . → \.
  const cleanPattern = pattern.replace(/^\*\*\//, '').replace(/\//g, '\\/');
  const regex = new RegExp(
    '^' + cleanPattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '«DS»')
      .replace(/\*/g, '[^\\/]*')
      .replace(/«DS»/g, '.*')
      + '$', 'i',
  );
  for (const ent of entries) {
    if (counter.n > 200) break;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'build', '.dsa'].includes(ent.name)) continue;
      await walkFiles(full, pattern, results, counter);
    } else if (regex.test(ent.name)) {
      results.push(full);
      counter.n++;
    }
  }
}

export async function walkAndSearch(
  dir: string,
  re: RegExp,
  glob: string,
  results: string[],
  counter: { n: number },
): Promise<void> {
  if (counter.n > 200) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (counter.n > 200) break;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'dist' || ent.name === 'build') continue;
      await walkAndSearch(full, re, glob, results, counter);
    } else {
      if (glob !== '*') {
        // 支持形如 "*.ts" 的后缀匹配（只取 * 之后的部分，避免 "hosts" 误匹配 "*.ts"），
        // 也支持无通配的精确文件名匹配（如 "Makefile"）。
        const suffix = glob.startsWith('*') ? glob.slice(1) : null;
        const matched = suffix !== null ? ent.name.endsWith(suffix) : ent.name === glob;
        if (!matched) continue;
      }
      try {
        const content = await readFile(full, 'utf8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && counter.n < 200; i++) {
          if (re.test(lines[i])) {
            results.push(`${full}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            counter.n++;
          }
        }
      } catch {
        /* 跳过二进制/不可读文件 */
      }
    }
  }
}
