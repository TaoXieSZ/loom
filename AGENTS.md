# loom 工作约定

## 进度图 = `docs/architecture/v2-progress.*`（archify）

项目进度页用 [archify](https://github.com/tt-a1i/archify) 维护（`npx skills add tt-a1i/archify -g` 安装）。
**每当组件/里程碑进度变化，必须同步更新这张图**，它是 README 里进度一节的图源。

- 唯一手写源：`docs/architecture/v2-progress.architecture.json`（archify IR，勿手改 HTML/SVG）
- 语义约定：**节点：✅ 已建成 / ◐ 部分或过渡 / ⬜ 待建**（标记直接放进节点 `label`，`tag` 标里程碑）；**连线：实线 = 链路已接通，虚线（`"variant": "dashed"`）= 未接通**。两个维度都要标，避免"不知是框没建还是线没接"
- 改动后重渲染 + 重导 SVG（README 引用的是 SVG）：

```bash
node ~/.agents/skills/archify/bin/archify.mjs deliver architecture \
  docs/architecture/v2-progress.architecture.json docs/architecture/v2-progress.html \
  --json --quality standard
node docs/architecture/export-svg.mjs docs/architecture/v2-progress.html
```

- deliver 前校验失败时按诊断里的 suggested fix 修，不要改 renderer；目标架构图
  `v2-runtime.*` 同理（同目录、同流程）。

## 验证

```bash
npm run check   # build 全部包 + 跑全部测试（node:test）
```
