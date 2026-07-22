/**
 * ② 层：agent loop。
 *
 * 骨架就是第一课 §1 讲的三段式对话：
 *   while (模型说要调工具) { 执行; 把结果以 role:"tool" 回填 messages; 再发一次 }
 * 这个 while 就是"自有 loop"的全部含义——工具执行、上下文、能力边界都在我们手里，
 * 而不是租来的 SDK 里。
 */

import { createHash } from "node:crypto";
import type { Message, ToolDef } from "@loom/protocol";
import type {
  ApprovalVerdict,
  Grant,
  GrantMode,
  Grants,
  LoopDeps,
  ToolRegistry,
  ToolSpec,
  TurnConfig,
  TurnEvent,
} from "./types.js";

const DEFAULT_MAX_STEPS = 10;
const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000;
/** 工具报错回填给模型的文本上限，防一条堆栈把上下文吃光。 */
const MAX_TOOL_RESULT = 8_000;

/**
 * 构造式能力边界：只把**授权过且注册过**的工具描述给模型。
 * 没授权的工具不会出现在 tools 数组里——模型不知道它存在，也就无从调用。
 * 这比"调用了再拒绝"强：后者模型会反复尝试、反复失败、把上下文浪费在撞墙上。
 */
export function grantedTools(
  registry: ToolRegistry,
  grants: Grants
): ToolDef[] {
  const out: ToolDef[] = [];
  for (const name of Object.keys(grants)) {
    const spec = registry[name];
    // grants 里写了但注册表没有：配置写错了，静默跳过（不让 agent 直接起不来）
    if (spec) out.push(spec.def);
  }
  return out;
}

/** (name, args) 的稳定指纹。JSON 键序不稳，所以先规范化再哈希。 */
export function fingerprint(name: string, args: unknown): string {
  return createHash("sha256")
    .update(name)
    .update("\0")
    .update(stableStringify(args))
    .digest("hex")
    .slice(0, 16);
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map(
        (k) =>
          JSON.stringify(k) + ":" + stableStringify((v as any)[k])
      )
      .join(",") +
    "}"
  );
}

/** 工具声明风险 → grant 覆盖 → 都没说则按 ask（保守优先）。 */
function resolveMode(spec: ToolSpec, grant: Grant | undefined): GrantMode {
  return grant?.mode ?? spec.defaultMode ?? "ask";
}

