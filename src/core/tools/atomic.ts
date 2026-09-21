/**
 * 内核原子工具集（P0 六件）。
 *
 * 继承极简模式「工具少而原子」的取舍，并修正其两个缺陷：
 *   1. 旧 4 工具缺检索能力，导致模型只能 read_file 全仓盲扫——补 search_files / list_files
 *      （这正是旧 system prompt 里 search_code / search_files 幽灵工具的**正解**：
 *      不是把提示词删掉，而是把真实需要的能力做出来）。
 *   2. 所有写路径接入 rollback 快照（数据安全：可回滚），bash 支持 AbortSignal 终止。
 *
 * 失败即 throw：错误由 loop 作为 tool 结果回灌模型自我纠正，不静默跳过。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { isDestructive } from '../permission/engine.ts';
import { rollbackManager } from '../../utils/rollback.ts';
import { defineTool, type ToolContext, type ToolResult, type ToolSpec } from './registry.ts';
import { isWithin } from '../../config/workspace.ts';

/** 单文件读取上限（超出截断并提示，防止 5MB 日志炸上下文） */
const MAX_READ_BYTES = 512 * 1024;
/** 检索/列举默认返回上限 */
const MAX_SEARCH_HITS = 200;
/** bash 输出上限（超出保留头尾） */
const MAX_BASH_OUT = 64 * 1024;

function safePath(cwd: string, p: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/** 写路径校验：受保护目录（源码根）内一律拒绝；工作区外的绝对路径也要求显式确认前的边界提示 */
function safeWritePath(ctx: ToolContext, p: string): string {
  const full = safePath(ctx.cwd, p);
  for (const root of ctx.protectedRoots) {
    if (isWithin(full, root)) {
      throw new Error(
        `拒绝写入受保护目录: ${p}（解析后 ${full} 属于 ${root}）。工作区为 ${ctx.cwd}，请使用工作区内的路径。`,
      );
    }
  }
  return full;
}

function looksBinary(text: string): boolean {
  const sample = text.slice(0, 8000);
  let nul = 0;
  for (let i = 0; i < sample.length; i++) if (sample.charCodeAt(i) === 0) nul++;
  return nul > 0 || /[\u0001-\u0008\u000e-\u001f]/.test(sample);
}

/** 默认排除目录：.git 结构性排除（数据安全第 1 条的本地镜像：任何功能路径不扫 .git） */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '.next', '__pycache__',
  '.venv', 'venv', 'target', '.idea', '.dsa', '.cache', 'vendor',
]);

function walkFiles(
  root: string,
  accept: (name: string, full: string) => boolean,
  onFile: (full: string) => boolean | void,
): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(root, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkFiles(full, accept, onFile);
    } else if (st.isFile() && accept(name, full)) {
      if (onFile(full) === false) return;
    }
  }
}

