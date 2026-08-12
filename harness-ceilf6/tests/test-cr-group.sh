#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
CG="$HERE/../scripts/cr-group.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
has() { case "$3" in *"$2"*) ok "$1" ;; *) bad "${1}（未见「${2}」）" ;; esac }
hasnt() { case "$3" in *"$2"*) bad "${1}（不应出现「${2}」）" ;; *) ok "$1" ;; esac }

export PATH="$HERE/stubs:$PATH"

setup() { # <mr_id 或空>：造 repo + ctx + STUB_STATE
  T=$(mktemp -d); T=$(cd "$T" && pwd -P)
  export HARNESS_THREADS_FILE="$T/threads.jsonl"
  export STUB_STATE="$T/stub"; mkdir -p "$STUB_STATE"
  REPO="$T/repo"; mkdir -p "$REPO"
  git -C "$REPO" init -q -b master
  git -C "$REPO" config user.email t@t
  git -C "$REPO" config user.name wangjinghong.ceilf6
  CTX="$REPO/.harness-ceilf6/feat__cg"; mkdir -p "$CTX"
  jq -n --arg mr "${1:-}" \
    '{branch:"feat/cg", base_branch:"master", status:"awaiting_human",
      mr_id:(if $mr == "" then null else $mr end),
      milestones:{plan_gate:"2026-08-07T00:00:00Z", dev_done:"2026-08-07T00:00:01Z",
                  cr_passed:"2026-08-07T00:00:02Z", mr_created:"2026-08-07T00:00:03Z",
                  human_cr_done:"2026-08-07T00:00:04Z", selftest_done:"2026-08-07T00:00:05Z"}}' \
    > "$CTX/meta.json"
  echo '[{"username":"dalao1"},{"username":"dalao2"},{"username":"wangjinghong.ceilf6"},{"username":"dalao1"}]' \
    > "$STUB_STATE/reviewers.json"
  # chat create 真机应答把 chat_id 裸放在 data 字段
  echo '{"code":200,"data":"oc_stub_1","message":"success"}' > "$STUB_STATE/create.json"
}
# 本机 AI IDE 守护进程会异步往新 .git 下写 ai/ 目录，与删除竞争导致 ENOTEMPTY，故重试
teardown() { rm -rf "$T" 2>/dev/null || { sleep 1; rm -rf "$T" 2>/dev/null || true; }; }

echo "== group：建群、去重排己拉人、落群标识 =="
setup 8300001
out=$(bash "$CG" group --ctx-dir "$CTX")
calls=$(cat "$STUB_STATE/calls.log")
has "读 reviewer 名单" 'bits mr reviewer info --mr-id 8300001' "$calls"
has "建群" 'bits mr chat create --mr-id 8300001' "$calls"
has "拉 dalao1" 'chat add --mr-id 8300001 --username dalao1 --member-type reviewer' "$calls"
has "拉 dalao2" 'chat add --mr-id 8300001 --username dalao2' "$calls"
hasnt "排除本人" 'chat add --mr-id 8300001 --username wangjinghong.ceilf6' "$calls"
[ "$(grep -c 'chat add' "$STUB_STATE/calls.log")" = 2 ] && ok "去重后只拉两人" || bad "chat add 次数: $(grep -c 'chat add' "$STUB_STATE/calls.log")"
has "收尾行带实际拉人数" '拉入 2 人' "$out"
jq -e '.milestones.cr_group_created' "$CTX/meta.json" >/dev/null && ok "拉群节点已 mark" || bad "拉群节点未 mark"
jq -e '.cr_chat_id == "oc_stub_1"' "$CTX/meta.json" >/dev/null && ok "群标识落 meta" || bad "群标识未落盘"
# 拉群不发消息；常态也不摘 WIP（仅 start 被 WIP 挡的重试路径例外，见后面专节）
hasnt "拉群不发消息" 'messages-send' "$calls"
hasnt "拉群常态不摘 WIP" '--wip false' "$calls"
jq -e '.milestones | has("cr_requested") | not' "$CTX/meta.json" >/dev/null && ok "拉群不标求CR" || bad "拉群误标求CR"
# 名单来自平台按规则的评审发起：不 start 名单里只有全局 QA/RD 位，建群只剩本人
has "拉群前发起代码评审" 'code-review start --mr-id 8300001' "$calls"
s_line=$(grep -n 'code-review start' "$STUB_STATE/calls.log" | head -1 | cut -d: -f1 || true)
r_line=$(grep -n 'reviewer info' "$STUB_STATE/calls.log" | head -1 | cut -d: -f1 || true)
[ -n "$s_line" ] && [ -n "$r_line" ] && [ "$s_line" -lt "$r_line" ] \
  && ok "start 先于读名单" || bad "顺序: start@${s_line:-无} reviewer@${r_line:-无}"

