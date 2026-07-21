/**
 * openai-compat SSE 解析器 —— 两级，纯逻辑，零 IO。
 *
 * 第一级 frameDecoder：字节流 → SSE 帧（一行 `data: ...`）。
 * 第二级 parseCompletionStream：帧 → CompletionEvent（语义事件）。
 *
 * 教学主线（第一课 §2-4）：**为什么是增量状态机，而不是 raw.split("\n\n")**——
 * split 假设"全部数据已经在手里"，而流式的第一原则是"数据一段段来"：
 *   - 一个网络 chunk 可能是半帧（要缓冲等下一段）也可能是多帧（要循环切分）；
 *   - 多字节 UTF-8 字符（"圳" = 3 字节）可能被 chunk 切两半，先 toString 会得到乱码。
 * 所以底层必须是"喂字节 → 攒缓冲 → 吐完整帧"的状态机，边界由它自己判定，不信任 chunk 边界。
 */

import type { CompletionEvent, FinishReason } from "./types.js";

/** 未知/异常输入时的留痕钩子（Q2 宽进严出）。默认 console.warn，可注入以便测试断言。 */
export type Warn = (msg: string, detail?: unknown) => void;
const defaultWarn: Warn = (m, d) => console.warn(`[loom/protocol] ${m}`, d ?? "");

// ── 第一级：字节流 → SSE 帧 ────────────────────────────────────────────

const DONE = "[DONE]";

/**
 * 增量帧解码器。喂进任意切分的 Uint8Array，吐出完整帧的 payload（`data:` 后的内容）。
 * `[DONE]` 哨兵作为流结束标记，吐出后续帧一律忽略。
 *
 * 用法：
 *   const dec = frameDecoder();
 *   for await (const chunk of byteStream) for (const payload of dec.push(chunk)) { ... }
 *   for (const payload of dec.flush()) { ... }   // 收尾残留
 */
export function frameDecoder(warn: Warn = defaultWarn) {
  // TextDecoder({stream:true}) 会把切在多字节字符中间的尾字节留在内部，
  // 下次 decode 时接上——这正是"圳被切两半"问题的标准解法，我们不用自己拼字节。
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let done = false;

  /** 从行缓冲里切出所有已完整的帧 payload；不完整的行留在 buf 里。 */
  function* drain(final: boolean): Generator<string> {
    // SSE 帧以换行分隔。我们按行处理：一行 `data: X` 是一帧，空行是帧分隔（跳过），
    // `:` 开头是注释行（keep-alive，跳过）。用 \n 切，行尾可能带 \r（CRLF）要削掉。
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const framed = handleLine(line);
      if (framed !== undefined) yield framed;
    }
    // final 时把残留的最后一行（没有结尾换行）也处理掉。
    if (final && buf.length > 0) {
      const framed = handleLine(buf.endsWith("\r") ? buf.slice(0, -1) : buf);
      buf = "";
      if (framed !== undefined) yield framed;
    }
  }

  /** 单行 → 帧 payload（或 undefined 表示这行不产出帧）。 */
  function handleLine(line: string): string | undefined {
    if (done) return undefined; // [DONE] 之后的一切忽略
    if (line === "") return undefined; // 帧分隔空行
    if (line.startsWith(":")) return undefined; // 注释行 / keep-alive
    if (!line.startsWith("data:")) {
      // openai-compat 流里我们只关心 data: 行。event:/id: 等 SSE 字段不该出现在这个 API，
      // 出现了按 Q2 忽略+留痕，不硬失败（可能是代理注入的）。
      warn("non-data SSE line ignored", line.slice(0, 80));
      return undefined;
    }
    // `data:` 后按 SSE 规范去掉一个可选前导空格。
    const payload = line.slice(5).replace(/^ /, "");
    if (payload === DONE) {
      done = true;
      return undefined;
    }
    return payload;
  }

  return {
    push(chunk: Uint8Array): string[] {
      buf += decoder.decode(chunk, { stream: true });
      return [...drain(false)];
    },
    /** 流结束时调用：冲掉 decoder 内残留字节 + 处理最后一行。 */
    flush(): string[] {
      buf += decoder.decode(); // 无参 decode = 收尾，吐出任何残留
      return [...drain(true)];
    },
    get sawDone() {
      return done;
    },
  };
}

// ── 第二级：帧 payload → CompletionEvent ───────────────────────────────

/** 拼装中的一个 tool_call（按 index 分桶累积，直到 finish 才成型）。 */
interface PendingTool {
  id: string;
  name: string;
  args: string; // arguments 碎片依序拼接的字符串，中途不可 parse
}

/**
 * 增量事件解码器：喂一个帧 payload → 吐 0..n 个语义事件。
 *
 * 形状刻意与 frameDecoder 对称（push/end），因为它们要串成流水线：
 *   字节 →[frameDecoder]→ 帧 payload →[eventDecoder]→ 语义事件
 * 两级都能"边到边吐"，所以模型的第一个字可以立刻推给飞书卡片，不必等整轮结束。
 *
 * 状态（pending tool_calls / finished）活在闭包里，跨 push 调用累积——
 * 这正是不能写成"每次调用新建状态的纯函数"的原因。
 */
