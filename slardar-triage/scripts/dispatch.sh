#!/usr/bin/env bash
# 派发单点：Meego → worktree → 任务书 → traex 起 omh → 核验 runtime → 落账。
# 每步完成写 dispatched.json[issue].steps.<step>=done，重跑跳过已完成步骤，副作用不重复。
# stdout 只输出一行 JSON；退出码：0 成功，3 有未到终态的单，4 runtime 不符，1 其他。
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
MEEGO_CMD=${MEEGO_CMD:-bytedcli}; OMH_CLI=${OMH_CLI:-omh-cli}; TRAECLI=${TRAECLI:-traecli}; ORCH=${ORCH:-orchestrator}; PNPM=${PNPM:-pnpm}
export OMH_CLI TRAECLI
TASK_WAIT_SECONDS=${TASK_WAIT_SECONDS:-1800}
PK=5e96d7bff4e7c525510f9156
OWNER=7657492291354954694
WORKFLOW=pc-web-bugfix

state=""; issue=""; slug=""; book=""; desc=""; name=""; os=""; release=""; repo=""; runs=""
while [ $# -gt 0 ]; do
  case "$1" in
    --state) state=$2; shift 2;; --issue-id) issue=$2; shift 2;; --slug) slug=$2; shift 2;;
    --task-book) book=$2; shift 2;; --meego-desc) desc=$2; shift 2;; --meego-name) name=$2; shift 2;;
    --os) os=$2; shift 2;; --release) release=$2; shift 2;; --repo) repo=$2; shift 2;; --runs-root) runs=$2; shift 2;;
    *) echo "{\"ok\":false,\"error\":\"未知参数 $1\"}"; exit 1;;
  esac
done
repo=${repo:-$(cd "$PWD/../byteview-web" 2>/dev/null && pwd -P)}
runs=${runs:-$HOME/Desktop/workspace/omh-runs}
for v in state issue slug book desc name os release repo; do
  [ -n "${!v}" ] || { echo "{\"ok\":false,\"error\":\"缺少 --${v}\"}"; exit 1; }
done
mkdir -p "$state"
DJ="$state/dispatched.json"; [ -f "$DJ" ] || echo '{}' > "$DJ"

# --- 账本读写（jq 单点） ---
get()  { jq -r --arg i "$issue" ".[\$i]$1 // empty" "$DJ"; }
set_() { local tmp; tmp=$(mktemp); jq --arg i "$issue" "(.[\$i] //= {}) | .[\$i]$1 = $2" "$DJ" > "$tmp" && mv "$tmp" "$DJ"; }
step_done() { [ "$(get ".steps.$1")" = done ]; }
fail() { set_ ".error" "$(jq -Rn --arg e "$2" '$e')"; echo "{\"ok\":false,\"issue_id\":\"$issue\",\"step\":\"$1\",\"error\":$(jq -Rn --arg e "$2" '$e')}"; exit "${3:-1}"; }

# --- 步骤 0：幂等与并发检查 ---
if step_done verify; then
  echo "{\"ok\":true,\"issue_id\":\"$issue\",\"step\":\"verify\",\"meego_url\":\"$(get .meego_url)\",\"task_id\":\"$(get .task_id)\",\"workspace\":\"$(get .workspace)\",\"reused\":true}"; exit 0
fi
while IFS=$'\t' read -r tid ws; do
  [ -n "$tid" ] && [ -n "$ws" ] || continue
  meta="$ws/.omh/tasks/$tid/meta.json"
  [ -f "$meta" ] || continue
  phase=$(jq -r '.phase // empty' "$meta")
  case "$phase" in completed|failed|cancelled|"") ;; *) fail precheck "已有未到终态的 Task ${tid}（phase=${phase}，工作区 ${ws}），本次不派发" 3;; esac
done < <(jq -r 'to_entries[] | select(.value.task_id and .value.workspace) | [.value.task_id, .value.workspace] | @tsv' "$DJ")
set_ ".slug" "\"$slug\""

