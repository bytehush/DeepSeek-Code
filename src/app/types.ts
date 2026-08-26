/**
 * 共享类型：UI 层（ink CLI / 网页 DOM）与内核（Agent Loop）之间的契约。
 *
 * 这些类型只依赖内核模块的类型（全部 type-only 导入），不含任何运行时依赖，
 * 因此即便被「网页前端」以 `import type` 引入也绝不会把 Node 内核拉进浏览器包。
 */
import type { DeepSeekClient } from '../llm/deepseek.ts';
import type { ConversationHistory } from '../context/history.ts';
import type { TraceLogger } from '../context/trace.ts';
import type { SessionManager } from '../agent/session.ts';
import type { MemoryService } from '../memory/service.ts';
import type { SkillManager } from '../skills/loader.ts';
import type { Agent } from '@earendil-works/pi-agent-core';
import type { Models } from '@earendil-works/pi-ai';

/** 消息角色（UI 与内核共用） */
export type MsgRole = 'user' | 'assistant' | 'tool' | 'system' | 'error';

/** UI 层展示的一条消息 */
export interface UiMessage {
  id: number;
  role: MsgRole;
  text: string;
  /** P2-⑨ 任务级标记：progress=过程叙述（暗显），final=最终答复（正常） */
  phase?: 'progress' | 'final';
  /** 该答案气泡对应的「思考盒」轮次 id（仅最终答复气泡带，用于前端把思考卡渲染在气泡上方） */
  thinkingId?: number;
  /** 该气泡因用户中断而只生成了部分内容（前端展示「生成中断」徽章） */
  interrupted?: boolean;
  /** 前端唯一序号：服务端 msg.id 在多次 boot 时会从 0 重复，导致 React key 冲突与更新错配；
   *  前端为每条进入 state 的消息分配唯一 localId，作展示 key 与流式更新匹配依据。 */
  /** 消息发生时间（ISO 字符串），由存储层从 trace 事件 timestamp 提取，用于时间线展示 */
  ts?: string;
  localId?: number;
}

/** 内核注入 UI 的 props 契约（main.ts / assemble.ts 负责装配） */
export interface AppProps {
  client: DeepSeekClient;
  history: ConversationHistory;
  cfg: { apiKey: string; baseURL: string; model: string; reasonerModel?: string };
  traceLogger: TraceLogger;
  recentTraces: string[];
  sessionManager: SessionManager;
  /** P5: 启动时从磁盘恢复的历史会话数量（>0 时首屏提示） */
  restoredSessions?: number;
  /** 记忆层：跨会话用户记忆 + 轻量 RAG 预取 */
  memoryStore: MemoryService;
  /** 应用版本号（来自 package.json，避免与 package.json 多处不一致） */
  version: string;
  /** 技能子系统管理器（项目级 + 全局级，白名单过滤） */
  skillManager: SkillManager;
  /** Pi Agent 运行时实例（持久化，跨轮累积上下文）；P1 引擎切换后由内核驱动 */
  agent: Agent;
  /** Pi Models 实例（provider 已设 deepseekProvider） */
  models: Models;
}
