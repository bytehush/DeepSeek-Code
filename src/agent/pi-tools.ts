/**
 * stock-Pi 原子工具集：read_file / write_file / edit_file / bash。
 *
 * 设计对齐 Pi 哲学（仅 4 个原子工具，丢掉自研 20+ 领域工具）：
 *  - 工具只读/写/编辑/执行，复杂能力由模型用这 4 个原子工具组合完成；
 *  - 路径相对 cwd 解析（agent 的「工作目录」，即用户在设置里指定的项目目录）；
 *  - 失败直接 throw，Pi 会把错误作为 tool error 回灌给模型（不返回错误内容字符串）；
 *  - bash 用 spawn 流式输出，通过 onUpdate 实时推给上层（onToolProgress）。
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { type AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { isWithin } from '../config/workspace.ts';

export interface AtomicToolContext {
  cwd: string;
  /**
   * 受保护目录（写操作禁止落点）：源码根等——agent 不得写入自身代码目录。
   * read 不受限（agent 需要读自己的配置/系统提示）。
   * （docs/UX优化-工作空间路径规划与源码目录保护.md 方案 A R2）
   */
  protectedRoots?: string[];
}

function safePath(cwd: string, p: string): string {
  // 允许绝对路径；相对路径基于 cwd 解析
  return resolve(cwd, p);
}

/**
 * 写路径安全校验：解析后若落在任一受保护目录内 → 拒绝（throw 回灌模型）。
 * 覆盖相对/绝对/`..` 逃逸三形态（isWithin 做路径级包含判定，win32 忽略大小写）。
 */
function safeWritePath(cwd: string, p: string, protectedRoots: string[]): string {
  const full = safePath(cwd, p);
  for (const root of protectedRoots) {
    if (isWithin(full, root)) {
      throw new Error(
        `拒绝写入受保护目录: ${p}（解析后 ${full} 属于 ${root}）。` +
          `工作区为 ${cwd}，请使用工作区内的路径。`,
      );
    }
  }
  return full;
}

/** 4 个 stock-Pi 原子工具 */
export function createAtomicTools(ctx: AtomicToolContext): AgentTool[] {
  const { cwd } = ctx;
  const protectedRoots = ctx.protectedRoots ?? [];

  const readFileTool: AgentTool = {
    name: 'read_file',
    label: 'Read File',
    description: 'Read a file from the working directory as UTF-8 text. Use for viewing source, configs, or any text file.',
    parameters: Type.Object({
      path: Type.String({ description: 'File path, absolute or relative to the working directory.' }),
    }),
    executionMode: 'sequential',
    execute: async (_id, params: any) => {
      const full = safePath(cwd, params.path);
      if (!existsSync(full)) throw new Error(`File not found: ${params.path}`);
      const content = readFileSync(full, 'utf-8');
      return {
        content: [{ type: 'text', text: content }],
        details: { path: params.path, size: content.length },
      };
    },
  };

  const writeFileTool: AgentTool = {
    name: 'write_file',
    label: 'Write File',
    description: 'Create or overwrite a file with the given content. Creates parent directories if needed.',
    parameters: Type.Object({
      path: Type.String({ description: 'File path, absolute or relative to the working directory.' }),
      content: Type.String({ description: 'Full file content to write.' }),
    }),
    executionMode: 'sequential',
    execute: async (_id, params: any) => {
      const full = safeWritePath(cwd, params.path, protectedRoots);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, params.content, 'utf-8');
      return {
        content: [{ type: 'text', text: `Wrote ${params.path} (${params.content.length} bytes)` }],
        details: { path: params.path, size: params.content.length },
      };
    },
  };

  const editFileTool: AgentTool = {
    name: 'edit_file',
    label: 'Edit File',
    description: 'Replace the first occurrence of `old` with `new` in a file. Use for targeted in-place edits.',
    parameters: Type.Object({
      path: Type.String({ description: 'File path, absolute or relative to the working directory.' }),
      old: Type.String({ description: 'Exact text to replace (first occurrence).' }),
      new: Type.String({ description: 'Replacement text.' }),
    }),
    executionMode: 'sequential',
    execute: async (_id, params: any) => {
      const full = safeWritePath(cwd, params.path, protectedRoots);
      if (!existsSync(full)) throw new Error(`File not found: ${params.path}`);
      const text = readFileSync(full, 'utf-8');
      if (!text.includes(params.old)) throw new Error(`Pattern not found in ${params.path}: ${params.old}`);
      const replaced = text.replace(params.old, params.new);
      writeFileSync(full, replaced, 'utf-8');
      return {
        content: [{ type: 'text', text: `Edited ${params.path}` }],
        details: { path: params.path, changed: replaced !== text },
      };
    },
  };

  const bashTool: AgentTool = {
    name: 'bash',
    label: 'Bash',
    description: 'Run a shell command in the working directory and return its output. Streams stdout in real time.',
    parameters: Type.Object({
      command: Type.String({ description: 'Shell command to execute.' }),
    }),
    executionMode: 'sequential',
    execute: async (_id, params: any, _signal, onUpdate) => {
      return await new Promise<{ content: { type: 'text'; text: string }[]; details: { exitCode: number } }>(
        (resolvePromise, reject) => {
          let out = '';
          const child = spawn(params.command, {
            cwd,
            shell: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          child.stdout?.on('data', (d: Buffer) => {
            const s = d.toString();
            out += s;
            onUpdate?.({ content: [{ type: 'text', text: s }], details: {} });
          });
          child.stderr?.on('data', (d: Buffer) => {
            const s = d.toString();
            out += s;
            onUpdate?.({ content: [{ type: 'text', text: s }], details: {} });
          });
          child.on('error', (err) => reject(err));
          child.on('close', (code: number) => {
            if (code === 0) {
              resolvePromise({
                content: [{ type: 'text', text: out || '(no output)' }],
                details: { exitCode: code },
              });
            } else {
              reject(new Error(`Command exited with code ${code}:\n${out}`));
            }
          });
        },
      );
    },
  };

  return [readFileTool, writeFileTool, editFileTool, bashTool];
}

/** 列出工作目录（调试/探查用，非暴露给模型的工具） */
export function listDir(cwd: string, sub: string = '.'): string[] {
  const base = resolve(cwd, sub);
  if (!existsSync(base)) return [];
  if (statSync(base).isFile()) return [sub];
  return readdirSync(base);
}
