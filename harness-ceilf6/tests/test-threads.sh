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
has "list 含唤回命令" 'claude --resume sid-aaa' "$out"

echo "== 分支一致：唤回命令不含 checkout =="
hasnt "无多余 checkout" 'git checkout' "$out"

echo "== 二次登记 last-wins =="
mk_session sid-bbb
(cd "$REPO" && CLAUDE_CODE_SESSION_ID=sid-bbb bash "$TH" register --ctx-dir "$CTX" --title '需求甲') >/dev/null
[ "$(wc -l < "$HARNESS_THREADS_FILE" | tr -d ' ')" = 2 ] && ok "追加而非改写（2 行）" || bad "行数: $(wc -l < "$HARNESS_THREADS_FILE")"
out=$(bash "$TH" list)
[ "$(printf '%s' "$out" | grep -c 'feat/alpha')" = 1 ] && ok "list 去重后只一条" || bad "去重失败"
has "取新 session" 'claude --resume sid-bbb' "$out"
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
has "序号唤回给出完整命令" 'claude --resume' "$out"
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

echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
