#!/usr/bin/env bash
# 记录子命令、参数与调用时的 PWD；register 时校验 ctx 下 meta.json 存在且含 branch。
echo "threads.sh $* PWD=$PWD" >> "$STUB_STATE/calls"
if [ "${1:-}" = register ]; then
  ctx=""
  while [ $# -gt 0 ]; do case "$1" in --ctx-dir) ctx=$2; shift 2;; *) shift;; esac; done
  [ -f "$ctx/meta.json" ] || { echo "stub: 缺 meta.json" >&2; exit 1; }
  jq -e '.branch | length > 0' "$ctx/meta.json" >/dev/null || { echo "stub: meta.branch 缺失" >&2; exit 1; }
  echo "harness-threads: 已登记"
fi
exit 0