echo "== request：发消息、标节点、摘 WIP =="
: > "$STUB_STATE/calls.log"
out=$(bash "$CG" request --ctx-dir "$CTX")
calls=$(cat "$STUB_STATE/calls.log")
has "向落盘的群发消息" '+messages-send --chat-id oc_stub_1' "$calls"
has "消息含求CR文案与表情" '大佬们，有空辛苦 CR 一下[送心]' "$calls"
has "摘 WIP" 'mr update --mr-id 8300001 --wip false' "$calls"
jq -e '.milestones.cr_requested' "$CTX/meta.json" >/dev/null && ok "求CR 节点已 mark" || bad "求CR 节点未 mark"
# 群已在 meta 里，求CR 不必再建一次
hasnt "求CR 不重复建群" 'chat create' "$calls"
hasnt "求CR 不重复拉人" 'chat add' "$calls"

echo "== qa：一键提醒 + 群里知会，两者都成才标完成 =="
: > "$STUB_STATE/calls.log"
out=$(bash "$CG" qa --ctx-dir "$CTX")
calls=$(cat "$STUB_STATE/calls.log")
has "调一键提醒 QA" 'bits mr remind-qa --mr-id 8300001' "$calls"
has "群里知会 QA" '辛苦 QA 老师有空测一下[送心]' "$calls"
has "发到既有的群" '+messages-send --chat-id oc_stub_1' "$calls"
jq -e '.milestones.qa_requested' "$CTX/meta.json" >/dev/null && ok "求QA 节点已 mark" || bad "求QA 节点未 mark"
hasnt "求QA 不碰 WIP" '--wip' "$calls"
# 提醒失败：不发群消息、不标完成
tmp=$(mktemp); jq 'del(.milestones.qa_requested)' "$CTX/meta.json" > "$tmp" && mv "$tmp" "$CTX/meta.json"
: > "$STUB_STATE/calls.log"; : > "$STUB_STATE/qa_fail"
err=$(mktemp); rc=0
bash "$CG" qa --ctx-dir "$CTX" >/dev/null 2>"$err" || rc=$?
[ "$rc" != 0 ] && ok "提醒失败非零退出" || bad "提醒失败仍 exit 0"
grep -q '一键提醒 QA 失败' "$err" && ok "提醒失败有诊断" || bad "提醒失败无诊断"
grep -q 'messages-send' "$STUB_STATE/calls.log" && bad "提醒失败不该发群消息" || ok "提醒失败不发群消息"
jq -e '.milestones | has("qa_requested") | not' "$CTX/meta.json" >/dev/null && ok "提醒失败不 mark" || bad "提醒失败误 mark"
rm -f "$STUB_STATE/qa_fail"
# 群消息发不出：已提醒但仍不标完成
: > "$STUB_STATE/msg_fail"; rc=0
bash "$CG" qa --ctx-dir "$CTX" >/dev/null 2>"$err" || rc=$?
[ "$rc" != 0 ] && ok "群消息失败非零退出" || bad "群消息失败仍 exit 0"
grep -q '已提醒 QA，但群消息未发出' "$err" && ok "点明已提醒但消息未发" || bad "缺该诊断"
jq -e '.milestones | has("qa_requested") | not' "$CTX/meta.json" >/dev/null && ok "群消息失败不 mark" || bad "群消息失败误 mark"
rm -f "$STUB_STATE/msg_fail" "$err"
bash "$CG" qa --ctx-dir "$CTX" >/dev/null 2>&1

