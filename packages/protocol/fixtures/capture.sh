#!/usr/bin/env bash
# Capture RAW DeepSeek SSE byte streams as test fixtures.
# Usage: DEEPSEEK_API_KEY=sk-... ./capture.sh <outdir>
# Re-run whenever the upstream API shape might have changed; commit the diffs.
set -euo pipefail
OUT="${1:?outdir required}"; mkdir -p "$OUT"
BASE="https://api.deepseek.com/v1"
AUTH="Authorization: Bearer ${DEEPSEEK_API_KEY:?DEEPSEEK_API_KEY required}"
JSON="Content-Type: application/json"

# 0. real model catalog (itself a fixture; picks the flash id if present)
curl -sS "$BASE/models" -H "$AUTH" -o "$OUT/models.json"
# node, not python3: capture hosts (e.g. Mac2) may lack Xcode CLT where python3 is a stub
MODEL=$(node -e "const ids=require('$OUT/models.json').data.map(m=>m.id);console.log(ids.find(i=>i.includes('flash'))??ids[0])")
echo "model: $MODEL"

TOOLS='[{"type":"function","function":{"name":"get_weather","description":"查指定城市当前天气","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}]'

req() { # req <outfile> <body>
  curl -sS -N --no-buffer "$BASE/chat/completions" -H "$AUTH" -H "$JSON" -d "$2" -o "$OUT/$1"
  echo "captured $1 ($(wc -c < "$OUT/$1" | tr -d ' ') bytes)"
}

# 1. plain CJK text
req plain.sse "{\"model\":\"$MODEL\",\"stream\":true,\"stream_options\":{\"include_usage\":true},
  \"messages\":[{\"role\":\"user\",\"content\":\"用一句话介绍深圳。\"}]}"

# 2. single tool call
req toolcall.sse "{\"model\":\"$MODEL\",\"stream\":true,\"stream_options\":{\"include_usage\":true},
  \"tools\":$TOOLS,
  \"messages\":[{\"role\":\"user\",\"content\":\"查一下深圳现在的天气\"}]}"

# 3. parallel tool calls (same tool, two cities → index 0/1 interleaving)
req parallel.sse "{\"model\":\"$MODEL\",\"stream\":true,\"stream_options\":{\"include_usage\":true},
  \"tools\":$TOOLS,
  \"messages\":[{\"role\":\"user\",\"content\":\"同时查深圳和北京现在的天气,两个都要\"}]}"

# 4. longer CJK reply (multibyte-across-chunk odds)
req long-cjk.sse "{\"model\":\"$MODEL\",\"stream\":true,\"stream_options\":{\"include_usage\":true},
  \"messages\":[{\"role\":\"user\",\"content\":\"写一段两百字左右的深圳简介。\"}]}"

echo "done → $OUT"
