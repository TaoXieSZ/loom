/**
 * AgentHome —— agent home 目录的仓库接口（蓝图 D3：仓库包裹文件）。
 *
 * 为什么包一层接口而不是让上层直接 fs：
 *  - 真相只有一个形状，散落在各处的 readFileSync 会让"格式"长满整个代码库；
 *    收在一个文件里，jsonl 的 ts 包装、core.md 的截断、sid 的清洗都只有一处定义。
 *  - 上层（server / distill / memory-index）只跟语义方法打交道，测试可以
 *    对着临时目录直接验证文件层行为。
 *
 * 布局（第二课 §1）：
 *   agents/<id>/{agent.json, memory/{core.md,facts/,episodes/}, sessions/*.jsonl, audit.log}
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import type { Message } from "@loom/protocol";
import type { Grants } from "@loom/loop";

/** core.md 的硬上限（字符）。它每次请求都进 system prompt，必须严格小（D4）。 */
export const CORE_MAX_CHARS = 2_000;

/**
 * id 白名单。sessionId / agentId 都会拼进文件路径，
 * 不过滤的话 `../../etc` 就是路径穿越——白名单比黑名单省事且没有漏网之鱼。
 */
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

export function sanitizeId(id: string, what = "id"): string {
  if (!SAFE_ID.test(id))
    throw new Error(`invalid ${what}: ${JSON.stringify(id)} (只允许 [a-zA-Z0-9_-])`);
  return id;
}

/** agent.json 的形状：对齐 server.ts 的 AgentConfig（去掉 agentId —— 目录名就是 id）。 */
export interface AgentConfigFile {
  model: string;
  systemPrompt?: string;
  grants?: Grants;
  maxSteps?: number;
  approvalTimeoutMs?: number;
}

/** 一个可被索引的记忆文件。path 是相对 home 根的（写进索引、给模型看都用它）。 */
export interface MemoryFile {
  kind: "fact" | "episode";
  path: string;
  absPath: string;
}

export interface AgentHome {
  /** home 根目录（agents/<id>/）。 */
  dir: string;
  /** 读 agent.json。文件必须存在——没有身份文件的目录不是 agent home。 */
  loadConfig(): AgentConfigFile;
  /** 读常驻记忆。缺失 = 无常驻记忆；超 CORE_MAX_CHARS 截断（严格小，D4）。 */
  readCore(): string | undefined;
  /** 列出 facts/ + episodes/ 下的 .md（core.md 常驻注入，不进索引，D4）。 */
  listMemoryFiles(): MemoryFile[];
  /** 把消息 append 到 sessions/<sid>.jsonl，每行 {"ts":..., ...Message}。 */
  appendSession(sid: string, msgs: Message[]): void;
  /** 读回整个 session（剥掉 ts 包装）。坏行跳过并 warn —— append-only 的断点保护。 */
  loadSession(sid: string): Message[];
  /** 追加一条审计事件（{"ts":..., ...event}）到 audit.log。 */
  appendAudit(event: Record<string, unknown>): void;
}

export function openAgentHome(
  root: string,
  agentId: string,
  opts: { warn?: (msg: string) => void } = {}
): AgentHome {
  const warn = opts.warn ?? ((msg: string) => console.error(`[home] ${msg}`));
  const dir = join(root, sanitizeId(agentId, "agentId"));
  const memoryDir = join(dir, "memory");
  const sessionsDir = join(dir, "sessions");

  const sessionFile = (sid: string) =>
    join(sessionsDir, sanitizeId(sid, "sessionId") + ".jsonl");

  return {
    dir,

    loadConfig() {
      const raw = readFileSync(join(dir, "agent.json"), "utf8");
      const cfg = JSON.parse(raw) as AgentConfigFile;
      if (typeof cfg.model !== "string" || cfg.model.length === 0)
        throw new Error(`${dir}/agent.json: model 缺失`);
      return cfg;
    },

    readCore() {
      const p = join(memoryDir, "core.md");
      if (!existsSync(p)) return undefined;
      const text = readFileSync(p, "utf8").trim();
      if (text.length <= CORE_MAX_CHARS) return text;
      // 硬截断而不是报错：core.md 是手改的文件，宁可丢尾也不让 agent 起不来。
      warn(`core.md 超 ${CORE_MAX_CHARS} 字，已截断`);
      return text.slice(0, CORE_MAX_CHARS);
    },

    listMemoryFiles() {
      const out: MemoryFile[] = [];
      for (const [sub, kind] of [
        ["facts", "fact"],
        ["episodes", "episode"],
      ] as const) {
        const subDir = join(memoryDir, sub);
        if (!existsSync(subDir)) continue;
        for (const name of readdirSync(subDir).sort()) {
          if (!name.endsWith(".md")) continue;
          out.push({
            kind,
            path: `memory/${sub}/${name}`,
            absPath: join(subDir, name),
          });
        }
      }
      return out;
    },

    appendSession(sid, msgs) {
      if (msgs.length === 0) return;
      mkdirSync(sessionsDir, { recursive: true });
      const lines = msgs
        .map((m) => JSON.stringify({ ts: Date.now(), ...m }))
        .join("\n");
      appendFileSync(sessionFile(sid), lines + "\n", "utf8");
    },

    loadSession(sid) {
      const p = sessionFile(sid);
      if (!existsSync(p)) return [];
      const out: Message[] = [];
      const lines = readFileSync(p, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!.trim();
        if (!line) continue;
        try {
          const rec = JSON.parse(line) as { ts?: number } & Message;
          delete rec.ts; // ts 是落盘包装，不是消息本体
          out.push(rec);
        } catch {
          // 断电/中断最多坏最后一行——跳过它，前面照常加载（append-only 的意义）。
          warn(`${p}:${i + 1} 坏行已跳过`);
        }
      }
      return out;
    },

    appendAudit(event) {
      mkdirSync(dir, { recursive: true });
      appendFileSync(
        join(dir, "audit.log"),
        JSON.stringify({ ts: Date.now(), ...event }) + "\n",
        "utf8"
      );
    },
  };
}
