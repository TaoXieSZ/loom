/**
 * host 测试:SSE 发射 + 全链路服务。
 *
 * 亮点是【往返测试】:host 发出的 SSE,用 @loom/protocol 【自己的】 frameDecoder
 * 读回来,证明发射与解析用同一套协议原语、严丝合缝。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { frameDecoder } from "@loom/protocol";
import type { TurnEvent } from "@loom/loop";
import { sseFrame, sseDone, pipeEventsToSse } from "./sse.js";

const SAMPLE: TurnEvent[] = [
  { type: "text_delta", text: "深圳" },
  { type: "text_delta", text: "今天 31°C" },
  { type: "usage", input: 9, output: 6 },
  { type: "turn_end", reason: "stop", text: "深圳今天 31°C" },
];

test("单个事件 → 一个 data: 帧", () => {
  assert.equal(
    sseFrame({ type: "text_delta", text: "hi" }),
    'data: {"type":"text_delta","text":"hi"}\n\n'
  );
  assert.equal(sseDone(), "data: [DONE]\n\n");
});

test("往返:发射的 SSE 能被我们自己的 frameDecoder 原样读回", async () => {
  // 1. 发射
  let wire = "";
  async function* gen() {
    for (const e of SAMPLE) yield e;
  }
  await pipeEventsToSse(gen(), (c) => (wire += c));

  // 2. 用 @loom/protocol 的 frameDecoder 解析这串字节
  const dec = frameDecoder();
  const payloads = [
    ...dec.push(new TextEncoder().encode(wire)),
    ...dec.flush(),
  ];

  // 3. 帧 payload 解析回 TurnEvent,应与原始一致
  const back = payloads.map((p) => JSON.parse(p));
  assert.deepEqual(back, SAMPLE);
  assert.equal(dec.sawDone, true, "应识别到 [DONE] 哨兵");
});

test("往返在任意字节切分下都成立(多字节中文)", async () => {
  let wire = "";
  async function* gen() {
    yield { type: "text_delta", text: "圳圳圳深圳" } as TurnEvent;
    yield { type: "turn_end", reason: "stop", text: "圳圳圳深圳" } as TurnEvent;
  }
  await pipeEventsToSse(gen(), (c) => (wire += c));
  const bytes = new TextEncoder().encode(wire);
  // 逐字节喂,最狠的多字节切分
  const dec = frameDecoder();
  const payloads: string[] = [];
  for (let i = 0; i < bytes.length; i++)
    for (const p of dec.push(bytes.subarray(i, i + 1))) payloads.push(p);
  for (const p of dec.flush()) payloads.push(p);
  const back = payloads.map((p) => JSON.parse(p));
  assert.equal(back[0].text, "圳圳圳深圳", "中文不该乱码");
});
