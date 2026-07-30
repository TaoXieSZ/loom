/**
 * 全链路服务测试:真起一个 server(端口 0),用 fetch 打它,验证 SSE 响应。
 * 模型是注入的假实现——测服务/路由/SSE 管道,不碰网络。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionEvent, CompletionRequest } from "@loom/protocol";
import type { CompleteFn } from "@loom/loop";
import {
  startServer,
  createHomeResolver,
  type AgentConfig,
  type HostDeps,
} from "./server.js";
import { openAgentHome, type AgentHome } from "./home.js";
import { memorySearchTool } from "./memory-tools.js";

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

// ── M2:home-backed agent(状态层)──────────────────────────────────────────

/** 剧本式假模型:第 i 次调用吐 steps[i](超出则用最后一个)。 */
function scriptedComplete(steps: CompletionEvent[][]) {
  const seen: CompletionRequest[] = [];
  const fn: CompleteFn = (req) => {
    seen.push(JSON.parse(JSON.stringify(req)));
    const events = steps[Math.min(seen.length - 1, steps.length - 1)]!;
    return (async function* () {
      for (const e of events) yield e;
    })();
  };
  return { fn, seen };
}

/** 临时 agent home:core.md(常驻) + 一条深烘咖啡 fact(检回)。 */
function makeHome() {
  const root = mkdtempSync(join(tmpdir(), "loom-server-test-"));
  const dir = join(root, "demo");
  mkdirSync(join(dir, "memory", "facts"), { recursive: true });
  writeFileSync(join(dir, "agent.json"), JSON.stringify({ model: "fake" }));
  writeFileSync(join(dir, "memory", "core.md"), "# 常驻\n你是 demo。");
  writeFileSync(
    join(dir, "memory", "facts", "coffee.md"),
    "# 咖啡偏好\n主人喜欢深烘咖啡。\n"
  );
  return { root, dir, home: openAgentHome(root, "demo") };
}

function homeAgent(home: AgentHome, over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    agentId: "demo",
    model: "fake",
    systemPrompt: "系统提示。",
    home,
    ...over,
  };
}

test("home-backed:turn 结束后新增段落盘 jsonl(system 不落)", async () => {
  const { home } = makeHome();
  const { fn } = fakeComplete([
    { type: "text_delta", text: "记下了" },
    { type: "finish", reason: "stop" },
  ]);
  const { server, port } = await startServer(
    deps({ complete: fn, resolveAgent: () => homeAgent(home) })
  );
  try {
    await fetch(`http://127.0.0.1:${port}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "记住我喜欢深烘咖啡", sessionId: "s1" }),
    });
    const lines = readFileSync(
      join(home.dir, "sessions", "s1.jsonl"),
      "utf8"
    ).trim().split("\n");
    assert.equal(lines.length, 2);
    const [u, a] = lines.map((l) => JSON.parse(l) as any);
    assert.equal(u.role, "user");
    assert.equal(u.content, "记住我喜欢深烘咖啡");
    assert.equal(typeof u.ts, "number");
    assert.equal(a.role, "assistant");
    assert.equal(a.content, "记下了");
    // system 是配置的投影,每次现拼——落盘就出第二份真相了
    assert.ok(!lines.some((l) => l.includes('"system"')));
  } finally {
    server.close();
  }
});

test("home-backed:新 server 实例历史还在(重启连续的单测版)", async () => {
  const { home } = makeHome();
  const mk = () => fakeComplete([{ type: "finish", reason: "stop" }]);
  const first = mk();
  const s1 = await startServer(
    deps({ complete: first.fn, resolveAgent: () => homeAgent(home) })
  );
  const post = (port: number) =>
    fetch(`http://127.0.0.1:${port}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "第一句", sessionId: "s1" }),
    });
  try {
    await post(s1.port);
  } finally {
    s1.server.close();
  }

  // 第二个 server 实例(等于重启):同一 session 的历史必须从盘上接回来
  const second = mk();
  const s2 = await startServer(
    deps({ complete: second.fn, resolveAgent: () => homeAgent(home) })
  );
  try {
    await post(s2.port);
    const roles = second.seen[0]!.messages.map((m) => m.role);
    assert.deepEqual(roles, ["system", "user", "assistant", "user"]);
    const contents = second.seen[0]!.messages.map(
      (m) => (m as { content?: string }).content
    );
    assert.deepEqual(contents.slice(1), ["第一句", "", "第一句"]);
  } finally {
    s2.server.close();
  }
});

