// @loom/host — 进程壳:HTTP/SSE 服务,把 loop 暴露给 dispatch。
export {
  createServer,
  startServer,
  type HostDeps,
  type AgentConfig,
} from "./server.js";
export { sseFrame, sseDone, pipeEventsToSse, SSE_HEADERS } from "./sse.js";
