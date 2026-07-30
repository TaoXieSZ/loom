# agent-farm v2 蓝图 — own-the-loop 重建宪章

Status: **已定稿 —— M1 ✅ M2 ✅（2026-07-29 真机验证）→ 当前 M3**
Date: 2026-07-17｜方法：逐分支拍板，每个决策先讲透 tradeoff 再定

## 0. 一句话

**换心不拆楼**：重建核心（自有 agent loop + agent 状态单一归属），移植外壳
（飞书层/approval 流/dispatch 事件接入——战斗验证过的脏活不重交学费）。
v2 是教学项目：每个关键点掰碎讨论，学习深度优先于进度。

## 1. 决策记录（8 项架构决策）

| # | 决策 | 要点 |
|---|---|---|
| D1 | 重建边界=换心不拆楼 | 病灶在核心（租的 loop、状态三家分管）；外壳（飞书 1030 行、approval、intake）是资产 |
| D2 | loop 五层全自建，① 接口先行 | 窄接口 `complete(messages, tools) → 事件流`；第一版手写 openai-compat（~400 行+真机 SSE 夹具）；SDK 可换入=双向门；单线格式覆盖国产模型全阵营 |
| D3 | 聚合根=agent home，文件优先 | `agents/<id>/` 一处安家；仓库接口包裹；一切索引皆派生物（可重建）；dispatch 只留"世界如何接到 agent"（路由/bot/human-principal） |
| D4 | 记忆=两级注入+派生索引+蒸馏 | core.md 常驻（严格小）；facts/（一事一文件）+ episodes/ 靠 memory_search 工具 FTS5 检回；蒸馏 cron 合并降噪；embeddings 留位不实现 |
| D5 | 拓扑=每机一个 loop-host | dispatch 保持控制面；协议两端自有→"能力撒谎"病消灭；SSE 流式原生（v1 的 0/20 债变出生特性）；跨机/双面隔离/爆炸半径三保 |
| D6 | 能力=构造式，loop 原生 | grants 住 agent.json（不授权的工具不出现在工具列表）；approval=loop 原语（执行前 await 审批，飞书卡复用）；v1 的 HMAC/registry 七件套不移植（围栏时代补丁） |
| D7 | 仓库=新 monorepo 分阶段吸收 | packages/{protocol,loop,host}；protocol 单一真相；dispatch 留老仓库服务生产，外壳移植阶段搬入，v1 归档 |
| D8 | 节奏=行走骨架，通电第一 | 梯子见 §3；旧 adapter 路线关闭（被 v2 取代）；主力 agent 过渡期留在旧后端，最后再迁 |

## 2. 目标架构

```
飞书/设备/cron ──→ dispatch (控制面：路由·bot·human-principal·审批投递)
                     │  自有协议 packages/protocol（SSE 流式）
        ┌────────────┼────────────┐
   loop-host@主机A          loop-host@远端VM        ← packages/host（进程壳）
   ┌───────────────────┐
   │ loop（②工具循环 ③上下文 ④MCP ⑤session）        ← packages/loop（纯逻辑可单测）
   │   └ ① complete() 接口 → 手写 openai-compat → DeepSeek(v4-flash)
   │ agents/<id>/  ← 聚合根
   │   ├ agent.json      (身份+配置+grants)
   │   ├ memory/{core.md, facts/, episodes/, index.sqlite†}   †派生物
   │   ├ sessions/*.jsonl
   │   └ audit.log
   └───────────────────┘
```

v2 买到的结构性简化：**rotation/memory_key 整体蒸发**（自有③=压缩内化，id 终身稳定）；
**per-run token 体系蒸发**（loop 即 run，approval 是循环里的一个 await）。

## 3. 里程碑梯子（每级真机验收，不过不进下级）

