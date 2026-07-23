#!/usr/bin/env bash
# Stop hook:回复结束时,若 loom 有进度相关改动,自动同步门户。
#
# 自节流:只有 packages/ · scripts/ · overrides 有【未提交改动】时才跑同步。
# 在别的项目工作时 loom 是 committed-clean → git 检查空 → 秒退(~20ms),不打扰。
# 这样门户始终跟随工作树,提交时门户与代码一同提交、永不脱节。
set -e
LOOM="/Users/txie/OpenSourceProjects/agent-farm/loom"
[ -d "$LOOM/.git" ] || exit 0
cd "$LOOM" || exit 0

# 有进度相关的未提交改动才同步
if git status --porcelain -- packages scripts docs/progress.overrides.json 2>/dev/null | grep -q .; then
  NODE="$(command -v node || echo /usr/local/bin/node)"
  [ -x "$NODE" ] && "$NODE" scripts/sync-portal.mjs >/dev/null 2>&1 || true
fi
exit 0