/** 带超时的审批等待。超时 = 拒绝（fail-closed）。 */
async function awaitVerdict(
  deps: LoopDeps,
  req: Parameters<NonNullable<LoopDeps["requestApproval"]>>[0],
  timeoutMs: number
): Promise<ApprovalVerdict> {
  // 没接审批通道时一律拒绝——对应 OpenClaw 的 askFallback: deny。
  if (!deps.requestApproval) {
    return { decision: "deny", fingerprint: req.fingerprint };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      deps.requestApproval(req),
      new Promise<ApprovalVerdict>((resolve) => {
        timer = setTimeout(
          () => resolve({ decision: "deny", fingerprint: req.fingerprint }),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 跑一个回合：喂进历史消息，产出事件流，返回时 messages 已被就地更新。
 *
 * @param messages 会调用方的消息数组**就地追加**（assistant / tool 回合都写回去），
 *                 这样调用方拿到的就是可以直接存盘的完整会话。
 */
export async function* runTurn(
  deps: LoopDeps,
  cfg: TurnConfig,
  messages: Message[]
): AsyncGenerator<TurnEvent> {
  const maxSteps = cfg.maxSteps ?? DEFAULT_MAX_STEPS;
  const approvalTimeoutMs =
    cfg.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  const tools = grantedTools(cfg.tools, cfg.grants);

  for (let step = 0; step < maxSteps; step++) {
    let text = "";
    let finish: string | undefined;
    const calls: { id: string; name: string; args: unknown }[] = [];

    // ── 一次模型调用 ────────────────────────────────────────────────
    for await (const ev of deps.complete(
      {
        model: cfg.model,
        messages,
        ...(tools.length ? { tools } : {}),
      },
      cfg.signal ? { signal: cfg.signal } : {}
    )) {
      switch (ev.type) {
        case "text_delta":
          text += ev.text;
          yield { type: "text_delta", text: ev.text };
          break;
        case "reasoning_delta":
          // 思考流转发给上层（可显示可丢弃），但**不进 messages**：
          // 下一轮请求里没有它的位置，硬塞会污染上下文。
          yield { type: "reasoning_delta", text: ev.text };
          break;
        case "tool_call":
          calls.push({ id: ev.id, name: ev.name, args: ev.args });
          break;
        case "usage":
          yield { type: "usage", input: ev.input, output: ev.output };
          break;
        case "finish":
          finish = ev.reason;
          break;
      }
    }

    // ── Q1：截断如实上报，不入 messages、不自动重试 ──────────────────
    if (finish === "length") {
      yield { type: "turn_end", reason: "truncated", text };
      return;
    }

    // ── 模型要调工具：三段式对话的第二、三段 ─────────────────────────
    if (finish === "tool_calls" && calls.length > 0) {
      // 第一段：assistant 说"我要调这些工具"。必须先入 messages，
      // 否则后面的 role:"tool" 消息没有对应的 tool_call_id，模型会拒收。
      messages.push({
        role: "assistant",
        ...(text ? { content: text } : {}),
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      });

      for (const call of calls) {
        const result = yield* executeCall(deps, cfg, call, approvalTimeoutMs);
        // 第二段：工具结果回填。无论成功失败都要回填——
        // 模型需要知道发生了什么才能继续（失败时它可以换个方式重试）。
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result.slice(0, MAX_TOOL_RESULT),
        });
      }
      continue; // 第三段：带着工具结果再问一次模型
    }

    // 声称要调工具但一个可用调用都没有（都因 args 坏掉被丢了）。
    // 不 continue——否则会拿着同样的 messages 空转到 maxSteps。
    if (finish === "tool_calls") {
      messages.push({ role: "assistant", content: text });
      yield { type: "turn_end", reason: "no_tool_calls", text };
      return;
    }

    // ── 正常收尾 ────────────────────────────────────────────────────
    messages.push({ role: "assistant", content: text });
    yield { type: "turn_end", reason: "stop", text };
    return;
  }

  yield { type: "turn_end", reason: "max_steps", text: "" };
}

/**
 * 执行一次工具调用：授权检查 → （必要时）审批 → 执行 → 结果文本。
 * 返回值是要回填给模型的字符串；过程中的可观测事件通过 yield 吐给上层。
 */
async function* executeCall(
  deps: LoopDeps,
  cfg: TurnConfig,
  call: { id: string; name: string; args: unknown },
  approvalTimeoutMs: number
): AsyncGenerator<TurnEvent, string> {
  const spec = cfg.tools[call.name];
  const grant = cfg.grants[call.name];

  // 模型幻觉出一个没授权的工具名。如实告诉它，别假装执行了。
  if (!spec || !grant) {
    const msg = `Error: tool "${call.name}" is not available to this agent.`;
    yield { type: "tool_end", callId: call.id, name: call.name, ok: false, result: msg };
    return msg;
  }

  const fp = fingerprint(call.name, call.args);
  const mode = resolveMode(spec, grant);

  if (mode !== "always") {
    // `auto` 的自动审阅器还没接（M3），先按 ask 处理——保守方向的降级。
    yield { type: "approval_requested", callId: call.id, name: call.name };
    const verdict = await awaitVerdict(
      deps,
      {
        callId: call.id,
        toolName: call.name,
        args: call.args,
        fingerprint: fp,
        agentId: cfg.agentId,
      },
      approvalTimeoutMs
    );

    // approve-what-executes：批的必须正是要执行的那一个。
    // 指纹对不上说明请求在往返途中被改过（或串了别的审批），一律拒绝。
    const ok =
      verdict.decision === "approve" && verdict.fingerprint === fp;
    yield {
      type: "approval_settled",
      callId: call.id,
      decision: ok ? "approve" : "deny",
    };
    if (!ok) {
      const msg =
        verdict.decision === "approve"
          ? "Error: approval fingerprint mismatch — refused."
          : "Denied by the owner.";
      yield { type: "tool_end", callId: call.id, name: call.name, ok: false, result: msg };
      return msg;
    }
  }

  yield { type: "tool_start", callId: call.id, name: call.name, args: call.args };
  try {
    const result = await spec.run(call.args, {
      agentId: cfg.agentId,
      fingerprint: fp,
    });
    yield { type: "tool_end", callId: call.id, name: call.name, ok: true, result };
    return result;
  } catch (e) {
    // 工具抛错不该炸掉整个回合：把错误回填给模型，让它有机会换个方式。
    const msg = `Error: ${e instanceof Error ? e.message : String(e)}`;
    yield { type: "tool_end", callId: call.id, name: call.name, ok: false, result: msg };
    return msg;
  }
}