echo "== 返工重来：拉群幂等，求CR 再发一次 =="
: > "$STUB_STATE/calls.log"
: > "$STUB_STATE/create_fail"   # 群已存在，建群必失败
tmp=$(mktemp); jq 'del(.milestones.cr_group_created, .milestones.cr_requested)' "$CTX/meta.json" > "$tmp" && mv "$tmp" "$CTX/meta.json"
err=$(mktemp)
bash "$CG" group --ctx-dir "$CTX" >/dev/null 2>"$err"
grep -q '建群失败' "$err" && ok "群已存在有告警" || bad "群已存在无告警"
jq -e '.milestones.cr_group_created' "$CTX/meta.json" >/dev/null && ok "仍标拉群完成" || bad "返工后拉群未 mark"
jq -e '.cr_chat_id == "oc_stub_1"' "$CTX/meta.json" >/dev/null && ok "沿用既有群标识" || bad "群标识丢失"
: > "$STUB_STATE/calls.log"
bash "$CG" request --ctx-dir "$CTX" >/dev/null 2>&1
has "返工后重新发消息" '+messages-send --chat-id oc_stub_1' "$(cat "$STUB_STATE/calls.log")"
jq -e '.milestones.cr_requested' "$CTX/meta.json" >/dev/null && ok "求CR 重新标记" || bad "求CR 未重新标记"
bash "$CG" qa --ctx-dir "$CTX" >/dev/null 2>&1
jq -e '.milestones.qa_requested' "$CTX/meta.json" >/dev/null && ok "求QA 重新标记" || bad "求QA 未重新标记"
rm -f "$err"; teardown

echo "== 无 mr_id：三个子命令都 exit 3 且零外部调用 =="
setup ""
rc=0; out=$(bash "$CG" group --ctx-dir "$CTX") || rc=$?
[ "$rc" = 3 ] && ok "group exit 3" || bad "group rc=$rc"
has "group 契约文案" '无 MR，未拉群' "$out"
rc=0; out=$(bash "$CG" request --ctx-dir "$CTX") || rc=$?
[ "$rc" = 3 ] && ok "request exit 3" || bad "request rc=$rc"
has "request 契约文案" '无 MR，未发起CR' "$out"
rc=0; out=$(bash "$CG" qa --ctx-dir "$CTX") || rc=$?
[ "$rc" = 3 ] && ok "qa exit 3" || bad "qa rc=$rc"
has "qa 契约文案" '无 MR，未发起QA' "$out"
jq -e '.milestones | has("cr_group_created") | not' "$CTX/meta.json" >/dev/null && ok "未 mark" || bad "误 mark"
[ ! -f "$STUB_STATE/calls.log" ] && ok "零外部调用" || bad "有外部调用: $(cat "$STUB_STATE/calls.log")"
teardown

echo "== 建群成功但应答无 chat_id：告警且求CR 兜底再取一次 =="
setup 8300009
echo '{"data":{}}' > "$STUB_STATE/create.json"
err=$(mktemp)
bash "$CG" group --ctx-dir "$CTX" >/dev/null 2>"$err"
grep -q '未拿到群标识' "$err" && ok "拉群告警未拿到群标识" || bad "缺群标识告警"
jq -e 'has("cr_chat_id") | not' "$CTX/meta.json" >/dev/null && ok "不落空群标识" || bad "落了空群标识"
jq -e '.milestones.cr_group_created' "$CTX/meta.json" >/dev/null && ok "拉群仍 mark" || bad "拉群未 mark"
# 求CR 时再问一次；仍取不到就不标完成——消息没发出去，节点不该绿
: > "$STUB_STATE/calls.log"
rc=0; bash "$CG" request --ctx-dir "$CTX" >/dev/null 2>"$err" || rc=$?
[ "$rc" != 0 ] && ok "取不到群标识则非零退出" || bad "无群标识仍 exit 0"
grep -q 'chat create' "$STUB_STATE/calls.log" && ok "求CR 兜底再问一次群" || bad "求CR 未兜底"
grep -q 'messages-send' "$STUB_STATE/calls.log" && bad "无 chat_id 不应发消息" || ok "跳过发消息"
jq -e '.milestones | has("cr_requested") | not' "$CTX/meta.json" >/dev/null && ok "求CR 不 mark" || bad "求CR 误 mark"
# 兜底那次能拿到就照常发；嵌套 chat_id 键是兼容形状，一并覆盖
echo '{"data":{"chat_id":"oc_late"}}' > "$STUB_STATE/create.json"
bash "$CG" request --ctx-dir "$CTX" >/dev/null 2>&1
has "兜底取到后发消息" '+messages-send --chat-id oc_late' "$(cat "$STUB_STATE/calls.log")"
jq -e '.milestones.cr_requested' "$CTX/meta.json" >/dev/null && ok "补齐后 mark" || bad "补齐后未 mark"
rm -f "$err"; teardown

