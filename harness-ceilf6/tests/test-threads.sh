#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
TH="$HERE/../scripts/threads.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
has() { # has <描述> <期望子串> <实际文本>
  case "$3" in *"$2"*) ok "$1" ;; *) bad "${1}（未见「${2}」）" ;; esac
}
hasnt() {
  case "$3" in *"$2"*) bad "${1}（不应出现「${2}」）" ;; *) ok "$1" ;; esac
}
check_die() {
  local d="$1" want="$2"; shift 2
  local err rc=0
  err=$(mktemp)
  "$@" >/dev/null 2>"$err" || rc=$?
  [ "$rc" != 0 ] && ok "${d}：非零退出" || bad "${d}：exit 0"
  grep -q "$want" "$err" && ok "${d}：诊断" || bad "${d}：诊断（实际：$(head -1 "$err")）"
  rm -f "$err"
}

make_env() {
  T=$(mktemp -d); T=$(cd "$T" && pwd -P)
  export HARNESS_THREADS_FILE="$T/threads.jsonl"
  export CLAUDE_PROJECTS_DIR="$T/projects"
  mkdir -p "$CLAUDE_PROJECTS_DIR/-proj"
}
# make_repo <目录名> <需求分支> <status> → 设置 REPO / CTX
make_repo() {
  REPO="$T/$1"; mkdir -p "$REPO"
  git -C "$REPO" init -q -b master
  git -C "$REPO" config user.email t@t
  git -C "$REPO" config user.name t
  git -C "$REPO" commit -q --allow-empty -m init
  git -C "$REPO" checkout -q -b "$2"
  CTX="$REPO/.harness-ceilf6/$(printf '%s' "$2" | sed 's|/|__|g')"
  mkdir -p "$CTX"
  jq -n --arg b "$2" --arg s "$3" \
    '{branch:$b, base_branch:"master", status:$s, mr_id:null, wiki_url:null}' > "$CTX/meta.json"
}
mk_session() { : > "$CLAUDE_PROJECTS_DIR/-proj/${1}.jsonl"; }
cleanup_env() { rm -rf "$T" 2>/dev/null || { sleep 1; rm -rf "$T" 2>/dev/null || true; }; }

echo "== register：写入与 list 呈现 =="
make_env
make_repo repo-a feat/alpha developing
mk_session sid-aaa
(cd "$REPO" && CLAUDE_CODE_SESSION_ID=sid-aaa bash "$TH" register --ctx-dir "$CTX" --title '需求甲') >/dev/null
[ -f "$HARNESS_THREADS_FILE" ] && ok "登记表已建" || bad "登记表未建"
[ "$(wc -l < "$HARNESS_THREADS_FILE" | tr -d ' ')" = 1 ] && ok "写入一行" || bad "行数: $(wc -l < "$HARNESS_THREADS_FILE")"
jq -e '.ctx_dir and .cwd and .branch and .session_id and .registered_at' "$HARNESS_THREADS_FILE" >/dev/null && ok "字段齐全" || bad "字段缺失"
out=$(bash "$TH" list)
has "list 含检出名" 'repo-a' "$out"
has "list 含需求分支" 'feat/alpha' "$out"
has "list 含状态" 'developing' "$out"
has "list 含短题" '需求甲' "$out"
has "list 含唤回命令" 'claude --dangerously-skip-permissions --resume sid-aaa' "$out"

echo "== 分支一致：唤回命令不含 checkout =="
hasnt "无多余 checkout" 'git checkout' "$out"

echo "== 二次登记 last-wins =="
mk_session sid-bbb
(cd "$REPO" && CLAUDE_CODE_SESSION_ID=sid-bbb bash "$TH" register --ctx-dir "$CTX" --title '需求甲') >/dev/null
[ "$(wc -l < "$HARNESS_THREADS_FILE" | tr -d ' ')" = 2 ] && ok "追加而非改写（2 行）" || bad "行数: $(wc -l < "$HARNESS_THREADS_FILE")"
out=$(bash "$TH" list)
[ "$(printf '%s' "$out" | grep -c 'feat/alpha')" = 1 ] && ok "list 去重后只一条" || bad "去重失败"
has "取新 session" 'claude --dangerously-skip-permissions --resume sid-bbb' "$out"
hasnt "旧 session 不再出现" 'sid-aaa' "$out"
cleanup_env

echo "== 检出分支漂移：唤回命令带 checkout =="
make_env
make_repo repo-b fix/drift awaiting_human
mk_session sid-drift
(cd "$REPO" && CLAUDE_CODE_SESSION_ID=sid-drift bash "$TH" register --ctx-dir "$CTX") >/dev/null
git -C "$REPO" checkout -q master              # 检出漂到 master，需求仍在 fix/drift
out=$(bash "$TH" list)
has "标注漂移" '检出在 master' "$out"
has "命令含 checkout" 'git checkout fix/drift' "$out"
cleanup_env

