/**
 * OutboundLedger —— 出站记账（数据安全第 3 条：外传透明、本地留档、可导出）。
 *
 * 位置选择是设计要点：记账挂在 ModelHub 的唯一出口上，
 * 因此**任何**模型调用（actor / critic / cheap、任何 provider）结构性不可绕过。
 *
 * 记录什么（默认）：时间、目标端点、模型、请求体积、逐条消息体积与角色、正文摘要哈希。
 * 默认**不记录正文**——留档的是「传了什么出去」的元数据，而非内容本身，
 * 避免审计日志自身变成第二份数据泄漏面。
 * 用户显式开启 debug（DSA_OUTBOUND_DEBUG=1）后，正文另存
 *   ~/.dsa/outbound/payloads/<id>.json 并在记录里留路径。
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Msg } from '../types.ts';

export interface OutboundRecord {
  id: string;
  ts: string;
  provider: string;
  model: string;
  endpoint: string;
  /** 请求体字节数（序列化后） */
  bytes: number;
  /** 请求体 SHA-256；正文未留档时用于「同内容可比对」 */
  payloadSha256: string;
  /** 逐条消息的角色与体积（不含正文） */
  messages: Array<{ role: string; bytes: number }>;
  /** 是否包含工具定义及其数量 */
  toolsIncluded: boolean;
  toolCount: number;
  /** debug 模式下正文落盘路径 */
  fullPayloadPath?: string;
  /**
   * 本次外发状态：
   * sent=请求体已生成并落档（发出前记录）；error=该次调用失败；ok=历史兼容值。
   */
  status?: 'sent' | 'ok' | 'error';
  errorCategory?: string;
}

/** 出站目录：默认 ~/.dsa/outbound，测试可注入临时目录 */
export function outboundDir(base?: string): string {
  return resolve(base ?? process.env.DSA_OUTBOUND_DIR ?? join(homedir(), '.dsa', 'outbound'));
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf-8');
}

export class OutboundLedger {
  private readonly dir: string;
  private readonly debugPayloads: boolean;

  constructor(opts?: { dir?: string; debugPayloads?: boolean } | string) {
    const o = typeof opts === 'string' ? { dir: opts } : (opts ?? {});
    this.dir = outboundDir(o.dir);
    this.debugPayloads =
      o.debugPayloads ?? /^(1|true|yes)$/i.test(process.env.DSA_OUTBOUND_DEBUG ?? '');
  }

  get directory(): string {
    return this.dir;
  }

  /**
   * 记一次外发。body 为最终发给 provider 的原始请求体字符串，
   * 体积/哈希以它为准（即用户看到的字节数 = 网络上走的字节数）。
   */
  append(params: {
    provider: string;
    model: string;
    endpoint: string;
    body: string;
    messages: Msg[];
    toolCount: number;
    status?: 'sent' | 'ok' | 'error';
    errorCategory?: string;
  }): OutboundRecord {
    const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const rec: OutboundRecord = {
      id,
      ts: new Date().toISOString(),
      provider: params.provider,
      model: params.model,
      endpoint: params.endpoint,
      bytes: byteLen(params.body),
      payloadSha256: createHash('sha256').update(params.body, 'utf-8').digest('hex'),
      messages: params.messages.map((m) => ({
        role: m.role,
        bytes: byteLen(m.content) + (m.toolCalls ? byteLen(JSON.stringify(m.toolCalls)) : 0),
      })),
      toolsIncluded: params.toolCount > 0,
      toolCount: params.toolCount,
      status: params.status,
      errorCategory: params.errorCategory,
    };

    if (this.debugPayloads) {
      const pdir = join(this.dir, 'payloads');
      mkdirSync(pdir, { recursive: true });
      const fp = join(pdir, `${id}.json`);
      writeFileSync(fp, params.body, 'utf-8');
      rec.fullPayloadPath = fp;
    }

    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, monthFile(rec.ts)), JSON.stringify(rec) + '\n', 'utf-8');
    return rec;
  }

  /** 读取指定月份（YYYY-MM）的记录；无文件返回空数组。 */
  read(month?: string): OutboundRecord[] {
    const fp = join(this.dir, monthFile(month ?? new Date().toISOString()));
    try {
      return readFileSync(fp, 'utf-8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as OutboundRecord);
    } catch {
      return [];
    }
  }

  /** 导出全部留档到目标目录（原样拷贝 JSONL + payloads）。 */
  exportDir(target: string): { dir: string; files: number; totalBytes: number } {
    mkdirSync(target, { recursive: true });
    let files = 0;
    let totalBytes = 0;
    const walk = (src: string, dst: string): void => {
      mkdirSync(dst, { recursive: true });
      for (const name of readdirSync(src)) {
        const s = join(src, name);
        const st = statSync(s);
        if (st.isDirectory()) walk(s, join(dst, name));
        else {
          copyFileSync(s, join(dst, name));
          files += 1;
          totalBytes += st.size;
        }
      }
    };
    walk(this.dir, target);
    return { dir: target, files, totalBytes };
  }

  /** 人类可读摘要（/outbound 命令用）。 */
  summarize(month?: string): string {
    const recs = this.read(month);
    if (recs.length === 0) return '出站留档为空（本目录尚无记录）。';
    const byProvider = new Map<string, { n: number; bytes: number }>();
    for (const r of recs) {
      const k = `${r.provider}/${r.model}`;
      const cur = byProvider.get(k) ?? { n: 0, bytes: 0 };
      cur.n += 1;
      cur.bytes += r.bytes;
      byProvider.set(k, cur);
    }
    const total = recs.reduce((a, r) => a + r.bytes, 0);
    const lines = [
      `📤 出站留档（${monthFile(recs[0]!.ts)}）：共 ${recs.length} 次调用，累计 ${(total / 1024).toFixed(1)} KB`,
      ...[...byProvider.entries()].map(
        ([k, v]) => `   ${k}：${v.n} 次，${(v.bytes / 1024).toFixed(1)} KB`,
      ),
      this.debugPayloads ? '   ⚠ 正文留档已开启（DSA_OUTBOUND_DEBUG）' : '   正文未留档，仅记录体积与哈希',
    ];
    return lines.join('\n');
  }
}

function monthFile(ts: string): string {
  return ts.slice(0, 7) + '.jsonl';
}