echo "== 建群应答 data 为错误文案：不得当群标识落盘 =="
setup 8300014
echo '{"code":500,"data":"mr not found","message":"fail"}' > "$STUB_STATE/create.json"
bash "$CG" group --ctx-dir "$CTX" >/dev/null 2>&1
jq -e 'has("cr_chat_id") | not' "$CTX/meta.json" >/dev/null && ok "错误文案不落盘" || bad "错误文案被当群标识"
teardown

echo "== reviewer 名单为空：照常建群，但要告警 =="
setup 8300003
echo '[]' > "$STUB_STATE/reviewers.json"
err=$(mktemp)
out=$(bash "$CG" group --ctx-dir "$CTX" 2>"$err")
grep -q 'chat create' "$STUB_STATE/calls.log" && ok "仍建群" || bad "未建群"
grep -q 'chat add' "$STUB_STATE/calls.log" && bad "空名单不应拉人" || ok "空名单零拉人"
grep -q '未解析到任何 reviewer' "$err" && ok "空名单有告警" || bad "空名单零告警"
has "收尾行如实报 0 人" '拉入 0 人' "$out"
rm -f "$err"; teardown

echo "== reviewer 输出为包装形状：解析不出人也要告警且不阻断 =="
setup 8300010
echo '{"data":[{"username":"dalao1"}]}' > "$STUB_STATE/reviewers.json"
err=$(mktemp)
out=$(bash "$CG" group --ctx-dir "$CTX" 2>"$err")
grep -q '未解析到任何 reviewer' "$err" && ok "形状不符有告警" || bad "形状不符零告警"
grep -q 'chat create' "$STUB_STATE/calls.log" && ok "仍建群" || bad "未建群"
jq -e '.milestones.cr_group_created' "$CTX/meta.json" >/dev/null && ok "仍 mark" || bad "未 mark"
has "收尾行如实报 0 人" '拉入 0 人' "$out"
rm -f "$err"; teardown

echo "== 拉人失败：逐个告警但流程继续 =="
setup 8300011
: > "$STUB_STATE/add_fail"
err=$(mktemp)
out=$(bash "$CG" group --ctx-dir "$CTX" 2>"$err")
grep -q '拉人失败：dalao1' "$err" && ok "dalao1 失败有告警" || bad "dalao1 失败无告警"
grep -q '拉人失败：dalao2' "$err" && ok "dalao2 失败有告警" || bad "dalao2 失败无告警"
jq -e '.milestones.cr_group_created' "$CTX/meta.json" >/dev/null && ok "仍 mark" || bad "未 mark"
# 收尾行是唯一到达用户眼前的成功回执：全失败还报「拉入 2 人」会让人以为已喊到人
has "全失败如实报 0 人" '拉入 0 人' "$out"
grep -q '未解析到任何 reviewer' "$err" && bad "名单解析出来了不该说没解析到" || ok "拉人失败不冒充名单为空"
rm -f "$err"; teardown