# --- 步骤 1：Meego ---
if ! step_done meego; then
  case "$os" in iOS) endopt=option_2;; Android) endopt=option_1;; *) endopt=option_3;; esac
  major=$(echo "$release" | cut -d. -f1,2)
  vid=$("$MEEGO_CMD" --json meego workitem config field list --project-key "$PK" --work-item-type issue --field-keys '["field_2f21a0"]' 2>/dev/null \
    | jq -r --arg m "$major" '.data.result.content[0].text | fromjson | .list[0].option | (map(select(.option_name == $m)) + map(select(.option_name | test("^7\\.[0-9]+$")))) | .[0].option_id // empty')
  [ -n "$vid" ] || fail meego "缺陷发现版本选项查不到（release ${release}）"
  fields=$(jq -cn --arg n "$name" --rawfile d "$desc" --arg e "$endopt" --arg v "$vid" --arg o "$OWNER" '[
    {field_key:"template",field_value:"4"},{field_key:"name",field_value:$n},{field_key:"description",field_value:$d},
    {field_key:"business",field_value:"694269fe841acec8b67164b2"},{field_key:"priority",field_value:"2"},
    {field_key:"field_4fd05c",field_value:"option_4"},{field_key:"issue_stage",field_value:"stage_online"},
    {field_key:"field_610176",field_value:$e},
    {field_key:"field_2f21a0",field_value:([{option_id:$v}]|tojson)},
    {field_key:"role_owners",field_value:([{role:"operator",owners:[$o]}]|tojson)}]')
  out=$("$MEEGO_CMD" --json meego workitem create --project-key "$PK" --work-item-type issue --fields "$fields" 2>&1)
  mid=$(echo "$out" | jq -r '.data.result.content[0].text | fromjson | .work_item_id // empty' 2>/dev/null)
  [ -n "$mid" ] || fail meego "Meego 创建失败：$(echo "$out" | head -c 400)"
  set_ ".meego_id" "\"$mid\""; set_ ".meego_url" "\"https://meego.larkoffice.com/larksuite/issue/detail/$mid\""; set_ ".steps.meego" '"done"'
fi
meego_url=$(get .meego_url)

# --- 步骤 2：worktree ---
ws="$runs/$slug"
if ! step_done worktree; then
  mkdir -p "$runs/tasks"
  git -C "$repo" fetch origin master >/dev/null 2>&1 || fail worktree "fetch origin master 失败"
  if [ ! -d "$ws" ]; then
    git -C "$repo" worktree add -b "omh-base/$slug" "$ws" origin/master >/dev/null 2>&1 || fail worktree "worktree add 失败：$ws"
  fi
  (cd "$ws" && "$PNPM" install --frozen-lockfile >/dev/null 2>&1) || fail worktree "pnpm install 失败"
  main_n=$(ls "$repo/node_modules/.pnpm" 2>/dev/null | wc -l | tr -d ' '); ws_n=$(ls "$ws/node_modules/.pnpm" 2>/dev/null | wc -l | tr -d ' ')
  [ "$ws_n" -ge $((main_n * 95 / 100)) ] || fail worktree "依赖不完整：主仓 $main_n / 工作区 $ws_n"
  set_ ".workspace" "\"$ws\""; set_ ".steps.worktree" '"done"'
fi

# --- 步骤 3：任务书 ---
final_book="$runs/tasks/$slug.md"
if ! step_done task_book; then
  mkdir -p "$runs/tasks"
  sed "s#{{meego_url}}#$meego_url#g" "$book" > "$final_book"
  head -1 "$final_book" | grep -q "目标分支为 master" || fail task_book "任务书首行缺「目标分支为 master」"
  head -1 "$final_book" | grep -q "Meego issue:$meego_url" || fail task_book "任务书首行 Meego URL 未填入"
  head -1 "$final_book" | grep -q "MR 类型 bug" || fail task_book "任务书首行缺「MR 类型 bug」"
  set_ ".task_book" "\"$final_book\""; set_ ".steps.task_book" '"done"'
fi

# --- 步骤 4：起 omh ---
if ! step_done launch; then
  log=$(bash "$HERE/launch-traex.sh" "$ws" "$final_book" "$WORKFLOW")
  set_ ".host_log" "\"$log\""; set_ ".launched_at" "\"$(date -u +%FT%TZ)\""; set_ ".steps.launch" '"done"'
fi

# --- 步骤 5：等任务目录出现并核验 runtime ---
if ! step_done verify; then
  tid=""
  for _ in $(seq 1 $((TASK_WAIT_SECONDS / 5 + 1))); do
    tid=$(ls -td "$ws"/.omh/tasks/task_* 2>/dev/null | head -1 | xargs -n1 basename 2>/dev/null)
    [ -n "$tid" ] && break
    sleep 5
  done
  [ -n "$tid" ] || fail verify "等待 ${TASK_WAIT_SECONDS}s 未见任务目录，宿主日志：$(get .host_log)"
  tg=$(cd "$ws" && "$ORCH" task-get --task-id "$tid" 2>/dev/null)
  rt=$(echo "$tg" | jq -r '.task.host.runtime // empty'); wf=$(echo "$tg" | jq -r '.task.extras.platform_workflow_key // empty')
  if [ "$rt" != traecli ] || [ "$wf" != "$WORKFLOW" ]; then
    (cd "$ws" && "$ORCH" task-cancel --task-id "$tid" >/dev/null 2>&1)
    fail verify "runtime=$rt workflow=$wf 不符，已 cancel $tid" 4
  fi
  set_ ".task_id" "\"$tid\""; set_ ".dispatched_at" "\"$(date -u +%FT%TZ)\""; set_ ".steps.verify" '"done"'; set_ ".error" 'null'
fi

echo "{\"ok\":true,\"issue_id\":\"$issue\",\"step\":\"verify\",\"meego_url\":\"$meego_url\",\"task_id\":\"$(get .task_id)\",\"workspace\":\"$ws\",\"task_book\":\"$final_book\",\"host_log\":\"$(get .host_log)\"}"
