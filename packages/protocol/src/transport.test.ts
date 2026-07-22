/**
 * transport 测试：用注入的假 fetch 回放**真机 fixture 字节**。
 * 测的是完整流水线（HTTP 响应 → frameDecoder → eventDecoder → 事件），但不碰网络。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { complete, CompletionHttpError, type ProviderConfig } from "./transport.js";
import type { CompletionEvent } from "./types.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/** 造一个把 fixture 按 sliceSize 分块吐出的假 fetch（模拟网络分段到达）。 */
function fakeFetch(
  fixture: string,
  sliceSize = 64,
  captured?: { url?: string; init?: RequestInit }
): typeof fetch {
  const raw = readFileSync(join(FIX, fixture));
  return (async (url: any, init: any) => {
    if (captured) {
      captured.url = String(url);
      captured.init = init;
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < raw.length; i += sliceSize) {
          controller.enqueue(new Uint8Array(raw.subarray(i, i + sliceSize)));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
}

const cfg = (fetchImpl: typeof fetch): ProviderConfig => ({
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test",
  fetchImpl,
});

async function collect(gen: AsyncGenerator<CompletionEvent>) {
  const out: CompletionEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const REQ = { model: "deepseek-v4-flash", messages: [{ role: "user" as const, content: "hi" }] };

test("transport 端到端：真机 plain fixture → 事件流", async () => {
  const evs = await collect(complete(cfg(fakeFetch("plain.sse")), REQ));
  assert.ok(evs.some((e) => e.type === "text_delta"), "应有正文增量");
  assert.equal(evs.filter((e) => e.type === "finish").length, 1);
  assert.equal(evs.filter((e) => e.type === "usage").length, 1);
});

test("transport 端到端：工具调用 fixture → 完整 tool_call", async () => {
  const evs = await collect(complete(cfg(fakeFetch("toolcall.sse")), REQ));
  const tcs = evs.filter((e) => e.type === "tool_call") as Extract<
    CompletionEvent,
    { type: "tool_call" }
  >[];
  assert.equal(tcs.length, 1);
  assert.equal(tcs[0]!.name, "get_weather");
  assert.equal(typeof tcs[0]!.args, "object");
});

test("流式：第一个 text_delta 在流读完之前就到达", async () => {
  // 证明是"边到边吐"而非"攒完再吐"——这是流式体验的地基。
  const gen = complete(cfg(fakeFetch("long-cjk.sse", 64)), REQ);
  const first = await gen.next();
  assert.equal(first.done, false);
  // 拿到第一个事件时，流远没读完；提前 break 应触发 finally 里的 reader.cancel()
  await gen.return(undefined as never);
});

test("请求体形状：stream + include_usage + 无 tools 时不带 tools 字段", async () => {
  const cap: { url?: string; init?: RequestInit } = {};
  await collect(complete(cfg(fakeFetch("plain.sse", 4096, cap)), REQ));
  assert.equal(cap.url, "https://api.example.com/v1/chat/completions");
  const sent = JSON.parse(String(cap.init!.body));
  assert.equal(sent.stream, true);
  assert.deepEqual(sent.stream_options, { include_usage: true });
  assert.equal("tools" in sent, false, "没有工具时不应带空 tools");
  assert.equal(
    (cap.init!.headers as Record<string, string>)["Authorization"],
    "Bearer sk-test"
  );
});

test("HTTP 错误：抛 CompletionHttpError，429/5xx 标记为可重试", async () => {
  const errFetch = (async () =>
    new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
  await assert.rejects(
    () => collect(complete(cfg(errFetch), REQ)),
    (e: unknown) => {
      assert.ok(e instanceof CompletionHttpError);
      assert.equal(e.status, 429);
      assert.equal(e.retriable, true, "429 应可重试");
      assert.match(e.body, /rate limited/);
      return true;
    }
  );

  const badReq = (async () =>
    new Response("bad model", { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(
    () => collect(complete(cfg(badReq), REQ)),
    (e: unknown) => {
      assert.equal((e as CompletionHttpError).retriable, false, "400 不该重试");
      return true;
    }
  );
});

test("取消：abort 后迭代抛出，不静默吞掉", async () => {
  const ac = new AbortController();
  const hangingFetch = (async (_u: any, init: any) => {
    // 真实 fetch 在 abort 时 reject；这里如实模拟。
    return new Promise((_res, rej) => {
      init?.signal?.addEventListener("abort", () =>
        rej(Object.assign(new Error("aborted"), { name: "AbortError" }))
      );
    });
  }) as unknown as typeof fetch;

  const p = collect(complete(cfg(hangingFetch), REQ, { signal: ac.signal }));
  ac.abort();
  await assert.rejects(() => p, /aborted/);
});