echo "== 发消息失败：不标完成，节点留黄可重试 =="
setup 8300004
bash "$CG" group --ctx-dir "$CTX" >/dev/null 2>&1
: > "$STUB_STATE/msg_fail"
err=$(mktemp)
rc=0; bash "$CG" request --ctx-dir "$CTX" >/dev/null 2>"$err" || rc=$?
[ "$rc" != 0 ] && ok "发送失败非零退出" || bad "发送失败仍 exit 0"
grep -q '消息未发出' "$err" && ok "发送失败有诊断" || bad "发送失败无诊断"
jq -e '.milestones | has("cr_requested") | not' "$CTX/meta.json" >/dev/null && ok "求CR 不 mark" || bad "求CR 误 mark"
jq -e '.milestones.cr_group_created' "$CTX/meta.json" >/dev/null && ok "拉群节点不受影响" || bad "拉群节点被清"
rm -f "$err"; teardown

echo "== 用户身份被企业管控拒发：拉 bot 进群改用 bot 身份补发 =="
setup 8300015
bash "$CG" group --ctx-dir "$CTX" >/dev/null 2>&1
: > "$STUB_STATE/user_send_denied"
: > "$STUB_STATE/calls.log"
rc=0; HARNESS_LARK_BOT_PROFILE=stub_bot bash "$CG" request --ctx-dir "$CTX" >/dev/null 2>&1 || rc=$?
calls=$(cat "$STUB_STATE/calls.log")
[ "$rc" = 0 ] && ok "降级后 exit 0" || bad "降级 rc=$rc"
has "先试默认（用户）身份" '+messages-send --chat-id oc_stub_1' "$calls"
has "查 harness bot 的应用标识" 'auth status --json --profile stub_bot' "$calls"
has "把 harness bot 拉进群" 'chat.members create --chat-id oc_stub_1 --member-id-type app_id' "$calls"
has "拉的是 auth status 回的应用" 'cli_stub_app' "$calls"
add_line=$(grep 'chat.members create' "$STUB_STATE/calls.log" | head -1)
hasnt "拉 bot 进群用本人身份（不带 profile）" '--profile' "$add_line"
has "以 harness bot 身份补发" '--as bot' "$calls"
has "补发带 bot profile" '+messages-send --chat-id oc_stub_1 --as bot' "$calls"
bot_send=$(grep -- '--as bot' "$STUB_STATE/calls.log" | head -1)
has "bot 发送切到 harness bot profile" '--profile stub_bot' "$bot_send"
jq -e '.milestones.cr_requested' "$CTX/meta.json" >/dev/null && ok "求CR 已 mark" || bad "求CR 未 mark"
# qa 走同一条发送路径
: > "$STUB_STATE/calls.log"
rc=0; HARNESS_LARK_BOT_PROFILE=stub_bot bash "$CG" qa --ctx-dir "$CTX" >/dev/null 2>&1 || rc=$?
[ "$rc" = 0 ] && ok "qa 同样降级成功" || bad "qa 降级 rc=$rc"
has "qa 也以 bot 补发" '--as bot' "$(cat "$STUB_STATE/calls.log")"
jq -e '.milestones.qa_requested' "$CTX/meta.json" >/dev/null && ok "求QA 已 mark" || bad "求QA 未 mark"
teardown

echo "== --message 覆盖文案 =="
setup 8300005
bash "$CG" group --ctx-dir "$CTX" >/dev/null 2>&1
: > "$STUB_STATE/calls.log"
bash "$CG" request --ctx-dir "$CTX" --message '自定义文案' >/dev/null 2>&1
has "自定义文案生效" '自定义文案' "$(cat "$STUB_STATE/calls.log")"
teardown

echo "== dry-run：两个子命令都零外部调用零落盘 =="
setup 8300006
out=$(bash "$CG" group --ctx-dir "$CTX" --dry-run)
has "group dry-run 打印计划" 'DRY:' "$out"
has "group dry-run 提到建群" 'chat create' "$out"
out=$(bash "$CG" request --ctx-dir "$CTX" --dry-run)
has "request dry-run 打印计划" 'DRY:' "$out"
has "request dry-run 提到发消息" 'messages-send' "$out"
out=$(bash "$CG" qa --ctx-dir "$CTX" --dry-run)
has "qa dry-run 打印计划" 'DRY:' "$out"
has "qa dry-run 提到一键提醒" 'remind-qa' "$out"
has "qa dry-run 用 QA 默认文案" '辛苦 QA 老师有空测一下[送心]' "$out"
[ ! -f "$STUB_STATE/calls.log" ] && ok "dry-run 零外部调用" || bad "dry-run 有外部调用"
jq -e '.milestones | has("cr_group_created") | not' "$CTX/meta.json" >/dev/null && ok "dry-run 不落盘" || bad "dry-run 落盘了"
teardown