export function createCoreTools(): ToolSpec[] {
  const readFile = defineTool({
    name: 'read_file',
    label: '读取文件',
    description: '读取文本文件（UTF-8）。支持 offset/limit 按行读取大文件；超长内容自动截断并提示。',
    capability: 'read',
    risk: 'low',
    parameters: z.object({
      path: z.string().describe('文件路径，绝对或相对工作区'),
      offset: z.number().int().min(1).optional().describe('起始行号（1 基）'),
      limit: z.number().int().min(1).max(2000).optional().describe('读取行数'),
    }),
    async execute(args, ctx): Promise<ToolResult> {
      const full = safePath(ctx.cwd, String(args.path));
      if (!existsSync(full)) throw new Error(`文件不存在: ${args.path}`);
      const st = statSync(full);
      if (st.isDirectory()) throw new Error(`${args.path} 是目录，请用 list_files`);
      if (st.size > MAX_READ_BYTES && args.offset === undefined && args.limit === undefined) {
        // 大文件强制分段：把截断提示直接回灌，引导模型用 offset/limit
        const head = readFileSync(full, 'utf-8').split('\n').slice(0, 400).join('\n');
        return {
          content: `[文件过大 ${st.size}B，仅返回前 400 行]\n${head}\n[用 offset/limit 分段读取]`,
          details: { path: full, truncated: true },
        };
      }
      const all = readFileSync(full, 'utf-8');
      if (looksBinary(all)) throw new Error(`二进制文件不支持读取: ${args.path}`);
      const lines = all.split('\n');
      const off = (args.offset as number | undefined) ?? 1;
      const lim = (args.limit as number | undefined) ?? 2000;
      const slice = lines.slice(off - 1, off - 1 + lim);
      return {
        content: `${off}-${off + slice.length - 1} 行 / 共 ${lines.length} 行：\n${slice.join('\n')}`,
        details: { path: full, lines: slice.length },
      };
    },
  });

  const writeFile = defineTool({
    name: 'write_file',
    label: '写入文件',
    description: '创建或覆盖文本文件（自动建父目录）。覆盖前自动快照原内容，可 /rollback 还原。',
    capability: 'write',
    risk: 'mid',
    parameters: z.object({
      path: z.string().describe('文件路径，绝对或相对工作区'),
      content: z.string().describe('完整文件内容'),
    }),
    preview(args, ctx) {
      const full = safePath(ctx.cwd, String(args.path));
      if (!existsSync(full)) return `[新建] ${args.path}（${String(args.content).length} 字节）`;
      const before = readFileSync(full, 'utf-8');
      return `[覆盖] ${args.path}\n  原 ${before.length}B → 新 ${String(args.content).length}B`;
    },
    async execute(args, ctx): Promise<ToolResult> {
      const full = safeWritePath(ctx, String(args.path));
      const content = String(args.content);
      const existed = existsSync(full);
      const before = existed ? readFileSync(full, 'utf-8') : undefined;
      await rollbackManager.snapshot(existed ? 'edit' : 'create', full, before, ctx.cwd);
      mkdirSync(resolve(full, '..'), { recursive: true });
      writeFileSync(full, content, 'utf-8');
      return {
        content: `${existed ? '已覆盖' : '已创建'} ${args.path}（${content.length} 字节）`,
        details: { path: full, created: !existed },
      };
    },
  });

  const editFile = defineTool({
    name: 'edit_file',
    label: '编辑文件',
    description:
      '精确字符串替换（old 必须在文件中唯一匹配，含空格与换行的原文）。改前自动快照，可 /rollback。',
    capability: 'write',
    risk: 'mid',
    parameters: z.object({
      path: z.string().describe('文件路径'),
      old: z.string().describe('被替换原文（需唯一匹配）'),
      new: z.string().describe('替换文本'),
    }),
    preview(args, ctx) {
      const full = safePath(ctx.cwd, String(args.path));
      const lines = String(args.old).split('\n').length;
      return `[编辑] ${args.path}（替换 ${lines} 行）${existsSync(full) ? '' : ' —— 文件不存在!'}`;
    },
    async execute(args, ctx): Promise<ToolResult> {
      const full = safeWritePath(ctx, String(args.path));
      if (!existsSync(full)) throw new Error(`文件不存在: ${args.path}`);
      const text = readFileSync(full, 'utf-8');
      const old = String(args.old);
      const occurrences = text.split(old).length - 1;
      if (occurrences === 0) {
        throw new Error(`未找到匹配文本（检查空格/缩进/换行是否逐字一致）: ${old.slice(0, 80)}…`);
      }
      if (occurrences > 1) {
        throw new Error(`匹配文本出现 ${occurrences} 次，需唯一——请扩大 old 的上下文范围`);
      }
      const replaced = text.replace(old, String(args.new));
      await rollbackManager.snapshot('edit', full, text, ctx.cwd);
      writeFileSync(full, replaced, 'utf-8');
      return { content: `已编辑 ${args.path}`, details: { path: full } };
    },
  });

  const listFiles = defineTool({
    name: 'list_files',
    label: '列目录',
    description:
      '递归列出工作区文件树（自动排除 .git/node_modules/dist 等）。可按目录与 glob 过滤，用于理解项目结构。',
    capability: 'read',
    risk: 'low',
    parameters: z.object({
      dir: z.string().optional().describe('起始目录，默认工作区根'),
      pattern: z.string().optional().describe('文件名通配，如 *.ts（* ? 语法）'),
      max: z.number().int().min(1).max(2000).optional().describe('返回上限，默认 300'),
    }),
    async execute(args, ctx): Promise<ToolResult> {
      const base = safePath(ctx.cwd, String(args.dir ?? '.'));
      if (!existsSync(base)) throw new Error(`目录不存在: ${args.dir}`);
      const re = args.pattern ? globToRe(String(args.pattern)) : null;
      const out: string[] = [];
      const cap = (args.max as number | undefined) ?? 300;
      let overflow = false;
      walkFiles(
        base,
        (name) => !re || re.test(name),
        (full) => {
          if (out.length >= cap) {
            overflow = true;
            return false;
          }
          out.push('./' + relative(ctx.cwd, full).replaceAll(sep, '/'));
          return;
        },
      );
      out.sort();
      return {
        content:
          out.join('\n') + (overflow ? `\n[已达 ${cap} 上限，更多文件请用 pattern 过滤]` : ''),
        details: { count: out.length, overflow },
      };
    },
  });

  const searchFiles = defineTool({
    name: 'search_files',
    label: '搜索内容',
    description:
      '在工作区内按正则搜索文本内容（rg 风格子集），返回 文件:行号: 行内容。用于定位符号、调用点、报错文案。',
    capability: 'read',
    risk: 'low',
    parameters: z.object({
      query: z.string().describe('正则（JS 语法），如 function\\s+foo 或 TODO'),
      pattern: z.string().optional().describe('限定文件名通配，如 *.py'),
      dir: z.string().optional().describe('限定起始目录'),
      ignoreCase: z.boolean().optional().describe('忽略大小写'),
    }),
    async execute(args, ctx): Promise<ToolResult> {
      let re: RegExp;
      try {
        re = new RegExp(String(args.query), args.ignoreCase ? 'i' : '');
      } catch (e) {
        throw new Error(`非法正则: ${e instanceof Error ? e.message : String(e)}`);
      }
      const base = safePath(ctx.cwd, String(args.dir ?? '.'));
      const fileRe = args.pattern ? globToRe(String(args.pattern)) : null;
      const hits: string[] = [];
      let scanned = 0;
      walkFiles(base, (name, full) => (!fileRe || fileRe.test(name)) && !looksBigSkip(full), (full) => {
        let text: string;
        try {
          text = readFileSync(full, 'utf-8');
        } catch {
          return;
        }
        if (looksBinary(text)) return;
        scanned++;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) {
            hits.push(`./${relative(ctx.cwd, full).replaceAll(sep, '/')}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
            if (hits.length >= MAX_SEARCH_HITS) return false;
          }
        }
        return;
      });
      return {
        content:
          (hits.length > 0 ? hits.join('\n') : '（无匹配）') +
          `\n[扫描 ${scanned} 个文件，命中 ${hits.length}${hits.length >= MAX_SEARCH_HITS ? '（已达上限）' : ''}]`,
        details: { hits: hits.length, scanned },
      };
    },
  });

  const bash = defineTool({
    name: 'bash',
    label: '执行命令',
    description: '在工作区执行 shell 命令，实时流式返回输出，非零退出码报错回灌。可被用户中断。',
    capability: 'exec',
    risk: 'high',
    isDestructiveArgs: (a) => isDestructive(String(a.command ?? '')),
    preview: (a) => `[执行] ${String(a.command).slice(0, 200)}`,
    parameters: z.object({
      command: z.string().describe('shell 命令'),
      timeoutSec: z.number().int().min(1).max(600).optional().describe('超时秒数，默认 120'),
    }),
    async execute(args, ctx): Promise<ToolResult> {
      const command = String(args.command);
      const timeoutMs = ((args.timeoutSec as number | undefined) ?? 120) * 1000;
      return await new Promise<ToolResult>((resolvePromise, reject) => {
        let out = '';
        let truncated = false;
        const child = spawn(command, {
          cwd: ctx.cwd,
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          // 数据安全第 1 条的本地镜像：API key 不进子进程环境
          env: scrubEnv(process.env),
        });
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
        }, timeoutMs);
        const onAbort = (): void => {
          child.kill('SIGKILL');
        };
        ctx.signal?.addEventListener('abort', onAbort);

        const collect = (d: Buffer): void => {
          const s = d.toString();
          if (out.length < MAX_BASH_OUT) out += s.slice(0, MAX_BASH_OUT - out.length);
          else truncated = true;
          ctx.onProgress?.(s);
        };
        child.stdout?.on('data', collect);
        child.stderr?.on('data', collect);
        child.on('error', (err) => {
          clearTimeout(timer);
          ctx.signal?.removeEventListener('abort', onAbort);
          reject(err);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          ctx.signal?.removeEventListener('abort', onAbort);
          const tail = truncated ? `\n[输出超 ${MAX_BASH_OUT}B 已截断]` : '';
          if (code === 0) {
            resolvePromise({ content: (out || '(无输出)') + tail, details: { exitCode: 0 } });
          } else {
            reject(new Error(`命令退出码 ${code}:\n${out.slice(-4000)}${tail}`));
          }
        });
      });
    },
  });

  return [readFile, writeFile, editFile, listFiles, searchFiles, bash];
}

function looksBigSkip(full: string): boolean {
  try {
    return statSync(full).size > 2 * 1024 * 1024;
  } catch {
    return true;
  }
}

function globToRe(glob: string): RegExp {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`(^|/)${esc}$`);
}

/** 从子进程环境中剥离凭证类变量（最小化采集原则的镜像：本地执行也不外扩） */
function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const k of Object.keys(copy)) {
    if (/(_API_KEY|_TOKEN|_SECRET|_PASSWORD|^AWS_|^DEEPSEEK_)/i.test(k)) delete copy[k];
  }
  return copy;
}
