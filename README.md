# loom

把 loop 织起来的机器 —— agent-farm v2 的核心：自有 agent loop + agent 状态单一归属。

- 宪章（8 项架构决策 + M1-M6 里程碑）：[`docs/blueprint.md`](docs/blueprint.md)
- 教学课件（本项目是教学项目，关键概念先讲后写）：[`docs/lessons/`](docs/lessons/)

## 目标运行时架构

> ⚠️ **这是目标态，不是已交付状态**。当前进度见宪章（[`docs/blueprint.md`](docs/blueprint.md)）
> 的 M1-M6 梯子。v1（dispatch + agent-host）是独立的上一代实现，不在本库。

![agent-farm v2 (loom) 目标运行时架构](docs/architecture/v2-runtime.svg)

图随主题自适配（深/浅色跟随阅读器偏好）。可交互版本（主题切换 + 4× 导出）：
`docs/architecture/v2-runtime.html`。改架构 → 改 `v2-runtime.architecture.json` →
重渲染 → `node docs/architecture/export-svg.mjs docs/architecture/v2-runtime.html`。

## 当前进度

> 组件视角（不是 M1-M6 里程碑——里程碑要等 host 打通飞书链路才算达成）。

![loom 组件进度](docs/architecture/v2-progress.svg)

| 组件 | 状态 |
|---|---|
<!-- SYNC:PROGRESS:START -->
| **① complete()** wire 契约 + SSE 解析 + transport | ✅ 已建成，真机验证（[PR #1](https://github.com/TaoXieSZ/loom/pull/1)） |
| **② loop** agent 循环 + 构造式边界 + 审批原语 | ✅ 已建成，真机验证（[PR #2](https://github.com/TaoXieSZ/loom/pull/2)） |
| **host** 进程壳:HTTP/SSE | ✅ 已建成，真机验证 |
| **grants** 构造式门控逻辑已在 ② 实现；飞书审批卡渲染待接 | ◐ 逻辑已在 ② 实现；飞书审批卡待接（M3） |
| **agent home** 文件优先聚合根 + 两级记忆（core.md + FTS）+ memory_search + 蒸馏入口，真机验证 | ✅ 已建成 |
| **dispatch** 外壳移植（飞书层 / 审批流）+ 绞杀迁移 | ⬜ 待建 · M4–M5 |

DeepSeek v4-flash 全链路已打通，**58 测试绿**（14 protocol + 16 loop + 28 host）。
<!-- SYNC:PROGRESS:END -->

> 进度由 `scripts/sync-portal.mjs` 从测试与实现事实自动同步，非手工维护。

## 布局

```
packages/protocol   ✅ 类型契约 + SSE 解析 + transport（dispatch↔loom-host 协议唯一真相）
packages/loop       ✅ agent loop（工具循环 / 构造式能力边界 / 审批原语），纯逻辑可单测
packages/host       ✅ 进程壳（HTTP/SSE）+ agent home 落盘（两级记忆/memory_search/蒸馏，M2 真机验证）— pm2 托管待部署
```

## 命令

```bash
npm run check   # build 全部包 + 跑全部测试（node:test）
```

原则摘要：文件优先聚合根（`agents/<id>/`），一切索引皆派生物；能力构造式
（grants 不授权的工具不进工具列表，approval 是 loop 原语）；夹具必须抄真机 payload。
