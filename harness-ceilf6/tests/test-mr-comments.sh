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
# iid 是字符串：消费方一路当 CLI 参数用，数字化会在 -R 后面拼出别的东西
printf '%s' "$snap" | jq -e '.iid == "1678"' >/dev/null && ok "iid 保持字符串" || bad "iid: $(printf '%s' "$snap" | jq -c '.iid')"
grep -q 'comment list -R lark/byteview-web 1678' "$STUB_STATE/calls.log" && ok "comment list 带上 repo/iid" || bad "comment list 参数: $(grep 'comment list' "$STUB_STATE/calls.log")"
# 二拉（水位未 mark）：new 仍在——fetch 只读水位
snap2=$(bash "$MC" fetch --ctx-dir "$ctx")
[ "$(printf '%s' "$snap2" | jq '.new | length')" = 1 ] && ok "fetch 不推水位" || bad "fetch 推了水位"
[ "$(grep -c 'code-review gitlab' "$STUB_STATE/calls.log")" = 1 ] && ok "repo/iid 只解析一次" || bad "gitlab 解析次数: $(grep -c 'code-review gitlab' "$STUB_STATE/calls.log")"
cleanup

echo "== meta.mr_id 变更（MR 重建）：重置 repo/iid 与线程水位 =="
make_fixture
std_comments
bash "$MC" fetch --ctx-dir "$ctx" >/dev/null
# 手工推一次水位（mark 是 Task 2 的活），模拟 t1 已被处理过
jq '.threads = {"t1":{reply_count:1, handled:"fixed"}}' "$ctx/mr-comments.json" > "$ctx/tmp" && mv "$ctx/tmp" "$ctx/mr-comments.json"
snap=$(bash "$MC" fetch --ctx-dir "$ctx")
[ "$(printf '%s' "$snap" | jq '.new | length')" = 0 ] && ok "水位内的线程不再算 new" || bad "new: $(printf '%s' "$snap" | jq -c '.new')"
jq '.mr_id = "9000001"' "$ctx/meta.json" > "$ctx/tmp" && mv "$ctx/tmp" "$ctx/meta.json"
snap=$(bash "$MC" fetch --ctx-dir "$ctx")
[ "$(grep -c 'code-review gitlab' "$STUB_STATE/calls.log")" = 2 ] && ok "换 MR 后重解析 repo/iid" || bad "gitlab 解析次数: $(grep -c 'code-review gitlab' "$STUB_STATE/calls.log")"
[ "$(jq -r '.mr_id' "$ctx/mr-comments.json")" = 9000001 ] && ok "水位 mr_id 跟着换" || bad "水位 mr_id: $(jq -r '.mr_id' "$ctx/mr-comments.json")"
[ "$(printf '%s' "$snap" | jq '.new | length')" = 1 ] && ok "换 MR 后线程水位清零" || bad "new: $(printf '%s' "$snap" | jq -c '.new')"
cleanup

echo "== 拉取失败：exit 4 计连败；status=merged 时转 closed =="
make_fixture
std_comments
touch "$STUB_STATE/list_fail"
jq -n '{state:"opened"}' > "$STUB_STATE/status.json"
rc=0; err=$(bash "$MC" fetch --ctx-dir "$ctx" 2>&1 >/dev/null) || rc=$?
[ "$rc" = 4 ] && ok "拉取失败 exit 4" || bad "exit $rc"
[ "$(jq '.consecutive_failures' "$ctx/mr-comments.json")" = 1 ] && ok "连败 +1" || bad "连败: $(jq '.consecutive_failures' "$ctx/mr-comments.json")"
# 无人值守时这行诊断是唯一现场：bytedcli 说了什么必须带出来
case "$err" in *"list failed"*) ok "诊断带上 bytedcli stderr" ;; *) bad "诊断丢了 stderr：${err}" ;; esac
jq -n '{state:"merged"}' > "$STUB_STATE/status.json"
out=$(bash "$MC" fetch --ctx-dir "$ctx")
[ "$(printf '%s' "$out" | jq '.closed')" = true ] && ok "merged → closed 快照" || bad "closed 快照"
[ "$(jq '.closed' "$ctx/mr-comments.json")" = true ] && ok "closed 落水位" || bad "closed 未落水位"
cleanup

