#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
CTX="$HERE/../scripts/ctx-dir.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
check_fail() { # check_fail <desc> <cmd...>：命令须失败
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then bad "$d"; else ok "$d"; fi
}
# 终态失败必须是 die 的干净退出（exit 1 且 stderr 含指定诊断文案），shell 崩溃（词法错误吞掉 die）不算。
# bash 3.2 对 $var 紧跟全角标点会解析出错误变量名转 unbound variable 崩溃：崩溃也退 1，只有 stderr 文案能区分。
check_die() {
  local d="$1" want="$2"; shift 2
  local err rc=0
  err=$(mktemp)
  "$@" >/dev/null 2>"$err" || rc=$?
  [ "$rc" = 1 ] && ok "${d}：exit 1" || bad "${d}：exit $rc"
  grep -q "$want" "$err" && ok "${d}：die 诊断" || bad "${d}：die 诊断"
  rm -f "$err"
}

R=$(mktemp -d)
R=$(cd "$R" && pwd -P)   # macOS: /var → /private/var 归一化，避免与 git 解析出的路径比较失败
trap 'rm -rf "$R"' EXIT
git -C "$R" init -q -b master
git -C "$R" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
cd "$R"

echo "== resolve =="
check_die "master 分支拒绝" '主分支' bash "$CTX" resolve
git checkout -q -b feat/x
out=$(bash "$CTX" resolve)
if [ "$out" = "$R/.harness-ceilf6/feat__x" ]; then ok "分支名 sanitize"; else bad "分支名 sanitize: $out"; fi
git checkout -q --detach
check_fail "detached HEAD 拒绝" bash "$CTX" resolve
git checkout -q feat/x

echo "== init =="
dir=$(bash "$CTX" init --wiki-url https://x/wiki/abc)
if [ -d "$dir/context" ] && [ -d "$dir/cr" ]; then ok "目录创建"; else bad "目录创建"; fi
excl=$(git rev-parse --git-path info/exclude)
if grep -qxF '.harness-ceilf6/' "$excl"; then ok "exclude 写入"; else bad "exclude 写入"; fi
[ "$(jq -r .status "$dir/meta.json")" = planning ] && ok "status=planning" || bad "status"
[ "$(jq -r .branch "$dir/meta.json")" = feat/x ] && ok "branch 记录" || bad "branch"
[ "$(jq -r .base_branch "$dir/meta.json")" = master ] && ok "base_branch 探测" || bad "base_branch"
[ "$(jq -r .wiki_url "$dir/meta.json")" = "https://x/wiki/abc" ] && ok "wiki_url 记录" || bad "wiki_url"
jq -e '.max_rounds == null and .mr_id == null' "$dir/meta.json" >/dev/null && ok "max_rounds/mr_id 默认 null" || bad "默认 null"
jq -e '.created_at | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T")' "$dir/meta.json" >/dev/null && ok "created_at ISO" || bad "created_at"

bash "$CTX" init >/dev/null 2>&1
[ "$(jq -r .wiki_url "$dir/meta.json")" = "https://x/wiki/abc" ] && ok "init 幂等不覆盖 meta" || bad "init 幂等"
[ "$(grep -cxF '.harness-ceilf6/' "$excl")" = 1 ] && ok "exclude 幂等" || bad "exclude 幂等"

echo "== new-entry =="
p=$(bash "$CTX" new-entry note my-slug)
case "$p" in
  "$dir"/context/[0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]-note-my-slug.md) ok "条目命名格式" ;;
  *) bad "条目命名格式: $p" ;;
esac
check_fail "非法类型拒绝" bash "$CTX" new-entry bogus x

echo "== set-status =="
bash "$CTX" set-status developing >/dev/null
[ "$(jq -r .status "$dir/meta.json")" = developing ] && ok "set-status 生效" || bad "set-status"
check_fail "非法状态拒绝" bash "$CTX" set-status nope

echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
