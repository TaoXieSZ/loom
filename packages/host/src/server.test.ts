/**
 * 全链路服务测试:真起一个 server(端口 0),用 fetch 打它,验证 SSE 响应。
 * 模型是注入的假实现——测服务/路由/SSE 管道,不碰网络。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompletionEvent, CompletionRequest } from "@loom/protocol";
import type { CompleteFn } from "@loom/loop";
import { startServer, type AgentConfig, type HostDeps } from "./server.js";

/** 假模型:吐固定事件。记录收到的请求以便断言。 */
function fakeComplete(events: CompletionEvent[]) {
  const seen: CompletionRequest[] = [];
  const fn: CompleteFn = (req) => {
    seen.push(JSON.parse(JSON.stringify(req)));
    return (async function* () {
      for (const e of events) yield e;
    })();
  };
  return { fn, seen };
}

const AGENT: AgentConfig = {
  agentId: "default",
  model: "fake",
  systemPrompt: "你是测试助手。",
};

function deps(over: Partial<HostDeps> = {}): HostDeps {
  const { fn } = fakeComplete([
    { type: "text_delta", text: "你好" },
    { type: "finish", reason: "stop" },
  ]);
  return {
    complete: fn,
    resolveAgent: (id) => (id === "default" ? AGENT : undefined),
    backend: "test",
    ...over,
  };
}

/** 收集 SSE 响应体,解析出 data: 帧的 JSON。 */
async function collectSse(res: Response): Promise<any[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l.trim() !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)));
}

test("GET /health → ok", async () => {
  const { server, port } = await startServer(deps());
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, backend: "test" });
  } finally {
    server.close();
  }
});

test("POST /run → SSE 事件流(text_delta + turn_end)", async () => {
  const { server, port } = await startServer(deps());
  try {
    const r = await fetch(`http://127.0.0.1:${port}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "在吗" }),
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/event-stream/);
    const evs = await collectSse(r);
    assert.ok(evs.some((e) => e.type === "text_delta" && e.text === "你好"));
    const end = evs.find((e) => e.type === "turn_end");
    assert.equal(end?.reason, "stop");
  } finally {
    server.close();
  }
});

test("POST /run 把 system + user 组进 messages", async () => {
  const cap = fakeComplete([{ type: "finish", reason: "stop" }]);
  const { server, port } = await startServer(deps({ complete: cap.fn }));
  try {
    await fetch(`http://127.0.0.1:${port}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "天气?" }),
    });
    const msgs = cap.seen[0]!.messages;
    assert.deepEqual(msgs, [
      { role: "system", content: "你是测试助手。" },
      { role: "user", content: "天气?" },
    ]);
  } finally {
    server.close();
  }
});

test("坏请求:空 message → 400;未知 agent → 404", async () => {
  const { server, port } = await startServer(deps());
  try {
    const bad = await fetch(`http://127.0.0.1:${port}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "" }),
    });
    assert.equal(bad.status, 400);
    const nf = await fetch(`http://127.0.0.1:${port}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi", agentId: "ghost" }),
    });
    assert.equal(nf.status, 404);
  } finally {
    server.close();
  }
});

test("未知路由 → 404", async () => {
  const { server, port } = await startServer(deps());
  try {
    const r = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(r.status, 404);
  } finally {
    server.close();
  }
});
