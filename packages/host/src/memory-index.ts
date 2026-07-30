/**
 * memory/index.sqlite —— 记忆的 FTS 派生索引（蓝图 D3/D4：索引皆派生物）。
 *
 * 两条纪律（第二课 §2/§4）：
 *  - **可重建**。真相在 facts/*.md + episodes/*.md，这个 sqlite 只是检索加速器。
 *    过期检测故意粗暴：任一源文件 mtime 比索引新 → 整个重建。不做增量同步，
 *    就没有双写一致性问题。
 *  - **双通道查询**。trigram 分词要求查询词 ≥3 字符（实测：两字符中文 "深烘"
 *    MATCH 静默返空）——所以 ≥3 字符走 FTS5 MATCH，短词回退 LIKE。
 *  - **OR + 命中词数排序，不是 AND**。模型的查询是自然语言（"咖啡 偏好 喜欢"），
 *    AND 只要一个词不在正文就整体 miss——真机 smoke 就栽在这（模型明明调了
 *    memory_search，却回答"没有相关记忆"）。命中任意词即入选，命中词多者排前。
 *
 * core.md 不进索引：它常驻 system prompt，索引它只会污染搜索结果。
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentHome } from "./home.js";

/** trigram 分词的最小查询词长（字符）。短于它的词 MATCH 不到任何东西。 */
const TRIGRAM_MIN = 3;
/** snippet 在命中点前后各取的字符数。 */
const SNIPPET_RADIUS = 60;

export interface MemoryHit {
  kind: "fact" | "episode";
  /** 相对 home 根的路径（memory/facts/xxx.md）——给模型指引用它。 */
  path: string;
  /** 命中处 ±SNIPPET_RADIUS 字的片段。 */
  snippet: string;
}

export interface MemoryIndex {
  /** 源文件比索引新就重建（开 home 时、distill 后各调一次）。 */
  ensureFresh(): void;
  /** 全量重建：删光重插。索引随时可删，这就是恢复手段。 */
  rebuild(): void;
  search(query: string, limit?: number): MemoryHit[];
  close(): void;
}

interface Row {
  kind: "fact" | "episode";
  path: string;
  title: string;
  body: string;
}

/** 标题 = 首个 markdown 标题行，没有就用文件名。 */
function titleOf(path: string, body: string): string {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1]!.trim() : path.split("/").pop()!;
}

/** FTS5 查询串：词加引号（防词里的特殊字符被当语法）。限定 title/body 两列——
 *  kind/path 也在 FTS 表里，不框住的话查 "fact" 会命中所有 fact 行。 */
function ftsQuery(term: string): string {
  return `{title body} : "${term.replace(/"/g, '""')}"`;
}

/** 命中点 ±SNIPPET_RADIUS 字的片段；找不到（LIKE 多词场景）就从开头截。 */
function snippetOf(body: string, terms: string[]): string {
  let at = -1;
  for (const t of terms) {
    const i = body.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) at = 0;
  const from = Math.max(0, at - SNIPPET_RADIUS);
  const to = Math.min(body.length, at + SNIPPET_RADIUS);
  return (
    (from > 0 ? "…" : "") +
    body.slice(from, to).replace(/\s+/g, " ").trim() +
    (to < body.length ? "…" : "")
  );
}

export function openMemoryIndex(home: AgentHome): MemoryIndex {
  const memoryDir = join(home.dir, "memory");
  mkdirSync(memoryDir, { recursive: true });
  const indexPath = join(memoryDir, "index.sqlite");

  // DatabaseSync 打开即建文件——所以"索引原本是否存在"必须在打开前取证，
  // 否则刚建的空文件 mtime = now，永远显得"新鲜"，删索引重建就失效了。
  let idxMtime = existsSync(indexPath) ? statSync(indexPath).mtimeMs : 0;

  // node:sqlite 是 Node 24 内置模块（experimental，启动时打一条 warning，可接受）。
  // 选它是因为零新依赖，且 FTS5 + trigram 开箱即用。
  const db = new DatabaseSync(indexPath);
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS mem USING fts5(
       kind, path, title, body, tokenize='trigram'
     )`
  );

  const insert = db.prepare(
    `INSERT INTO mem (kind, path, title, body) VALUES (?, ?, ?, ?)`
  );

  function readRows(): Row[] {
    return home.listMemoryFiles().map((f) => {
      const body = readFileSync(f.absPath, "utf8");
      return { kind: f.kind, path: f.path, title: titleOf(f.path, body), body };
    });
  }

  function rebuild(): void {
    db.exec(`DELETE FROM mem`);
    for (const r of readRows()) insert.run(r.kind, r.path, r.title, r.body);
    idxMtime = Date.now();
  }

  return {
    rebuild,

    ensureFresh() {
      const stale = home
        .listMemoryFiles()
        .some((f) => statSync(f.absPath).mtimeMs > idxMtime);
      if (stale) rebuild();
    },

    search(query, limit = 5) {
      const terms = query.trim().split(/\s+/).filter(Boolean);
      if (terms.length === 0) return [];

      // 逐词独立查（≥3 字符 FTS，短词 LIKE），命中任意词即入选，按命中词数降序。
      // 语义的"为什么"见文件头——AND 在自然语言查询下太脆。
      const byPath = new Map<string, { row: Row; score: number }>();
      for (const t of terms) {
        const rows = (
          t.length >= TRIGRAM_MIN
            ? db
                .prepare(
                  `SELECT kind, path, title, body FROM mem
                   WHERE mem MATCH ? ORDER BY rank LIMIT 50`
                )
                .all(ftsQuery(t))
            : // 短词回退：LIKE 全表扫（标题+正文）。记忆库是 KB~MB 级，
              // 正确性优先、性能够用。
              db
                .prepare(
                  `SELECT kind, path, title, body FROM mem
                   WHERE title LIKE ? OR body LIKE ? LIMIT 50`
                )
                .all(`%${t}%`, `%${t}%`)
        ) as unknown as Row[];
        for (const r of rows) {
          const cur = byPath.get(r.path);
          if (cur) cur.score += 1;
          else byPath.set(r.path, { row: r, score: 1 });
        }
      }
      return [...byPath.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ row }) => ({
          kind: row.kind,
          path: row.path,
          snippet: snippetOf(row.body, terms),
        }));
    },

    close() {
      db.close();
    },
  };
}
