/**
 * 蒸馏测试:假模型出 JSON → episode/facts 落盘 + 索引重建 + watermark 推进
 * + 二次 no-op + 围栏容忍 + 解析失败不推进 watermark。全程不碰网络。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionEvent, CompletionRequest } from "@loom/protocol";
import type { CompleteFn } from "@loom/loop";
import { openAgentHome } from "./home.js";
import { openMemoryIndex } from "./memory-index.js";
import { distill } from "./distill.js";

/** 假模型:把给定文本当一轮流式回复吐出来,并记录收到的请求。 */
function fakeComplete(replyText: string) {
  const seen: CompletionRequest[] = [];
  const fn: CompleteFn = (req) => {
    seen.push(JSON.parse(JSON.stringify(req)));
    return (async function* (): AsyncGenerator<CompletionEvent> {
      yield { type: "text_delta", text: replyText };
      yield { type: "finish", reason: "stop" };
    })();
  };
  return { fn, seen };
}

function makeHome() {
  const root = mkdtempSync(join(tmpdir(), "loom-distill-test-"));
  const dir = join(root, "demo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.json"), JSON.stringify({ model: "fake-distill" }));
  return { root, dir, home: openAgentHome(root, "demo") };
}

const MODEL_JSON = JSON.stringify({
  episode_md: "# 7月27日\n主人说他喜欢深烘咖啡。",
  facts: [{ slug: "coffee-preference", md: "# 咖啡偏好\n主人喜欢深烘咖啡。" }],
});

test("蒸馏全链路:落盘 + 索引重建 + watermark 推进 + 二次 no-op", async () => {
  const { dir, home } = makeHome();
  home.appendSession("main", [
    { role: "user", content: "记住我喜欢深烘咖啡" },
    { role: "assistant", content: "记下了。" },
  ]);

  const model = fakeComplete(MODEL_JSON);
  const r1 = await distill(home, model.fn, { today: "2026-07-27" });

  assert.equal(r1.distilled, true);
  assert.equal(r1.lines, 2);
  assert.equal(r1.episodePath, "memory/episodes/2026-07-27.md");
  assert.deepEqual(r1.facts, ["coffee-preference"]);

  // episode / fact 落盘
  assert.match(
    readFileSync(join(dir, "memory", "episodes", "2026-07-27.md"), "utf8"),
    /深烘咖啡/
  );
  assert.match(
    readFileSync(join(dir, "memory", "facts", "coffee-preference.md"), "utf8"),
    /深烘咖啡/
  );

  // 索引已重建:新记忆立刻可搜
  const idx = openMemoryIndex(home);
  try {
    idx.ensureFresh();
    assert.equal(idx.search("深烘咖啡").length >= 1, true);
  } finally {
    idx.close();
  }

  // watermark 推进:行数记到 distill-state.json
  const state = JSON.parse(
    readFileSync(join(dir, "memory", "distill-state.json"), "utf8")
  ) as { sessions: Record<string, number> };
  assert.equal(state.sessions["main.jsonl"], 2);

  // 二次运行:无增量 = no-op,模型根本不该被调用
  const model2 = fakeComplete(MODEL_JSON);
  const r2 = await distill(home, model2.fn, { today: "2026-07-27" });
  assert.equal(r2.distilled, false);
  assert.equal(model2.seen.length, 0);

  // 再追加两行 → 只处理增量
  home.appendSession("main", [{ role: "user", content: "再来一杯" }]);
  const model3 = fakeComplete(JSON.stringify({ episode_md: "", facts: [] }));
  const r3 = await distill(home, model3.fn, { today: "2026-07-27" });
  assert.equal(r3.distilled, true);
  assert.equal(r3.lines, 1);
});

test("模型输出带 ```json 围栏也能解析", async () => {
  const { dir, home } = makeHome();
  home.appendSession("main", [{ role: "user", content: "记住这件事" }]);
  const fenced = "```json\n" + MODEL_JSON + "\n```";
  const r = await distill(home, fakeComplete(fenced).fn, {
    today: "2026-07-27",
  });
  assert.equal(r.distilled, true);
  assert.ok(existsSync(join(dir, "memory", "facts", "coffee-preference.md")));
});

test("输出不是 JSON → 抛错且 watermark 不推进(下次重试)", async () => {
  const { dir, home } = makeHome();
  home.appendSession("main", [{ role: "user", content: "随便说说" }]);

  await assert.rejects(
    distill(home, fakeComplete("这不是 JSON").fn, { today: "2026-07-27" }),
    /蒸馏输出解析失败/
  );
  assert.equal(existsSync(join(dir, "memory", "distill-state.json")), false);

  // 下一趟换个能正常输出的模型,同样的增量还能被处理
  const r = await distill(home, fakeComplete(MODEL_JSON).fn, {
    today: "2026-07-27",
  });
  assert.equal(r.distilled, true);
});

test("同日已有 episode → 旧内容一起给模型合并降噪", async () => {
  const { dir, home } = makeHome();
  mkdirSync(join(dir, "memory", "episodes"), { recursive: true });
  writeFileSync(
    join(dir, "memory", "episodes", "2026-07-27.md"),
    "# 7月27日\n上午的内容。\n"
  );
  home.appendSession("main", [{ role: "user", content: "下午的事" }]);

  const model = fakeComplete(MODEL_JSON);
  await distill(home, model.fn, { today: "2026-07-27" });
  const userMsg = model.seen[0]!.messages.find((m) => m.role === "user");
  assert.ok(userMsg && "content" in userMsg);
  assert.match((userMsg as { content: string }).content, /已有 episode/);
  assert.match((userMsg as { content: string }).content, /上午的内容/);
});