export function eventDecoder(warn: Warn = defaultWarn) {
  const pending = new Map<number, PendingTool>(); // index → 拼装中的 tool_call
  let finished = false;

  function push(payload: string): CompletionEvent[] {
    const events: CompletionEvent[] = [];
    let chunk: any;
    try {
      chunk = JSON.parse(payload);
    } catch {
      // Q2：单帧 JSON 坏了是异常但非致命——留痕跳过，不拖垮整条流。
      warn("unparseable SSE data payload skipped", payload.slice(0, 120));
      return events;
    }

    // 根基性校验（Q2 快失败）：choices 必须是数组。usage-only 帧的 choices 是 []，允许。
    const choices = chunk.choices;
    if (choices !== undefined && !Array.isArray(choices)) {
      throw new Error(
        `loom/protocol: malformed chunk — choices is not an array (got ${typeof choices})`
      );
    }

    // usage 帧：choices 为空、带 usage。独立事件（Q3），不与 finish 合并。
    if (chunk.usage) {
      const u = chunk.usage;
      events.push({
        type: "usage",
        input: u.prompt_tokens ?? 0,
        output: u.completion_tokens ?? 0,
      });
    }

    const choice = choices?.[0];
    if (!choice) return events; // usage-only 帧到此为止

    const delta = choice.delta ?? {};

    // 正文增量。
    if (typeof delta.content === "string" && delta.content.length > 0) {
      events.push({ type: "text_delta", text: delta.content });
    }

    // 思考流（真机确证存在，课件 §7）。独立事件，不混入正文。
    if (
      typeof delta.reasoning_content === "string" &&
      delta.reasoning_content.length > 0
    ) {
      events.push({ type: "reasoning_delta", text: delta.reasoning_content });
    }

    // tool_call 碎片：按 index 分桶累积（第一课 §3 核心算法）。
    if (Array.isArray(delta.tool_calls)) {
      for (const frag of delta.tool_calls) {
        // 根基性校验（Q2 快失败）：碎片必须带 index，否则无法归桶。
        if (typeof frag.index !== "number") {
          throw new Error(
            "loom/protocol: malformed tool_call fragment — missing numeric index"
          );
        }
        const slot = pending.get(frag.index) ?? { id: "", name: "", args: "" };
        if (frag.id) slot.id = frag.id;
        if (frag.function?.name) slot.name = frag.function.name;
        if (typeof frag.function?.arguments === "string") {
          slot.args += frag.function.arguments; // 依序拼接，绝不中途 parse
        }
        pending.set(frag.index, slot);
      }
    }

    // finish_reason：本轮定性 + tool_call 成型时机。
    const raw = choice.finish_reason;
    if (raw != null) {
      const reason = normalizeFinish(raw, warn);
      // Q1：只有 tool_calls 收尾时，才把攒好的 tool_call 吐出去（且必须 parse 成功）。
      // stop/length 都不吐半截 tool_call——length 截断的 args 是坏的，吐了就是埋雷。
      if (reason === "tool_calls") {
        for (const [, t] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
          let args: unknown;
          try {
            args = JSON.parse(t.args);
          } catch {
            // 声称 tool_calls 收尾却给了坏 JSON：留痕跳过这一个，不崩整轮。
            warn("tool_call with unparseable arguments dropped", {
              name: t.name,
              args: t.args.slice(0, 120),
            });
            continue;
          }
          events.push({ type: "tool_call", id: t.id, name: t.name, args });
        }
      }
      pending.clear();
      events.push({ type: "finish", reason });
      finished = true;
    }

    return events;
  }

  /** 流结束时调用。本身不产出事件，只在缺 finish 时留痕（"签名 vs 告别"）。 */
  function end(): CompletionEvent[] {
    // 流结束却没见过任何 finish：协议层面不完整（连接被掐？）。
    // 注意：缺 `[DONE]` 无害——它只是礼貌的告别；finish_reason 才是正式的签名。
    if (!finished) warn("stream ended without a finish event", undefined);
    return [];
  }

  return { push, end };
}

/**
 * 批量版：一次吃完所有帧 payload，返回完整事件数组。
 * fixture 回放与测试用这个；真实流式走 eventDecoder。
 */
export function parseCompletionStream(
  payloads: Iterable<string>,
  warn: Warn = defaultWarn
): CompletionEvent[] {
  const decoder = eventDecoder(warn);
  const events: CompletionEvent[] = [];
  for (const payload of payloads) events.push(...decoder.push(payload));
  events.push(...decoder.end());
  return events;
}

/** finish_reason 归一。未知值按 Q2 保守当 stop（防 loop 死循环），并留痕。 */
function normalizeFinish(raw: unknown, warn: Warn): FinishReason {
  if (raw === "stop" || raw === "tool_calls" || raw === "length") return raw;
  warn(`unknown finish_reason "${String(raw)}" treated as stop`, undefined);
  return "stop";
}
