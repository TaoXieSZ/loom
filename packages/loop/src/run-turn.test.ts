/**
 * ② 层测试：用**脚本化的假模型**驱动完整循环，零网络。
 * 假模型同时记录每一步收到的 request——这样能断言"发给模型的 tools 数组里有什么"，
 * 也就是构造式能力边界的核心性质。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompletionEvent, CompletionRequest, Message } from "@loom/protocol";
import { runTurn, grantedTools, fingerprint } from "./run-turn.js";
import type {
  ApprovalVerdict,
  CompleteFn,
  LoopDeps,
  ToolRegistry,
  TurnConfig,
  TurnEvent,
} from "./types.js";

/** 脚本化假模型：第 n 次调用吐 script[n] 里的事件。 */
function fakeModel(script: CompletionEvent[][]) {
  const seen: CompletionRequest[] = [];
  let i = 0;
  const complete: CompleteFn = (req) => {
    // messages 会被就地修改，必须快照，否则断言看到的是最终态
    seen.push(JSON.parse(JSON.stringify(req)));
    const events = script[i++] ?? [{ type: "finish", reason: "stop" as const }];
    return (async function* () {
      for (const e of events) yield e;
    })();
  };
  return { complete, seen };
}

const say = (text: string): CompletionEvent[] => [
  { type: "text_delta", text },
  { type: "finish", reason: "stop" },
];

const callTool = (
  name: string,
  args: unknown,
  id = "call_1"
): CompletionEvent[] => [
  { type: "tool_call", id, name, args },
  { type: "finish", reason: "tool_calls" },
];

