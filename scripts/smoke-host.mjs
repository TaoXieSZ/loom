#!/usr/bin/env node
/**
 * host 真机冒烟:起真 loom-host + 真 DeepSeek,用 Node http 客户端打它,
 * 记录每个 SSE 事件的到达时间——证明是【逐帧流式】而非攒完一次性给。
 *   ... | node scripts/smoke-host.mjs   (key 走 stdin)
 */
import http from "node:http";
import { complete } from "../packages/protocol/dist/index.js";
import { startServer } from "../packages/host/dist/index.js";

const apiKey = (
  await new Promise((r) => {
    let d = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (d += c)).on("end", () => r(d));
  })
).trim();
if (!/^sk-\S+/.test(apiKey)) { console.error("需要 stdin 传 key"); process.exit(1); }

const AGENT = { agentId: "default", model: "deepseek-v4-flash",
  systemPrompt: "你是简洁的助手。用与用户相同的语言回答。" };
const { server, port } = await startServer({
  complete: (req, opts) => complete({ baseUrl: "https://api.deepseek.com/v1", apiKey }, req, opts),
  resolveAgent: (id) => (id === "default" ? AGENT : undefined),
  backend: "smoke",
});

let fail = 0;
const ok = (c, l, d = "") => { console.log(`  ${c ? "✅" : "❌"} ${l}${d ? "  " + d : ""}`); if (!c) fail++; };

// 1. health
const health = await new Promise((res) => {
  http.get(`http://127.0.0.1:${port}/health`, (r) => {
    let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => res(JSON.parse(b)));
  });
});
console.log("[1] /health"); ok(health.ok === true, "健康", JSON.stringify(health));

// 2. POST /run,记录每帧到达时间
console.log("\n[2] POST /run(流式,记录到达时间)");
const t0 = Date.now();
const evTimes = [];
const events = await new Promise((resolve) => {
  const body = JSON.stringify({ message: "用一句话介绍深圳，再用一句话说说它的天气。" });
  const req = http.request(
    { host: "127.0.0.1", port, path: "/run", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
    (r) => {
      let buf = "";
      const evs = [];
      r.setEncoding("utf8");
      r.on("data", (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!line.startsWith("data: ")) continue;
          const p = line.slice(6);
          if (p === "[DONE]") continue;
          const ev = JSON.parse(p);
          evs.push(ev);
          evTimes.push({ dt: Date.now() - t0, type: ev.type });
        }
      });
      r.on("end", () => resolve(evs));
    }
  );
  req.end(body);
});

const texts = events.filter((e) => e.type === "text_delta");
const end = events.find((e) => e.type === "turn_end");
const usage = events.find((e) => e.type === "usage");
const full = texts.map((e) => e.text).join("");
const firstText = evTimes.find((e) => e.type === "text_delta");
const total = Date.now() - t0;

ok(texts.length >= 2, `收到 ${texts.length} 个 text_delta`);
ok(!!end && end.reason === "stop", "turn_end = stop", `(${end?.reason})`);
ok(!!usage && usage.input > 0, "usage 有值", JSON.stringify(usage));
ok(full.length > 0, "拼出完整回复", JSON.stringify(full.slice(0, 60)) + "…");
ok(firstText && firstText.dt < total, "流式:首帧早于整轮结束",
  `首个 text ${firstText?.dt}ms / 总计 ${total}ms`);
ok(evTimes.length >= 3 && evTimes.at(-1).dt - evTimes[0].dt > 50,
  "事件在时间上铺开(非一次性)",
  `跨度 ${evTimes.at(-1).dt - evTimes[0].dt}ms`);

server.close();
console.log(fail === 0 ? "\n🎉 host 真机全绿 — loom-host 通过 HTTP/SSE 打通真 DeepSeek\n" : `\n💥 ${fail} 项失败\n`);
process.exit(fail === 0 ? 0 : 1);
