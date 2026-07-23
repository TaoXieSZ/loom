#!/usr/bin/env node
/**
 * 把 docs 下的 markdown 渲染成套了门户风格的独立 html。
 *
 * 为什么需要:门户要托管到 Netlify(GitHub Pages 免费版不支持 private 仓库),
 * 而 Netlify 不像 GitHub 那样渲染 .md——直接访问是纯文本。这里预渲染成 html,
 * 复用门户(docs/index.html)的 Anthropic 配色,让文档在站点上也好读。
 *
 * 用法: npm i -D marked && node scripts/build-docs.mjs
 * 改了 md 就重跑,把生成的 .html 一起提交。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const DOCS = join(dirname(fileURLToPath(import.meta.url)), "..", "docs");

/** 要渲染的 md → 输出 html + 标题 + 返回门户的相对路径。 */
const PAGES = [
  { md: "blueprint.md", title: "v2 重建蓝图 — own-the-loop 宪章", home: "index.html" },
  { md: "lessons/01-wire-protocol.md", title: "第一课 — openai-compat 线协议", home: "../index.html" },
];

/** 门户同款 Anthropic 配色 + markdown 排版。 */
function shell(title, home, bodyHtml) {
  const fav = home.replace(/index\.html$/, ""); // "" 或 "../" —— 适配 lessons 子目录
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · loom</title>
<link rel="icon" href="${fav}favicon.svg" type="image/svg+xml">
<link rel="icon" href="${fav}favicon-32.png" sizes="32x32" type="image/png">
<meta name="theme-color" content="#cc785c">
<style>
  :root{
    --bg:#faf9f5;--surface:#f3f1ea;--ink:#1a1915;--muted:#6b6558;--faint:#9a9384;
    --line:#e2dfd4;--line-firm:#d0ccbe;--accent:#cc785c;--accent-ink:#a8502f;
    --serif:ui-serif,Georgia,"Songti SC","Noto Serif SC",serif;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,"Noto Sans Mono CJK SC",monospace;
  }
  @media(prefers-color-scheme:dark){:root{
    --bg:#1f1e1b;--surface:#292722;--ink:#f0eee6;--muted:#a8a090;--faint:#756f62;
    --line:#34322c;--line-firm:#423f37;--accent:#e0997c;--accent-ink:#eab59f;}}
  :root[data-theme="light"]{--bg:#faf9f5;--surface:#f3f1ea;--ink:#1a1915;--muted:#6b6558;--faint:#9a9384;--line:#e2dfd4;--line-firm:#d0ccbe;--accent:#cc785c;--accent-ink:#a8502f;}
  :root[data-theme="dark"]{--bg:#1f1e1b;--surface:#292722;--ink:#f0eee6;--muted:#a8a090;--faint:#756f62;--line:#34322c;--line-firm:#423f37;--accent:#e0997c;--accent-ink:#eab59f;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);
    font-size:16px;line-height:1.7;-webkit-font-smoothing:antialiased}
  .wrap{max-width:760px;margin:0 auto;padding:0 28px}
  header{border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5;
    background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px)}
  .bar{display:flex;align-items:center;gap:14px;padding:14px 0}
  .bar a.back{color:var(--muted);text-decoration:none;font-size:13.5px;font-family:var(--mono)}
  .bar a.back:hover{color:var(--accent-ink)}
  .bar .sp{margin-left:auto}
  .toggle{font-family:var(--mono);font-size:12px;color:var(--muted);background:transparent;
    border:1px solid var(--line-firm);border-radius:2px;padding:4px 9px;cursor:pointer}
  .toggle:hover{border-color:var(--accent);color:var(--accent-ink)}
  .toggle:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  main{padding:48px 0 80px}
  .prose h1{font-family:var(--serif);font-weight:500;font-size:clamp(30px,5vw,42px);
    line-height:1.15;letter-spacing:-.01em;margin:0 0 28px;text-wrap:balance}
  .prose h2{font-family:var(--serif);font-weight:500;font-size:25px;margin:44px 0 16px;
    padding-top:20px;border-top:1px solid var(--line);letter-spacing:-.005em}
  .prose h3{font-family:var(--serif);font-weight:600;font-size:19px;margin:32px 0 12px}
  .prose p{margin:0 0 18px}
  .prose ul,.prose ol{margin:0 0 18px;padding-left:24px}
  .prose li{margin:6px 0}
  .prose a{color:var(--accent-ink);text-decoration:none;border-bottom:1px solid var(--line-firm)}
  .prose a:hover{border-color:var(--accent)}
  .prose strong{font-weight:600;color:var(--ink)}
  .prose em{font-family:var(--serif);font-style:italic}
  .prose code{font-family:var(--mono);font-size:.88em;background:var(--surface);
    border:1px solid var(--line);border-radius:3px;padding:1px 5px}
  .prose pre{background:var(--surface);border:1px solid var(--line);border-radius:4px;
    padding:16px 18px;overflow-x:auto;margin:0 0 20px;line-height:1.55}
  .prose pre code{background:none;border:0;padding:0;font-size:13px}
  .prose blockquote{margin:0 0 20px;padding:2px 18px;border-left:3px solid var(--accent);
    color:var(--muted);background:var(--surface)}
  .prose blockquote p{margin:12px 0}
  .prose table{border-collapse:collapse;width:100%;margin:0 0 22px;font-size:14px;display:block;overflow-x:auto}
  .prose th,.prose td{border:1px solid var(--line);padding:8px 12px;text-align:left;vertical-align:top}
  .prose th{background:var(--surface);font-weight:600;font-family:var(--mono);font-size:12.5px}
  .prose hr{border:0;border-top:1px solid var(--line);margin:32px 0}
  @media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>
<header><div class="wrap bar">
  <a class="back" href="${home}">← 门户</a>
  <span class="sp"></span>
  <button class="toggle" id="t" aria-label="切换主题">主题</button>
</div></header>
<main class="wrap"><article class="prose">
${bodyHtml}
</article></main>
<script>
(function(){var r=document.documentElement,k="loom-theme",s=null;
try{s=localStorage.getItem(k)}catch(e){}if(s)r.setAttribute("data-theme",s);
document.getElementById("t").addEventListener("click",function(){
var c=r.getAttribute("data-theme")||(matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light");
var n=c==="dark"?"light":"dark";r.setAttribute("data-theme",n);
try{localStorage.setItem(k,n)}catch(e){}});})();
</script>
</body>
</html>
`;
}

marked.setOptions({ gfm: true, breaks: false });

for (const p of PAGES) {
  const src = readFileSync(join(DOCS, p.md), "utf8");
  // 门户内部的 .md 链接改指向对应 .html(站点上 md 不渲染)
  const body = marked.parse(src).replace(/href="([^"]+)\.md"/g, 'href="$1.html"');
  const out = join(DOCS, p.md.replace(/\.md$/, ".html"));
  writeFileSync(out, shell(p.title, p.home, body));
  console.log("rendered", relative(DOCS, out), `(${(Buffer.byteLength(shell(p.title, p.home, body)) / 1024).toFixed(1)}KB)`);
}
