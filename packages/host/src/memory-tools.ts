/**
 * memory_search 工具 —— 模型检回长期记忆的唯一入口（蓝图 D4：两级记忆）。
 *
 * 只读、只搜自己的 home，风险天然低 → defaultMode: "always"（不打扰人，
 * 对应 types.ts 里"工具自己声明风险"的既定例子）。agent.json 的 grants
 * 仍可覆盖成 ask —— 风险知识属于工具，策略属于 agent 配置。
 */

import type { ToolSpec } from "@loom/loop";
import type { AgentHome } from "./home.js";
import { openMemoryIndex } from "./memory-index.js";

export function memorySearchTool(home: AgentHome): ToolSpec {
  return {
    def: {
      type: "function",
      function: {
        name: "memory_search",
        description:
          "检索你的长期记忆（facts/ 与 episodes/）。core.md 已在上下文里，不用搜它。",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "检索词，可用空格分隔多个词（AND）。注意：短于 3 字符的词走慢速回退。",
            },
          },
          required: ["query"],
        },
      },
    },
    defaultMode: "always",
    async run(args) {
      const query = (args as { query?: unknown })?.query;
      if (typeof query !== "string" || query.trim().length === 0)
        return "Error: args.query (non-empty string) is required";

      const index = openMemoryIndex(home);
      try {
        index.ensureFresh();
        const hits = index.search(query);
        if (hits.length === 0) return `没有命中「${query}」的记忆。`;
        return hits
          .map((h) => `--- ${h.path} (${h.kind})\n${h.snippet}`)
          .join("\n\n");
      } finally {
        index.close();
      }
    },
  };
}
