# 第一课：openai-compat 线协议 —— ① 层到底在处理什么

> loom 教学系列。读完这课，你能看懂 DeepSeek 流式回复的每一个字节，
> 并理解为什么 ① 层的接口要设计成"语义事件流"。写代码之前先过这一课。

## 1. 请求：一个 POST 就是全部

```jsonc
POST https://api.deepseek.com/v1/chat/completions
Authorization: Bearer sk-...
{
  "model": "deepseek-chat",            // v4-flash 用 "deepseek-chat"? 不——用真实 id,M1 时以 /models 为准
  "messages": [
    { "role": "system", "content": "你是..." },
    { "role": "user", "content": "帮我查下天气" },
    // 工具往返的历史长这样：
    { "role": "assistant", "tool_calls": [ { "id": "call_1", "type": "function",
        "function": { "name": "get_weather", "arguments": "{\"city\":\"深圳\"}" } } ] },
    { "role": "tool", "tool_call_id": "call_1", "content": "{\"temp\":31}" }
  ],
  "tools": [ { "type": "function", "function": {
      "name": "get_weather",
      "description": "查天气",
      "parameters": { "type": "object", "properties": { "city": { "type": "string" } },
                      "required": ["city"] } } } ],
  "stream": true,
  "stream_options": { "include_usage": true }   // ← 不带这个,流式拿不到 token 用量
}
```

三个要点：
- **无状态**。服务器不记得任何历史——每轮都把完整 messages 重发。这就是 ③ 层
  （上下文管理）存在的原因：messages 数组的大小由**我们**控制，压缩/裁剪是我们的自由。
  v1 做不到这点（Cursor 的 loop 管上下文），所以才有 rotation 补丁。
- **工具调用是三段式对话**：assistant 说"我要调 get_weather(深圳)" → 我们执行 →
  以 `role:"tool"` 把结果塞回 messages 再问一次。**所谓 agent loop，②层，
  本质就是这个 while 循环**：`while (回复带 tool_calls) { 执行; 回填; 重发 }`。
- `arguments` 是 **JSON 字符串**，不是对象——模型输出的文本恰好是 JSON，需要我们 parse
  （可能是坏的！parse 失败要回给模型让它重试——这是 ② 层的错误处理职责）。

## 2. 回复（流式）：SSE 的解剖

HTTP 响应头 `Content-Type: text/event-stream`，body 是一串**帧**，帧之间空行分隔：

```
data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}

data: {"choices":[{"index":0,"delta":{"content":"深"}}]}

data: {"choices":[{"index":0,"delta":{"content":"圳今天"}}]}

data: {"choices":[{"index":0,"delta":{"content":"31 度"}},"finish_reason":null]}

data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"choices":[],"usage":{"prompt_tokens":812,"completion_tokens":9,"total_tokens":821}}

data: [DONE]
```

规则：
- 每帧 = `data: ` 前缀 + 一行 JSON + 空行。终止哨兵是字面量 `data: [DONE]`（不是 JSON！）。
- `delta` 是**增量**：把所有帧的 `delta.content` 依序拼接 = 完整回复。
- `finish_reason` 出现在最后一个内容帧：`stop`（正常）/ `tool_calls`（要调工具）/
  `length`（撞 max_tokens——② 层必须把它当异常处理，不能当正常结束）。
- usage 只在倒数第二帧（`stream_options` 换来的），`choices` 为空数组。
- 服务器可能穿插**注释行**（`: keep-alive` 之类，冒号开头）——必须跳过，v1 时代
  很多客户端栽在这。

## 3. 最阴的部分：tool_calls 的增量拼装

模型决定调工具时，`delta` 里不是 content，是 **tool_calls 碎片**：

```
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function",
        "function":{"name":"get_weather","arguments":""}}]}}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"ci"}}]}}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\":\"深圳\"}"}}]}}]}

data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}
```

拼装规则（这就是 ① 层的核心算法）：
- **`index` 是聚合键**。首帧带 `id`/`name`，后续帧只带 `arguments` 碎片；
  按 index 分桶，`arguments` 字符串**依序拼接**，直到 finish_reason 出现才完整。
