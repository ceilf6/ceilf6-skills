#!/usr/bin/env bash
# 单测入口：JS 走 node:test，bash 走各自的 test-*.sh；任一失败整体退出 1。
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
status=0
if ls "$HERE"/*.test.mjs >/dev/null 2>&1; then
  node --test "$HERE"/*.test.mjs || status=1
fi
for t in "$HERE"/test-*.sh; do
  [ -f "$t" ] || continue
  bash "$t" || status=1
done
exit $status
