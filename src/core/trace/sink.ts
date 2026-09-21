/**
 * TraceSink —— 事件流落盘（可观测性地基，CoreEvent 的第二消费者）。
 *
 * 设计取舍：trace 就是 CoreEvent 的 JSONL 镜像，不自造第二套记录格式。
 * 好处：eval runner、事后复盘、UI 回放吃同一份数据；格式变更只需改事件契约一处。
 *
 * 落盘位置 ~/.dsa/traces/<session>.jsonl；写失败静默降级（观测不该搞挂主流程）。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CoreEvent } from '../loop/events.ts';
import type { Msg } from '../types.ts';

export interface TraceRecord {
  ts: string;
  session: string;
  turn: number;
  kind: 'event' | 'user_input' | 'assistant_final' | 'tool_exec' | 'compact' | 'permission' | 'end';
  event?: CoreEvent;
  detail?: unknown;
}

export class TraceSink {
  readonly session: string;
  private file: string | null = null;
  private dir: string;
  private turn = 0;
  private buffered: TraceRecord[] = [];

  constructor(dir?: string, session?: string) {
    this.dir = resolve(dir ?? join(homedir(), '.dsa', 'traces'));
    this.session = session ?? randomUUID().slice(0, 8);
  }

  get path(): string | null {
    return this.file;
  }

  /** 开启落盘（默认开；--no-trace 或 DSA_TRACE=0 时跳过） */
  start(meta: { workspace: string; version: string }): void {
    if (/^(0|false)$/i.test(process.env.DSA_TRACE ?? '')) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      this.file = join(this.dir, `${dateStamp()}-${this.session}.jsonl`);
      this.write({ ts: new Date().toISOString(), session: this.session, turn: 0, kind: 'end', detail: { boot: meta } });
    } catch {
      this.file = null;
    }
  }

  beginTurn(userInput: string): number {
    this.turn += 1;
    this.record('user_input', { text: userInput });
    return this.turn;
  }

  get currentTurn(): number {
    return this.turn;
  }

  record(kind: TraceRecord['kind'], detail?: unknown): void {
    this.write({
      ts: new Date().toISOString(),
      session: this.session,
      turn: this.turn,
      kind,
      detail,
    });
  }

  event(ev: CoreEvent): void {
    this.write({
      ts: new Date().toISOString(),
      session: this.session,
      turn: this.turn,
      kind: 'event',
      event: ev,
    });
  }

  /** 导出本轮完整消息（审计与 eval transcript 用） */
  snapshotMessages(messages: Msg[]): void {
    this.record('assistant_final', {
      count: messages.length,
      bytes: messages.reduce((a, m) => a + m.content.length, 0),
    });
  }

  private write(rec: TraceRecord): void {
    if (!this.file) {
      this.buffered.push(rec);
      if (this.buffered.length > 500) this.buffered.shift();
      return;
    }
    this.sink(rec);
  }

  /** 输出通道：默认 JSONL 追加；子类覆写可实现内存收集 */
  protected sink(rec: TraceRecord): void {
    try {
      appendFileSync(this.file as string, JSON.stringify(rec) + '\n', 'utf-8');
    } catch {
      /* 观测降级 */
    }
  }
}

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

/** 供测试用：内存 sink（不落盘，可断言记录序列）。经 newSink() 构造。 */
export class MemoryTraceSink extends TraceSink {
  readonly records: TraceRecord[] = [];
  private constructor() {
    super(join(process.cwd(), '.dsa-trace-disabled'), 'memtest');
  }
  static newSink(): MemoryTraceSink {
    return new MemoryTraceSink();
  }
  override start(): void {
    /* 不落盘 */
  }
  protected override sink(rec: TraceRecord): void {
    this.records.push(rec);
  }
}
