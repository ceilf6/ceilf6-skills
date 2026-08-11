#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
MC="$HERE/../scripts/mr-comments.sh"
export PATH="$HERE/stubs:$PATH"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

# fixture：R/.harness-ceilf6/feat__x 两层 ctx（脚本按 ctx/../.. 找仓根读 git user.name）
make_fixture() {
  R=$(mktemp -d); R=$(cd "$R" && pwd -P)
  git -C "$R" init -q -b master
  git -C "$R" config user.email t@t
  git -C "$R" config user.name me-user
  ctx="$R/.harness-ceilf6/feat__x"; mkdir -p "$ctx"
  jq -n '{branch:"feat/x", base_branch:"master", mr_id:"8288090"}' > "$ctx/meta.json"
  export STUB_STATE="$R/stub-state"; mkdir -p "$STUB_STATE"
  jq -n '{project_path:"lark/byteview-web", iid:1678}' > "$STUB_STATE/gitlab.json"
}
cleanup() { rm -rf "$R" 2>/dev/null || { sleep 1; rm -rf "$R"; }; }

# 标准评论现场：t1 未 resolve 有机器人评论；t2 已 resolve；t3 未 resolve 只有本人评论
std_comments() {
  jq -n '{threads:[
    {id:"t1", resolved:false, comments:[{author:{username:"cr-bot"}, body:"这里有空指针风险"}]},
    {id:"t2", resolved:true,  comments:[{author:{username:"cr-bot"}, body:"已解决的旧问题"}]},
    {id:"t3", resolved:false, comments:[{author:{username:"me-user"}, body:"自己留的备忘"}]}
  ]}' > "$STUB_STATE/comments.json"
}

echo "== 无 mr_id：exit 3 =="
make_fixture
jq 'del(.mr_id)' "$ctx/meta.json" > "$ctx/tmp" && mv "$ctx/tmp" "$ctx/meta.json"
rc=0; bash "$MC" fetch --ctx-dir "$ctx" >/dev/null 2>&1 || rc=$?
[ "$rc" = 3 ] && ok "无 MR exit 3" || bad "exit $rc"
cleanup

echo "== 首拉：缓存 repo/iid、new 判定、水位初始化 =="
make_fixture
std_comments
snap=$(bash "$MC" fetch --ctx-dir "$ctx")
[ "$(printf '%s' "$snap" | jq -r '.repo')" = "lark/byteview-web" ] && ok "repo 解析" || bad "repo: $(printf '%s' "$snap" | jq -r '.repo')"
[ "$(jq -r '.repo' "$ctx/mr-comments.json")" = "lark/byteview-web" ] && ok "repo 缓存落水位" || bad "repo 未缓存"
[ "$(printf '%s' "$snap" | jq '.new | length')" = 1 ] && ok "new 只含 t1" || bad "new: $(printf '%s' "$snap" | jq -c '.new')"
[ "$(printf '%s' "$snap" | jq -r '.new[0].id')" = t1 ] && ok "resolved(t2)/本人(t3) 被滤" || bad "new[0]: $(printf '%s' "$snap" | jq -c '.new[0]')"
[ "$(printf '%s' "$snap" | jq '.loop_suspect')" = false ] && ok "loop_suspect=false" || bad "loop_suspect"
[ "$(jq '.consecutive_failures' "$ctx/mr-comments.json")" = 0 ] && ok "连败清零" || bad "连败计数"
# 二拉（水位未 mark）：new 仍在——fetch 只读水位
snap2=$(bash "$MC" fetch --ctx-dir "$ctx")
[ "$(printf '%s' "$snap2" | jq '.new | length')" = 1 ] && ok "fetch 不推水位" || bad "fetch 推了水位"
cleanup

echo "== 拉取失败：exit 4 计连败；status=merged 时转 closed =="
make_fixture
std_comments
touch "$STUB_STATE/list_fail"
jq -n '{state:"opened"}' > "$STUB_STATE/status.json"
rc=0; bash "$MC" fetch --ctx-dir "$ctx" >/dev/null 2>&1 || rc=$?
[ "$rc" = 4 ] && ok "拉取失败 exit 4" || bad "exit $rc"
[ "$(jq '.consecutive_failures' "$ctx/mr-comments.json")" = 1 ] && ok "连败 +1" || bad "连败: $(jq '.consecutive_failures' "$ctx/mr-comments.json")"
jq -n '{state:"merged"}' > "$STUB_STATE/status.json"
out=$(bash "$MC" fetch --ctx-dir "$ctx")
[ "$(printf '%s' "$out" | jq '.closed')" = true ] && ok "merged → closed 快照" || bad "closed 快照"
[ "$(jq '.closed' "$ctx/mr-comments.json")" = true ] && ok "closed 落水位" || bad "closed 未落水位"
cleanup

echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
