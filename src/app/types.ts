/**
 * 共享类型：UI 层（ink CLI）与自研内核（src/core）之间的契约。
 *
 * 全部 type-only 导入，不含运行时依赖。
 * 内核重写（docs/重设计方案 决策 D1）后，原 Pi 的 agent/models 两字段
 * 由 kernel + 内核支撑单例取代；UI 消费的事件契约（CoreEvent）逐字段不变。
 */
import type { AgentKernel } from '../core/loop/kernel.ts';
import type { ModelHub } from '../core/provider/hub.ts';
import type { ToolRegistry } from '../core/tools/registry.ts';
import type { OutboundLedger } from '../core/provider/ledger.ts';
import type { TraceSink } from '../core/trace/sink.ts';
import type { SessionStore } from '../core/session/store.ts';

/** 消息角色（UI 与内核共用） */
export type MsgRole = 'user' | 'assistant' | 'tool' | 'system' | 'error';

/** 时间线节点类别（app/timeline.ts fold 的产物；渲染层按此选呈现方式） */
export type NodeKind = 'user' | 'answer' | 'progress' | 'step' | 'notice' | 'error';

/** UI 层展示的一条消息 */
export interface UiMessage {
  id: number;
  role: MsgRole;
  /** 折叠后的节点类别；旧式 ctx.push 产物可缺省（渲染层按 role 兜底） */
  kind?: NodeKind;
  text: string;
  /** 任务级标记：progress=过程叙述（暗显），final=最终答复（正常） */
  phase?: 'progress' | 'final';
  /** 该气泡因用户中断而只生成了部分内容 */
  interrupted?: boolean;
  /** 消息发生时间（ISO 字符串），用于时间线展示 */
  ts?: string;
}

/** 内核注入 UI 的 props 契约（core/assemble.ts 负责装配） */
export interface AppProps {
  /** 自研内核（持久化上下文 + ReAct 循环） */
  kernel: AgentKernel;
  /** 模型中枢（多厂商路由 + 出站记账出口） */
  hub: ModelHub;
  /** 工具注册表（system prompt 工具段的唯一来源） */
  registry: ToolRegistry;
  /** 出站留档（/outbound 命令） */
  ledger: OutboundLedger;
  /** 事件流落盘 */
  trace: TraceSink;
  /** 会话持久化（回合末快照内核消息列；启动时恢复） */
  session: SessionStore;
  /** 启动时从会话文件恢复的内核消息条数（0 = 新会话） */
  restoredCount: number;
  /** 应用版本号（来自 package.json） */
  version: string;
  /**
   * Agent 工作空间（read/write/edit/bash 的工作根；/rollback 配置根均以此为准）。
   * 与源码目录（protectedRoots）隔离——见 docs/UX优化-工作空间路径规划与源码目录保护.md
   */
  workspace: string;
}
