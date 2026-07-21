/**
 * 解析器测试：对着**真机 fixture** 回放（fixture 纪律，见第一课 §6）。
 * 真机字节流是唯一可信的测试输入——v1 两次同型事故都因为夹具是凭想象写的。
 *
 * 跑法：npm run build && node --test dist/（根 npm run check 会做）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { frameDecoder, parseCompletionStream } from "./parse-sse.js";
import type { CompletionEvent, Warn } from "./index.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/** 读一个 fixture 的原始字节。 */
function bytes(name: string): Uint8Array {
  return readFileSync(join(FIX, name));
}

/** 静默 warn，同时记录调用，供断言"有没有留痕"。 */
function recordingWarn(): { warn: Warn; calls: string[] } {
  const calls: string[] = [];
  return { warn: (m) => calls.push(m), calls };
}

/**
 * 端到端跑一个字节流：按 `sliceSize` 切成 chunk（模拟网络分段），
 * 过 frameDecoder → parseCompletionStream，返回事件序列。
 * sliceSize 存在的意义：证明结果**不依赖 chunk 边界**（同一 fixture 切法不同结果必须一致）。
 */
function run(raw: Uint8Array, sliceSize: number, warn?: Warn): CompletionEvent[] {
  const dec = frameDecoder(warn);
  const payloads: string[] = [];
  for (let i = 0; i < raw.length; i += sliceSize) {
    for (const p of dec.push(raw.subarray(i, i + sliceSize))) payloads.push(p);
  }
  for (const p of dec.flush()) payloads.push(p);
  return parseCompletionStream(payloads, warn);
}

const only = (evs: CompletionEvent[], t: CompletionEvent["type"]) =>
  evs.filter((e) => e.type === t);
const text = (evs: CompletionEvent[]) =>
  only(evs, "text_delta")
    .map((e) => (e as { text: string }).text)
    .join("");

// ── 真机 fixture：plain（纯 CJK 文本）──────────────────────────────────
test("plain.sse → text + usage + finish:stop", () => {
  const evs = run(bytes("plain.sse"), 64);
  assert.equal(only(evs, "tool_call").length, 0);
  const fin = only(evs, "finish");
  assert.equal(fin.length, 1);
  assert.equal((fin[0] as { reason: string }).reason, "stop");
  assert.equal(only(evs, "usage").length, 1);
  const u = only(evs, "usage")[0] as { input: number; output: number };
  assert.ok(u.input > 0 && u.output > 0, "usage 应有正的 token 数");
  assert.ok(text(evs).length > 0, "应有正文");
});

// ── 真机 fixture：单工具调用 ───────────────────────────────────────────
test("toolcall.sse → 1 个完整 tool_call + finish:tool_calls", () => {
  const evs = run(bytes("toolcall.sse"), 64);
  const tcs = only(evs, "tool_call") as {
    id: string;
    name: string;
    args: any;
  }[];
  assert.equal(tcs.length, 1);
  assert.equal(tcs[0]!.name, "get_weather");
  assert.equal(typeof tcs[0]!.args, "object", "args 应已 parse 成对象");
  assert.ok(tcs[0]!.args.city, "args 应含 city");
  assert.equal(
    (only(evs, "finish")[0] as { reason: string }).reason,
    "tool_calls"
  );
});

// ── 真机 fixture：并行工具调用（index 0/1）────────────────────────────
test("parallel.sse → 2 个完整 tool_call", () => {
  const evs = run(bytes("parallel.sse"), 64);
  const tcs = only(evs, "tool_call") as { name: string; args: any }[];
  assert.equal(tcs.length, 2);
  for (const tc of tcs) {
    assert.equal(tc.name, "get_weather");
    assert.ok(tc.args.city, "每个 args 都应 parse 出 city");
  }
});

// ── 真机 fixture：长 CJK，且不依赖 chunk 切法 ─────────────────────────
test("long-cjk.sse → 中文无乱码，且切法无关", () => {
  const raw = bytes("long-cjk.sse");
  // 三种极端切法结果必须逐字节相同——证明多字节跨 chunk 被正确处理。
  const a = text(run(raw, 1)); // 每次 1 字节：最狠的多字节切分
  const b = text(run(raw, 7)); // 质数，帧边界永远错位
  const c = text(run(raw, 4096)); // 一大口
  assert.equal(a, b);
  assert.equal(b, c);
  assert.ok(a.length > 50, "应是一段长中文");
  assert.ok(!a.includes("�"), "不应出现 UTF-8 替换字符（乱码）");
});

// ── 合成 fixture：帧切在多字节字符中间（显式构造，非真机）──────────────
test("[synthetic] 帧被切在 '圳' 的三个字节中间也能还原", () => {
  const frame = `data: {"choices":[{"delta":{"content":"深圳"}}]}\n\n`;
  const raw = new TextEncoder().encode(frame);
  // "圳" 的第一个字节落在位置 p；从 p+1 处切开，制造"半个字符"跨 chunk。
  const cut = raw.indexOf(0xe5, frame.indexOf("圳") - 2) + 1; // 圳 = E5 9C B3
  const dec = frameDecoder();
  const payloads = [
    ...dec.push(raw.subarray(0, cut)),
    ...dec.push(raw.subarray(cut)),
    ...dec.flush(),
  ];
  assert.equal(text(parseCompletionStream(payloads)), "深圳");
});

// ── 合成 fixture：length 截断 + 半截 tool_call arguments ──────────────
test("[synthetic] finish:length 时半截 tool_call 不吐，finish 如实带 length", () => {
  const { warn, calls } = recordingWarn();
  const frames = [
    `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","type":"function","function":{"name":"get_weather","arguments":"{\\"ci"}}]}}]}`,
    // arguments 停在 {"ci —— 永远拼不完整
    `{"choices":[{"delta":{},"finish_reason":"length"}]}`,
  ];
  const evs = parseCompletionStream(frames, warn);
  assert.equal(only(evs, "tool_call").length, 0, "半截 tool_call 绝不吐");
  const fin = only(evs, "finish");
  assert.equal(fin.length, 1);
  assert.equal((fin[0] as { reason: string }).reason, "length");
  // 这里不该 warn（length 是合法结局，不是错误）——半截 tool_call 是被 length 分支静默丢弃的。
  assert.equal(calls.length, 0);
});

// ── 合成：未知字段忽略、未知 finish_reason 归一到 stop（Q2）──────────
test("[synthetic] 未知字段忽略 + 未知 finish_reason → stop + 留痕", () => {
  const { warn, calls } = recordingWarn();
  const frames = [
    `{"choices":[{"delta":{"content":"hi","brand_new_field":42}}]}`,
    `{"choices":[{"delta":{},"finish_reason":"content_filter"}]}`,
  ];
  const evs = parseCompletionStream(frames, warn);
  assert.equal(text(evs), "hi", "未知字段不影响已知字段");
  assert.equal((only(evs, "finish")[0] as { reason: string }).reason, "stop");
  assert.ok(
    calls.some((m) => m.includes("finish_reason")),
    "未知 finish_reason 应留痕"
  );
});

// ── 合成：根基性缺失快失败（Q2）──────────────────────────────────────
test("[synthetic] choices 非数组 → 抛错快失败", () => {
  assert.throws(
    () => parseCompletionStream([`{"choices":"nope"}`]),
    /choices is not an array/
  );
});