- **M1 骨架**：新测试 agent（零工具）打穿全链路——飞书真实消息→dispatch(新 engine 类型)→
  loop-host→DeepSeek→SSE 流式回飞书卡。验收：流式卡片真机可见。
  - _进度（2026-07-21）_：① `complete()` 与 ② `loop` 组件已建成并真机验证（PR #1 #2，30 测试绿）；
    DeepSeek 全链路打通。**剩 host 进程壳**——它把这套通过 HTTP/SSE 暴露给 dispatch，
    是"能跑脚本"变成"飞书消息真机可见"的最后一步。组件进度见
    `docs/architecture/v2-progress.svg`。
  - _进度（2026-07-29）_：**M1 达成**。dispatch 新 engine 类型 `loom`（`loom-client.ts`，
    `IAgentHostClient` 实现：POST /run 消费 SSE、sessionId 透传、busy/cancel 映射）+
    飞书流式卡接线（`partialAnswerCard` 经 ProgressHub，1.5s 一档增量刷新）。
    真机全链路：owner 飞书 DM → dispatch(feishu-dm `/to loom-test`) → loom-host → DeepSeek →
    流式卡（trace 佐证：dispatch_progress 每 ~800ms 累计字符 2→115→199→282→370→462，
    5.7s 跑完，reply_delivered）。
    **运维教训**：同一飞书 app 多个 WS 消费者会被平台分片（Mac2 生产 dispatch 存活时
    消息随机分流两端，本机收不到的事件被旧配置拒绝）——本机测试期间需停 Mac2 dispatch
    或用独立测试 app。
- **M2 状态**：agent home 落盘、sessions.jsonl、两级记忆+memory_search+蒸馏 cron。
  验收：重启后记忆/会话连续，检索命中真实历史。
  - _进度（2026-07-27）_：`agents/<id>/` 聚合根 + sessions/*.jsonl 续接 + 两级记忆
    （core.md 常驻 + facts/episodes FTS5 检回，trigram 短词 LIKE 回退、OR 按命中词数排序）
    + memory_search 工具 + 蒸馏入口（`scripts/distill.mjs`）已建成，**58 测试绿**（+20）；
    第二课 [`lessons/02-agent-home.md`](lessons/02-agent-home.md)。
    **真机验收全绿**（`scripts/smoke-home.mjs`）：session 落盘 → 蒸馏出 facts →
    派生全新进程换 session 提问，只能靠 memory_search 检回并答对"深烘咖啡"——
    重启后记忆/会话连续，检索命中真实历史。（教训：多词 AND 检索太脆，改 OR 排序。）
- **M3 边界**：工具注册表、grants 构造式门控、approval 原语（飞书卡）、shell 工具、MCP 客户端。
  验收：未授权工具模型不可见；高危动作真机弹卡、owner-only。
- **M4 绞杀**：现有辅助 agent 逐个割接到 v2（先低风险的临时 agent，再有状态的）。
  验收：与既有 canary 同标准。
- **M5 加冕**：主力 agent 迁移——v1 记忆导入、全工具面 canary、退役旧后端。
- **M6 收尾**：远端 loop-host、设备通道、dispatch 搬入 monorepo、v1 归档。

## 4. 账目与遗留

- 旧 adapter 路线关闭（superseded by v2）；现役辅助 agent 平滑运行至 M4。
- 主力 agent 过渡期留在旧后端，至 M5 迁移，过渡成本已知已接受。
- 暂缓未决：embeddings、设备通道细节、Claude 原生线格式（第二线协议）。
- 有效输入存档：架构评审（单向门方法）、代码考古结论、own-the-loop 分析、OpenClaw/Hermes 可借鉴的设计
  （doctor 体检/配对信任/沙箱默认/bootstrap 契约）。

## 5. 工作方式（对本项目全程生效）

教学模式：写关键代码前先讲原理，写完带走读；一次一个决策点；分析归 AI，决策归负责人；
"已确认"只能指负责人亲选的选项；对外发布按最高危对待。
