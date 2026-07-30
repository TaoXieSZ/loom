#!/usr/bin/env node
/**
 * 真机冒烟 ③：M2 状态层 —— 记忆/会话跨进程连续，检索命中真实历史。
 *
 * 验收路径（全程真 DeepSeek）：
 *   turn1「记住我喜欢深烘咖啡」→ 落盘 → 蒸馏成 fact
 *   → **新进程**(等于重启)换个 session 问「我喜欢什么咖啡?」
 *   → 只能靠 memory_search 检回 → 答出"深烘"。
 *
 *   ssh mac2 '取 key' | node scripts/smoke-home.mjs
 *
 * --child 是内部参数(父进程派生"新进程"用),不要手动调。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { complete } from "../packages/protocol/dist/index.js";
import {
  createHomeResolver,
  distill,
  openAgentHome,
  openMemoryIndex,
  startServer,
} from "../packages/host/dist/index.js";

const MODEL = "deepseek-v4-flash";
let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
};

const SELF = fileURLToPath(import.meta.url);

/** 起一个接真 DeepSeek 的 server,跑一次 /run,返回收集到的事件。 */
async function runOnce(root, apiKey, body) {
  const provider = { baseUrl: "https://api.deepseek.com/v1", apiKey };
  const { server, port } = await startServer({
    complete: (req, opts) => complete(provider, req, opts),
    resolveAgent: createHomeResolver(root),
    backend: "smoke-home",
  });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    return text
      .split("\n")
      .filter((l) => l.startsWith("data: ") && l.trim() !== "data: [DONE]")
      .map((l) => JSON.parse(l.slice(6)));
  } finally {
    server.close();
  }
}

// ── 子进程模式:全新进程(全新内存),只认盘上的 home ─────────────────────────
async function child(root, apiKey) {
  console.log("\n[子进程] 新实例从盘上恢复,换 session 问咖啡偏好");
  const evs = await runOnce(root, apiKey, {
    agentId: "smoke",
    sessionId: "fresh", // 故意换 session:历史里没有答案,只能靠记忆检回
    message: "我喜欢什么咖啡?一句话回答。",
  });
  const finalText = evs.find((e) => e.type === "turn_end")?.text ?? "";
  check(finalText.length > 0, "新进程给出了回答", JSON.stringify(finalText.slice(0, 60)));
  check(/深烘/.test(finalText), "答案说对了:深烘(只能来自检回的记忆)");

  const audit = readFileSync(join(root, "smoke", "audit.log"), "utf8");
  check(
    audit.includes('"memory_search"'),
    "memory_search 被真实调用过(audit.log 有记录)"
  );
  process.exit(failures === 0 ? 0 : 1);
}

// ── 父进程 ───────────────────────────────────────────────────────────────
const childIdx = process.argv.indexOf("--child");
if (childIdx >= 0) {
  await child(process.argv[childIdx + 1], process.env.DEEPSEEK_API_KEY ?? "");
} else {
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

  // 临时 home:最小常驻记忆 + 显式授权 memory_search
  const root = mkdtempSync(join(tmpdir(), "loom-smoke-home-"));
  const dir = join(root, "smoke");
  mkdirSync(join(dir, "memory"), { recursive: true });
  writeFileSync(
    join(dir, "agent.json"),
    JSON.stringify({
      model: MODEL,
      systemPrompt:
        "你是 smoke 测试 agent。回答关于主人偏好的问题前," +
        "如果上下文里没有答案,必须调用 memory_search 工具检索长期记忆。简洁回答。",
      grants: { memory_search: {} },
    })
  );
  writeFileSync(join(dir, "memory", "core.md"), "# 常驻\n你是 smoke 测试 agent。\n");
  console.log(`临时 home: ${dir}`);

  console.log("\n[1] turn1:告知偏好,session 落盘");
  const evs1 = await runOnce(root, apiKey, {
    agentId: "smoke",
    sessionId: "main",
    message: "记住:我只喝深烘咖啡,浅烘的果酸我受不了。回复'记下了'即可。",
  });
  check(
    evs1.some((e) => e.type === "turn_end"),
    "turn1 正常收尾"
  );
  const jsonl = readFileSync(join(dir, "sessions", "main.jsonl"), "utf8")
    .trim()
    .split("\n");
  check(jsonl.length >= 2, `session 落盘 ${jsonl.length} 行(user+assistant)`);
  check(
    !jsonl.some((l) => l.includes('"system"')),
    "system 消息未落盘(配置的投影,每次现拼)"
  );

  console.log("\n[2] 蒸馏:session 增量 → 长期记忆");
  const home = openAgentHome(root, "smoke");
  const provider = { baseUrl: "https://api.deepseek.com/v1", apiKey };
  try {
    const r = await distill(home, (req, opts) => complete(provider, req, opts));
    check(r.distilled, `蒸馏处理了 ${r.lines} 行增量`);
    check(
      r.facts.length > 0 || r.episodePath !== undefined,
      "蒸馏产物落盘",
      r.facts.length ? `facts: ${r.facts.join(", ")}` : (r.episodePath ?? "")
    );
  } catch (e) {
    check(false, "蒸馏失败", e instanceof Error ? e.message : String(e));
  }

  const idx = openMemoryIndex(home);
  try {
    idx.ensureFresh();
    const hits = idx.search("深烘咖啡"); // ≥3 字符,走 FTS5 trigram
    check(hits.length > 0, "memory_search 索引命中真实蒸馏历史", hits[0]?.path ?? "");
    const hitsShort = idx.search("深烘"); // 2 字符,验证 LIKE 回退
    check(hitsShort.length > 0, "短词 LIKE 回退也命中", hitsShort[0]?.path ?? "");
  } finally {
    idx.close();
  }

  console.log("\n[3] 派生全新进程验证重启连续(单测证明不了的最后一环)");
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [SELF, "--child", root], {
      env: { ...process.env, DEEPSEEK_API_KEY: apiKey },
      stdio: "inherit",
    });
    p.on("exit", resolve);
  });
  check(code === 0, "子进程(=重启后)验收通过");

  console.log(
    failures === 0
      ? "\n🎉 M2 状态层真机全绿 — 重启后记忆/会话连续,检索命中真实历史\n"
      : `\n💥 ${failures} 项失败(home 留在 ${dir} 可供排查)\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}
