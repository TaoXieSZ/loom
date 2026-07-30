// @loom/host — 进程壳:HTTP/SSE 服务,把 loop 暴露给 dispatch;M2 起兼任 agent home 状态层。
export {
  createServer,
  startServer,
  createHomeResolver,
  type HostDeps,
  type AgentConfig,
} from "./server.js";
export { sseFrame, sseDone, pipeEventsToSse, SSE_HEADERS } from "./sse.js";
export {
  openAgentHome,
  sanitizeId,
  CORE_MAX_CHARS,
  type AgentHome,
  type AgentConfigFile,
  type MemoryFile,
} from "./home.js";
export {
  openMemoryIndex,
  type MemoryIndex,
  type MemoryHit,
} from "./memory-index.js";
export { memorySearchTool } from "./memory-tools.js";
export { distill, type DistillResult } from "./distill.js";