echo "== 无 session_id：登记成功且给降级指引 =="
make_env
make_repo repo-c feat/nosid developing
(cd "$REPO" && CLAUDE_CODE_SESSION_ID= bash "$TH" register --ctx-dir "$CTX") >/dev/null
jq -e '.session_id == null' "$HARNESS_THREADS_FILE" >/dev/null && ok "session_id 记 null" || bad "session_id 未记 null"
out=$(bash "$TH" list)
has "列出该需求" 'feat/nosid' "$out"
has "降级指引" '续入' "$out"
hasnt "不出现空 resume" '--resume ' "$out"
cleanup_env

echo "== 异常标注：ctx 失效 / 会话丢失 =="
make_env
make_repo repo-d feat/gone developing
mk_session sid-gone
(cd "$REPO" && CLAUDE_CODE_SESSION_ID=sid-gone bash "$TH" register --ctx-dir "$CTX") >/dev/null
make_repo repo-e feat/losts developing
(cd "$REPO" && CLAUDE_CODE_SESSION_ID=sid-missing bash "$TH" register --ctx-dir "$CTX") >/dev/null
rm -rf "$T/repo-d/.harness-ceilf6"             # ctx 目录消失
out=$(bash "$TH" list)
has "ctx 失效标注" '[失效]' "$out"
has "会话丢失标注" '[会话丢失]' "$out"
has "会话丢失仍列出需求" 'feat/losts' "$out"

echo "== prune：删失效留有效 =="
bash "$TH" prune >/dev/null
[ "$(wc -l < "$HARNESS_THREADS_FILE" | tr -d ' ')" = 1 ] && ok "失效行已删" || bad "prune 后行数: $(wc -l < "$HARNESS_THREADS_FILE")"
grep -q 'feat/losts' "$HARNESS_THREADS_FILE" && ok "有效行保留" || bad "有效行被误删"
cleanup_env

echo "== done 默认隐藏、--all 显示 =="
make_env
make_repo repo-f feat/done done
mk_session sid-done
(cd "$REPO" && CLAUDE_CODE_SESSION_ID=sid-done bash "$TH" register --ctx-dir "$CTX") >/dev/null
make_repo repo-g feat/live developing
mk_session sid-live
(cd "$REPO" && CLAUDE_CODE_SESSION_ID=sid-live bash "$TH" register --ctx-dir "$CTX") >/dev/null
out=$(bash "$TH" list)
hasnt "默认隐藏 done" 'feat/done' "$out"
has "默认显示未完成" 'feat/live' "$out"
out=$(bash "$TH" list --all)
has "--all 显示 done" 'feat/done' "$out"
cleanup_env

echo "== resume：序号 / 关键词 / 多命中 / 越界 =="
make_env
make_repo repo-h feat/apple developing
mk_session sid-apple
(cd "$REPO" && CLAUDE_CODE_SESSION_ID=sid-apple bash "$TH" register --ctx-dir "$CTX") >/dev/null
make_repo repo-i feat/apricot developing
mk_session sid-apricot
(cd "$REPO" && CLAUDE_CODE_SESSION_ID=sid-apricot bash "$TH" register --ctx-dir "$CTX") >/dev/null
out=$(bash "$TH" resume 1 --dry-run || true)
has "序号唤回给出完整命令" 'claude --dangerously-skip-permissions --resume' "$out"
has "序号唤回含 cd" 'cd ' "$out"
out=$(bash "$TH" resume apple --dry-run || true)
has "关键词唯一命中" 'sid-apple' "$out"
hasnt "未误取另一条" 'sid-apricot' "$out"
check_die "关键词多命中列候选" '多条' bash "$TH" resume 'feat/ap' --dry-run
check_die "序号越界" '序号' bash "$TH" resume 9 --dry-run
check_die "无参数" '用法' bash "$TH" resume

echo "== resume 守卫：脏工作区 + 漂移则不自动切分支 =="
git -C "$T/repo-h" checkout -q master
echo dirty > "$T/repo-h/dirty.txt"
git -C "$T/repo-h" add dirty.txt
check_die "脏工作区拒绝自动 checkout" '未提交' bash "$TH" resume apple --dry-run
cleanup_env

echo "== 未知子命令 =="
make_env
check_die "未知子命令" '用法' bash "$TH" bogus
cleanup_env

