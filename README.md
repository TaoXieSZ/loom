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

## 布局

```
packages/protocol   类型契约，dispatch↔loom-host 协议的唯一真相
packages/loop       agent loop 纯逻辑（工具循环/上下文/MCP/session），可单测
packages/host       进程壳（HTTP/SSE 服务、agent home 落盘、pm2 托管）
```

## 命令

```bash
npm run check   # build 全部包 + 跑全部测试（node:test）
```

原则摘要：文件优先聚合根（`agents/<id>/`），一切索引皆派生物；能力构造式
（grants 不授权的工具不进工具列表，approval 是 loop 原语）；夹具必须抄真机 payload。
