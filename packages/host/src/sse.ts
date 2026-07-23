/**
 * SSE 发射器 —— host 层的教学核心。
 *
 * 对称之美:@loom/protocol 里我们写过 SSE **解析器**(frameDecoder/eventDecoder),
 * 用来【读】DeepSeek 的流。host 干的正好反过来——把 runTurn 吐出的 TurnEvent 流,
 * 以 SSE 【写】给 dispatch。同一个协议,相反方向。
 *
 * 关键选择:用和上游一样的 `data: {json}\n\n` + `data: [DONE]` 格式(不是 SSE 的
 * `event:` 字段)。因为 TurnEvent 自带 `type` 字段,类型已经在 payload 里。这样发出去的
 * 流能被我们【自己的】 frameDecoder 原样读回来——发射与解析用同一套协议原语,
 * 往返测试就能证明这两半严丝合缝(见 sse.test.ts)。
 */

import type { TurnEvent } from "@loom/loop";

/** 一个 TurnEvent → 一个 SSE 帧。 */
export function sseFrame(event: TurnEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** 流终止哨兵。和上游同一个 [DONE](第一课 §2)——正式的收尾信号。 */
export function sseDone(): string {
  return "data: [DONE]\n\n";
}

/** SSE 响应必须的头。no-cache + keep-alive,否则中间层可能缓冲住流。 */
export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  // 关掉 nginx 一类反代的缓冲,否则流式会被攒成一坨
  "X-Accel-Buffering": "no",
} as const;

/**
 * 把一个 TurnEvent 异步流写成 SSE,逐事件 flush。
 * write 是注入的(测试塞数组收集器,生产塞 res.write)——host 层也保持可测。
 */
export async function pipeEventsToSse(
  events: AsyncIterable<TurnEvent>,
  write: (chunk: string) => void
): Promise<void> {
  for await (const ev of events) {
    write(sseFrame(ev));
  }
  write(sseDone());
}
