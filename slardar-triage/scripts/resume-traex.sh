#!/usr/bin/env bash
# 恢复 failed 的 omh Task。死于 code-review 时带 stage=impl(直接消费 pending-findings)。
# 用法: resume-traex.sh <workspace> <task-id> [stage]
set -u
WS=$1; TASK=$2; AT=${3:-}
TRAECLI=${TRAECLI:-traecli}
LOG="$(dirname "$WS")/$(basename "$WS")-host.log"
cd "$WS" || exit 1
AT_TEXT=""
[ -n "$AT" ] && AT_TEXT="恢复入口:从 ${AT} 阶段恢复,即调用 resume-task.mjs 时必须带 --at ${AT}(两个 token:\`--at\` 与 \`${AT}\`)。"
PROMPT="\$oh-my-harness:omh-resume 恢复当前工作区的 omh Task ${TASK}。${AT_TEXT}恢复后按 skill 交接给 \$oh-my-harness:stage-monitor 监控到终态。本会话无人值守:遇到 blocked / double_confirm 不要向用户提问,按任务书与 skill 纪律自行裁决;全程不要在本会话里自己实现、测试或修改仓库代码。"
echo "== $(date +%H:%M:%S) traecli resume ${TASK} ${AT}" >> "$LOG"
(nohup bash -c '"$0" exec -y "$1" < /dev/null >> "$2" 2>&1; echo "== resume host exit=$?" >> "$2"' "$TRAECLI" "$PROMPT" "$LOG" >/dev/null 2>&1 &)
echo "$LOG"
