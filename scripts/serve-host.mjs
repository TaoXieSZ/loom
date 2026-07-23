#!/usr/bin/env node
/**
 * 启动一个真 loom-host,接真实 DeepSeek。M1 用来 curl 验证 / 手动把玩。
 *
 *   DEEPSEEK_API_KEY=sk-... [PORT=60640] node scripts/serve-host.mjs
 *
 * 然后:
 *   curl -N localhost:60640/health
 *   curl -N -X POST localhost:60640/run -H 'content-type: application/json' \
 *        -d '{"message":"用一句话介绍深圳"}'
 */
import { complete } from "../packages/protocol/dist/index.js";
import { startServer } from "../packages/host/dist/index.js";

const apiKey = (process.env.DEEPSEEK_API_KEY ?? "").trim();
if (!/^sk-\S+/.test(apiKey)) {
  console.error("需要 DEEPSEEK_API_KEY 环境变量");
  process.exit(1);
}

const provider = {
  baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
  apiKey,
};
const MODEL = process.env.LOOM_MODEL ?? "deepseek-v4-flash";

// M1:单个内存 agent,零工具。M2 会从 agent home 读。
const AGENT = {
  agentId: "default",
  model: MODEL,
  systemPrompt: "你是一个简洁的助手。用与用户相同的语言回答。",
};

const { port } = await startServer(
  {
    complete: (req, opts) => complete(provider, req, opts),
    resolveAgent: (id) => (id === "default" || id === AGENT.agentId ? AGENT : undefined),
    backend: `loom-host · ${MODEL}`,
  },
  { port: Number(process.env.PORT ?? 60640), host: process.env.HOST ?? "127.0.0.1" }
);

console.log(`loom-host 已启动: http://127.0.0.1:${port}  (model: ${MODEL})`);
console.log("  GET  /health");
console.log("  POST /run   { message, agentId? }  → SSE");