echo "== bytedcli 吐非 JSON（鉴权过期横幅）：三条路径都守住 exit 4 与连败 =="
# gitlab 解析
make_fixture
std_comments
printf 'ERROR: token expired, run bytedcli login\n' > "$STUB_STATE/gitlab.json"
rc=0; err=$(bash "$MC" fetch --ctx-dir "$ctx" 2>&1 >/dev/null) || rc=$?
[ "$rc" = 4 ] && ok "gitlab 非 JSON exit 4" || bad "exit $rc"
[ "$(jq '.consecutive_failures' "$ctx/mr-comments.json")" = 1 ] && ok "gitlab 非 JSON 计连败" || bad "连败: $(jq '.consecutive_failures' "$ctx/mr-comments.json")"
case "$err" in *"token expired"*) ok "诊断带上原文" ;; *) bad "诊断无原文：${err}" ;; esac
cleanup
# comment list 输出
make_fixture
printf 'ERROR: token expired\n' > "$STUB_STATE/comments.json"
rc=0; bash "$MC" fetch --ctx-dir "$ctx" >/dev/null 2>&1 || rc=$?
[ "$rc" = 4 ] && ok "comment list 非 JSON exit 4" || bad "exit $rc"
[ "$(jq '.consecutive_failures' "$ctx/mr-comments.json")" = 1 ] && ok "comment list 非 JSON 计连败" || bad "连败: $(jq '.consecutive_failures' "$ctx/mr-comments.json")"
cleanup
# mr status 探测
make_fixture
std_comments
touch "$STUB_STATE/list_fail"
printf 'ERROR: token expired\n' > "$STUB_STATE/status.json"
rc=0; bash "$MC" fetch --ctx-dir "$ctx" >/dev/null 2>&1 || rc=$?
[ "$rc" = 4 ] && ok "status 非 JSON 仍 exit 4" || bad "exit $rc"
[ "$(jq '.consecutive_failures' "$ctx/mr-comments.json")" = 1 ] && ok "status 非 JSON 计连败" || bad "连败: $(jq '.consecutive_failures' "$ctx/mr-comments.json")"
[ "$(jq '.closed' "$ctx/mr-comments.json")" = false ] && ok "状态不可解析不误判 closed" || bad "误判 closed"
cleanup

echo "== mark：推进水位、count-trigger、幂等 =="
make_fixture
std_comments
bash "$MC" fetch --ctx-dir "$ctx" > "$R/snap.json"
# mark 按 .threads 全量推水位（不只是 new），少一条就会让已读线程重新触发
[ "$(jq '.threads | length' "$R/snap.json")" = 3 ] && ok "快照带全量线程" || bad "threads: $(jq -c '.threads' "$R/snap.json")"
[ "$(jq '.closed' "$R/snap.json")" = false ] && ok "正常路径 closed=false" || bad "closed: $(jq -c '.closed' "$R/snap.json")"
bash "$MC" mark --ctx-dir "$ctx" --from-snapshot "$R/snap.json" --count-trigger >/dev/null
[ "$(jq '.threads.t1.reply_count' "$ctx/mr-comments.json")" = 1 ] && ok "reply_count 推进" || bad "reply_count"
[ "$(jq -r '.threads.t1.triggered_at' "$ctx/mr-comments.json")" != null ] && ok "new 线程落 triggered_at" || bad "triggered_at"
[ "$(jq '.trigger_count' "$ctx/mr-comments.json")" = 1 ] && ok "count-trigger 计数" || bad "trigger_count"
# 已解决/本人的线程也要记 reply_count，否则别人后续回复时会把本人旧评论一起当增量推给模型
[ "$(jq '.threads | length' "$ctx/mr-comments.json")" = 3 ] && ok "水位覆盖快照全量线程" || bad "水位线程: $(jq -c '.threads | keys' "$ctx/mr-comments.json")"
snap2=$(bash "$MC" fetch --ctx-dir "$ctx")
[ "$(printf '%s' "$snap2" | jq '.new | length')" = 0 ] && ok "mark 后 new 清空" || bad "mark 未生效"
bash "$MC" mark --ctx-dir "$ctx" --from-snapshot "$R/snap.json" >/dev/null
[ "$(jq '.trigger_count' "$ctx/mr-comments.json")" = 1 ] && ok "无 --count-trigger 不计配额" || bad "配额误计"

echo "== 回复增长：只有增量进 new；loop_suspect 依赖 handled =="
bash "$MC" reply --ctx-dir "$ctx" --thread t1 --message-file <(printf '已修复：改为判空后再取值') --handled fixed >/dev/null
grep -q -- '-m 【bot】已修复' "$STUB_STATE/calls.log" && ok "reply 自动加【bot】前缀" || bad "前缀缺失"
[ "$(jq -r '.threads.t1.handled' "$ctx/mr-comments.json")" = fixed ] && ok "handled 落位" || bad "handled"
jq '.threads[0].comments += [{author:{username:"cr-bot"}, body:"回复收到，另外这里还有一处"}]' \
  "$STUB_STATE/comments.json" > "$STUB_STATE/tmp" && mv "$STUB_STATE/tmp" "$STUB_STATE/comments.json"
snap3=$(bash "$MC" fetch --ctx-dir "$ctx")
[ "$(printf '%s' "$snap3" | jq '.new[0].new_replies | length')" = 1 ] && ok "只含增量回复" || bad "增量: $(printf '%s' "$snap3" | jq -c '.new[0]')"
[ "$(printf '%s' "$snap3" | jq '.loop_suspect')" = true ] && ok "已处置线程再评 → loop_suspect" || bad "loop_suspect"

