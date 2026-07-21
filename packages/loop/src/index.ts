// @loom/loop — agent loop（②-⑤ 层的②：工具循环 + 能力边界 + 审批原语）
export { runTurn, grantedTools, fingerprint } from "./run-turn.js";
export type {
  ToolSpec,
  ToolRegistry,
  ToolContext,
  Grant,
  Grants,
  GrantMode,
  ApprovalRequest,
  ApprovalVerdict,
  TurnEvent,
  TurnEndReason,
  TurnConfig,
  LoopDeps,
  CompleteFn,
} from "./types.js";