echo "== mark 直指形式：写入 / 幂等 / 校验 =="
make_env
make_repo repo-j feat/mark developing
out=$(bash "$TH" mark --ctx-dir "$CTX" plan_gate)
jq -e '.milestones.plan_gate' "$CTX/meta.json" >/dev/null && ok "plan_gate 落盘" || bad "plan_gate 落盘"
has "回显进度图（当前节点标记）" '◉' "$out"
has "计划门已完成段" '● 计划门' "$out"
has "开发为当前节点" '◉ 开发（当前）' "$out"
out=$(bash "$TH" mark --ctx-dir "$CTX" plan_gate)
has "幂等不覆盖" '不覆盖' "$out"
check_die "cr_passed 拒绝人工写" 'cr-round' bash "$TH" mark --ctx-dir "$CTX" cr_passed
check_die "未知节点报错" '未知节点' bash "$TH" mark --ctx-dir "$CTX" bogus_node
check_die "缺 meta.json 报错" 'meta.json' bash "$TH" mark --ctx-dir "$T/nonexist" plan_gate

echo "== mark 乱序：警告但放行 =="
err=$(mktemp)
bash "$TH" mark --ctx-dir "$CTX" selftest_done >/dev/null 2>"$err"
jq -e '.milestones.selftest_done' "$CTX/meta.json" >/dev/null && ok "乱序仍落盘" || bad "乱序仍落盘"
grep -q '警告' "$err" && ok "乱序有警告" || bad "乱序有警告"
rm -f "$err"

echo "== progress：全齐 → 可交付 =="
tmp=$(mktemp)
jq '.milestones.dev_done="2026-08-03T00:00:00Z" | .milestones.cr_passed="2026-08-03T00:00:01Z"' \
  "$CTX/meta.json" > "$tmp" && mv "$tmp" "$CTX/meta.json"
bash "$TH" mark --ctx-dir "$CTX" mr_created >/dev/null
bash "$TH" mark --ctx-dir "$CTX" human_cr_done >/dev/null
out=$(bash "$TH" progress --ctx-dir "$CTX")
has "全齐后可交付点亮" '● 可交付' "$out"
hasnt "全齐后无当前标记" '（当前）' "$out"
check_die "progress 缺 --ctx-dir" 'ctx-dir' bash "$TH" progress
cleanup_env

echo "== mark 乱序通用：前序未完成即警告 =="
make_env
make_repo repo-o feat/order developing
err=$(mktemp)
bash "$TH" mark --ctx-dir "$CTX" mr_created >/dev/null 2>"$err"
grep -q '警告' "$err" && ok "跳过前序节点有警告" || bad "跳过前序节点有警告"
jq -e '.milestones.mr_created' "$CTX/meta.json" >/dev/null && ok "仍放行落盘" || bad "仍放行落盘"
rm -f "$err"

echo "== 无 milestones 字段：progress 按 status 回退当前节点 =="
make_repo repo-p feat/legacy developing
out=$(bash "$TH" progress --ctx-dir "$CTX")
has "legacy developing 当前在开发" '◉ 开发（当前）' "$out"
has "legacy 前序位置点亮" '● 计划门' "$out"
make_repo repo-p2 feat/olddone done
out=$(bash "$TH" progress --ctx-dir "$CTX")
has "legacy done 全亮可交付" '● 可交付' "$out"
make_repo repo-p3 feat/badstatus bogus
out=$(bash "$TH" progress --ctx-dir "$CTX")
has "未知 status 按全未完成" '◉ 计划门（当前）' "$out"
cleanup_env

echo "== mark 序号/别名形式 =="
make_env
make_repo repo-l feat/alias developing
mk_session sid-alias
(cd "$REPO" && CLAUDE_CODE_SESSION_ID=sid-alias bash "$TH" register --ctx-dir "$CTX" --title '别名测试') >/dev/null
check_die "序号形式拒绝节点内部名" '人工节点' bash "$TH" mark 1 dev_done
check_die "序号越界" '序号' bash "$TH" mark 9 human-cr
bash "$TH" mark 1 human-cr >/dev/null 2>/dev/null
jq -e '.milestones.human_cr_done' "$CTX/meta.json" >/dev/null && ok "序号+human-cr 落盘" || bad "序号+human-cr 落盘"
bash "$TH" mark alias selftest >/dev/null 2>&1
jq -e '.milestones.selftest_done' "$CTX/meta.json" >/dev/null && ok "关键词+selftest 落盘" || bad "关键词+selftest 落盘"
check_die "缺节点参数" '用法' bash "$TH" mark 1
cleanup_env