test("home-backed:core.md 拼进 system prompt", async () => {
  const { home } = makeHome();
  const cap = fakeComplete([{ type: "finish", reason: "stop" }]);
  const { server, port } = await startServer(
    deps({ complete: cap.fn, resolveAgent: () => homeAgent(home) })
  );
  try {
    await fetch(`http://127.0.0.1:${port}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    const sys = cap.seen[0]!.messages[0]!;
    assert.equal(sys.role, "system");
    assert.match((sys as { content: string }).content, /系统提示。/);
    assert.match((sys as { content: string }).content, /你是 demo。/);
  } finally {
    server.close();
  }
});

test("home-backed:memory_search 授权后可调,结果带 path,且进 audit.log", async () => {
  const { home } = makeHome();
  const tools = { memory_search: memorySearchTool(home) };
  const cap = scriptedComplete([
    [
      { type: "tool_call", id: "c1", name: "memory_search", args: { query: "深烘咖啡" } },
      { type: "finish", reason: "tool_calls" },
    ],
    [
      { type: "text_delta", text: "你喜欢深烘咖啡" },
      { type: "finish", reason: "stop" },
    ],
  ]);
  const agent = homeAgent(home, {
    tools,
    grants: { memory_search: {} }, // 授权 → defaultMode always,直接执行
  });
  const { server, port } = await startServer(
    deps({ complete: cap.fn, resolveAgent: () => agent })
  );
  try {
    const r = await fetch(`http://127.0.0.1:${port}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "我喜欢什么咖啡?", sessionId: "s1" }),
    });
    const evs = await collectSse(r);
    const end = evs.find((e) => e.type === "tool_end");
    assert.equal(end?.ok, true);
    assert.match(end?.result ?? "", /memory\/facts\/coffee\.md/);
    assert.match(end?.result ?? "", /深烘咖啡/);

    // 工具执行 tee 进了 audit.log
    const audit = readFileSync(join(home.dir, "audit.log"), "utf8");
    assert.match(audit, /"tool_end"/);
    assert.match(audit, /"sessionId":"s1"/);

    // 模型第二轮请求里能看到工具结果(三段式回填)
    assert.equal(cap.seen.length, 2);
    const toolMsg = cap.seen[1]!.messages.find((m) => m.role === "tool");
    assert.match((toolMsg as { content: string }).content, /深烘咖啡/);
  } finally {
    server.close();
  }
});

test("home-backed:memory_search 未授权 → 模型看不见、调用被拒(构造式边界)", async () => {
  const { home } = makeHome();
  const tools = { memory_search: memorySearchTool(home) };
  const cap = scriptedComplete([
    // 模型幻觉出工具名(它根本没在 tools 列表里见过)也必须被如实拒绝
    [
      { type: "tool_call", id: "c1", name: "memory_search", args: { query: "咖啡" } },
      { type: "finish", reason: "tool_calls" },
    ],
    [{ type: "finish", reason: "stop" }],
  ]);
  const agent = homeAgent(home, { tools, grants: {} }); // grants 没有 = 不存在
  const { server, port } = await startServer(
    deps({ complete: cap.fn, resolveAgent: () => agent })
  );
  try {
    // 发给模型的 tools 数组是空的——构造式边界:没授权的工具不出现在列表里
    const r = await fetch(`http://127.0.0.1:${port}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "查一下" }),
    });
    assert.equal(cap.seen[0]!.tools, undefined);
    const evs = await collectSse(r);
    const end = evs.find((e) => e.type === "tool_end");
    assert.equal(end?.ok, false);
    assert.match(end?.result ?? "", /not available/);
  } finally {
    server.close();
  }
});

test("createHomeResolver:从 agents/<id>/ 组装,未知 id → undefined", () => {
  const { root } = makeHome();
  const resolve = createHomeResolver(root);
  const agent = resolve("demo");
  assert.ok(agent);
  assert.equal(agent.model, "fake");
  assert.ok(agent.home);
  assert.ok(agent.tools?.memory_search); // 默认授予(只读工具)
  assert.ok(agent.grants?.memory_search);
  assert.equal(resolve("ghost"), undefined);
  assert.equal(resolve("../escape"), undefined);
});
