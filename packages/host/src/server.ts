/**
 * loom-host 的 HTTP 服务 —— 进程壳(用 Node 内置 http,零依赖)。
 *
 * M1 范围:极简、无状态。收一条消息 → 跑一个 turn → 流式吐 SSE → 结束。
 * M2 范围:AgentConfig 带 home 时,接通 agent home —— system = systemPrompt + core.md
 * 现拼、session 历史接上、turn 结束把新增段 append 进 sessions/*.jsonl、
 * approval/tool_end 事件 tee 进 audit.log。**无 home 的旧路径行为一行不动。**
 *
 * 接口面就三个:
 *   GET  /health          → { ok, backend }
 *   POST /run             → SSE 流(TurnEvent),body: { message, agentId?, sessionId? }
 */

import { createServer as createHttpServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@loom/protocol";
import {
  runTurn,
  type CompleteFn,
  type Grants,
  type LoopDeps,
  type ToolRegistry,
  type TurnEvent,
} from "@loom/loop";
import { SSE_HEADERS, pipeEventsToSse } from "./sse.js";
import { openAgentHome, type AgentHome } from "./home.js";
import { memorySearchTool } from "./memory-tools.js";

/** agent 定义。home 缺省 = M1 的无状态内存 agent;带上 home 即获得 M2 全部状态能力。 */
export interface AgentConfig {
  agentId: string;
  model: string;
  systemPrompt?: string;
  grants?: Grants;
  tools?: ToolRegistry;
  maxSteps?: number;
  approvalTimeoutMs?: number;
  home?: AgentHome;
}

export interface HostDeps {
  /** 注入 complete(与 loop 同款注入):生产接真 DeepSeek,测试塞假模型。 */
  complete: CompleteFn;
  /** 按 id 找 agent 定义;找不到返回 undefined → 404。 */
  resolveAgent: (agentId: string) => AgentConfig | undefined;
  requestApproval?: LoopDeps["requestApproval"];
  /** /health 里回报的后端标识,便于运维确认。 */
  backend?: string;
}

const readBody = (req: import("node:http").IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      data += c;
      if (data.length > 256 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

const json = (
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown
) => {
  const s = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(s);
};

export function createServer(deps: HostDeps): Server {
  return createHttpServer(async (req, res) => {
    const url = req.url ?? "/";

    if (req.method === "GET" && url === "/health") {
      json(res, 200, { ok: true, backend: deps.backend ?? "loom-host" });
      return;
    }

    if (req.method === "POST" && url === "/run") {
      let body: { message?: unknown; agentId?: unknown; sessionId?: unknown };
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (typeof body.message !== "string" || body.message.length === 0) {
        json(res, 400, { error: "body.message (non-empty string) is required" });
        return;
      }
      const agentId = typeof body.agentId === "string" ? body.agentId : "default";
      const agent = deps.resolveAgent(agentId);
      if (!agent) {
        json(res, 404, { error: `unknown agent: ${agentId}` });
        return;
      }

      const sessionId =
        typeof body.sessionId === "string" ? body.sessionId : "main";

      // 有 home:system = systemPrompt + core.md 现拼(system 不落盘——它是配置的投影,
      // 落盘就出了第二份真相),再接上 session 历史。无 home:M1 旧路径,行为不变。
      const messages: Message[] = [];
      if (agent.home) {
        const sys = [agent.systemPrompt, agent.home.readCore()]
          .filter((s): s is string => !!s)
          .join("\n\n");
        if (sys) messages.push({ role: "system", content: sys });
        try {
          messages.push(...agent.home.loadSession(sessionId));
        } catch (e) {
          // sid 清洗失败(路径穿越嫌疑)之类,400 比 500 诚实。
          json(res, 400, { error: e instanceof Error ? e.message : String(e) });
          return;
        }
      } else if (agent.systemPrompt) {
        messages.push({ role: "system", content: agent.systemPrompt });
      }
      // runTurn 就地追加 messages(② 层契约)——turn 后 slice(turnStart) 就是要落盘的新增段。
      const turnStart = messages.length;
      messages.push({ role: "user", content: body.message });

      // 客户端断开(用户 /stop、dispatch 掉线)→ abort,一路传到 fetch 取消。
      const ac = new AbortController();
      res.on("close", () => ac.abort());

      res.writeHead(200, SSE_HEADERS);
      try {
        let events = runTurn(
          {
            complete: deps.complete,
            ...(deps.requestApproval
              ? { requestApproval: deps.requestApproval }
              : {}),
          },
          {
            agentId: agent.agentId,
            model: agent.model,
            grants: agent.grants ?? {},
            tools: agent.tools ?? {},
            ...(agent.maxSteps !== undefined ? { maxSteps: agent.maxSteps } : {}),
            ...(agent.approvalTimeoutMs !== undefined
              ? { approvalTimeoutMs: agent.approvalTimeoutMs }
              : {}),
            signal: ac.signal,
          },
          messages
        );
        if (agent.home)
          events = teeAudit(events, agent.home, agent.agentId, sessionId);
        await pipeEventsToSse(events, (chunk) => res.write(chunk));
      } catch (e) {
        // 流已经开始(头发了),没法改状态码。发一个 error 事件让下游知道。
        const msg = e instanceof Error ? e.message : String(e);
        if (!ac.signal.aborted)
          res.write(`data: ${JSON.stringify({ type: "error", message: msg })}\n\n`);
      } finally {
        // 中断/异常也如实落已有部分(jsonl append-only,落一半是正常状态不是损坏)。
        if (agent.home) {
          try {
            agent.home.appendSession(sessionId, messages.slice(turnStart));
          } catch (e) {
            console.error(
              `[host] session 落盘失败: ${e instanceof Error ? e.message : String(e)}`
            );
          }
        }
        res.end();
      }
      return;
    }

    json(res, 404, { error: "not found" });
  });
}

/**
 * 把 approval / tool_end 事件 tee 一份进 audit.log,事件本身原样下传。
 * 谁发起的审批、批没批、工具执行结果如何——审计口径和 dispatch 看到的流一致。
 */
async function* teeAudit(
  events: AsyncIterable<TurnEvent>,
  home: AgentHome,
  agentId: string,
  sessionId: string
): AsyncGenerator<TurnEvent> {
  for await (const ev of events) {
    if (
      ev.type === "approval_requested" ||
      ev.type === "approval_settled" ||
      ev.type === "tool_end"
    )
      home.appendAudit({ agentId, sessionId, event: ev });
    yield ev;
  }
}

/**
 * 从 agents/<id>/ 组装 AgentConfig 的 resolver（M2 生产接线）。
 *
 * memory_search 默认授予（只读、只搜自己的 home，风险天然低），
 * agent.json 的 grants 可覆盖 mode（比如改成 "ask"）。
 * 构造式边界的语义仍在 loop 层：grants 表里没有的工具，模型压根看不见。
 */
export function createHomeResolver(
  homeRoot: string
): (agentId: string) => AgentConfig | undefined {
  return (agentId) => {
    let home: AgentHome;
    try {
      home = openAgentHome(homeRoot, agentId);
    } catch {
      return undefined; // agentId 带非法字符 → 视为不存在
    }
    if (!existsSync(join(home.dir, "agent.json"))) return undefined;
    const cfg = home.loadConfig();
    return {
      agentId,
      model: cfg.model,
      ...(cfg.systemPrompt !== undefined
        ? { systemPrompt: cfg.systemPrompt }
        : {}),
      grants: { memory_search: {}, ...cfg.grants },
      tools: { memory_search: memorySearchTool(home) },
      home,
      ...(cfg.maxSteps !== undefined ? { maxSteps: cfg.maxSteps } : {}),
      ...(cfg.approvalTimeoutMs !== undefined
        ? { approvalTimeoutMs: cfg.approvalTimeoutMs }
        : {}),
    };
  };
}

/** 便捷启动:createServer + listen,resolve 出实际端口。 */
export function startServer(
  deps: HostDeps,
  opts: { port?: number; host?: string } = {}
): Promise<{ server: Server; port: number }> {
  const server = createServer(deps);
  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 0);
      resolve({ server, port });
    });
  });
}
