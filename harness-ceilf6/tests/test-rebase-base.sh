#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
RB="$HERE/../scripts/rebase-base.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
check_die() {
  local d="$1" want="$2"; shift 2
  local err rc=0
  err=$(mktemp)
  "$@" >/dev/null 2>"$err" || rc=$?
  [ "$rc" = 1 ] && ok "${d}：exit 1" || bad "${d}：exit $rc"
  grep -q "$want" "$err" && ok "${d}：die 诊断" || bad "${d}：die 诊断"
  rm -f "$err"
}

# fixture：U 为上游仓（充当 origin），R 为 clone；feat/x 一个自有提交。
# 上游推进只发生在 U——R 侧必须靠脚本自己的 fetch 才看得到，借此钉死「不 fetch 会假性已最新」。
make_repos() {
  U=$(mktemp -d); U=$(cd "$U" && pwd -P)
  git -C "$U" init -q -b master
  git -C "$U" config user.email t@t
  git -C "$U" config user.name t
  printf 'l1\nl2\nl3\n' > "$U/f.txt"
  git -C "$U" add . && git -C "$U" commit -qm init
  W=$(mktemp -d); W=$(cd "$W" && pwd -P); R="$W/repo"
  git clone -q "$U" "$R"
  git -C "$R" config user.email t@t
  git -C "$R" config user.name t
  git -C "$R" checkout -q -b feat/x
  ctx="$R/.harness-ceilf6/feat__x"
  mkdir -p "$ctx"
  jq -n '{branch:"feat/x", wiki_url:null, base_branch:"master", status:"cr",
          max_rounds:null, mr_id:null, created_at:"2026-08-11T00:00:00Z"}' > "$ctx/meta.json"
}
cleanup_repos() { rm -rf "$U" "$W" 2>/dev/null || { sleep 1; rm -rf "$U" "$W"; }; }

echo "== 上游推进后变基（fetch 生效 + 单提交重放）=="
make_repos
echo mine > "$R/mine.txt"
git -C "$R" add mine.txt && git -C "$R" commit -qm '我的提交'   # 不 add .：ctx 目录必须保持未跟踪，否则切分支会被 checkout 移除
echo up1 >> "$U/f.txt"; git -C "$U" commit -qam 'upstream 1'
echo up2 >> "$U/f.txt"; git -C "$U" commit -qam 'upstream 2'
UPTIP=$(git -C "$U" rev-parse master)
OUT=$(bash "$RB" --dir "$ctx") && ok "exit 0" || bad "exit $?"
[ "$(git -C "$R" rev-parse origin/master)" = "$UPTIP" ] && ok "fetch 更新了远程跟踪 ref" || bad "origin/master 未更新"
[ "$(git -C "$R" rev-parse HEAD^)" = "$UPTIP" ] && ok "父提交是远端 tip" || bad "父提交: $(git -C "$R" rev-parse --short HEAD^)"
[ "$(git -C "$R" log -1 --format=%s)" = '我的提交' ] && ok "自有提交重放保留" || bad "subject: $(git -C "$R" log -1 --format=%s)"
echo "$OUT" | grep -q '吸收上游 2 个提交' && ok "回显吸收提交数" || bad "回显: $OUT"
if git -C "$R" diff origin/master...HEAD | grep -q '^+up'; then bad "MR 视角 diff 混入上游改动"; else ok "MR 视角 diff 只含本人改动"; fi

echo "== 已最新时空转 =="
H0=$(git -C "$R" rev-parse HEAD)
OUT=$(bash "$RB" --dir "$ctx") && ok "空转 exit 0" || bad "空转 exit $?"
echo "$OUT" | grep -q '无需变基' && ok "回显无需变基" || bad "回显: $OUT"
[ "$(git -C "$R" rev-parse HEAD)" = "$H0" ] && ok "HEAD 未动" || bad "HEAD 被改写"
cleanup_repos

echo "== 冲突：exit 2、现场保留、abort 可回退 =="
make_repos
printf 'l1-mine\nl2\nl3\n' > "$R/f.txt"
git -C "$R" commit -qam '我的提交'
printf 'l1-up\nl2\nl3\n' > "$U/f.txt"
git -C "$U" commit -qam 'upstream 冲突提交'
OLD=$(git -C "$R" rev-parse HEAD)
err=$(mktemp); rc=0
bash "$RB" --dir "$ctx" >/dev/null 2>"$err" || rc=$?
[ "$rc" = 2 ] && ok "冲突 exit 2" || bad "冲突 exit $rc"
grep -q '冲突现场' "$err" && ok "冲突指引" || bad "冲突指引缺失"
grep -q '重跑自检' "$err" && ok "自检纪律提示" || bad "自检纪律提示缺失"
git -C "$R" status --porcelain | grep -q '^UU' && ok "冲突现场保留" || bad "无冲突现场"
check_die "半途现场再跑拒绝" '半途' bash "$RB" --dir "$ctx"
git -C "$R" rebase --abort
[ "$(git -C "$R" rev-parse HEAD)" = "$OLD" ] && ok "abort 回到旧 HEAD" || bad "abort 后 HEAD 漂移"
rm -f "$err"
cleanup_repos

echo "== 守卫 =="
make_repos
echo up >> "$U/f.txt"; git -C "$U" commit -qam 'upstream'   # 落后才走到脏区检查
echo mine > "$R/mine.txt"; git -C "$R" add mine.txt && git -C "$R" commit -qm '我的提交'
echo dirty >> "$R/f.txt"
check_die "脏工作区拒绝" '未提交改动' bash "$RB" --dir "$ctx"
git -C "$R" checkout -q -- f.txt
git -C "$R" remote set-url origin "$W/nonexistent-remote"
check_die "fetch 失败即停不降级" 'fetch' bash "$RB" --dir "$ctx"
git -C "$R" remote set-url origin "$U"
git -C "$R" checkout -q master
check_die "在 base 分支上拒绝" 'base 分支' bash "$RB" --dir "$ctx"
git -C "$R" checkout -q --detach feat/x
check_die "detached HEAD 拒绝" 'detached' bash "$RB" --dir "$ctx"
check_die "meta.json 缺失" 'meta.json' bash "$RB" --dir "$W"
cleanup_repos

echo "== 纯本地仓（无远程）：跳过 fetch、按本地 base 变基 =="
R=$(mktemp -d); R=$(cd "$R" && pwd -P)
git -C "$R" init -q -b master
git -C "$R" config user.email t@t
git -C "$R" config user.name t
echo base > "$R/f.txt"; git -C "$R" add .; git -C "$R" commit -qm init
git -C "$R" checkout -q -b feat/local
ctx="$R/.harness-ceilf6/feat__local"; mkdir -p "$ctx"
jq -n '{branch:"feat/local", base_branch:"master"}' > "$ctx/meta.json"
echo mine > "$R/mine.txt"; git -C "$R" add mine.txt; git -C "$R" commit -qm '我的提交'
git -C "$R" checkout -q master
echo up >> "$R/f.txt"; git -C "$R" commit -qam 'local upstream'
LOCTIP=$(git -C "$R" rev-parse master)
git -C "$R" checkout -q feat/local
bash "$RB" --dir "$ctx" >/dev/null && ok "无远程 exit 0" || bad "无远程 exit $?"
[ "$(git -C "$R" rev-parse HEAD^)" = "$LOCTIP" ] && ok "变基到本地 base tip" || bad "父提交错位"
rm -rf "$R" 2>/dev/null || { sleep 1; rm -rf "$R"; }   # git 后台维护进程可能仍在写 .git，首次 rm 会撞 Directory not empty

echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
