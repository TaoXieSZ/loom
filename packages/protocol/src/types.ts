/**
 * loom 协议契约 —— dispatch ↔ loom-host ↔ loop 三方共享的唯一真相。
 *
 * 这里只有类型，没有实现。谁引用 @loom/protocol，谁就同意按这些形状说话。
 * 分两半：
 *   - Request 侧：喂给 ① 层 complete() 的东西（照 openai-compat 线格式）。
 *   - Event 侧：① 层吐出来的**语义事件**——② 层（loop）只认这些，永远不碰 SSE/delta/index。
 */

// ── Request 侧（openai-compat 线格式的最小子集）─────────────────────────

/** 一条对话消息。role 决定其余字段的含义（见第一课 §1 的三段式工具往返）。 */
export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content?: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** assistant 发起的一次工具调用。arguments 是 JSON **字符串**（线上如此，不是对象）。 */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** 一个可被模型调用的工具的声明。parameters 是 JSON Schema。 */
export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

/** 一次补全请求。这是 ① 层 complete() 的入参形状。 */
export interface CompletionRequest {
  model: string;
  messages: Message[];
  tools?: ToolDef[];
}

// ── Event 侧（① 层的产出：语义事件流）──────────────────────────────────

/**
 * 为什么把 finish_reason 收成三个具名值而不是透传 string：
 * 这三个是 ② 层要**分诊**的（stop 收尾 / tool_calls 继续循环 / length 截断异常）。
 * 未知的 finish_reason 由解析器按 Q2 保守归一到 "stop"（避免 loop 死循环），并 warn 留痕。
 */
export type FinishReason = "stop" | "tool_calls" | "length";

/**
 * ① 层吐出的语义事件。② 层的整个世界就是消费这个 union。
 *
 * 设计原则（第一课 + grilling 三决定）：
 *   - text_delta / reasoning_delta 分开：思考流不入 assistant 正文（下一轮 messages 不含它），
 *     但对调试/审计有值。真机确证 deepseek-v4-flash 会先流 reasoning_content（课件 §7）。
 *   - tool_call **拼完整才吐**：args 已 parse 成对象；半截 arguments（含 length 截断）绝不吐。
 *   - finish 与 usage **各自独立**（Q3）：线上就是分开的两帧；usage 时序在 finish 之后到；
 *     M2 的 audit.log 要把 usage 当计费记录单独落盘 → 独立事件直接转发，不必缓冲合并。
 */
export type CompletionEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "finish"; reason: FinishReason }
  | { type: "usage"; input: number; output: number };
