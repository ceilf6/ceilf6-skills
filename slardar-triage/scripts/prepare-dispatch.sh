#!/usr/bin/env bash
# 派单准备单点：在途检查 → Meego → 任务书。工作区、起 omh 与收尾归 byteview-web-harness 任务链。
# 每步完成写 dispatched.json[issue].steps.<step>=done，重跑跳过已完成步骤，副作用不重复。
# stdout 只输出一行 JSON；退出码：0 成功，3 有未到终态的单，1 其他。
set -uo pipefail
# 建单走 bytedcli-meego 的机械层单点（恒 story / 模板 498109），本脚本不自持 Meego 字段配方。
MEEGO_SH=${MEEGO_SH:-$HOME/.claude/skills/bytedcli-meego/scripts/meego.sh}
MEEGO_REPO=${MEEGO_REPO:-lark/byteview-web}

state=""; issue=""; slug=""; book=""; desc=""; name=""; slardar_url=""
while [ $# -gt 0 ]; do
  case "$1" in
    --slardar-url) slardar_url=$2; shift 2;;
    --state) state=$2; shift 2;; --issue-id) issue=$2; shift 2;; --slug) slug=$2; shift 2;;
    --task-book) book=$2; shift 2;; --meego-desc) desc=$2; shift 2;; --meego-name) name=$2; shift 2;;
    *) jq -cn --arg e "未知参数 $1" '{ok:false, error:$e}'; exit 1;;
  esac
done
for v in state issue slug book desc name; do
  [ -n "${!v}" ] || { jq -cn --arg e "缺少 --${v}" '{ok:false, error:$e}'; exit 1; }
done
mkdir -p "$state"
DJ="$state/dispatched.json"; [ -f "$DJ" ] || echo '{}' > "$DJ"

# --- 账本读写（jq 单点） ---
get()  { jq -r --arg i "$issue" ".[\$i]$1 // empty" "$DJ"; }
set_() { local tmp; tmp=$(mktemp); jq --arg i "$issue" "(.[\$i] //= {}) | .[\$i]$1 = $2" "$DJ" > "$tmp" && mv "$tmp" "$DJ"; }
step_done() { [ "$(get ".steps.$1")" = done ]; }
fail() { set_ ".error" "$(jq -Rn --arg e "$2" '$e')"; jq -cn --arg i "$issue" --arg s "$1" --arg e "$2" '{ok:false, issue_id:$i, step:$s, error:$e}'; exit "${3:-1}"; }
done_json() { jq -cn --arg i "$issue" --arg m "$(get .meego_url)" --arg b "$(get .task_book)" --argjson r "$1" '{ok:true, issue_id:$i, step:"task_book", meego_url:$m, task_book:$b, reused:$r}'; }

# --- 步骤 0：幂等与并发检查 ---
if step_done task_book; then done_json true; exit 0; fi
while IFS=$'\t' read -r tid ws; do
  [ -n "$tid" ] && [ -n "$ws" ] || continue
  meta="$ws/.omh/tasks/$tid/meta.json"
  [ -f "$meta" ] || continue
  phase=$(jq -r '.phase // empty' "$meta")
  case "$phase" in completed|failed|cancelled|"") ;; *) fail precheck "已有未到终态的 Task ${tid}（phase=${phase}，工作区 ${ws}），本次不派发" 3;; esac
done < <(jq -r 'to_entries[] | select(.value.task_id and .value.workspace) | [.value.task_id, .value.workspace] | @tsv' "$DJ")
set_ ".slug" "\"$slug\""
[ -z "$slardar_url" ] || set_ ".slardar_url" "$(jq -Rn --arg u "$slardar_url" '$u')"

# --- 步骤 1：Meego ---
if ! step_done meego; then
  [ -f "$MEEGO_SH" ] || fail meego "bytedcli-meego 机械层不存在：$MEEGO_SH"
  # meego.sh 成功时 stdout 末行是 {id,url}；失败 die 到 stderr，合并后取末行解析必空 → 落进 fail。
  out=$(bash "$MEEGO_SH" create --repo "$MEEGO_REPO" --title "$name" --description-file "$desc" 2>&1)
  last=$(echo "$out" | tail -1)
  mid=$(echo "$last" | jq -r 'select(.skipped|not) | .id // empty' 2>/dev/null)
  murl=$(echo "$last" | jq -r 'select(.skipped|not) | .url // empty' 2>/dev/null)
  { [ -n "$mid" ] && [ -n "$murl" ]; } || fail meego "Meego 创建失败：$(echo "$out" | tail -3 | head -c 400)"
  set_ ".meego_id" "\"$mid\""; set_ ".meego_url" "\"$murl\""; set_ ".meego_name" "$(jq -Rn --arg n "$name" '$n')"; set_ ".steps.meego" '"done"'
fi
meego_url=$(get .meego_url)

# --- 步骤 2：任务书（渲染结果即 harness task-schedule 的 --approved-plan-file） ---
final_book="$state/task-books/$slug.md"
mkdir -p "$state/task-books"
sed "s#{{meego_url}}#$meego_url#g" "$book" > "$final_book"
head -1 "$final_book" | grep -q "目标分支为 master" || fail task_book "任务书首行缺「目标分支为 master」"
head -1 "$final_book" | grep -q "Meego:$meego_url" || fail task_book "任务书首行 Meego URL 未填入"
head -1 "$final_book" | grep -q "MR 类型 feature" || fail task_book "任务书首行缺「MR 类型 feature」"
set_ ".task_book" "\"$final_book\""; set_ ".steps.task_book" '"done"'; set_ ".error" 'null'

done_json false
