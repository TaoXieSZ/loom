#!/usr/bin/env node
/**
 * 蒸馏 cron 入口：把 agent home 的 session 增量压缩内化成长期记忆。
 *
 * 调度本身是部署事（launchd/cron 都行），这里只交付"可被定时调用"的入口：
 *
 *   ssh mac2 '取 key' | node scripts/distill.mjs --home agents/<id>
 *
 * 退出码：0 = 成功（含无增量的 no-op）；1 = 失败（watermark 未推进，下趟重试）。
 */
import { complete } from "../packages/protocol/dist/index.js";
import { openAgentHome, distill } from "../packages/host/dist/index.js";

const homeArgIdx = process.argv.indexOf("--home");
const homePath = homeArgIdx >= 0 ? process.argv[homeArgIdx + 1] : undefined;
if (!homePath) {
  console.error("用法: node scripts/distill.mjs --home agents/<id>");
  process.exit(1);
}

const apiKey = (
  await new Promise((resolve) => {
    let d = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => resolve(d));
  })
).trim();
if (!/^sk-\S+/.test(apiKey)) {
  console.error("需要从 stdin 传入 DeepSeek API key");
  process.exit(1);
}

// --home 指向 agents/<id>，拆出 root 和 agentId
const parts = homePath.replace(/\/+$/, "").split("/");
const agentId = parts.pop();
const root = parts.join("/") || ".";

const provider = { baseUrl: "https://api.deepseek.com/v1", apiKey };
const home = openAgentHome(root, agentId);

try {
  const r = await distill(home, (req, opts) => complete(provider, req, opts));
  if (!r.distilled) {
    console.log(`[${agentId}] 无增量,no-op`);
  } else {
    console.log(
      `[${agentId}] 蒸馏完成: ${r.lines} 行增量` +
        (r.episodePath ? ` → ${r.episodePath}` : "") +
        (r.facts.length ? ` facts: ${r.facts.join(", ")}` : "")
    );
  }
} catch (e) {
  console.error(`[${agentId}] 蒸馏失败: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