echo "== wip：有/无 mr_id 两态 =="
setup 8300007
bash "$CG" wip --ctx-dir "$CTX" >/dev/null
has "挂 WIP 调用" 'mr update --mr-id 8300007 --wip' "$(cat "$STUB_STATE/calls.log")"
hasnt "挂 WIP 不带 false" '--wip false' "$(cat "$STUB_STATE/calls.log")"
teardown
setup ""
out=$(bash "$CG" wip --ctx-dir "$CTX")
has "无 MR 跳过" '跳过 WIP' "$out"
[ ! -f "$STUB_STATE/calls.log" ] && ok "无 MR 零调用" || bad "无 MR 有调用"
teardown

echo "== wip：挂载失败非零退出 =="
setup 8300012
: > "$STUB_STATE/update_fail"
rc=0; bash "$CG" wip --ctx-dir "$CTX" >/dev/null 2>&1 || rc=$?
[ "$rc" != 0 ] && ok "update 失败非零退出" || bad "update 失败仍 exit 0"
teardown

echo "== wip --dry-run：打印计划零调用 =="
setup 8300013
out=$(bash "$CG" wip --ctx-dir "$CTX" --dry-run)
has "dry-run 打印计划" 'DRY:' "$out"
hasnt "dry-run 不带 false" '--wip false' "$out"
[ ! -f "$STUB_STATE/calls.log" ] && ok "dry-run 零外部调用" || bad "dry-run 有外部调用"
teardown

echo "== 坏入参 =="
setup 8300008
rc=0; bash "$CG" group 2>/dev/null || rc=$?
[ "$rc" != 0 ] && ok "缺 ctx 非零退出" || bad "缺 ctx exit 0"
rc=0; bash "$CG" bogus --ctx-dir "$CTX" 2>/dev/null || rc=$?
[ "$rc" != 0 ] && ok "未知子命令非零退出" || bad "未知子命令 exit 0"
rc=0; bash "$CG" group --ctx-dir "$T/nonexist" 2>/dev/null || rc=$?
[ "$rc" != 0 ] && ok "缺 meta 非零退出" || bad "缺 meta exit 0"
teardown

echo "== group：评审已发起（start 报已运行）——幂等放行不告警 =="
setup 8300021
: > "$STUB_STATE/start_started"
err=$(bash "$CG" group --ctx-dir "$CTX" 2>&1 >/dev/null) || true
hasnt "已发起不告警" '发起代码评审失败' "$err"
has "照常建群" 'chat create' "$(cat "$STUB_STATE/calls.log")"
teardown

echo "== group：start 被 WIP 挡——摘 WIP 重试一次后静默成功 =="
setup 8300022
: > "$STUB_STATE/start_wip"
err=$(bash "$CG" group --ctx-dir "$CTX" 2>&1 >/dev/null) || true
calls=$(cat "$STUB_STATE/calls.log")
has "先摘 WIP" 'mr update --mr-id 8300022 --wip false' "$calls"
[ "$(grep -c 'code-review start' "$STUB_STATE/calls.log")" = 2 ] && ok "start 重试一次" || bad "start 次数: $(grep -c 'code-review start' "$STUB_STATE/calls.log")"
hasnt "重试成功不告警" '仍失败' "$err"
teardown

echo "== group：start 持续失败——告警但拉群继续 =="
setup 8300023
: > "$STUB_STATE/start_fail"
rc=0; bash "$CG" group --ctx-dir "$CTX" >/dev/null 2>"$T/err" || rc=$?
[ "$rc" = 0 ] && ok "拉群继续 exit 0" || bad "exit $rc"
has "失败告警" '发起代码评审失败' "$(cat "$T/err")"
has "照常建群" 'chat create' "$(cat "$STUB_STATE/calls.log")"
teardown

echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
