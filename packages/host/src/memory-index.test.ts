/**
 * FTS 派生索引测试:重建、中文 ≥3 字符命中、短词 LIKE 回退、
 * stale 自动重建、删索引可重建——全是"索引皆派生物"的验收面。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAgentHome } from "./home.js";
import { openMemoryIndex } from "./memory-index.js";

/** 临时 home:agent.json + 两个记忆文件(一 fact 一 episode)。 */
function makeHome() {
  const root = mkdtempSync(join(tmpdir(), "loom-idx-test-"));
  const dir = join(root, "demo");
  mkdirSync(join(dir, "memory", "facts"), { recursive: true });
  mkdirSync(join(dir, "memory", "episodes"), { recursive: true });
  writeFileSync(join(dir, "agent.json"), JSON.stringify({ model: "fake" }));
  writeFileSync(
    join(dir, "memory", "core.md"),
    "# 常驻\ncore.md 不该进索引。\n"
  );
  writeFileSync(
    join(dir, "memory", "facts", "coffee.md"),
    "# 咖啡偏好\n主人喜欢深烘咖啡,浅烘的果酸受不了。\n"
  );
  writeFileSync(
    join(dir, "memory", "episodes", "2026-07-26.md"),
    "# 7月26日\n今天帮主人查了手冲磨豆机的推荐。\n"
  );
  return { root, dir, home: openAgentHome(root, "demo") };
}

test("rebuild 后中文 ≥3 字符走 FTS 命中,且 core.md 不在索引里", () => {
  const { home } = makeHome();
  const idx = openMemoryIndex(home);
  try {
    idx.rebuild();

    const hits = idx.search("深烘咖啡");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.kind, "fact");
    assert.equal(hits[0]!.path, "memory/facts/coffee.md");
    assert.match(hits[0]!.snippet, /深烘咖啡/);

    // 多词 OR + 命中词数排序:命中任意词即入选,命中多的排前
    assert.equal(idx.search("磨豆机 推荐").length, 1);
    const orHits = idx.search("磨豆机 咖啡");
    assert.equal(orHits.length, 2); // episode 命中"磨豆机",fact 命中"咖啡"

    // 真机 smoke 回归:自然语言查询"咖啡 偏好 喜欢"——"喜欢"不在正文,
    // AND 语义会整体 miss(模型检不到就答"没有记忆"),OR 下 咖啡+偏好 两词命中排第一
    const nl = idx.search("咖啡 偏好 喜欢");
    assert.equal(nl[0]?.path, "memory/facts/coffee.md");

    // core.md 常驻注入,索引它只会污染搜索结果(D4)
    assert.equal(idx.search("不该进索引").length, 0);
  } finally {
    idx.close();
  }
});

test("短词(<3 字符)回退 LIKE,照样命中", () => {
  const { home } = makeHome();
  const idx = openMemoryIndex(home);
  try {
    idx.rebuild();
    // "深烘"只有 2 字符,trigram MATCH 静默返空——必须靠 LIKE 回退兜住
    const hits = idx.search("深烘");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.path, "memory/facts/coffee.md");

    // 混合:长短词一起,只要有短词就整组走 LIKE
    assert.equal(idx.search("咖啡 浅烘").length, 1);
  } finally {
    idx.close();
  }
});

test("ensureFresh:源文件变新 → 自动重建", () => {
  const { dir, home } = makeHome();
  const idx = openMemoryIndex(home);
  try {
    idx.rebuild();
    assert.equal(idx.search("耶加雪菲").length, 0);

    // 改内容并把 mtime 拨到未来(避免同毫秒重建被当成"没变化")
    const f = join(dir, "memory", "facts", "coffee.md");
    writeFileSync(f, "# 咖啡偏好\n主人最近改喝耶加雪菲了。\n");
    const future = new Date(Date.now() + 60_000);
    utimesSync(f, future, future);

    idx.ensureFresh();
    const hits = idx.search("耶加雪菲");
    assert.equal(hits.length, 1);
    assert.match(hits[0]!.snippet, /耶加雪菲/);
  } finally {
    idx.close();
  }
});

test("删掉 index.sqlite 后重开,ensureFresh 自动重建", () => {
  const { dir, home } = makeHome();
  const idx1 = openMemoryIndex(home);
  idx1.rebuild();
  idx1.close();
  const dbFile = join(dir, "memory", "index.sqlite");
  assert.ok(existsSync(dbFile));

  rmSync(dbFile);
  const idx2 = openMemoryIndex(home);
  try {
    idx2.ensureFresh(); // 索引没了 → 全量重建
    assert.equal(idx2.search("深烘咖啡").length, 1);
  } finally {
    idx2.close();
  }
});