- **并行工具调用会交错**：index 0 和 index 1 的碎片可能穿插到达，绝不能假设串行。
- **中途不可 parse**：`{"ci` 不是合法 JSON——arguments 只有拼完才能 parse。
  所以 ① 对外**不应该**吐"碎片"，应该等一个 tool_call 拼完整后吐一个完整事件。

## 4. 两个传输层暗坑（真机 fixture 要覆盖的）

1. **UTF-8 多字节字符会被网络分块切开**。"圳"是 3 个字节，TCP 分块可能把它切在
   中间——如果按 chunk 直接 `toString()` 会得到乱码。正确做法：先按**字节**攒缓冲、
   按 `\n\n` 找帧边界，再对完整帧做 UTF-8 解码（或用 `TextDecoder{stream:true}`）。
2. **一个 chunk ≠ 一帧**。可能半帧（要缓冲）也可能多帧（要循环切分）。
   解析器必须是"喂字节、吐帧"的增量状态机，不能假设 chunk 边界和帧边界对齐。

## 5. 从这一切推导 ① 的接口（下一步我们一起写的东西）

① 层的职责现在清楚了：**把线上的碎片组装成语义事件**。loop（②）不该知道 SSE、
delta、index 这些词——它只想听到：

```ts
// packages/protocol 里将要定义的形状（草案，走读时一起敲定）
complete(req: CompletionRequest): AsyncIterable<CompletionEvent>

type CompletionEvent =
  | { type: "text_delta";      text: string }     // 拼好的增量文本(转发给飞书流式卡)
  | { type: "reasoning_delta"; text: string }     // 思考流(见 §7 真机发现,不入正文)
  | { type: "tool_call";  id: string; name: string; args: unknown }  // 拼完整才吐
  | { type: "finish";     reason: "stop" | "tool_calls" | "length" }
  | { type: "usage";      input: number; output: number }
```

这个接口就是 D2 说的"窄接口"：手写实现和 AI SDK 实现都能藏在它后面（双向门）。

## 6. Fixture 纪律（写实现前先做）

> fixture = 测试用的固定样本数据。此处特指：真机采集的原始 SSE 字节流文件，测试对着它回放。

v1 的两次同型事故（post 解析、card operator）教训：**fixture 必须抄真机 payload**。
所以第一个动作不是写解析器，是 `curl -N` 打真实 DeepSeek 拿一份原始 SSE 字节流存进
`packages/protocol/fixtures/`（含：纯文本回复、单工具调用、**并行双工具调用**、
长回复带多字节中文），解析器对着真尸体写。

## 7. 真机来信（2026-07-19 首次采集就学到的，课件初稿里没有）

对着 fixture 验证十分钟，真机教了三件事——**这就是 fixture 纪律存在的意义**：

1. **`delta.reasoning_content` 存在**。deepseek-v4-flash 回答前先流式吐思考
   （plain.sse 里 110 字推理、36 字正文）。它**不能**拼进 assistant 正文（下一轮
   messages 不含它），但对调试/审计有价值 → 独立成 `reasoning_delta` 事件（§5 已更新）。
   这也是课后思考 Q2 的现实版：没见过的字段真的会出现。
2. **工具调用前模型会先说话**。toolcall.sse 里先流 19 字正文（"我来帮你查…"）再流
   tool_calls 碎片——content 和 tool_calls **混在同一个回复里**，解析器不能假设二选一。
3. **并行调用实测是顺序块，不是交错**。parallel.sse 的 index 序列是 0×10 后接 1×10。
   按 index 分桶的算法照写（防御其他实现/未来变化），但真机行为记录在案；
   交错场景补一个**标注为合成**的 fixture 覆盖。

## 课后思考（走读时聊）

1. `finish_reason: "length"` 时 arguments 可能是半截 JSON——② 层该怎么办？
2. 如果 DeepSeek 某天在 delta 里加了新字段，我们的解析器该崩还是该忽略？（宽进严出）
3. 为什么 usage 事件值得单独存在，而不是塞进 finish 事件里？（提示：M2 的 audit.log）
