import { writeFile, mkdir, readdir, stat, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { ChatMessage, ToolCall } from '../llm/deepseek.ts';

/**
 * Trace 事件类型 — 覆盖 Agent Loop 完整生命周期。
 */
export type TraceEventType =
  | 'session_start'
  | 'user_input'
  | 'model_content'      // 模型流式文本片段
  | 'model_tool_use'     // 模型决定调用工具
  | 'tool_call'          // 工具开始执行
  | 'tool_result'        // 工具返回结果
  | 'context_compact'    // 上下文压缩（P0-① 每轮迭代末尾自动压缩）
  | 'manual_compact'     // 用户 /compact：手动强制压缩上下文
  | 'early_exit'         // 无进展/死循环提前退出（P1-⑤）
  | 'assistant_message'  // 完整 assistant 消息（文本 + tool_calls），用于会话重放
  | 'permission_request' // 权限确认请求
  | 'permission_decision'// 权限决策结果
  | 'error'              // 错误
  | 'cancelled'          // 用户主动中断当前请求
  | 'elevate'            // 双模型 Elevate 闸——最终答复前自动触发 Pro 审核
  | 'task_fidelity'      // 双模型 P2 任务级保真审计——整轮工作 vs 用户意图
  | 'review_commons'     // ReviewCommons 审查共同体——最终答复前 Format→Reflection 审查结论
  | 'cycle_rescue'       // 序列循环检测——首次命中注入自救指令
  | 'plan_generated'     // Plan&Act——计划生成完成
  | 'plan_decision'      // Plan&Act——用户确认/拒绝计划
  | 'auto_plan'         // P-Auto——复杂度分类器判定为复杂，自动进入规划
  | 'tool_cap'          // B·harness——每轮工具调用数达上限，停止派发
  | 'repeated_tool_break' // B·harness——同工具+相同参数重复超限，活锁熔断终止
  | 'self_review'        // P1.1 Flash 自检——中等规模任务输出前自检
  | 'replan_injected'     // P2.5 中继重新规划——连续失败+空转时注入 replan 指令
  | 'diminishing_output'   // P1 输出递减检测——连续 N 轮文本产出缩短
  | 'rollback'          // 用户 /rollback：撤销最近 N 次文件变更
  | 'resume'           // 用户 /resume：从最近 trace 恢复会话历史续跑
  | 'browser_watch'    // 浏览器观察回灌开关（/watch 命令）
  | 'session_end'       // 会话正常结束
  // ── 思考盒（思考过程）持久化：与前端显示完全同形，切回任务/重登录原样重建 ──
  | 'thinking_start'
  | 'thinking_entry'
  | 'thinking_update'
  | 'thinking_status'
  | 'thinking_end';

export interface TraceEvent {
  /** ISO 8601 时间戳 */
  timestamp: string;
  /** 事件类型 */
  type: TraceEventType;
  /** 事件载荷（类型相关） */
  payload: Record<string, unknown>;
}

/** 思考盒里一条「观察」条目（与前端 ThinkingEntry 同形） */
export interface ReplayedThinkingEntry {
  id: number;
  /** reason=推理文字；tool=工具调用；tool_result=工具返回结果；error=本轮错误 */
  kind: 'reason' | 'tool' | 'tool_result' | 'error';
  /** tool 条目的工具名 */
  title?: string;
  text: string;
}

/** 思考盒状态（与前端 ThinkingStatus 同形） */
export type ReplayedThinkingStatus = 'thinking' | 'outputting' | 'done' | 'interrupted';

/** 一个思考轮次（一次 agent 工作回合的完整思考过程） */
export interface ReplayedThinkingTurn {
  turnId: number;
  status: ReplayedThinkingStatus;
  entries: ReplayedThinkingEntry[];
}

/** 回放结果：消息 + 思考轮次（思考盒随消息同形恢复） */
export interface ReplayedConversation {
  messages: ReplayedMessage[];
  thinking: ReplayedThinkingTurn[];
}

/** 回放用消息：ChatMessage 扩展 thinkingId 绑定（关联对应思考轮次）与时间线 ts */
export type ReplayedMessage = ChatMessage & { thinkingId?: number; ts?: string };

/**
 * JSONL Trace 日志系统（P2-1）。
 *
 * 将每次 Agent Loop 的完整事件流追加写入 .dsa/traces/ 目录下的 JSONL 文件。
 * 每行一个 JSON 对象，包含 timestamp、type、payload。
 *
 * 用途：
 * - 出错后精确定位哪一步坏
 * - 回放完整 Agent 行为链
 * - 统计工具调用频率和成本
 */
export class TraceLogger {
  private filePath: string;
  private sessionId: string;
  private _count = 0; // 仅计数，不长期持有事件数组，避免长会话内存无限增长
  private enabled: boolean;

  /** ✅ 性能：写入缓冲区，定期批量刷新而非每条事件单独 writeFile */
  private _buf: string[] = [];
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;
  private _flushing = false;
  /** 当前进行中的 flush Promise：并发 flush（显式调用 vs 500ms 定时器）等待同一写操作，避免竞态丢数据 */
  private _flushPromise: Promise<void> | null = null;
  private static readonly FLUSH_INTERVAL_MS = 500;
  private static readonly FLUSH_THRESHOLD = 20; // 攒满 20 条自动刷

  constructor(options?: { workspaceDir?: string; enabled?: boolean }) {
    this.enabled = options?.enabled !== false;
    this.sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const baseDir = options?.workspaceDir ?? process.cwd();
    const traceDir = join(baseDir, '.dsa', 'traces');
    this.filePath = join(traceDir, `${this.sessionId}.jsonl`);
  }

  get id(): string {
    return this.sessionId;
  }

  /** 刷出缓冲区中所有待写入事件到文件 */
  /**
   * 刷出缓冲区中所有待写入事件到文件。
   * 强一致：循环直至缓冲清空；若已有刷盘在进行，等待其完成后再检查——
   * 这样显式 `await flush()`（如切任务前强制落盘）不会与 500ms 定时器竞态丢数据，
   * 调用方 await 返回后即可保证缓冲已落盘。
   */
  async flush(): Promise<void> {
    while (this._buf.length > 0) {
      if (this._flushing) {
        await this._flushPromise;
        continue; // 当前刷盘结束后再看缓冲是否又有新增
      }
      this._flushing = true;
      this._clearFlushTimer();
      const lines = this._buf.join('');
      this._buf = [];
      const p = (async () => {
        try {
          await this.ensureDir();
          await writeFile(this.filePath, lines, { flag: 'a', mode: 0o600 });
        } catch {
          /* 文件写入失败不阻塞主流程 */
        } finally {
          this._flushing = false;
        }
      })();
      this._flushPromise = p;
      await p;
    }
    this._flushPromise = null;
  }

  private _clearFlushTimer(): void {
    if (this._flushTimer !== null) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
  }

  private _scheduleFlush(): void {
    if (this._flushTimer !== null) return; // 已有定时
    if (this._buf.length >= TraceLogger.FLUSH_THRESHOLD) {
      void this.flush(); // 超过阈值立即刷
      return;
    }
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      void this.flush();
    }, TraceLogger.FLUSH_INTERVAL_MS);
  }

  /**
   * 记录一条 trace 事件。写入缓冲而非直接写盘。
   */
  async log(type: TraceEventType, payload: Record<string, unknown>): Promise<void> {
    if (!this.enabled) return;

    const event: TraceEvent = {
      timestamp: new Date().toISOString(),
      type,
      payload,
    };

    this._count++;

    // ✅ 写入缓冲，延迟批量刷盘
    this._buf.push(JSON.stringify(event) + '\n');
    this._scheduleFlush();
  }

  /**
   * 批量记录（直接写入缓冲区）。
   */
  async logBatch(events: Array<{ type: TraceEventType; payload: Record<string, unknown> }>): Promise<void> {
    if (!this.enabled) return;

    const now = new Date().toISOString();
    this._count += events.length;

    for (const e of events) {
      this._buf.push(JSON.stringify({ timestamp: now, type: e.type, payload: e.payload }) + '\n');
    }
    this._scheduleFlush();
  }

  /** 标记会话结束：刷出缓冲区中所有未写入事件 */
  async end(): Promise<void> {
    await this.flush();
    await this.log('session_end', { totalEvents: this._count });
    await this.flush();
  }

  /** 获取当前会话已记录的事件数 */
  get eventCount(): number {
    return this._count;
  }

  /**
   * 静态方法：获取最近的 trace 文件摘要（CLI 启动时展示）。
   */
  static async recentSummary(workspaceDir?: string): Promise<string[]> {
    const traceDir = join(workspaceDir ?? process.cwd(), '.dsa', 'traces');
    const lines: string[] = [];

    try {
      const files = await readdir(traceDir);
      const jsonlFiles = files.filter((f) => f.endsWith('.jsonl')).sort().reverse();

      // 取最近 5 个 trace 文件
      const recent = jsonlFiles.slice(0, 5);
      if (recent.length === 0) {
        return ['暂无 trace 记录'];
      }

      lines.push(`最近 ${recent.length} 个会话 trace:`);
      for (const f of recent) {
        const fp = join(traceDir, f);
        const s = await stat(fp);
        // 读第一行获取 session_start 信息
        const content = await readFileFirstLine(fp);
        let info = f.replace('.jsonl', '');
        try {
          const firstEvent = JSON.parse(content);
          if (firstEvent.payload?.cwd) {
            info += ` (${firstEvent.payload.cwd})`;
          }
        } catch { /* 解析失败就用文件名 */ }
        lines.push(`  ${info} | ${s.size}B | ${s.mtime.toLocaleString('zh-CN')}`);
      }
    } catch {
      lines.push('（trace 目录不存在或无法读取）');
    }

    return lines;
  }

  /**
   * P5 会话恢复：解析指定 sessionId 的 trace 文件，重建对话消息数组。
   * 返回 user/assistant/tool 消息（不含 system，由 ConversationHistory 自带）。
   * 若无可恢复内容则返回 null。
   */
  static async replayById(workspaceDir: string, sessionId: string): Promise<ChatMessage[] | null> {
    const traceDir = join(workspaceDir, '.dsa', 'traces');
    try {
      const content = await readFile(join(traceDir, `${sessionId}.jsonl`), 'utf8');
      const r = TraceLogger.parseReplay(content);
      return r ? r.messages : null;
    } catch {
      return null;
    }
  }

  /**
   * P5 会话恢复：解析最近的 trace 文件，重建对话消息数组。
   * 返回 user/assistant/tool 消息（不含 system，由 ConversationHistory 自带）。
   * 若无可恢复内容则返回 null。
   */
  static async replay(workspaceDir?: string): Promise<ChatMessage[] | null> {
    const traceDir = join(workspaceDir ?? process.cwd(), '.dsa', 'traces');
    try {
      const files = await readdir(traceDir);
      const jsonlFiles = files.filter((f) => f.endsWith('.jsonl')).sort().reverse();
      if (jsonlFiles.length === 0) return null;
      const content = await readFile(join(traceDir, jsonlFiles[0]), 'utf8');
      const r = TraceLogger.parseReplay(content);
      return r ? r.messages : null;
    } catch {
      return null;
    }
  }

  /**
   * 聚合版会话恢复：解析目录下【全部】 trace 文件，按文件名升序（=时间序）拼接重建对话消息数组。
   * 与 `replay` 只取最新单文件不同，本方法合并该任务所有历史会话，
   * 避免切换/重启后早期会话被新开空文件孤立而丢失历史。
   * 仅 Web 的「切任务 / 登录恢复」入口使用；CLI 仍走 `replay`，不受影响。
   */
  static async replayAll(workspaceDir?: string): Promise<ReplayedConversation | null> {
    const traceDir = join(workspaceDir ?? process.cwd(), '.dsa', 'traces');
    let files: string[];
    try {
      files = await readdir(traceDir);
    } catch {
      return null; // 目录不存在：无历史
    }
    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl')).sort(); // 升序 = 时间序
    if (jsonlFiles.length === 0) return null;
    const allMessages: ReplayedMessage[] = [];
    const allThinking: ReplayedThinkingTurn[] = [];
    // 全局唯一 thinking turnId：多 session 的 trace 各自从 1 计 turnId（AgentHost.curTurnId
    // 每次 makeHost 重置为 0；刷新重连还可能复用旧 traceLogger 文件追加），聚合后必然冲突。
    // 前端用 turnId 做 React key 与 assistant 消息的 thinkingId 匹配，重复 turnId 会导致
    // 思考轮错配 / 部分内容丢失（find 只命中首个同名 turnId）。故按聚合顺序重映射为全局
    // 唯一 id，并同步重写对应 assistant 消息的 thinkingId 指向新 id，确保前端关联正确。
    let seq = 0;
    for (const f of jsonlFiles) {
      try {
        const content = await readFile(join(traceDir, f), 'utf8');
        const part = TraceLogger.parseReplay(content);
        if (!part) continue;
        const remap = new Map<number, number>();
        for (const t of part.thinking) {
          const newId = ++seq;
          remap.set(t.turnId, newId);
          allThinking.push({ ...t, turnId: newId });
        }
        for (const m of part.messages) {
          if (typeof m.thinkingId === 'number' && remap.has(m.thinkingId)) {
            allMessages.push({ ...m, thinkingId: remap.get(m.thinkingId)! });
          } else {
            allMessages.push(m);
          }
        }
      } catch {
        // 单个文件读取失败（如被 TraceLogger 刷盘锁临时占用）跳过，不拖累整体聚合
        continue;
      }
    }
    return allMessages.length > 0 || allThinking.length > 0
      ? { messages: allMessages, thinking: allThinking }
      : null;
  }

  /**
   * P6 断点续跑：解析最近的 trace，返回可恢复的会话消息 + 已落盘文件清单 + 任务目标。
   * - messages：复用 parseReplay 重建的对话历史（不含 system）。
   * - filesWritten：从 tool_result 输出抽取「已创建文件 / 已修改 / 已删除」的路径，
   *   供续跑时告诉模型「这些文件已存在，不要重复创建」。
   * - lastGoal：最近一条 user_input 的内容（任务原始目标）。
   * 若无可恢复内容则返回 { messages: null, filesWritten: [], lastGoal: '' }。
   */
  static async replayMeta(workspaceDir?: string): Promise<{
    messages: ChatMessage[] | null;
    filesWritten: string[];
    lastGoal: string;
  }> {
    const traceDir = join(workspaceDir ?? process.cwd(), '.dsa', 'traces');
    let filesWritten: string[] = [];
    let lastGoal = '';
    try {
      const files = await readdir(traceDir);
      const jsonlFiles = files.filter((f) => f.endsWith('.jsonl')).sort().reverse();
      if (jsonlFiles.length > 0) {
        const content = await readFile(join(traceDir, jsonlFiles[0]), 'utf8');
        for (const line of content.split('\n').filter((l) => l.trim())) {
          let ev: TraceEvent;
          try {
            ev = JSON.parse(line) as TraceEvent;
          } catch {
            continue;
          }
          if (ev.type === 'user_input') lastGoal = String(ev.payload.input ?? '');
          else if (ev.type === 'tool_result') {
            const out = String(ev.payload.output ?? '');
            const m = out.match(/(?:已创建文件|已修改|已删除):\s*(\S+)/);
            if (m) filesWritten.push(m[1]);
          }
        }
      }
    } catch {
      /* 目录不存在或读取失败 */
    }
    const messages = await TraceLogger.replay(workspaceDir);
    return { messages, filesWritten: [...new Set(filesWritten)], lastGoal };
  }

  private static parseReplay(content: string): ReplayedConversation | null {
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    const messages: ReplayedMessage[] = [];
    const thinking: ReplayedThinkingTurn[] = [];
    let pendingToolCalls: Array<{ id: string; name: string }> = [];
    /** 当前进行中的思考轮次（thinking_start → thinking_end 之间非空） */
    let activeTurn: ReplayedThinkingTurn | null = null;
    /** 最近一次开轮的 id（即便已结束也保留），用于「序列化顺序无关」的兜底绑定 */
    let lastThinkingTurnId: number | null = null;

    for (const line of lines) {
      let ev: TraceEvent;
      try {
        ev = JSON.parse(line) as TraceEvent;
      } catch {
        continue;
      }
      switch (ev.type) {
        case 'user_input':
          messages.push({ role: 'user', content: String(ev.payload.input ?? ''), ts: ev.timestamp });
          break;
        case 'assistant_message': {
          const content = String(ev.payload.content ?? '');
          const raw = ev.payload.toolCalls;
          let tool_calls: ToolCall[] | undefined;
          if (Array.isArray(raw) && raw.length > 0) {
            tool_calls = (raw as Array<{ id: string; name: string; arguments: unknown }>).map((t) => ({
              id: String(t.id),
              type: 'function',
              function: { name: String(t.name), arguments: typeof t.arguments === 'string' ? t.arguments : JSON.stringify(t.arguments ?? {}) },
            }));
            pendingToolCalls = (raw as Array<{ id: string; name: string }>).map((t) => ({ id: String(t.id), name: String(t.name) }));
          }
          // 关键：无工具调用时绝不发送空数组 tool_calls（DeepSeek API 报 400）
          const msg: ReplayedMessage = tool_calls
            ? { role: 'assistant', content, tool_calls, ts: ev.timestamp }
            : { role: 'assistant', content, ts: ev.timestamp };
          // 绑定思考轮次：仅最终答复（无工具调用）归属思考轮——工具轮不单独成泡，
          // 其推理文字已作为 reason 条目落入思考盒（由 thinking_entry 持久化）。
          // 优先绑定「仍在进行中」的轮（activeTurn）；若思考轮已结束（thinking_end 先落盘）
          // 则回退到最近一次开轮的 id（lastThinkingTurnId），使重放与序列化顺序无关、更稳健。
          if (!tool_calls) msg.thinkingId = activeTurn ? activeTurn.turnId : (lastThinkingTurnId ?? undefined);
          messages.push(msg);
          break;
        }
        case 'tool_result': {
          const toolCallId = String(ev.payload.toolCallId ?? pendingToolCalls[0]?.id ?? 'unknown');
          const name = String(ev.payload.name ?? pendingToolCalls.shift()?.name ?? 'tool');
          const content = String(ev.payload.output ?? ev.payload.reason ?? '');
          messages.push({ role: 'tool', tool_call_id: toolCallId, name, content, ts: ev.timestamp });
          break;
        }
        // ── 思考盒持久化回放 ──
        case 'thinking_start': {
          const turnId = Number(ev.payload.turnId);
          activeTurn = { turnId, status: 'thinking', entries: [] };
          lastThinkingTurnId = turnId;
          thinking.push(activeTurn);
          break;
        }
        case 'thinking_entry': {
          if (activeTurn) {
            activeTurn.entries.push({
              id: Number(ev.payload.id),
              kind: (ev.payload.kind as ReplayedThinkingEntry['kind']) ?? 'reason',
              title: ev.payload.title !== undefined ? String(ev.payload.title) : undefined,
              text: String(ev.payload.text ?? ''),
            });
          }
          break;
        }
        case 'thinking_update': {
          if (activeTurn) {
            const e = activeTurn.entries.find((x) => x.id === Number(ev.payload.id));
            if (e) e.text += String(ev.payload.append ?? '');
          }
          break;
        }
        case 'thinking_status': {
          if (activeTurn) activeTurn.status = (ev.payload.status as ReplayedThinkingTurn['status']) ?? activeTurn.status;
          break;
        }
        case 'thinking_end': {
          // 思考轮结束：把当前轮状态置为 done，否则重放时停留 thinking，
          // 服务器重启后思考卡会显示成「进行中」而非已完成 —— 渲染状态未完整恢复。
          if (activeTurn) activeTurn.status = 'done';
          activeTurn = null;
          break;
        }
        default:
          break;
      }
    }
    return messages.length > 0 || thinking.length > 0 ? { messages, thinking } : null;
  }

  private async ensureDir(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
  }
}

/** 读取文件首行（辅助函数） */
async function readFileFirstLine(path: string): Promise<string> {
  // 简化实现：读整个文件取第一行（trace 文件通常不大）
  try {
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(path, 'utf8');
    return content.split('\n')[0];
  } catch {
    return '{}';
  }
}
