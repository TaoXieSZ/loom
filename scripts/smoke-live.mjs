#!/usr/bin/env node
/**
 * 真机冒烟：拿 loom 的 ① 层去打**真实的 DeepSeek**。
 *
 * mock 测试证明的是"我们按自己的假设解析得对"；这个脚本证明的是"假设本身对"。
 * 本项目反复吃过"机制建好但没通电"的亏（memory/五次同型返工），所以每层都要有真机闸。
 *
 * API key 从 **stdin** 读取，绝不落盘、不进 argv、不进环境变量：
 *   ssh mac2 'cat 密钥来源' | node scripts/smoke-live.mjs
 */
import { complete } from "../packages/protocol/dist/index.js";

const apiKey = (await new Promise((resolve) => {
  let d = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => resolve(d));
})).trim();

if (!/^sk-\S+/.test(apiKey)) {
  console.error("需要从 stdin 传入 DeepSeek API key");
  process.exit(1);
}

const cfg = { baseUrl: "https://api.deepseek.com/v1", apiKey };
const MODEL = "deepseek-v4-flash";
let failures = 0;

const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
};

// ── 1. 纯文本 + 流式到达顺序 ─────────────────────────────────────────
console.log("\n[1] 纯文本补全（验证流式增量 + usage）");
{
  const t0 = Date.now();
  let firstDeltaMs = null;
  let text = "";
  let usage = null;
  let finish = null;
  for await (const ev of complete(cfg, {
    model: MODEL,
    messages: [{ role: "user", content: "用一句话介绍深圳。" }],
  })) {
    if (ev.type === "text_delta") {
      if (firstDeltaMs === null) firstDeltaMs = Date.now() - t0;
      text += ev.text;
    } else if (ev.type === "usage") usage = ev;
    else if (ev.type === "finish") finish = ev.reason;
  }
  const totalMs = Date.now() - t0;
  check(text.length > 0, "收到正文", JSON.stringify(text.slice(0, 40)) + "…");
  check(finish === "stop", "finish = stop", `(实际 ${finish})`);
  check(usage?.input > 0 && usage?.output > 0, "usage 有值", JSON.stringify(usage));
  check(
    firstDeltaMs !== null && firstDeltaMs < totalMs,
    "流式：首字早于整轮结束",
    `首字 ${firstDeltaMs}ms / 总计 ${totalMs}ms`
  );
}

// ── 2. 工具调用（最容易出问题的一段）────────────────────────────────
console.log("\n[2] 工具调用（验证 tool_call 拼装 + args 解析）");
{
  const tools = [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "查指定城市当前天气",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    },
  ];
  const calls = [];
  let finish = null;
  for await (const ev of complete(cfg, {
    model: MODEL,
    messages: [{ role: "user", content: "查一下深圳现在的天气" }],
    tools,
  })) {
    if (ev.type === "tool_call") calls.push(ev);
    else if (ev.type === "finish") finish = ev.reason;
  }
  check(finish === "tool_calls", "finish = tool_calls", `(实际 ${finish})`);
  check(calls.length >= 1, `拿到 ${calls.length} 个 tool_call`);
  const c = calls[0];
  check(c?.name === "get_weather", "工具名正确", c?.name);
  check(!!c?.id, "有 tool_call id", c?.id);
  check(
    c?.args && typeof c.args === "object" && typeof c.args.city === "string",
    "args 已 parse 成对象",
    JSON.stringify(c?.args)
  );
}

// ── 3. 取消（证明 finally 里的 reader.cancel 真的释放连接）──────────
console.log("\n[3] 中途取消");
{
  const gen = complete(cfg, {
    model: MODEL,
    messages: [{ role: "user", content: "写一段五百字的深圳简介。" }],
  });
  let got = 0;
  for await (const ev of gen) {
    if (ev.type === "text_delta" && ++got >= 3) break; // 提前 break → 触发 finally
  }
  check(got >= 3, "提前 break 后进程未挂起", `收到 ${got} 个增量后取消`);
}

console.log(
  failures === 0
    ? "\n🎉 真机冒烟全部通过 — ① 层与真实 DeepSeek 打通\n"
    : `\n💥 ${failures} 项失败\n`
);
process.exit(failures === 0 ? 0 : 1);
