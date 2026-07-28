#!/usr/bin/env bash
# 校验 codex verdict.json：JSON 合法 + 结构符合契约 + pass 一致性。
# 退出 0 = 合法；非 0 = 非法（stderr 说明原因）。
set -euo pipefail

f="${1:?用法: validate-verdict.sh <verdict.json>}"
command -v jq >/dev/null 2>&1 || { echo "validate-verdict: 缺少依赖 jq" >&2; exit 3; }
[ -f "$f" ] || { echo "validate-verdict: 文件不存在：$f" >&2; exit 2; }

if ! jq empty "$f" >/dev/null 2>&1; then
  echo "validate-verdict: 不是合法 JSON：$f" >&2
  exit 1
fi

if ! jq -e '
  (type == "object")
  and ((.pass? | type) == "boolean")
  and ((.summary? | type) == "string")
  and ((.findings? | type) == "array")
  and ([ .findings[] |
        (type == "object")
        and ((.severity? // "") | IN("blocker", "major", "minor", "nit"))
        and ((.file? | type) == "string")
        and ((.issue? | type) == "string")
        and ((.suggestion? | type) == "string")
        and ((.line == null) or ((.line? | type) == "number"))
      ] | all)
' "$f" >/dev/null; then
  echo "validate-verdict: 结构不符合契约（pass/summary/findings 及 finding 字段）：$f" >&2
  exit 1
fi

if ! jq -e '
  (.pass == false)
  or ([ .findings[] | select(.severity == "blocker" or .severity == "major") ] | length == 0)
' "$f" >/dev/null; then
  echo "validate-verdict: 一致性违规：pass=true 但存在 blocker/major finding：$f" >&2
  exit 1
fi
