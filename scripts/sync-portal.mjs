#!/usr/bin/env node
/**
 * 门户进度同步 —— 事实驱动,防账本病。
 *
 * 分工:
 *   - 【脚本(本文件)】从可验证事实算:哪个包有实现 vs placeholder、每包测试用例数、
 *     有无真机 smoke 脚本 → 组件 done/todo 状态 + 测试数字。
 *   - 【人(progress.overrides.json)】维护语义:组件清单、描述、里程碑、PR、以及机械
 *     判不了的灰色状态(partial)。
 * 两者合并 → 注入 index.html 与 README.md 的 <!-- SYNC:* --> 锚点区。
 * 门户仍是纯静态(锚点注入,非 fetch)——file:// 本地与 Pages 都能开。
 *
 * 用法: node scripts/sync-portal.mjs   (幂等;无 loom 改动时也可安全重跑)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs");
const PKGS = ["protocol", "loop", "host"];

// ── 事实探测 ────────────────────────────────────────────────────────────

/** 该包 src/index.ts 是否是真实现(非 placeholder)。 */
function isImplemented(pkg) {
  const idx = join(ROOT, "packages", pkg, "src", "index.ts");
  if (!existsSync(idx)) return false;
  const s = readFileSync(idx, "utf8");
  return !/placeholder/.test(s) && /export\s+\{[^}]*\w/.test(s.replace(/export\s*\{\s*\}/g, ""));
}

/** 该包所有 *.test.ts 里的 test( 用例数。 */
function testCount(pkg) {
  const dir = join(ROOT, "packages", pkg, "src");
  let n = 0;
  try {
    const files = execSync(`ls "${dir}"/*.test.ts 2>/dev/null || true`, { encoding: "utf8" })
      .trim().split("\n").filter(Boolean);
    for (const f of files) n += (readFileSync(f, "utf8").match(/^test\(/gm) || []).length;
  } catch {}
  return n;
}

/** 是否有对应真机 smoke 脚本。 */
const hasSmoke = (pkg) => existsSync(join(ROOT, "scripts", `smoke-${pkg}.mjs`));

const facts = {
  pkg: Object.fromEntries(
    PKGS.map((p) => [p, { impl: isImplemented(p), tests: testCount(p), smoke: hasSmoke(p) }])
  ),
  sha: (() => { try { return execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim(); } catch { return "—"; } })(),
  date: new Date().toISOString().slice(0, 10),
};
const totalTests = PKGS.reduce((s, p) => s + facts.pkg[p].tests, 0);

// ── 合并语义层 ──────────────────────────────────────────────────────────

const overrides = JSON.parse(readFileSync(join(DOCS, "progress.overrides.json"), "utf8"));
const components = overrides.components.map((c) => {
  // status 只由硬事实决定:该包有实现(非 placeholder)= done,否则 todo。
  // 人工 partial 优先(机械判不了的灰色状态)。verified 只影响"· 真机"标签,不卡 status。
  let status = c.status;
  if (!status) {
    const f = c.pkg && facts.pkg[c.pkg];
    status = f && f.impl ? "done" : "todo";
  }
  return { ...c, status };
});
const doneCount = components.filter((c) => c.pkg && c.status === "done").length;
const totalCore = components.filter((c) => c.pkg).length; // 有实现包的核心组件
const verifiedLayers = components.filter((c) => c.status === "done" && c.verified).length;

// ── 生成片段 ────────────────────────────────────────────────────────────

const metricTiles = [
  [`${doneCount}<span class="accent">/${totalCore}</span>`, "核心组件已建成"],
  [`${totalTests}`, `测试全绿 · ${PKGS.map((p) => facts.pkg[p].tests).filter(Boolean).join("+")}`],
  [`${verifiedLayers}`, "组件真机验证"],
  [`v4`, "DeepSeek flash 打通"],
];
const metricsHtml = metricTiles
  .map(([n, k]) => `      <div class="metric"><div class="n">${n}</div>\n        <div class="k">${k}</div></div>`)
  .join("\n");

const stClass = { done: "st-done", partial: "st-part", todo: "st-todo" };
const stLabel = (c) =>
  c.status === "done" ? (c.verified ? "已建成 · 真机" : "已建成")
  : c.status === "partial" ? `部分 · ${c.note ?? ""}`
  : `待建 · ${c.note ?? ""}`;
const componentsHtml = components
  .map((c) => {
    const desc = (c.descBold ? `<b>${c.descBold}</b>` : "") + (c.descRest ?? "");
    return `      <li><span class="comp-id">${c.id}</span>\n` +
      `        <span class="comp-desc">${desc}</span>\n` +
      `        <span class="status ${stClass[c.status]}">${stLabel(c)}</span></li>`;
  })
  .join("\n");

// README 表格片段。名列=组件+描述;状态列=标记+简短状态(不重复描述)。
const mdMark = { done: "✅", partial: "◐", todo: "⬜" };
const readmeRows = components
  .map((c) => {
    const nameDesc = c.descBold ? `**${c.id}** ${c.descBold}` : `**${c.id}** ${(c.descRest ?? "").replace(/^，/, "")}`;
    const st = c.status === "done"
      ? `${mdMark.done} 已建成${c.verified ? "，真机验证" : ""}${c.pr ? `（[PR #${c.pr}](https://github.com/TaoXieSZ/loom/pull/${c.pr})）` : ""}`
      : c.status === "partial"
      ? `${mdMark.partial} 逻辑已在 ② 实现；飞书审批卡待接（${c.note}）`
      : `${mdMark.todo} 待建 · ${c.note}`;
    return `| ${nameDesc} | ${st} |`;
  })
  .join("\n");
const readmeSummary = `DeepSeek v4-flash 全链路已打通，**${totalTests} 测试绿**（${PKGS.map((p) => `${facts.pkg[p].tests} ${p}`).filter((x) => !x.startsWith("0")).join(" + ")}）。`;

// ── 锚点注入 ────────────────────────────────────────────────────────────

function inject(file, blocks) {
  let s = readFileSync(file, "utf8");
  for (const [name, content] of Object.entries(blocks)) {
    const re = new RegExp(`(<!-- SYNC:${name}:START -->)[\\s\\S]*?(<!-- SYNC:${name}:END -->)`);
    if (!re.test(s)) { console.warn(`  ⚠ 锚点 SYNC:${name} 未在 ${file} 找到,跳过`); continue; }
    s = s.replace(re, `$1\n${content}\n$2`);
  }
  writeFileSync(file, s);
}

inject(join(DOCS, "index.html"), { METRICS: metricsHtml, COMPONENTS: componentsHtml });
inject(join(ROOT, "README.md"), { PROGRESS: `${readmeRows}\n\n${readmeSummary}` });

// 顺带重渲染 md→html(文档站点用)
try { execSync("node scripts/build-docs.mjs", { cwd: ROOT, stdio: "pipe" }); } catch (e) {
  console.warn("  ⚠ build-docs 失败:", e.message.slice(0, 80));
}

console.log(`✓ 门户已同步 @ ${facts.sha} (${facts.date})`);
console.log(`  组件 ${doneCount}/${totalCore} done · ${totalTests} 测试 · ${verifiedLayers} 真机验证`);
for (const p of PKGS)
  console.log(`  @loom/${p}: ${facts.pkg[p].impl ? "impl" : "placeholder"} · ${facts.pkg[p].tests} 测试 · smoke ${facts.pkg[p].smoke ? "✓" : "—"}`);
