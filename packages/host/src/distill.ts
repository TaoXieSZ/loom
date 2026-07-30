/**
 * 蒸馏 —— 把 session 增量压缩内化成长期记忆（蓝图 D4，第二课 §5）。
 *
 * 流水线：
 *   watermark（memory/distill-state.json，每文件已蒸馏行数）
 *   → 读各 session 的增量行 → 喂给模型 → 模型吐 JSON {episode_md, facts[]}
 *   → 写 episodes/YYYY-MM-DD.md + facts/<slug>.md → 重建索引 → 推进 watermark
 *
 * 两个刻意的设计：
 *  - complete 是注入的（与 loop 同款 DI）：生产接真 DeepSeek，测试塞假模型。
 *  - watermark 是派生物：丢了无非全量重蒸，结果等价。所以它存 memory/ 下，
 *    和索引同一个"可再生"语义。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { CompleteFn } from "@loom/loop";
import { openMemoryIndex } from "./memory-index.js";
import { sanitizeId, type AgentHome } from "./home.js";

export interface DistillResult {
  /** 这次有没有实际蒸馏（无增量 = no-op）。 */
  distilled: boolean;
  /** 处理的增量行数。 */
  lines: number;
  /** 写入的 episode 相对路径（没写则为 undefined）。 */
  episodePath?: string;
  /** 写入/覆盖的 fact slug 列表。 */
  facts: string[];
}

interface DistillState {
  /** key = session 文件名（main.jsonl），value = 已蒸馏的行数。 */
  sessions: Record<string, number>;
}

/** 模型输出约定：一段当日 episode + 若干条原子事实。 */
interface DistillOutput {
  episode_md?: string;
  facts?: { slug: string; md: string }[];
}

const PROMPT = `你是一个记忆蒸馏器。下面是一个 agent 的会话增量（JSONL，每行 {"ts":..., "role":..., ...}）。
把它压缩内化成长期记忆，**只输出 JSON**（不要多余的话，不要 markdown 围栏）：

{"episode_md": "一段当日经历摘要（markdown，含 # 标题）", "facts": [{"slug": "kebab-case-标识", "md": "一条原子事实的完整 markdown（含 # 标题）"}]}

要求：
- facts 是一事一文件的长期事实（主人的偏好、重要的决定、可复用的结论），不是流水账；
- 已有的 episode 内容（如果提供）要和新增量合并降噪，不是简单拼接；
- 没有值得沉淀的内容时，facts 给空数组、episode_md 给空字符串。`;

/** 容忍模型的 ```json 围栏：剥掉首尾的 fence 再 parse。 */
function parseOutput(text: string): DistillOutput {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(stripped) as DistillOutput;
}

/** 聚合一次 complete 调用的全部正文（complete 是流式的，蒸馏只要最终文本）。 */
async function completeText(
  complete: CompleteFn,
  model: string,
  messages: { role: "system" | "user"; content: string }[]
): Promise<string> {
  let text = "";
  for await (const ev of complete({ model, messages })) {
    if (ev.type === "text_delta") text += ev.text;
  }
  return text;
}

export async function distill(
  home: AgentHome,
  complete: CompleteFn,
  opts: { model?: string; today?: string; warn?: (msg: string) => void } = {}
): Promise<DistillResult> {
  const warn = opts.warn ?? ((msg: string) => console.error(`[distill] ${msg}`));
  const model = opts.model ?? home.loadConfig().model;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const memoryDir = join(home.dir, "memory");
  const sessionsDir = join(home.dir, "sessions");
  const statePath = join(memoryDir, "distill-state.json");

  const state: DistillState = existsSync(statePath)
    ? (JSON.parse(readFileSync(statePath, "utf8")) as DistillState)
    : { sessions: {} };

  // ── 收集增量 ─────────────────────────────────────────────────────────
  const increment: string[] = [];
  const newCounts: Record<string, number> = {};
  if (existsSync(sessionsDir)) {
    for (const name of readdirSync(sessionsDir).sort()) {
      if (!name.endsWith(".jsonl")) continue;
      const lines = readFileSync(join(sessionsDir, name), "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
      newCounts[name] = lines.length;
      increment.push(...lines.slice(state.sessions[name] ?? 0));
    }
  }
  if (increment.length === 0) return { distilled: false, lines: 0, facts: [] };

  // ── 调模型 ───────────────────────────────────────────────────────────
  const episodeName = `${today}.md`;
  const episodeAbs = join(memoryDir, "episodes", episodeName);
  const existing = existsSync(episodeAbs)
    ? readFileSync(episodeAbs, "utf8")
    : undefined;
  const user =
    (existing ? `已有 episode（需合并降噪）：\n${existing}\n\n` : "") +
    `会话增量：\n${increment.join("\n")}`;

  let out: DistillOutput;
  try {
    out = parseOutput(await completeText(complete, model, [
      { role: "system", content: PROMPT },
      { role: "user", content: user },
    ]));
  } catch (e) {
    // 解析失败不推进 watermark：下次 cron 带着同样的增量重试。
    // 毒数据会反复重试（已知代价），但推进了就等于把没蒸馏的历史扔进黑洞。
    throw new Error(
      `蒸馏输出解析失败: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  // ── 落盘 ─────────────────────────────────────────────────────────────
  const facts: string[] = [];
  mkdirSync(join(memoryDir, "episodes"), { recursive: true });
  mkdirSync(join(memoryDir, "facts"), { recursive: true });

  if (typeof out.episode_md === "string" && out.episode_md.trim().length > 0)
    writeFileSync(episodeAbs, out.episode_md.trim() + "\n", "utf8");

  for (const f of out.facts ?? []) {
    if (typeof f?.slug !== "string" || typeof f?.md !== "string") {
      warn(`跳过畸形 fact: ${JSON.stringify(f)}`);
      continue;
    }
    let slug: string;
    try {
      slug = sanitizeId(f.slug, "fact slug");
    } catch {
      warn(`跳过非法 slug: ${JSON.stringify(f.slug)}`);
      continue;
    }
    writeFileSync(
      join(memoryDir, "facts", `${slug}.md`),
      f.md.trim() + "\n",
      "utf8"
    );
    facts.push(slug);
  }

  // 新记忆立刻可搜 → 全量重建（派生物，几秒的事）。
  const index = openMemoryIndex(home);
  try {
    index.rebuild();
  } finally {
    index.close();
  }

  // 推进 watermark（所有 session，含本次无增量的——行数以现在为准）。
  mkdirSync(memoryDir, { recursive: true });
  state.sessions = { ...state.sessions, ...newCounts };
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");

  return {
    distilled: true,
    lines: increment.length,
    ...(existsSync(episodeAbs)
      ? { episodePath: `memory/episodes/${episodeName}` }
      : {}),
    facts,
  };
}
