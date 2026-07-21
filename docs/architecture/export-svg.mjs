#!/usr/bin/env node
/**
 * 从 archify 生成的 HTML 里导出**双主题自包含 SVG**（可直接被 markdown 引用）。
 *
 * 为什么需要它：archify 的 SVG 导出只存在于浏览器里（页面按 E），CLI 没有这个命令。
 * 这里复刻其 serializeSvg(autoTheme=true) 的逻辑——因为主题 CSS 在 HTML 里是静态文本，
 * 不需要真的跑浏览器的 getComputedStyle。
 *
 * 产出的 SVG：默认深色；宿主声明 prefers-color-scheme: light 时自动切浅色；
 * 下游还可以用 svg[data-theme="..."] 强制指定。
 *
 * 用法： node export-svg.mjs <input.html> [output.svg]
 */
import { readFileSync, writeFileSync } from "node:fs";

const [, , inPath, outPathArg] = process.argv;
if (!inPath) {
  console.error("usage: node export-svg.mjs <input.html> [output.svg]");
  process.exit(1);
}
const outPath = outPathArg ?? inPath.replace(/\.html$/, ".svg");
const html = readFileSync(inPath, "utf8");

/** 抓第一个 <svg>…</svg>（archify 每个文件只有一个，check 会验证）。 */
const svgMatch = html.match(/<svg[\s\S]*?<\/svg>/);
if (!svgMatch) throw new Error("no <svg> block found in " + inPath);
let svg = svgMatch[0];

/**
 * 合并所有 <style> 块，并**剥掉注释**。
 *
 * 为什么必须剥：下面用文本切分求 selector，会把规则前面的注释横幅一并算进 selector
 * （浏览器的 rule.selectorText 天然不含注释，所以 archify 原版没这个坑）。
 * 结果就是每个注释分组后的第一条规则（.c-grid / .t-primary / .a-default …）
 * 因为"开头不是 . 而是 /*"被过滤器丢掉，导出的 SVG 少掉正文色和箭头色。
 */
const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)]
  .map((m) => m[1])
  .join("\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * 极简 CSS 规则切分（够用即可：archify 的 CSS 里没有嵌套 {}，
 * @media 块单独处理——我们只取顶层规则）。
 */
function topLevelRules(source) {
  const rules = [];
  let depth = 0;
  let start = 0;
  let selectorEnd = -1;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") {
      if (depth === 0) selectorEnd = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const selector = source.slice(start, selectorEnd).trim();
        const body = source.slice(selectorEnd + 1, i).trim();
        // 跳过 @media/@supports 等 at-rule（它们的 body 里还有规则）
        if (!selector.startsWith("@")) rules.push({ selector, body });
        start = i + 1;
      }
    }
  }
  return rules;
}

const rules = topLevelRules(css);

/** 只留 SVG 相关的规则（与 archify serializeSvg 同款判据）。 */
const SVG_SEL = /(^|,)\s*(svg|:root|\[data-theme|\.c-|\.t-|\.a-|\.m-)/;
const hostStyle = rules
  .filter((r) => SVG_SEL.test(r.selector))
  .map((r) => `${r.selector} { ${r.body} }`)
  .join("\n");

/** 取某个主题块里的 CSS 变量声明。 */
function varsFor(themeSelectorRe) {
  const rule = rules.find((r) => themeSelectorRe.test(r.selector));
  if (!rule) throw new Error("theme block not found: " + themeSelectorRe);
  return (rule.body.match(/--[a-zA-Z0-9-]+\s*:[^;]+;/g) || []).join(" ");
}

const darkVars = varsFor(/\[data-theme="dark"\]/);
const lightVars = varsFor(/\[data-theme="light"\]/);

const fontFallback = [400, 500, 600, 700]
  .map(
    (w) =>
      `@font-face { font-family: 'JetBrains Mono'; font-weight: ${w}; src: local('JetBrains Mono'), local('JetBrainsMono-Regular'); }`
  )
  .join("\n");

const FONT_STACK =
  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', 'Noto Sans Mono CJK SC', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', monospace";

const styleEl = `<style>
${fontFallback}
svg { font-family: ${FONT_STACK}; }
${hostStyle}
:root, svg { ${darkVars} }
@media (prefers-color-scheme: light) { :root, svg { ${lightVars} } }
svg[data-theme="light"] { ${lightVars} }
svg[data-theme="dark"] { ${darkVars} }
rect.c-bg-rect { fill: var(--bg); }
</style>`;

// viewBox → 显式 width/height（markdown/GitHub 需要固有尺寸才不会塌缩）
const vb = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
if (!vb) throw new Error("svg has no viewBox");
const [, w, h] = vb;

svg = svg.replace(
  /<svg([^>]*)>/,
  `<svg$1 xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
${styleEl}
<rect class="c-bg-rect" width="100%" height="100%"/>`
);
// 不锁定主题，交给宿主的 prefers-color-scheme
svg = svg.replace(/\s+data-theme="[^"]*"/, "");

writeFileSync(outPath, svg + "\n");
console.log(
  `${outPath}  (${(Buffer.byteLength(svg) / 1024).toFixed(1)}KB, ${w}×${h}, dual-theme)`
);
