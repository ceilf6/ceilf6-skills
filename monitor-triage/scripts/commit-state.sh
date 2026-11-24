#!/usr/bin/env bash
# 状态目录落盘后的提交单点：state.mjs / prepare-dispatch.sh / board.sh 写完文件就调一次。
# 只暂存 state 目录，不碰仓库里其他改动；同一天且尚未推送的 chore 用 amend 合并，免得一次扫描刷出十几个提交；
# 已推到远端的提交不改写。只提交不推送，推送由人决定。
# 用法: commit-state.sh --state <dir>
# stdout 一行 JSON {ok, committed:<sha|null>, amended, files, skipped?:<原因>}；退出码恒 0，提交失败不该拖垮调用方。
set -uo pipefail
state=""
while [ $# -gt 0 ]; do
  case "$1" in --state) state=$2; shift 2;; *) shift;; esac
done
emit() { jq -cn --argjson ok "$1" --arg c "${2:-}" --argjson a "${3:-false}" --argjson n "${4:-0}" --arg s "${5:-}" \
  '{ok:$ok, committed:(if $c == "" then null else $c end), amended:$a, files:$n} + (if $s == "" then {} else {skipped:$s} end)'; }
skip() { emit true "" false 0 "$1"; exit 0; }

[ -z "${web-monitor_TRIAGE_NO_COMMIT:-}" ] || skip "web-monitor_TRIAGE_NO_COMMIT 已设"
[ -n "$state" ] && [ -d "$state" ] || skip "缺 --state 或目录不存在"
state=$(cd "$state" && pwd -P)
top=$(git -C "$state" rev-parse --show-toplevel 2>/dev/null) || skip "不在 git 仓内"
rel=${state#"$top"/}
[ "$rel" != "$state" ] || skip "state 目录不在仓库工作区内"
! git -C "$top" check-ignore -q "$rel" || skip "state 目录被 gitignore"
# 暂存区里已有 state 之外的改动时不动它：那是别人提交到一半的现场，混进 chore 会把它带走。
if git -C "$top" diff --cached --name-only | grep -qv "^$rel/"; then skip "暂存区有 state 之外的改动"; fi

# 另一个会话（机器人 / 人）可能正同时写同一仓，index.lock 冲突等一下再试。
for _ in 1 2 3 4 5; do
  err=$(git -C "$top" add -A -- "$rel" 2>&1) && break
  echo "$err" | grep -q "index.lock" || { emit false "" false 0 "git add 失败：$(echo "$err" | head -c 200)"; exit 0; }
  sleep 1
done
staged=$(git -C "$top" diff --cached --name-only -- "$rel" | wc -l | tr -d ' ')
[ "$staged" -gt 0 ] || skip "无变更"

today=$(date +%F)
prefix="chore(monitor-triage): 记录 ${today} 扫描状态"
amend=false
if git -C "$top" log -1 --format=%s 2>/dev/null | grep -qF "$prefix" && ! git -C "$top" branch -r --contains HEAD 2>/dev/null | grep -q .; then
  amend=true
fi
if [ "$amend" = true ]; then
  n=$( (git -C "$top" diff-tree --no-commit-id --name-only -r HEAD; git -C "$top" diff --cached --name-only) | sort -u | wc -l | tr -d ' ')
  err=$(git -C "$top" commit -q --amend -m "${prefix}（${n} 个文件）" 2>&1) || { emit false "" true "$n" "git commit --amend 失败：$(echo "$err" | head -c 200)"; exit 0; }
else
  n=$staged
  err=$(git -C "$top" commit -q -m "${prefix}（${n} 个文件）" 2>&1) || { emit false "" false "$n" "git commit 失败：$(echo "$err" | head -c 200)"; exit 0; }
fi
emit true "$(git -C "$top" rev-parse --short HEAD)" "$amend" "$n"
