// @loom/protocol — dispatch↔loom-host↔loop 的共享契约与 openai-compat SSE 解析。
export type {
  Message,
  ToolCall,
  ToolDef,
  CompletionRequest,
  FinishReason,
  CompletionEvent,
} from "./types.js";
export {
  frameDecoder,
  eventDecoder,
  parseCompletionStream,
  type Warn,
} from "./parse-sse.js";
export {
  complete,
  CompletionHttpError,
  type ProviderConfig,
  type CompleteOptions,
} from "./transport.js";
