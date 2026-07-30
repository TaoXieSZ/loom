/**
 * AgentHome 仓库接口测试:对着临时目录验证文件层行为——
 * 配置/常驻记忆的读取纪律、session 的 append/load 往返、坏行容忍、id 清洗。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORE_MAX_CHARS,
  openAgentHome,
  sanitizeId,
} from "./home.js";

/** 临时 home 根目录 + 一个最小 agent（agent.json 必需，其余按需补）。 */
function makeHome(agentId = "demo") {
  const root = mkdtempSync(join(tmpdir(), "loom-home-test-"));
  const dir = join(root, agentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.json"), JSON.stringify({ model: "fake" }));
  return { root, dir, home: openAgentHome(root, agentId) };
}

test("loadConfig 读 agent.json;缺 model 报错", () => {
  const { root, home } = makeHome();
  assert.deepEqual(home.loadConfig(), { model: "fake" });

  writeFileSync(join(root, "demo", "agent.json"), JSON.stringify({}));
  assert.throws(() => home.loadConfig(), /model 缺失/);
});

test("readCore:缺失 → undefined;正常读取;超上限截断并 warn", () => {
  const { dir, home } = makeHome();
  assert.equal(home.readCore(), undefined);

  mkdirSync(join(dir, "memory"), { recursive: true });
  writeFileSync(join(dir, "memory", "core.md"), "# 常驻\n我是谁。\n");
  assert.equal(home.readCore(), "# 常驻\n我是谁。");

  const warnings: string[] = [];
  const home2 = openAgentHome(join(dir, ".."), "demo", {
    warn: (m) => warnings.push(m),
  });
  writeFileSync(join(dir, "memory", "core.md"), "x".repeat(CORE_MAX_CHARS + 100));
  const core = home2.readCore();
  assert.equal(core?.length, CORE_MAX_CHARS);
  assert.equal(warnings.length, 1);
});

test("session append/load 往返:ts 包装被剥掉", () => {
  const { home } = makeHome();
  home.appendSession("main", [
    { role: "user", content: "你好" },
    { role: "assistant", content: "在的" },
  ]);
  home.appendSession("main", [{ role: "user", content: "第二句" }]);

  assert.deepEqual(home.loadSession("main"), [
    { role: "user", content: "你好" },
    { role: "assistant", content: "在的" },
    { role: "user", content: "第二句" },
  ]);

  // 落盘的原始行确实带 ts 包装
  const raw = readFileSync(
    join(home.dir, "sessions", "main.jsonl"),
    "utf8"
  ).trim().split("\n");
  assert.equal(raw.length, 3);
  assert.equal(typeof (JSON.parse(raw[0]!) as { ts?: unknown }).ts, "number");

  // 没写过的 session = 空历史
  assert.deepEqual(home.loadSession("fresh"), []);
});

test("loadSession 坏行跳过并 warn,其余照常", () => {
  const { home } = makeHome();
  home.appendSession("main", [{ role: "user", content: "好的行" }]);
  // 模拟断电半写:最后一行是半截 JSON
  writeFileSync(
    join(home.dir, "sessions", "main.jsonl"),
    readFileSync(join(home.dir, "sessions", "main.jsonl"), "utf8") +
      '{"ts":1,"role":"user","cont',
    "utf8"
  );

  const warnings: string[] = [];
  const home2 = openAgentHome(join(home.dir, ".."), "demo", {
    warn: (m) => warnings.push(m),
  });
  assert.deepEqual(home2.loadSession("main"), [
    { role: "user", content: "好的行" },
  ]);
  assert.equal(warnings.length, 1);
});

test("appendAudit 写 audit.log,一行一条带 ts", () => {
  const { home } = makeHome();
  home.appendAudit({ type: "tool_end", ok: true });
  home.appendAudit({ type: "approval_settled", decision: "approve" });
  const lines = readFileSync(join(home.dir, "audit.log"), "utf8")
    .trim()
    .split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]!) as { ts?: unknown; type?: string };
  assert.equal(typeof first.ts, "number");
  assert.equal(first.type, "tool_end");
});

test("id 清洗:非法 agentId / sessionId 一律拒绝(防路径穿越)", () => {
  assert.throws(() => sanitizeId("../etc", "agentId"), /invalid agentId/);
  assert.throws(() => sanitizeId("a/b", "sessionId"), /invalid sessionId/);
  assert.equal(sanitizeId("main-2026_07", "sessionId"), "main-2026_07");

  const { root } = makeHome();
  assert.throws(() => openAgentHome(root, "../../escape"), /invalid agentId/);
  const { home } = makeHome();
  assert.throws(() => home.loadSession("../other"), /invalid sessionId/);
  assert.throws(
    () => home.appendSession("a b", [{ role: "user", content: "x" }]),
    /invalid sessionId/
  );
});
