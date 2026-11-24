#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
V="$HERE/../scripts/validate-verdict.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

expect_valid() { # expect_valid <desc> <json字符串>
  printf '%s' "$2" > "$T/v.json"
  if bash "$V" "$T/v.json" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi
}
expect_invalid() {
  printf '%s' "$2" > "$T/v.json"
  if bash "$V" "$T/v.json" >/dev/null 2>&1; then bad "$1"; else ok "$1"; fi
}

expect_valid   "干净通过" '{"pass":true,"summary":"clean","findings":[]}'
expect_valid   "带 minor 仍可 pass" '{"pass":true,"summary":"s","findings":[{"severity":"minor","file":"a.ts","line":1,"issue":"i","suggestion":"s"}]}'
expect_valid   "line 可缺省" '{"pass":false,"summary":"s","findings":[{"severity":"major","file":"a.ts","issue":"i","suggestion":"s"}]}'
expect_valid   "未通过带 blocker" '{"pass":false,"summary":"s","findings":[{"severity":"blocker","file":"a.ts","line":2,"issue":"i","suggestion":"s"}]}'
expect_invalid "pass=true 却有 major（一致性）" '{"pass":true,"summary":"s","findings":[{"severity":"major","file":"a.ts","issue":"i","suggestion":"s"}]}'
expect_invalid "缺 summary" '{"pass":true,"findings":[]}'
expect_invalid "缺 findings" '{"pass":true,"summary":"s"}'
expect_invalid "severity 非法" '{"pass":false,"summary":"s","findings":[{"severity":"huge","file":"a.ts","issue":"i","suggestion":"s"}]}'
expect_invalid "finding 缺 issue" '{"pass":false,"summary":"s","findings":[{"severity":"major","file":"a.ts","suggestion":"s"}]}'
expect_invalid "非 JSON" 'not json at all'
expect_invalid "pass 非布尔" '{"pass":"yes","summary":"s","findings":[]}'

echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
