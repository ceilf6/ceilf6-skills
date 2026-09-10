#!/usr/bin/env bash
# 把一条已派发的单登记到 harness 看板：写 ctx meta.json（含 Meego 绑定，看板点「完成」时
# meego.sh done 据此流转缺陷状态），再在当前进程 cwd 下调 threads.sh register。
# 登记的是调用本脚本的 claude 线程（cwd + CLAUDE_CODE_SESSION_ID），不是 traecli 宿主。
# 用法: board.sh --state <dir> --issue-id <id> [--title <短题>] [--mr-id <id>] [--session-id <sid>]
# stdout 一行 JSON {ok, ctx_dir, error?, warning?}；退出码恒 0（登记失败不该拖垮调用方）。
set -uo pipefail
THREADS_SH=${THREADS_SH:-$HOME/.claude/skills/harness-ceilf6/scripts/threads.sh}

state=""; issue=""; title=""; mr_id=""; sid_opt=""; slardar_url=""
while [ $# -gt 0 ]; do
  case "$1" in
    --state) state=$2; shift 2;; --issue-id) issue=$2; shift 2;; --title) title=$2; shift 2;;
    --mr-id) mr_id=$2; shift 2;; --session-id) sid_opt=$2; shift 2;; --slardar-url) slardar_url=$2; shift 2;;
    *) echo "{\"ok\":false,\"error\":\"未知参数 $1\"}"; exit 0;;
  esac
done
DJ="$state/dispatched.json"
{ [ -n "$state" ] && [ -n "$issue" ] && [ -f "$DJ" ]; } || { echo '{"ok":false,"error":"缺 --state/--issue-id 或 dispatched.json 不存在"}'; exit 0; }

get()  { jq -r --arg i "$issue" ".[\$i]$1 // empty" "$DJ"; }
set_() { local tmp; tmp=$(mktemp); jq --arg i "$issue" "(.[\$i] //= {}) | .[\$i]$1 = $2" "$DJ" > "$tmp" && mv "$tmp" "$DJ"; }

slug=$(get .slug); ws=$(get .workspace); task_id=$(get .task_id)
meego_id=$(get .meego_id); meego_url=$(get .meego_url)
[ -n "$title" ] || title=$(get .meego_name)
[ -n "$title" ] || title="$slug"
[ -n "$mr_id" ] || mr_id=$(get .mr_id)
if [ -n "$slardar_url" ]; then set_ ".slardar_url" "$(jq -Rn --arg u "$slardar_url" '$u')"; else slardar_url=$(get .slardar_url); fi
{ [ -n "$slug" ] && [ -n "$ws" ]; } || { echo '{"ok":false,"error":"处置账缺 slug 或 workspace"}'; exit 0; }

ctx="$ws/.harness-ceilf6/$slug"
mkdir -p "$ctx"
# branch 记登记时 cwd 的当前分支：threads.sh 拼唤回命令时若发现 cwd 分支与 meta.branch
# 不一致会插一句 git checkout，而 omh 基线分支只存在于工作区、不在会话 cwd 的仓库里。
cur_branch=$(git symbolic-ref --short -q HEAD 2>/dev/null || echo "omh-base/$slug")
existing='{}'; [ -f "$ctx/meta.json" ] && existing=$(cat "$ctx/meta.json")
# 备注是 CR 时看上下文的入口：Slardar 告警链接放最前，其后是 Meego 与 Task。备注每次登记都按现状重写。
note="Meego ${meego_url} · Task ${task_id}"
[ -z "$slardar_url" ] || note="Slardar ${slardar_url} · ${note}"
printf '%s' "$existing" | jq --arg b "$cur_branch" --arg n "$note" \
  --arg mi "$meego_id" --arg mu "$meego_url" --arg mr "$mr_id" --arg su "$slardar_url" '
  . + {branch:$b, status:(.status // "active"), note:$n, milestones:(.milestones // {})}
  + (if $mi == "" then {} else {meego_id:$mi, meego_type:"issue", meego_url:$mu} end)
  + (if $mr == "" then {} else {mr_id:$mr} end)
  + (if $su == "" then {} else {slardar_url:$su} end)' > "$ctx/meta.json.tmp" && mv "$ctx/meta.json.tmp" "$ctx/meta.json"

warn=""
[ -n "${sid_opt:-${CLAUDE_CODE_SESSION_ID:-}}" ] || warn="无 session_id，唤回将退化为新会话续入"
args=(register --ctx-dir "$ctx" --title "$title")
[ -n "$sid_opt" ] && args+=(--session-id "$sid_opt")
if [ -f "$THREADS_SH" ] && err=$(bash "$THREADS_SH" "${args[@]}" 2>&1 >/dev/null); then
  board_json=$(jq -cn --arg c "$ctx" --arg w "$warn" '{ok:true, ctx_dir:$c} + (if $w == "" then {} else {warning:$w} end)')
  set_ ".steps.board" '"done"'
else
  [ -f "$THREADS_SH" ] || err="threads.sh 不存在：$THREADS_SH"
  board_json=$(jq -cn --arg c "$ctx" --arg e "$(printf '%s' "$err" | head -c 300)" '{ok:false, ctx_dir:$c, error:$e}')
fi
set_ ".board" "$board_json"
echo "$board_json"
