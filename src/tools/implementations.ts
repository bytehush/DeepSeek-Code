import { readFile, writeFile, mkdir, rm, access, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { DeepSeekClient } from '../llm/deepseek.ts';
import { msgOf } from '../utils/logger.ts';
import { rollbackManager } from './rollback.ts';
import { verifyWrittenFile } from './semantic-check.ts';
import { runCodeVerify, type CodeVerifyOutcome } from './code-verify.ts';
import type { ToolDef, ToolContext, ToolResult } from './types.ts';
import { isSourceMutating, safeEnv } from './security.ts';
import { isDestructive } from '../permission/index.ts';
import { resolve, walkFiles, walkAndSearch } from './file-walk.ts';
import { fuzzyMatchBlock } from './validation.ts';

// 工具函数实现（S1.2 从 index.ts 拆分）：核心工具逻辑。

/** 预览文本行数截断，避免超长 diff 撑爆 TUI 确认条 */
function clipPreview(s: string, maxLines = 24): string {
  const lines = s.split('\n');
  if (lines.length <= maxLines) return s;
  return lines.slice(0, maxLines).join('\n') + `\n… (共 ${lines.length} 行，已截断显示)`;
}

/**
 * 基础工具工厂：闭包持有 client，使 create_file/edit_file 在写盘后
 * 能调用 Pro 模型做「意图层」自动校验（堵 P0 机械自检留下的逻辑盲区）。
 * 复合工具（review/verify/audit/...）仍是各自独立工厂，统一在 createTools 中拼装。
 */
export function createBaseTools(client: DeepSeekClient): ToolDef[] {
  return [
  {
    name: 'read_file',
    description: '读取文件内容以理解代码。支持按行偏移和行数限制。',
    risk: 'low',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件相对工作目录或绝对路径' },
        offset: { type: 'integer', description: '起始行（从1计），可选' },
        limit: { type: 'integer', description: '读取行数，可选，默认400' },
      },
      required: ['path'],
    },
    async execute(args, ctx) {
      const fp = resolve(String(args.path), ctx.cwd);
      try {
        const buf = await readFile(fp, 'utf8');
        const lines = buf.split('\n');
        const off = Math.max(1, Number(args.offset) || 1);
        const lim = args.limit ? Number(args.limit) : 400;
        const slice = lines.slice(off - 1, off - 1 + lim);
        return {
          ok: true,
          output: `文件: ${fp}\n总行数: ${lines.length}\n显示行 ${off}-${off + slice.length - 1}:\n\n${slice.join('\n')}`,
        };
      } catch (e: unknown) {
        return { ok: false, output: `读取失败: ${msgOf(e)}` };
      }
    },
  },
  {
    name: 'write_file',
    description:
      '写入文件内容——文件不存在则创建，已存在则覆盖。' +
      '这是向文件写入内容的正确工具（不要用 run_command 的 sed/node 脚本等改写文件）。',
    risk: 'mid',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '文件完整内容' },
      },
      required: ['path', 'content'],
    },
    async preview(args, ctx) {
      const fp = resolve(String(args.path), ctx.cwd);
      const content = String(args.content ?? '');
      const lines = content.split('\n');
      const head = clipPreview(content, 40);
      const ellipsis = lines.length > 40 ? `\n… (共 ${lines.length} 行，仅预览前 40 行)` : '';
      const existed = await (async () => { try { await access(fp); return true; } catch { return false; } })();
      const prefix = existed ? '📝 将覆盖文件' : '📄 将新建文件';
      return `${prefix}: ${fp}\n\n${head}${ellipsis}`;
    },
    async execute(args, ctx) {
      const fp = resolve(String(args.path), ctx.cwd);
      const content = String(args.content ?? '');
      try {
        const existed = await (async () => { try { await access(fp); return true; } catch { return false; } })();
        await mkdir(path.dirname(fp), { recursive: true });
        if (existed) {
          const original = await readFile(fp, 'utf8');
          await rollbackManager.snapshot('edit', fp, original, ctx.cwd);
        } else {
          await rollbackManager.snapshot('create', fp, undefined, ctx.cwd);
        }
        await writeFile(fp, content, 'utf8');
        const chk = await verifyWrittenFile(fp, content.length === 0);
        if (!chk.ok) {
          return { ok: false, output: `[语义自检失败] ${chk.error}` };
        }
        const av = await autoVerifyCode(client, fp, ctx.signal);
        let suffix = '';
        if (av) {
          if (!av.pass && av.hasHigh) suffix = `\n\n[⚠️ Pro 检出高危]\n${av.rendered}`;
          else if (!av.pass) suffix = `\n\n[⚠️ Pro 检出问题]\n${av.rendered}`;
          else suffix = `\n\n${av.rendered}`;
        }
        return { ok: true, output: `${existed ? '已覆盖' : '已创建'}文件: ${fp} (${content.length} 字符)${suffix}` };
      } catch (e: unknown) {
        return { ok: false, output: `写入失败: ${msgOf(e)}` };
      }
    },
  },
  // 向后兼容：create_file 作为 write_file 的别名
  {
    name: 'create_file',
    description: '[向后兼容] 写入文件内容——不存在则创建，已存在则覆盖。建议优先使用 write_file。',
    risk: 'mid',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '文件完整内容' },
      },
      required: ['path', 'content'],
    },
    async preview(args, ctx) {
      const fp = resolve(String(args.path), ctx.cwd);
      const content = String(args.content ?? '');
      const lines = content.split('\n');
      const head = clipPreview(content, 40);
      const ellipsis = lines.length > 40 ? `\n… (共 ${lines.length} 行)` : '';
      const existed = await (async () => { try { await access(fp); return true; } catch { return false; } })();
      return `${existed ? '📝 将覆盖' : '📄 将新建'}: ${fp}\n\n${head}${ellipsis}`;
    },
    async execute(args, ctx) {
      // 与 write_file 同逻辑：不存在则创建，存在则覆盖
      const fp = resolve(String(args.path), ctx.cwd);
      const content = String(args.content ?? '');
      try {
        const existed = await (async () => { try { await access(fp); return true; } catch { return false; } })();
        await mkdir(path.dirname(fp), { recursive: true });
        if (existed) {
          const original = await readFile(fp, 'utf8');
          await rollbackManager.snapshot('edit', fp, original, ctx.cwd);
        } else {
          await rollbackManager.snapshot('create', fp, undefined, ctx.cwd);
        }
        await writeFile(fp, content, 'utf8');
        const chk = await verifyWrittenFile(fp, content.length === 0);
        if (!chk.ok) return { ok: false, output: `[语义自检失败] ${chk.error}` };
        return { ok: true, output: `${existed ? '已覆盖' : '已创建'}文件: ${fp} (${content.length} 字符)` };
      } catch (e: unknown) {
        return { ok: false, output: `写入失败: ${msgOf(e)}` };
      }
    },
  },
  {
    name: 'ensure_dir',
    description:
      '确保指定目录存在，如果不存在则自动创建（含所有父目录）。' +
      '在写入多个文件到新目录前，先用此工具创建目录结构。纯幂等操作——目录已存在时不做任何事（不报错）。',
    risk: 'low',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要确保存在的目录路径（相对工作目录或绝对）' },
      },
      required: ['path'],
    },
    async execute(args, ctx) {
      const fp = resolve(String(args.path), ctx.cwd);
      try {
        await mkdir(fp, { recursive: true });
        return { ok: true, output: `目录已就绪: ${fp}` };
      } catch (e: unknown) {
        return { ok: false, output: `创建目录失败: ${msgOf(e)}` };
      }
    },
  },
  {
    name: 'edit_file',
    description: '用字符串替换修改文件。old_string 必须在文件中唯一存在。这是修改现有源码的唯一正确工具——不要用 run_command（如 node -e 正则替换、sed -i）改写文件。',
    risk: 'mid',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        old_string: { type: 'string', description: '要被替换的原文本（需唯一）' },
        new_string: { type: 'string', description: '替换后的新文本' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async preview(args, ctx) {
      const fp = resolve(String(args.path), ctx.cwd);
      const oldS = String(args.old_string);
      const newS = String(args.new_string);
      try {
        const buf = await readFile(fp, 'utf8');
        const idx = buf.indexOf(oldS);
        if (idx === -1) return `⚠️ 无法预览：未找到 old_string（执行时将报错）\n路径: ${fp}`;
        if (buf.indexOf(oldS, idx + 1) !== -1) return `⚠️ 无法预览：old_string 出现多次（执行时将报错）\n路径: ${fp}`;
        const lines = buf.split('\n');
        const startLine = buf.slice(0, idx).split('\n').length; // 1-based
        const oldLines = oldS.split('\n').length;
        const ctxN = 3;
        const from = Math.max(0, startLine - 1 - ctxN);
        const to = Math.min(lines.length, startLine - 1 + oldLines + ctxN);
        let out = `📝 将修改: ${fp}（第 ${startLine} 行附近）\n`;
        for (let i = from; i < to; i++) {
          const ln = i + 1;
          if (i >= startLine - 1 && i < startLine - 1 + oldLines) {
            out += `- ${ln} | ${lines[i]}\n`;
          } else {
            out += `  ${ln} | ${lines[i]}\n`;
          }
        }
        out += `        ↓ 替换为 ↓\n`;
        out += '+ ' + clipPreview(newS, 24).split('\n').join('\n+ ');
        return out;
      } catch {
        return `⚠️ 无法预览：文件不存在（执行时将报错）\n路径: ${fp}`;
      }
    },
    async execute(args, ctx) {
      const fp = resolve(String(args.path), ctx.cwd);
      const oldS = String(args.old_string);
      const newS = String(args.new_string);
      try {
        // 健壮性：确保目标目录存在（可用 ensure_dir 预先创建，此处兜底）
        await mkdir(path.dirname(fp), { recursive: true });
        const buf = await readFile(fp, 'utf8');
        const idx = fuzzyMatchBlock(buf, oldS);
        if (idx === -1)
          return {
            ok: false,
            output:
              '未找到 old_string（已尝试精确匹配与逐行空白归一化匹配）。' +
              '\n请先用 read_file 重新读取该文件的最新内容，确认 old_string 与文件实际字节一致' +
              '（尤其缩进、换行、行尾），再调用 edit_file。',
          };
        if (fuzzyMatchBlock(buf.slice(idx + 1), oldS) !== -1)
          return { ok: false, output: 'old_string 在文件中出现多次，请提供更多上下文使其唯一' };
        const updated = buf.slice(0, idx) + newS + buf.slice(idx + oldS.length);
        // 回滚点：落盘前记录原文（edit 还原=写回 buf），供 /rollback 撤销
        await rollbackManager.snapshot('edit', fp, buf, ctx.cwd);
        await writeFile(fp, updated, 'utf8');
        // P0 语义自检：写后校验文件真的正确落地（路径/非空/语法）
        const chk = await verifyWrittenFile(fp, newS.length === 0);
        if (!chk.ok) {
          return { ok: false, output: `[语义自检失败] ${chk.error}\n请检查 old_string/new_string 是否正确，或重新读取文件后再改。` };
        }
        // 意图层自检（P0 延续）：代码文件且改动实质（>=40 字符）才触发 Pro 校验，
        // 避免单行微调也付出 5-8s 延迟与成本。
        let suffix = '';
        if (newS.trim().length >= 40) {
          const av = await autoVerifyCode(client, fp, ctx.signal);
          if (av) {
            if (!av.pass && av.hasHigh) {
              suffix = `\n\n[⚠️ 自动验证-高危问题] 改动已写入，但 Pro 检出逻辑/安全高危问题，强烈建议复核：\n${av.rendered}`;
            } else if (!av.pass) {
              suffix = `\n\n[自动验证-需注意] Pro 检出问题：\n${av.rendered}`;
            } else {
              suffix = `\n\n${av.rendered}`;
            }
          }
        }
        return { ok: true, output: `已修改: ${fp}${suffix}` };
      } catch (e: unknown) {
        return { ok: false, output: `修改失败: ${msgOf(e)}` };
      }
    },
  },
  {
    name: 'delete_file',
    description: '删除文件或空目录。危险操作，需用户确认。',
    risk: 'high',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '待删除路径' } },
      required: ['path'],
    },
    async preview(args, ctx) {
      const fp = resolve(String(args.path), ctx.cwd);
      return `🗑️ 将删除: ${fp}\n⚠️ 此操作不可恢复，确认删除？`;
    },
    async execute(args, ctx) {
      const fp = resolve(String(args.path), ctx.cwd);
      try {
        // 回滚点：删除前先读原文（delete 还原=重新写回），供 /rollback 撤销
        const before = await readFile(fp, 'utf8').catch(() => null);
        await rollbackManager.snapshot('delete', fp, before ?? '', ctx.cwd);
        await rm(fp, { recursive: false, force: false });
        return { ok: true, output: `已删除: ${fp}` };
      } catch (e: unknown) {
        return { ok: false, output: `删除失败: ${msgOf(e)}` };
      }
    },
  },
  {
    name: 'run_command',
    description: '在终端执行 shell 命令并返回 stdout/stderr/退出码。危险命令需确认。注意：禁止用本工具改写源码文件（如 node -e 替换、sed -i、重定向写 .ts/.py 等），修改代码请用 edit_file。',
    risk: 'high',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: { type: 'string', description: '工作目录，可选，默认项目根' },
      },
      required: ['command'],
    },
      async execute(args, ctx) {
      const cmd = String(args.command);
      const cwd = args.cwd ? resolve(String(args.cwd), ctx.cwd) : ctx.cwd;
      const { onProgress, signal } = ctx;

      // 安全检查：防止 taskkill 误杀 Agent 自身进程
      if (/taskkill\s+\/f\s+\/im\s+node\.exe/i.test(cmd)) {
        const selfPid = process.pid;
        const msg = `⚠️ 安全拦截: taskkill /f /im node.exe 会杀掉所有 Node 进程（含 Agent 自身 PID=${selfPid}）。建议改为 taskkill /f /pid <目标PID> 或 npx kill-port <port>`;
        onProgress?.(msg);
        return { ok: false, output: msg };
      }

      // 安全护栏：阻断高危险命令（文档承诺的「安全底线」：即便 execute 模式也升级拦截）
      if (isDestructive(cmd)) {
        const msg = `⚠️ 安全拦截：检测到高危险命令（${cmd}）。此类破坏性操作禁止通过 run_command 执行，请改用专门工具或手动完成。`;
        onProgress?.(msg);
        return { ok: false, output: msg };
      }

      // 安全护栏：禁止用终端命令改写源码文件（应改用 edit_file）
      if (isSourceMutating(cmd)) {
        const msg =
          '⚠️ 安全拦截：检测到该命令会改写源码文件。修改代码请使用 edit_file 工具' +
          '（具备写前 diff 审批与精确/鲁棒匹配），不要用 run_command 绕过。';
        onProgress?.(msg);
        return { ok: false, output: msg };
      }

      // Windows 中文系统: 子进程 stdout 默认 GBK 编码（管道重定向不随 chcp 变化）
      // 故在 Buffer 层面解码：优先 UTF-8，若含替换符则回退 GBK
      const decode = (buf: Buffer): string => {
        if (process.platform !== 'win32') return buf.toString('utf8');
        const asUtf8 = buf.toString('utf8');
        if (asUtf8.includes('�')) {
          try {
            return new TextDecoder('gbk').decode(buf);
          } catch {
            return asUtf8;
          }
        }
        return asUtf8;
      };

      return new Promise<ToolResult>((resolve) => {
        // 外层已取消：直接返回，不启动子进程
        if (signal?.aborted) {
          resolve({ ok: false, output: '命令已取消（用户中断）' });
          return;
        }

        const startTime = Date.now();
        // 用 spawn 替代 exec，支持流式输出
        const child = spawn(cmd, [], {
          cwd,
          shell: true,
          timeout: 120000,
          // POSIX：detached 让子进程成为独立进程组 leader，便于用 -pid 递归杀掉
          // npm run dev 启动的 vite 等孙子进程，避免它们变孤儿继续占端口。Windows 走 taskkill /t。
          detached: process.platform !== 'win32',
          // ✅ 安全：过滤掉 API Key 等敏感环境变量，防止通过子进程泄露凭据
          env: safeEnv() as Record<string, string | undefined>,
        });

        let stdout = '';
        let stderr = '';
        const MAX_OUTPUT = 8000;
        let timedOut = false;
        let aborted = false;
        // 守护标记：避免 close/兜底超时双触发导致 resolve 二次调用
        let settled = false;
        const settle = (result: ToolResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(killTimer);
          clearTimeout(guardTimer);
          signal?.removeEventListener('abort', abortHandler);
          resolve(result);
        };

        // 递归杀进程树：避免 run_command 杀掉 shell 后，npm run dev 启动的 vite 等
        // 孙子进程变孤儿继续占端口 / 写已关闭的 pipe。
        const killTree = (force = false): void => {
          aborted = true;
          const pid = child.pid;
          if (!pid) return; // 进程已退出或 pid 不可用
          const sig: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';
          try {
            if (process.platform === 'win32') {
              // /T 递归杀整棵进程树（shell + npm + node + vite worker），
              // 任何孙进程还持有 pipe 写端都会导致 child.close 永久不触发。
              spawn(
                'taskkill',
                ['/pid', String(pid), '/t', '/f'],
                { stdio: 'ignore', detached: true, shell: false },
              ).unref();
            } else {
              // 负 pid = 整个进程组（含孙进程）
              process.kill(-pid, sig);
            }
          } catch {
            /* 已退出 */
          }
        };

        // 用户主动中断：接到 signal 后先 SIGTERM，5s 后升级 SIGKILL
        const abortHandler = () => {
          killTree(false);
          setTimeout(() => killTree(true), 5000);
        };
        signal?.addEventListener('abort', abortHandler);

        // 超时兜底：Node 的 timeout 选项在流式子进程下不保证回收进程树，
        // 故显式发 SIGTERM，仍不退出再升级 SIGKILL，避免后台进程（如 npm run dev）残留。
        const killTimer = setTimeout(() => {
          timedOut = true;
          killTree(false);
          setTimeout(() => killTree(true), 5000);
        }, 120000);

        // ═══ 核心修复：兜底 Promise 强制 resolve ═══
        // 即使 child.close 因孙进程持 pipe 而永不触发，超过最大总时长后必须 resolve，
        // 否则上游 await 永久挂起，agent 表现为「3 分钟后卡死」。
        // 时长 = 180s 业务超时 + 5s SIGKILL 升级 + 5s 孙进程清理 + 5s 缓冲 = 195s
        // 与 streamChat 180s 总超时对齐，避免 run_command 跑完时 streamChat 总超时已被吃掉
        const guardMs = 180_000 + 5_000 + 5_000 + 5_000;
        const guardTimer = setTimeout(() => {
          if (settled) return;
          // 主动 destroy 流，确保 Promise 不会因为 pipe 未关而继续等待
          child.stdout?.destroy();
          child.stderr?.destroy();
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const note = timedOut
            ? '（命令超时被杀，且孙进程未在窗口内退出）'
            : '（命令进程清理超时，已强制结束）';
          settle({
            ok: false,
            output: `命令: ${cmd}\n退出码: null | 耗时: ${elapsed}s (兜底超时)\n--- stdout ---\n${stdout.slice(0, MAX_OUTPUT)}\n--- stderr ---\n${stderr.slice(0, MAX_OUTPUT)}\n⚠️ ${note}`,
          });
        }, guardMs);

        child.stdout?.on('data', (chunk: Buffer) => {
          const line = decode(chunk);
          stdout += line;
          if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(0, MAX_OUTPUT);
          onProgress?.(line); // 流式推送到 CLI
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          const line = decode(chunk);
          stderr += line;
          if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(0, MAX_OUTPUT);
          onProgress?.(line); // stderr 也实时推送
        });

        child.on('close', (code) => {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const timeoutNote = timedOut ? '\n⚠️ 命令超时（120s）已被终止。' : '';
          const abortNote = aborted ? '\n⚠️ 用户已中断此命令。' : '';
          const out = `命令: ${cmd}\n退出码: ${code ?? 'null'} | 耗时: ${elapsed}s\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}${timeoutNote}${abortNote}`;
          settle({
            ok: code === 0 && !timedOut && !aborted,
            output: out.slice(0, MAX_OUTPUT),
          });
        });

        child.on('error', (e) => {
          settle({ ok: false, output: `命令启动失败: ${e.message}\n命令: ${cmd}` });
        });
      });
    },
  },
  {
    name: 'search_files',
    description: '按文件名模式查找文件（glob 匹配）。如 "*.ts" 匹配所有 TypeScript 文件。',
    risk: 'low',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '文件名 glob 模式，如 *.ts, **/*.test.ts, *.json' },
        dir: { type: 'string', description: '搜索根目录，可选，默认项目根目录' },
      },
      required: ['pattern'],
    },
    async execute(args, ctx) {
      const pattern = String(args.pattern);
      const root = args.dir ? resolve(String(args.dir), ctx.cwd) : ctx.cwd;
      const results: string[] = [];
      try {
        await walkFiles(root, pattern, results, { n: 0 });
        if (results.length === 0) return { ok: true, output: `未找到匹配 "${pattern}" 的文件` };
        return { ok: true, output: `匹配 ${results.length} 个文件:\n${results.join('\n')}` };
      } catch (e: unknown) {
        return { ok: false, output: `文件搜索失败: ${msgOf(e)}` };
      }
    },
  },
  {
    name: 'search_code',
    description: '在代码库中用正则搜索文本内容，返回匹配的文件、行号与行内容。支持文件名过滤。',
    risk: 'low',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式搜索模式' },
        dir: { type: 'string', description: '搜索根目录，可选，默认项目根目录' },
        glob: { type: 'string', description: '文件名过滤模式，如 *.ts，可选' },
      },
      required: ['pattern'],
    },
    async execute(args, ctx) {
      const pattern = String(args.pattern);
      if (pattern.length > 200) {
        return { ok: false, output: '搜索正则过长（上限 200 字符），已拒绝执行以防 ReDoS。' };
      }
      const root = args.dir ? resolve(String(args.dir), ctx.cwd) : ctx.cwd;
      const glob = args.glob ? String(args.glob) : '*';
      try {
        const re = new RegExp(pattern, 'i');
        const results: string[] = [];
        const counter = { n: 0 };
        await walkAndSearch(root, re, glob, results, counter);
        if (results.length === 0) return { ok: true, output: `未找到匹配 "${pattern}"` };
        return { ok: true, output: `匹配 ${counter.n} 处:\n${results.join('\n')}` };
      } catch (e: unknown) {
        return { ok: false, output: `搜索失败: ${msgOf(e)}` };
      }
    },
  },
  {
    name: 'todo_write',
    description: '维护当前会话的任务清单。用编号列表列出任务项，每项标记 [pending]/[>]/[x]。系统会追踪进度——连续多轮不更新会收到提醒。',
    risk: 'low',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '任务描述' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'pending=待办, in_progress=进行中, completed=已完成' },
            },
            required: ['content', 'status'],
          },
          description: '任务清单数组',
        },
      },
      required: ['todos'],
    },
    async execute(args, _ctx) {
      const todos = args.todos as Array<{ content: string; status: string }> | undefined;
      if (!todos || !Array.isArray(todos)) {
        return { ok: false, output: 'todos 参数必须是一个任务数组' };
      }
      const icon = (s: string) => (s === 'completed' ? '[x]' : s === 'in_progress' ? '[>]' : '[ ]');
      const lines = todos.map((t, i) => `${i + 1}. ${icon(t.status)} ${t.content}`);
      return { ok: true, output: `任务清单已更新 (${todos.length} 项):\n${lines.join('\n')}` };
    },
  },
  {
    name: 'list_dir',
    description: '列出目录中的文件和子目录。支持递归深度控制。',
    risk: 'low',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径，可选，默认项目根目录' },
        depth: { type: 'integer', description: '递归深度（1=仅当前层），默认 1' },
      },
    },
    async execute(args, ctx) {
      const fp = args.path ? resolve(String(args.path), ctx.cwd) : ctx.cwd;
      const depth = Math.max(1, Number(args.depth) || 1);
      const collect = async (dir: string, d: number, prefix: string): Promise<string[]> => {
        if (d > depth) return [];
        try {
          const ents = await readdir(dir, { withFileTypes: true });
          const out: string[] = [];
          for (const ent of ents) {
            if (['node_modules', '.git', '.dsa'].includes(ent.name)) continue;
            const icon = ent.isDirectory() ? '📁' : '📄';
            out.push(`${prefix}${icon} ${ent.name}`);
            if (ent.isDirectory() && d < depth) {
              out.push(...await collect(path.join(dir, ent.name), d + 1, prefix + '  '));
            }
          }
          return out;
        } catch (e: unknown) {
          return [`${prefix}⚠️ 无法读取: ${msgOf(e)}`];
        }
      };
      try {
        const listing = await collect(fp, 1, '');
        return { ok: true, output: `${fp}\n${listing.join('\n')}` };
      } catch (e: unknown) {
        return { ok: false, output: `列出目录失败: ${msgOf(e)}` };
      }
    },
  },
  {
    // P1-⑥ 模型主动 awaitUser：中途向用户提问，等待其回复后再继续当前任务。
    // 真实拦截在 loop.ts（拿到回复作为工具结果回灌，不真正执行 execute）。
    name: 'awaitUser',
    description:
      '中途向用户提问并等待其回复后再继续当前任务。当你需要用户澄清需求、确认方向、' +
      '或提供模型无法自行获取的个人信息（如密钥、偏好、环境细节）时使用。参数 question 是你想问用户的问题。',
    risk: 'low',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问用户的问题' },
      },
      required: ['question'],
    },
    async execute() {
      // 实际拦截在 loop.ts 中处理（awaitUser 不会真的执行到这里，而是挂起等待用户输入）
      return { ok: true, output: '' };
    },
  },
];
}

/** 写后自动意图校验覆盖的代码扩展名（不含 md/json/css 等纯数据/文档） */
const CODE_VERIFY_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.cpp', '.c', '.cs',
]);

/**
 * 写后自动意图层校验（P0 延续）：文件已通过机械语义自检（落盘/非空/语法），
 * 此处用 Pro 模型做「逻辑正确性 + 安全性」聚焦校验，堵住「写对但逻辑错」盲区。
 * 仅对代码文件触发；非代码文件（md/json/css/纯文本）直接返回 null 跳过。
 * 返回 null 表示「无需校验」（非代码文件或 Pro 未实际跑），调用方据此决定是否附报告。
 */
async function autoVerifyCode(
  client: DeepSeekClient,
  fp: string,
  signal?: AbortSignal,
): Promise<CodeVerifyOutcome | null> {
  const ext = path.extname(fp).toLowerCase();
  if (!CODE_VERIFY_EXT.has(ext)) return null;
  const out = await runCodeVerify(client, fp, { signal });
  return out.ran ? out : null;
}