echo "== reply 带前缀不重复加；失败不落 handled =="
bash "$MC" reply --ctx-dir "$ctx" --thread t1 --message-file <(printf '【bot】补充说明') >/dev/null
grep -q -- '-m 【bot】补充说明' "$STUB_STATE/calls.log" && ok "已带前缀原样发出" || bad "前缀重复"
grep -q -- '-m 【bot】【bot】' "$STUB_STATE/calls.log" && bad "前缀被叠加" || ok "无叠加前缀"
touch "$STUB_STATE/reply_fail"
rc=0; bash "$MC" reply --ctx-dir "$ctx" --thread t3 --message-file <(printf 'x') --handled rejected >/dev/null 2>&1 || rc=$?
[ "$rc" != 0 ] && ok "回复失败非零退出" || bad "失败被吞"
[ "$(jq -r '.threads.t3.handled // "null"' "$ctx/mr-comments.json")" = null ] && ok "失败不落 handled" || bad "handled 误落"
rm -f "$STUB_STATE/reply_fail"

echo "== enable / disable =="
bash "$MC" disable --ctx-dir "$ctx" >/dev/null
[ "$(jq '.auto_disabled' "$ctx/mr-comments.json")" = true ] && ok "disable" || bad "disable"
bash "$MC" enable --ctx-dir "$ctx" >/dev/null
[ "$(jq '.auto_disabled' "$ctx/mr-comments.json")" = false ] && ok "enable 复位" || bad "enable"
[ "$(jq '.trigger_count' "$ctx/mr-comments.json")" = 0 ] && ok "enable 清配额" || bad "trigger_count 未清"

echo "== mark 守卫：closed / 损坏 / 串 MR 的快照都不进水位 =="
jq -n '{mr_id:"8288090", closed:true}' > "$R/closed.json"
rc=0; err=$(bash "$MC" mark --ctx-dir "$ctx" --from-snapshot "$R/closed.json" 2>&1 >/dev/null) || rc=$?
[ "$rc" != 0 ] && ok "closed 快照非零退出" || bad "closed 快照被吞"
case "$err" in *"closed 形态"*) ok "closed 快照文案点明形态" ;; *) bad "closed 文案：${err}" ;; esac
jq -n '{mr_id:"8288090", closed:false, threads:null, new:null}' > "$R/shape.json"
rc=0; err=$(bash "$MC" mark --ctx-dir "$ctx" --from-snapshot "$R/shape.json" 2>&1 >/dev/null) || rc=$?
[ "$rc" != 0 ] && ok "threads/new 非数组非零退出" || bad "坏形状被吞"
case "$err" in *"$R/shape.json"*) ok "坏形状诊断指向快照文件" ;; *) bad "诊断未指快照：${err}" ;; esac
printf '{"mr_id":"8288090","threads":' > "$R/trunc.json"
rc=0; err=$(bash "$MC" mark --ctx-dir "$ctx" --from-snapshot "$R/trunc.json" 2>&1 >/dev/null) || rc=$?
[ "$rc" != 0 ] && ok "截断快照非零退出" || bad "截断快照被吞"
case "$err" in *"不是合法 JSON"*"$R/trunc.json"*) ok "截断快照诊断指向快照文件" ;; *) bad "诊断未指快照：${err}" ;; esac
# 换 MR 后误喂旧快照：脚本的 MR 重建防护刚把 threads 清空，mark 不能把它填回去
jq '.mr_id = "9000001"' "$ctx/meta.json" > "$ctx/tmp" && mv "$ctx/tmp" "$ctx/meta.json"
bash "$MC" fetch --ctx-dir "$ctx" >/dev/null
rc=0; err=$(bash "$MC" mark --ctx-dir "$ctx" --from-snapshot "$R/snap.json" 2>&1 >/dev/null) || rc=$?
[ "$rc" != 0 ] && ok "旧 MR 快照非零退出" || bad "串 MR 快照被吃下"
case "$err" in *8288090*9000001*) ok "文案点名快照/水位两侧 MR" ;; *) bad "文案：${err}" ;; esac
[ "$(jq '.threads | length' "$ctx/mr-comments.json")" = 0 ] && ok "串 MR 快照不污染水位" || bad "水位被污染: $(jq -c '.threads' "$ctx/mr-comments.json")"
# 缺 mr_id 的快照按同源放行：这条守的是喂错 MR，不是快照字段缺失
jq 'del(.mr_id)' "$R/snap.json" > "$R/nomr.json"
rc=0; bash "$MC" mark --ctx-dir "$ctx" --from-snapshot "$R/nomr.json" >/dev/null 2>&1 || rc=$?
[ "$rc" = 0 ] && ok "缺 mr_id 的快照不误伤" || bad "无 mr_id 快照被拒 (rc=$rc)"
cleanup

echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