/** 一个乖巧的工具 + 一个高危工具。 */
function registry(calls: string[] = []): ToolRegistry {
  return {
    get_weather: {
      def: {
        type: "function",
        function: {
          name: "get_weather",
          description: "查天气",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
      defaultMode: "always",
      async run(args) {
        calls.push("get_weather:" + JSON.stringify(args));
        return '{"temp":31}';
      },
    },
    shell: {
      def: {
        type: "function",
        function: {
          name: "shell",
          description: "跑命令",
          parameters: { type: "object", properties: { cmd: { type: "string" } } },
        },
      },
      defaultMode: "ask", // 工具自己声明高危
      async run(args) {
        calls.push("shell:" + JSON.stringify(args));
        return "ok";
      },
    },
  };
}

const cfg = (over: Partial<TurnConfig> = {}): TurnConfig => ({
  agentId: "test-agent",
  model: "fake-model",
  grants: { get_weather: {} },
  tools: registry(),
  ...over,
});

async function collect(gen: AsyncGenerator<TurnEvent>) {
  const out: TurnEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}
const endOf = (evs: TurnEvent[]) =>
  evs.find((e) => e.type === "turn_end") as Extract<TurnEvent, { type: "turn_end" }>;

// ── 基本回合 ───────────────────────────────────────────────────────────

test("纯文本回合：产出 text_delta + turn_end:stop，assistant 入 messages", async () => {
  const { complete } = fakeModel([say("你好")]);
  const messages: Message[] = [{ role: "user", content: "hi" }];
  const evs = await collect(runTurn({ complete }, cfg(), messages));

  assert.equal(endOf(evs).reason, "stop");
  assert.equal(endOf(evs).text, "你好");
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[1], { role: "assistant", content: "你好" });
});

test("工具回合：三段式对话按序写入 messages", async () => {
  const executed: string[] = [];
  const { complete, seen } = fakeModel([
    callTool("get_weather", { city: "深圳" }),
    say("深圳 31 度"),
  ]);
  const messages: Message[] = [{ role: "user", content: "天气?" }];
  const evs = await collect(
    runTurn({ complete }, cfg({ tools: registry(executed) }), messages)
  );

  assert.deepEqual(executed, ['get_weather:{"city":"深圳"}'], "工具应被执行");
  // user → assistant(tool_calls) → tool(result) → assistant(text)
  assert.equal(messages.length, 4);
  assert.equal(messages[1]!.role, "assistant");
  assert.ok((messages[1] as any).tool_calls?.length === 1, "assistant 须带 tool_calls");
  assert.deepEqual(messages[2], {
    role: "tool",
    tool_call_id: "call_1",
    content: '{"temp":31}',
  });
  assert.equal(messages[3]!.role, "assistant");
  // 第二次请求必须带上前面的工具往返
  assert.equal(seen[1]!.messages.length, 3);
  assert.equal(endOf(evs).reason, "stop");
});

// ── 构造式能力边界 ─────────────────────────────────────────────────────

test("未授权的工具压根不出现在发给模型的 tools 里", async () => {
  const { complete, seen } = fakeModel([say("hi")]);
  await collect(runTurn({ complete }, cfg({ grants: { get_weather: {} } }), []));
  const names = seen[0]!.tools!.map((t) => t.function.name);
  assert.deepEqual(names, ["get_weather"], "shell 未授权，不该被描述给模型");
});

test("grants 为空时不带 tools 字段", async () => {
  const { complete, seen } = fakeModel([say("hi")]);
  await collect(runTurn({ complete }, cfg({ grants: {} }), []));
  assert.equal(seen[0]!.tools, undefined);
});

test("模型幻觉出未授权工具 → 如实回错，不执行", async () => {
  const executed: string[] = [];
  const { complete } = fakeModel([
    callTool("shell", { cmd: "rm -rf /" }), // shell 不在 grants 里
    say("抱歉"),
  ]);
  const messages: Message[] = [];
  const evs = await collect(
    runTurn({ complete }, cfg({ tools: registry(executed) }), messages)
  );
  assert.deepEqual(executed, [], "未授权工具绝不能执行");
  const toolMsg = messages.find((m) => m.role === "tool") as any;
  assert.match(toolMsg.content, /not available/);
  assert.equal(evs.some((e) => e.type === "tool_end" && !e.ok), true);
});

// ── 审批 ───────────────────────────────────────────────────────────────

const approveAll = async (r: {
  fingerprint: string;
}): Promise<ApprovalVerdict> => ({
  decision: "approve",
  fingerprint: r.fingerprint,
});

test("ask 模式：批准后执行，事件序列完整", async () => {
  const executed: string[] = [];
  const { complete } = fakeModel([callTool("shell", { cmd: "ls" }), say("done")]);
  const deps: LoopDeps = { complete, requestApproval: approveAll };
  const evs = await collect(
    runTurn(
      deps,
      cfg({ grants: { shell: {} }, tools: registry(executed) }),
      []
    )
  );
  assert.deepEqual(executed, ['shell:{"cmd":"ls"}']);
  const types = evs.map((e) => e.type);
  assert.ok(types.indexOf("approval_requested") < types.indexOf("tool_start"));
  assert.ok(
    evs.some((e) => e.type === "approval_settled" && e.decision === "approve")
  );
});

test("拒绝：工具不执行，拒绝理由回填给模型", async () => {
  const executed: string[] = [];
  const { complete } = fakeModel([callTool("shell", { cmd: "ls" }), say("好的")]);
  const deps: LoopDeps = {
    complete,
    requestApproval: async (r) => ({ decision: "deny", fingerprint: r.fingerprint }),
  };
  const messages: Message[] = [];
  await collect(
    runTurn(deps, cfg({ grants: { shell: {} }, tools: registry(executed) }), messages)
  );
  assert.deepEqual(executed, [], "被拒绝的工具绝不能执行");
  assert.match((messages.find((m) => m.role === "tool") as any).content, /Denied/);
});

test("没接审批通道 → fail-closed 拒绝（askFallback: deny）", async () => {
  const executed: string[] = [];
  const { complete } = fakeModel([callTool("shell", { cmd: "ls" }), say("好的")]);
  await collect(
    runTurn(
      { complete }, // 没有 requestApproval
      cfg({ grants: { shell: {} }, tools: registry(executed) }),
      []
    )
  );
  assert.deepEqual(executed, [], "无审批通道时必须拒绝，不能默认放行");
});

test("approve-what-executes：指纹对不上 → 拒绝执行", async () => {
  const executed: string[] = [];
  const { complete } = fakeModel([callTool("shell", { cmd: "ls" }), say("好的")]);
  const deps: LoopDeps = {
    complete,
    // 批准了，但带回一个别的指纹（模拟审批串了 / 请求被改）
    requestApproval: async () => ({ decision: "approve", fingerprint: "deadbeef" }),
  };
  const messages: Message[] = [];
  const evs = await collect(
    runTurn(deps, cfg({ grants: { shell: {} }, tools: registry(executed) }), messages)
  );
  assert.deepEqual(executed, [], "指纹不符必须拒绝");
  assert.ok(
    evs.some((e) => e.type === "approval_settled" && e.decision === "deny")
  );
  assert.match((messages.find((m) => m.role === "tool") as any).content, /mismatch/);
});

test("审批超时 → 按拒绝处理", async () => {
  const executed: string[] = [];
  const { complete } = fakeModel([callTool("shell", { cmd: "ls" }), say("好的")]);
  const deps: LoopDeps = {
    complete,
    requestApproval: () => new Promise(() => {}), // 永不 resolve
  };
  const evs = await collect(
    runTurn(
      deps,
      cfg({
        grants: { shell: {} },
        tools: registry(executed),
        approvalTimeoutMs: 20,
      }),
      []
    )
  );
  assert.deepEqual(executed, []);
  assert.ok(evs.some((e) => e.type === "approval_settled" && e.decision === "deny"));
});

test("grant 可覆盖工具默认风险（shell 设为 always 则不问）", async () => {
  const executed: string[] = [];
  const { complete } = fakeModel([callTool("shell", { cmd: "ls" }), say("done")]);
  const evs = await collect(
    runTurn(
      { complete }, // 没有审批通道，但 always 不需要
      cfg({ grants: { shell: { mode: "always" } }, tools: registry(executed) }),
      []
    )
  );
  assert.deepEqual(executed, ['shell:{"cmd":"ls"}']);
  assert.equal(evs.some((e) => e.type === "approval_requested"), false);
});

// ── 异常路径 ───────────────────────────────────────────────────────────

test("工具抛错：错误回填给模型，回合继续而非崩溃", async () => {
  const reg = registry();
  reg.get_weather!.run = async () => {
    throw new Error("upstream down");
  };
  const { complete } = fakeModel([
    callTool("get_weather", { city: "深圳" }),
    say("查不到，稍后再试"),
  ]);
  const messages: Message[] = [];
  const evs = await collect(runTurn({ complete }, cfg({ tools: reg }), messages));
  assert.match((messages.find((m) => m.role === "tool") as any).content, /upstream down/);
  assert.equal(endOf(evs).reason, "stop", "错误不该中断回合");
});

test("finish:length → truncated，且**不**写入 messages（Q1）", async () => {
  const { complete } = fakeModel([
    [
      { type: "text_delta", text: "半句话" },
      { type: "finish", reason: "length" },
    ],
  ]);
  const messages: Message[] = [{ role: "user", content: "写长文" }];
  const evs = await collect(runTurn({ complete }, cfg(), messages));
  assert.equal(endOf(evs).reason, "truncated");
  assert.equal(messages.length, 1, "截断内容不该进历史，否则把垃圾喂回模型");
});

test("maxSteps：工具无限自调用时被拦住", async () => {
  // 模型每次都要调工具，永不收尾
  const script = Array.from({ length: 20 }, () => callTool("get_weather", {}));
  const { complete, seen } = fakeModel(script);
  const evs = await collect(
    runTurn({ complete }, cfg({ maxSteps: 3 }), [])
  );
  assert.equal(endOf(evs).reason, "max_steps");
  assert.equal(seen.length, 3, "模型调用次数应被 maxSteps 限制");
});

// ── 纯函数 ─────────────────────────────────────────────────────────────

test("fingerprint：键序无关，内容变则变", () => {
  assert.equal(
    fingerprint("t", { a: 1, b: 2 }),
    fingerprint("t", { b: 2, a: 1 }),
    "键序不该影响指纹"
  );
  assert.notEqual(fingerprint("t", { a: 1 }), fingerprint("t", { a: 2 }));
  assert.notEqual(fingerprint("t1", { a: 1 }), fingerprint("t2", { a: 1 }));
});

test("grantedTools：只返回授权且已注册的", () => {
  const defs = grantedTools(registry(), { shell: {}, nonexistent: {} });
  assert.deepEqual(defs.map((d) => d.function.name), ["shell"]);
});