echo "== mark 多线程：唯一命中与多命中守卫 =="
make_env
make_repo repo-q feat/pear developing
mk_session sid-pear
(cd "$REPO" && CLAUDE_CODE_SESSION_ID=sid-pear bash "$TH" register --ctx-dir "$CTX" --title '梨需求') >/dev/null
CTX1="$CTX"
make_repo repo-r feat/peach developing
mk_session sid-peach
(cd "$REPO" && CLAUDE_CODE_SESSION_ID=sid-peach bash "$TH" register --ctx-dir "$CTX" --title '桃需求') >/dev/null
check_die "mark 关键词多命中" '多条' bash "$TH" mark 'feat/pe' human-cr
bash "$TH" mark peach human-cr 2>/dev/null >/dev/null
jq -e '.milestones.human_cr_done' "$CTX/meta.json" >/dev/null && ok "唯一命中落对线程" || bad "唯一命中落对线程"
jq -e '.milestones | not' "$CTX1/meta.json" >/dev/null && ok "另一线程未被误写" || bad "另一线程未被误写"
cleanup_env

echo "== list 节点列：旧线程 status 回退与首次 mark 补录 =="
make_env
make_repo repo-m feat/nodecol awaiting_human
mk_session sid-node
(cd "$REPO" && CLAUDE_CODE_SESSION_ID=sid-node bash "$TH" register --ctx-dir "$CTX" --title '节点列') >/dev/null
out=$(bash "$TH" list)
has "旧线程 awaiting_human 回退待人工CR" '· 待人工CR]' "$out"
bash "$TH" mark --ctx-dir "$CTX" human_cr_done >/dev/null 2>&1
jq -e '.milestones | has("plan_gate") and has("dev_done") and has("cr_passed") and has("mr_created")' "$CTX/meta.json" >/dev/null \
  && ok "首次 mark 自动补录前序" || bad "首次 mark 自动补录前序"
out=$(bash "$TH" list)
has "mark 后推进到待自测" '· 待自测]' "$out"
cleanup_env

echo "== list --json =="
make_env
make_repo repo-n feat/json developing
mk_session sid-json
(cd "$REPO" && CLAUDE_CODE_SESSION_ID=sid-json bash "$TH" register --ctx-dir "$CTX" --title 'json测试') >/dev/null
bash "$TH" mark --ctx-dir "$CTX" plan_gate >/dev/null
out=$(bash "$TH" list --json)
echo "$out" | jq -e 'type == "array" and length == 1' >/dev/null && ok "输出 JSON 数组" || bad "输出 JSON 数组"
echo "$out" | jq -e '.[0] | .ctx_dir and .branch and .status and .node and .progress and (.milestones | type == "object")' >/dev/null \
  && ok "字段齐全" || bad "字段齐全"
echo "$out" | jq -e '.[0].node == "开发中"' >/dev/null && ok "node 推导正确" || bad "node: $(echo "$out" | jq -r '.[0].node')"
echo "$out" | jq -e '.[0].milestones.plan_gate' >/dev/null && ok "milestones 透传" || bad "milestones 透传"
cleanup_env

echo "== list --json 容错：坏 meta 与空 meta 不静默丢线程 =="
make_env
make_repo repo-s feat/good developing
mk_session sid-good
(cd "$REPO" && CLAUDE_CODE_SESSION_ID=sid-good bash "$TH" register --ctx-dir "$CTX" --title '好线程') >/dev/null
make_repo repo-t feat/badmeta developing
mk_session sid-bad
(cd "$REPO" && CLAUDE_CODE_SESSION_ID=sid-bad bash "$TH" register --ctx-dir "$CTX" --title '坏线程') >/dev/null
echo 'not json' > "$CTX/meta.json"
out=$(bash "$TH" list --json 2>/dev/null)
echo "$out" | jq -e 'length == 2' >/dev/null && ok "坏 meta 不丢线程" || bad "坏 meta 行数: $(echo "$out" | jq 'length')"
echo "$out" | jq -e '.[] | select(.branch=="feat/badmeta") | .milestones == {}' >/dev/null && ok "坏 meta milestones 回落 {}" || bad "坏 meta milestones 回落 {}"
echo "$out" | jq -e '.[] | select(.branch=="feat/badmeta") | .node == "-"' >/dev/null && ok "坏 meta 节点列降级 -" || bad "坏 meta 节点列: $(echo "$out" | jq -r '.[] | select(.branch=="feat/badmeta") | .node')"
: > "$CTX/meta.json"
out=$(bash "$TH" list --json 2>/dev/null)
echo "$out" | jq -e 'length == 2 and ([.[] | select(.branch=="feat/badmeta")][0].milestones == {})' >/dev/null && ok "空 meta 回落 {}" || bad "空 meta 回落 {}"
echo "$out" | jq -e '.[] | select(.branch=="feat/badmeta") | .node == "-"' >/dev/null && ok "空 meta 节点列降级 -" || bad "空 meta 节点列: $(echo "$out" | jq -r '.[] | select(.branch=="feat/badmeta") | .node')"
cleanup_env

echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
