#!/usr/bin/env bash
# 假 threads.sh：只实现接单水位判定读的那条 `list --json`。
# STUB_THREADS_JSON=<JSON 数组> 指定台账内容（默认空台账）；STUB_THREADS_FAIL=1 非零退出（测降级路径）。
set -euo pipefail
if [ "${STUB_THREADS_FAIL:-0}" = "1" ]; then
  echo 'stub 注入的 threads.sh 失败' >&2
  exit 1
fi
printf '%s\n' "${STUB_THREADS_JSON:-[]}"
