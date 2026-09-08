#!/usr/bin/env bash
# 用 traecli 无人值守发起一个 omh Task。宿主 runtime 从当前会话继承，所以 omh-loop 只能从
# traecli exec 里调；traecli exec 见 stdin 是管道会等 EOF，必须接 /dev/null。
# 用法: launch-traex.sh <workspace> <task-book> <workflow>
set -u
WS=$1; BOOK=$2; WF=$3
TRAECLI=${TRAECLI:-traecli}; OMH_CLI=${OMH_CLI:-omh-cli}
LOG="$(dirname "$WS")/$(basename "$WS")-host.log"
cd "$WS" || exit 1

echo "== $(date +%H:%M:%S) omh-cli setup ($WS)" >> "$LOG"
"$OMH_CLI" setup --agent traecli --scope project --config omh.config.yaml --no-ai-contrib >> "$LOG" 2>&1
echo "setup exit=$?" >> "$LOG"

PROMPT="\$oh-my-harness:omh-loop 在当前工作区创建并推进一个 omh Task。参数:task_input = 文件 $BOOK 的全文(先完整读取该文件,把内容原样作为任务正文传入 task-entry,不改写、不缩略;该任务书是唯一需求来源);--workflow $WF;--no-plan;--no-meego。创建成功后按 skill 流程走到 handoff_monitor,并用 \$oh-my-harness:stage-monitor 监控到终态。本会话无人值守:遇到 blocked / double_confirm 不要向用户提问,按任务书与 skill 纪律自行裁决(双确认 confirm,需要返工的用 user-message 回送具体缺口);环境类阻塞先等环境恢复后用 user-message 让它重跑就绪门,确实修不好就 unblock --decision fail 打回 impl,只有涉及产品级决策时才停下并在最终回复写明原因;全程不要在本会话里自己实现、测试或修改仓库代码。"

echo "== $(date +%H:%M:%S) traecli exec (workflow=$WF, book=$BOOK)" >> "$LOG"
(nohup bash -c '"$0" exec -y "$1" < /dev/null >> "$2" 2>&1; echo "== host exit=$?" >> "$2"' "$TRAECLI" "$PROMPT" "$LOG" >/dev/null 2>&1 &)
echo "$LOG"
