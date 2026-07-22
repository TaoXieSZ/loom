/**
 * ① 层的 live 实现：把一次 openai-compat HTTP 请求变成语义事件流。
 *
 * 职责边界（本项目的设计决定）：**transport 只管一次请求**。
 * 它不重试、不退避、不排队——错误如实抛出，由 ② 层决定重不重来。
 * 为什么：只有 ② 层知道"这一轮能不能重来"。一旦工具已经执行过（发了消息、
 * 改了文件），重发同样的 messages 就是重复副作用；transport 看不见这件事。
 *
 * 流水线：fetch 字节 →[frameDecoder]→ 帧 →[eventDecoder]→ CompletionEvent
 * 全程增量：模型吐第一个字，调用方立刻就能拿到 text_delta 推给飞书卡片。
 */

import type { CompletionEvent, CompletionRequest } from "./types.js";
import { eventDecoder, frameDecoder, type Warn } from "./parse-sse.js";

/** 一个 openai-compat 供应商的接入配置。换 Kimi/GLM/本地 vLLM 就是改这里。 */
export interface ProviderConfig {
  /** 形如 https://api.deepseek.com/v1（不带尾斜杠）。 */
  baseUrl: string;
  apiKey: string;
  /** 可注入的 fetch（测试用假实现；生产留空走全局 fetch）。 */
  fetchImpl?: typeof fetch;
}

export interface CompleteOptions {
  /** 取消用：用户 /stop、审批被拒、上层超时都靠它掐断。 */
  signal?: AbortSignal;
  /** 输出长度上限。撞上会得到 finish:length（Q1：如实上报，不自动重试）。 */
  maxTokens?: number;
  warn?: Warn;
}

/**
 * HTTP 层失败。带 `retriable` 供 ② 层分诊——**是建议，不是行动**：
 * transport 自己永远不重试。
 */
export class CompletionHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(`loom/protocol: completion request failed with HTTP ${status}`);
    this.name = "CompletionHttpError";
  }

  /** 429（限流）与 5xx（上游故障）通常值得重试；4xx 多是我们自己的请求有问题。 */
  get retriable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/**
 * 发一次补全请求，产出语义事件流。
 *
 * @example
 *   for await (const ev of complete(cfg, { model, messages })) {
 *     if (ev.type === "text_delta") process.stdout.write(ev.text);
 *   }
 */
export async function* complete(
  cfg: ProviderConfig,
  req: CompletionRequest,
  opts: CompleteOptions = {}
): AsyncGenerator<CompletionEvent> {
  const doFetch = cfg.fetchImpl ?? globalThis.fetch;
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream: true,
    // 不带这个，流式响应里就没有 usage 帧（第一课 §1）。
    stream_options: { include_usage: true },
  };
  // 空 tools 数组会让某些实现困惑，没有工具就干脆不带这个字段。
  if (req.tools?.length) body.tools = req.tools;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;

  const res = await doFetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  if (!res.ok) {
    // 错误响应是普通 JSON/文本，不是 SSE。读出来带上，否则排查时只剩一个状态码。
    const text = await res.text().catch(() => "");
    throw new CompletionHttpError(res.status, text.slice(0, 2000));
  }
  if (!res.body) {
    throw new Error("loom/protocol: response has no body (expected SSE stream)");
  }

  const frames = frameDecoder(opts.warn);
  const events = eventDecoder(opts.warn);
  // 用 reader 而非 for-await：ReadableStream 的异步迭代在各运行时上支持不一，
  // getReader() 是各处都稳的那条路。
  const reader = res.body.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const payload of frames.push(value)) {
        for (const ev of events.push(payload)) yield ev;
      }
    }
    // 收尾：decoder 内部可能还压着最后一行（没有结尾换行的情况）。
    for (const payload of frames.flush()) {
      for (const ev of events.push(payload)) yield ev;
    }
    for (const ev of events.end()) yield ev;
  } finally {
    // 调用方提前 break 出 for-await 时，generator 的 finally 会跑到这里，
    // 确保 socket 被释放而不是泄漏。
    await reader.cancel().catch(() => {});
  }
}
