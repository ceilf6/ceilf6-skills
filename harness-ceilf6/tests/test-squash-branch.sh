#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SQ="$HERE/../scripts/squash-branch.sh"
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

# fixture：master 一个初始提交，feat/x 三个迭代提交
make_repo() {
  R=$(mktemp -d); R=$(cd "$R" && pwd -P)
  git -C "$R" init -q -b master
  git -C "$R" config user.email t@t
  git -C "$R" config user.name t
  echo base > "$R/f.txt"
  git -C "$R" add . && git -C "$R" commit -qm init
  git -C "$R" checkout -q -b feat/x
  ctx="$R/.harness-ceilf6/feat__x"
  mkdir -p "$ctx"
  jq -n '{branch:"feat/x", wiki_url:null, base_branch:"master", status:"cr",
          max_rounds:null, mr_id:null, created_at:"2026-07-30T00:00:00Z"}' > "$ctx/meta.json"
  for i in 1 2 3; do
    echo "c$i" >> "$R/f.txt"
    git -C "$R" commit -qam "wip $i"
  done
}
cleanup_repo() { rm -rf "$R" 2>/dev/null || { sleep 1; rm -rf "$R"; }; }

echo "== 三提交压一 =="
make_repo
OLD=$(git -C "$R" rev-parse HEAD)
MSG=$(mktemp)
printf 'feat(x): 让 f 累积三段内容\n\n为验证 squash 保留整棵树而造的示例变更。\n' > "$MSG"
bash "$SQ" --dir "$ctx" --message-file "$MSG"
[ "$(git -C "$R" rev-list --count master..HEAD)" = 1 ] && ok "压成单提交" || bad "提交数: $(git -C "$R" rev-list --count master..HEAD)"
git -C "$R" diff --quiet "$OLD" HEAD && ok "内容等价（diff 为空）" || bad "内容等价"
[ "$(git -C "$R" rev-parse harness-backup/feat/x)" = "$OLD" ] && ok "备份指针指向旧 HEAD" || bad "备份指针"
[ "$(git -C "$R" log -1 --format=%s)" = 'feat(x): 让 f 累积三段内容' ] && ok "subject 取自文件" || bad "subject: $(git -C "$R" log -1 --format=%s)"
git -C "$R" log -1 --format=%b | grep -q '为验证 squash' && ok "body 保留" || bad "body 保留"
[ "$(git -C "$R" symbolic-ref --short HEAD)" = feat/x ] && ok "仍在原分支" || bad "分支漂移"

echo "== 续入二次 squash（备份指针覆盖）=="
echo c4 >> "$R/f.txt"
git -C "$R" commit -qam "wip 4"
PRE2=$(git -C "$R" rev-parse HEAD)
printf 'feat(x): 让 f 累积四段内容\n' > "$MSG"
bash "$SQ" --dir "$ctx" --message-file "$MSG"
[ "$(git -C "$R" rev-list --count master..HEAD)" = 1 ] && ok "二次仍单提交" || bad "二次提交数"
[ "$(git -C "$R" rev-parse harness-backup/feat/x)" = "$PRE2" ] && ok "备份指针覆盖为二次改写前状态" || bad "备份指针未覆盖"

echo "== 工作区未提交改动保留 =="
echo dirty >> "$R/f.txt"
echo c5 >> "$R/g.txt"; git -C "$R" add g.txt; git -C "$R" commit -qm "wip 5"   # 再造一个可压提交
printf 'feat(x): 增加 g 文件\n' > "$MSG"
bash "$SQ" --dir "$ctx" --message-file "$MSG"
git -C "$R" status --porcelain | grep -q 'f.txt' && ok "脏文件仍在" || bad "脏文件丢失"
tail -1 "$R/f.txt" | grep -qx dirty && ok "脏内容未变" || bad "脏内容被改"
cleanup_repo

echo "== 守卫 =="
make_repo
check_die "message 文件缺失" 'message' bash "$SQ" --dir "$ctx" --message-file /nonexistent-msg
git -C "$R" checkout -q master
check_die "在 base 分支上拒绝" 'base 分支' bash "$SQ" --dir "$ctx" --message-file <(printf 'x\n')
git -C "$R" checkout -q --detach feat/x
check_die "detached HEAD 拒绝" 'detached' bash "$SQ" --dir "$ctx" --message-file <(printf 'x\n')
cleanup_repo

make_repo
git -C "$R" checkout -q master
git -C "$R" checkout -q -b feat/empty
ctx2="$R/.harness-ceilf6/feat__empty"; mkdir -p "$ctx2"
jq -n '{branch:"feat/empty", base_branch:"master"}' > "$ctx2/meta.json"
MSG=$(mktemp); printf 'x\n' > "$MSG"
check_die "零提交拒绝" '没有可 squash' bash "$SQ" --dir "$ctx2" --message-file "$MSG"
cleanup_repo

echo "== 本地 base 落后时按远程跟踪 ref 求分叉点（不吞上游提交）=="
# 真机成因：worktree 流从 origin/<base> 切分支，本地 base 不参与、必然滞后（实测落后 16 提交）。
# 按本地 base 求 merge-base 会把上游别人的提交压进本分支的单提交里。
R=$(mktemp -d); R=$(cd "$R" && pwd -P)
git -C "$R" init -q -b master
git -C "$R" config user.email t@t
git -C "$R" config user.name t
echo base > "$R/f.txt"; git -C "$R" add .; git -C "$R" commit -qm init
STALE=$(git -C "$R" rev-parse HEAD)
echo up1 >> "$R/f.txt"; git -C "$R" commit -qam 'upstream 1'
echo up2 >> "$R/f.txt"; git -C "$R" commit -qam 'upstream 2'
UPSTREAM=$(git -C "$R" rev-parse HEAD)
git -C "$R" update-ref refs/remotes/origin/master "$UPSTREAM"
git -C "$R" checkout -q -b feat/y "$UPSTREAM"  # 分支从远程 tip 切出（须先离开 master 才能改它）
git -C "$R" branch -f master "$STALE"          # 本地 master 停在两个提交之前
ctx3="$R/.harness-ceilf6/feat__y"; mkdir -p "$ctx3"
jq -n '{branch:"feat/y", base_branch:"master"}' > "$ctx3/meta.json"
echo mine >> "$R/f.txt"; git -C "$R" commit -qam '我的提交'
MSG=$(mktemp); printf 'feat(y): 我的改动\n' > "$MSG"
bash "$SQ" --dir "$ctx3" --message-file "$MSG"
[ "$(git -C "$R" rev-parse HEAD^)" = "$UPSTREAM" ] && ok "父提交是远程 tip" || bad "父提交: $(git -C "$R" rev-parse --short HEAD^)（应为远程 tip ${UPSTREAM}）"
# 直接钉危害：评审员与 MR 看到的是 origin/master...HEAD，父提交挂错会让上游改动混进本次 diff
if git -C "$R" diff origin/master...HEAD | grep -q '^+up'; then bad "MR 视角 diff 混入上游改动"; else ok "MR 视角 diff 只含本人改动"; fi
git -C "$R" merge-base --is-ancestor "$UPSTREAM" HEAD && ok "上游提交仍在历史中" || bad "上游提交被吞"
rm -f "$MSG"
cleanup_repo

echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
