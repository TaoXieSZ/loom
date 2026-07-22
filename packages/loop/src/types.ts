/**
 * ② 层的契约：工具、授权、审批、回合事件。
 *
 * 设计要点（蓝图 D6 + OpenClaw/Hermes 调研）：
 *  - **构造式能力**：工具列表由 grants 生成。没授权的工具压根不出现在发给模型的
 *    tools 数组里——不是"拒绝执行"，是"它不存在"。模型无从想象一个它没见过的工具。
 *  - **approve-what-executes 绑定**：审批请求带一个 (name+args) 指纹，执行前重新
 *    计算并比对。审批要绕一圈飞书再回来，这一圈里没人能把"批准 ls"换成别的。
 *  - **分级授权**：抄 OpenClaw 的反审批疲劳设计。每次都问 = 用户条件反射点同意 =
 *    审批变成剧场，安全价值变负数。
 */

import type {
  CompletionEvent,
  CompletionRequest,
  FinishReason,
  ToolDef,
} from "@loom/protocol";

// ── 工具 ───────────────────────────────────────────────────────────────

/** 工具执行时能拿到的上下文（先放最小集，M2 加 agent home / memory）。 */
export interface ToolContext {
  agentId: string;
  /** 本次调用的审批指纹；工具想审计自己被批准过什么时可用。 */
  fingerprint: string;
}

/**
 * 一个可执行工具。`def` 是给模型看的 JSON Schema，`run` 是真正干活的。
 *
 * `defaultMode` 让**工具自己声明风险**（shell 天然是 "ask"，memory_search 天然是
 * "always"），grants 再按 agent 覆盖。风险知识属于工具，策略属于 agent 配置。
 */
export interface ToolSpec {
  def: ToolDef;
  run(args: unknown, ctx: ToolContext): Promise<string>;
  defaultMode?: GrantMode;
}

export type ToolRegistry = Record<string, ToolSpec>;

// ── 授权 ───────────────────────────────────────────────────────────────

/**
 * - `always` 直接执行，不打扰人
 * - `ask`    每次都要人批
 * - `auto`   先过自动审阅器，拿不准才升级给人（审阅器未接入时等同 `ask`）
 */
export type GrantMode = "always" | "ask" | "auto";

export interface Grant {
  /** 不写则用工具自己的 defaultMode，工具也没写则按 `ask`（保守优先）。 */
  mode?: GrantMode;
}

/** key = 工具名。**不在这个表里的工具 = 对该 agent 不存在。** */
export type Grants = Record<string, Grant>;

// ── 审批 ───────────────────────────────────────────────────────────────

export interface ApprovalRequest {
  /** 本次工具调用的 id（来自模型），用于和飞书卡片对账。 */
  callId: string;
  toolName: string;
  args: unknown;
  /** (name, args) 的 sha256 前 16 位。verdict 必须带回同一个值。 */
  fingerprint: string;
  agentId: string;
}

/**
 * 审批结论。`fingerprint` 必须回传——对不上就当拒绝（approve-what-executes）。
 * OpenClaw 把这叫 "approval mismatch"，是防"批准 A 执行 B"的关键一环。
 */
export interface ApprovalVerdict {
  decision: "approve" | "deny";
  fingerprint: string;
  /** 谁批的（human principal）。留给 M2 写进 audit.log。 */
  approvedBy?: string;
}

// ── 回合事件（② 层对外的输出流）───────────────────────────────────────

export type TurnEndReason =
  | "stop" // 模型正常收尾
  | "truncated" // finish:length（Q1：如实上报，不自动重试）
  | "max_steps" // 撞到工具循环上限，防跑飞
  | "no_tool_calls"; // 声称要调工具却没有可用的调用（异常但不致命）

export type TurnEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_start"; callId: string; name: string; args: unknown }
  | { type: "approval_requested"; callId: string; name: string }
  | { type: "approval_settled"; callId: string; decision: "approve" | "deny" }
  | {
      type: "tool_end";
      callId: string;
      name: string;
      ok: boolean;
      result: string;
    }
  | { type: "usage"; input: number; output: number }
  | { type: "turn_end"; reason: TurnEndReason; text: string };

// ── 依赖注入 ───────────────────────────────────────────────────────────

/**
 * 注入 complete 而不是直接 import transport：② 层因此不含任何 IO，
 * 测试里塞个假模型就能跑完整循环。
 */
export type CompleteFn = (
  req: CompletionRequest,
  opts?: { signal?: AbortSignal }
) => AsyncIterable<CompletionEvent>;

export interface LoopDeps {
  complete: CompleteFn;
  /**
   * 拿人类裁决。不提供时，任何需要审批的工具一律拒绝（fail-closed，
   * 对应 OpenClaw 的 askFallback: deny）。
   */
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalVerdict>;
}

export interface TurnConfig {
  agentId: string;
  model: string;
  grants: Grants;
  tools: ToolRegistry;
  /** 工具循环上限，防模型无限自我调用。 */
  maxSteps?: number;
  /** 审批等待上限；超时按拒绝处理（把"重启后永久丢失"降级成"N 分钟后拒绝"）。 */
  approvalTimeoutMs?: number;
  signal?: AbortSignal;
}

export type { FinishReason };
