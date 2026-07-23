/**
 * loom-host 的 HTTP 服务 —— 进程壳(用 Node 内置 http,零依赖)。
 *
 * M1 范围:极简、无状态。收一条消息 → 跑一个 turn → 流式吐 SSE → 结束。
 * 落盘 / 记忆 / 多轮连续性都是 M2,这里碰都不碰。
 *
 * 接口面就三个:
 *   GET  /health          → { ok, backend }
 *   POST /run             → SSE 流(TurnEvent),body: { message, agentId? }
 */

import { createServer as createHttpServer, type Server } from "node:http";
import type { Message } from "@loom/protocol";
import {
  runTurn,
  type CompleteFn,
  type Grants,
  type LoopDeps,
  type ToolRegistry,
} from "@loom/loop";
import { SSE_HEADERS, pipeEventsToSse } from "./sse.js";

/** M1 的最小 agent 定义。M2 会从 agent home 的 agent.json 读,现在先内存里给。 */
export interface AgentConfig {
  agentId: string;
  model: string;
  systemPrompt?: string;
  grants?: Grants;
  tools?: ToolRegistry;
  maxSteps?: number;
  approvalTimeoutMs?: number;
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
      let body: { message?: unknown; agentId?: unknown };
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

      // M1 无状态:每次请求现搭 messages。多轮连续性是 M2 的 session。
      const messages: Message[] = [];
      if (agent.systemPrompt)
        messages.push({ role: "system", content: agent.systemPrompt });
      messages.push({ role: "user", content: body.message });

      // 客户端断开(用户 /stop、dispatch 掉线)→ abort,一路传到 fetch 取消。
      const ac = new AbortController();
      res.on("close", () => ac.abort());

      res.writeHead(200, SSE_HEADERS);
      try {
        const events = runTurn(
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
        await pipeEventsToSse(events, (chunk) => res.write(chunk));
      } catch (e) {
        // 流已经开始(头发了),没法改状态码。发一个 error 事件让下游知道。
        const msg = e instanceof Error ? e.message : String(e);
        if (!ac.signal.aborted)
          res.write(`data: ${JSON.stringify({ type: "error", message: msg })}\n\n`);
      } finally {
        res.end();
      }
      return;
    }

    json(res, 404, { error: "not found" });
  });
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
