#!/usr/bin/env bash
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
D="$HERE/../scripts/prepare-dispatch.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
ticket-platform="<internal-url>"

fixture() {
  T=$(mktemp -d); T=$(cd "$T" && pwd -P)
  export STUB_STATE="$T/stub"; mkdir -p "$STUB_STATE"; : > "$STUB_STATE/calls"
  STATE="$T/state"; mkdir -p "$STATE"; echo '{}' > "$STATE/dispatched.json"
  BOOK="$T/book.md"; printf '交付说明:目标分支为 master(x)。ticket-platform:{{ticket-platform_url}}。MR 类型 feature。\n\n# 修复 x\n' > "$BOOK"
  DESC="$T/desc.txt"; echo "desc" > "$DESC"
  export ticket-platform_SH="$HERE/stubs/ticket-platform.sh"
}
run_prepare() {
  bash "$D" --state "$STATE" --issue-id "${ISSUE:-i1}" --slug avatar-2026-09-08 --task-book "$BOOK" --ticket-platform-desc "$DESC" --ticket-platform-name "n" --web-monitor-url "<internal-url>" "$@"
}

echo "case 1: 准备成功——只建 ticket-platform 与任务书"
fixture
out=$(run_prepare); rc=$?
[ $rc -eq 0 ] && ok "退出 0" || bad "退出 $rc: $out"
[ "$(echo "$out" | jq -r .task_book)" = "$STATE/task-books/avatar-2026-09-08.md" ] && ok "输出 task_book 路径" || bad "task_book 不符: $out"
[ "$(echo "$out" | jq -r .ticket-platform_url)" = "$ticket-platform" ] && ok "输出 ticket-platform_url" || bad "ticket-platform_url 不符: $out"
[ "$(echo "$out" | jq -r .reused)" = false ] && ok "reused=false" || bad "reused 不符: $out"
grep -q "ticket-platform.sh create --repo lark/biz-vc-web --title n --description-file $DESC" "$STUB_STATE/calls" && ok "经 internal-cli-ticket 机械层建 story" || bad "ticket-platform.sh 调用不符: $(cat "$STUB_STATE/calls")"
grep -q "ticket-platform:$ticket-platform" "$STATE/task-books/avatar-2026-09-08.md" && ok "任务书 ticket-platform URL 已替换" || bad "任务书未替换"
grep -qv '^ticket-platform.sh ' "$STUB_STATE/calls" && bad "调用了 ticket-platform.sh 以外的命令: $(grep -v '^ticket-platform.sh ' "$STUB_STATE/calls")" || ok "只调用 ticket-platform.sh"
node -e "const d=require('$STATE/dispatched.json').i1; process.exit(d.steps.ticket-platform==='done' && d.steps.task_book==='done' && d.slug==='avatar-2026-09-08' && d.ticket-platform_id==='7374348254' && d.web-monitor_url.includes('filter_id=f1') && d.task_id===undefined && d.workspace===undefined ? 0 : 1)" && ok "处置账只记准备产物" || bad "处置账不符: $(cat "$STATE/dispatched.json")"

echo "case 1b: --ticket-platform-repo 指定建到 biz-vc-pc 的 ticket-platform 映射"
fixture
out=$(run_prepare --ticket-platform-repo ee/biz-vc-pc); rc=$?
[ $rc -eq 0 ] && ok "退出 0" || bad "退出 $rc: $out"
grep -q "ticket-platform.sh create --repo ee/biz-vc-pc --title n" "$STUB_STATE/calls" && ok "ticket-platform.sh 用 ee/biz-vc-pc" || bad "ticket-platform.sh 调用不符: $(cat "$STUB_STATE/calls")"

echo "case 2: 幂等——再跑一次不重复建 ticket-platform，reused=true"
n_before=$(grep -c "ticket-platform.sh create" "$STUB_STATE/calls")
out=$(run_prepare); rc=$?
n_after=$(grep -c "ticket-platform.sh create" "$STUB_STATE/calls")
[ $rc -eq 0 ] && [ "$n_before" = "$n_after" ] && ok "未重复建 ticket-platform" || bad "重复建 ticket-platform 或退出 $rc"
[ "$(echo "$out" | jq -r .reused)" = true ] && ok "reused=true" || bad "reused 不符: $out"

echo "case 3: 有在跑的单则拒绝"
fixture
mkdir -p "$T/other/.omh/tasks/task_running"; echo '{"phase":"running"}' > "$T/other/.omh/tasks/task_running/meta.json"
jq -n --arg ws "$T/other" '{i0:{task_id:"task_running",workspace:$ws}}' > "$STATE/dispatched.json"
out=$(run_prepare); rc=$?
[ $rc -eq 3 ] && ok "退出 3" || bad "退出 $rc: $out"
grep -q "ticket-platform.sh create" "$STUB_STATE/calls" && bad "拒绝前已建 ticket-platform" || ok "未建 ticket-platform"

echo "case 4: 在途单到终态后放行"
echo '{"phase":"completed"}' > "$T/other/.omh/tasks/task_running/meta.json"
out=$(run_prepare); rc=$?
[ $rc -eq 0 ] && ok "退出 0" || bad "退出 $rc: $out"

echo "case 5: 断点续跑——ticket-platform 已建，重跑只补任务书"
fixture
echo '{"i1":{"steps":{"ticket-platform":"done"},"ticket-platform_url":"<internal-url>","ticket-platform_id":"1","slug":"avatar-2026-09-08"}}' > "$STATE/dispatched.json"
out=$(run_prepare); rc=$?
[ $rc -eq 0 ] && ok "续跑成功" || bad "续跑退出 $rc: $out"
grep -q "ticket-platform.sh create" "$STUB_STATE/calls" && bad "续跑重复建 ticket-platform" || ok "续跑未建 ticket-platform"
grep -q "ticket-platform:<internal-url>" "$STATE/task-books/avatar-2026-09-08.md" && ok "任务书用已有 ticket-platform" || bad "任务书 ticket-platform 不符"

echo "case 6: 任务书首行缺任一项则失败在 task_book"
for miss in '目标分支为 master(x)。' 'ticket-platform:{{ticket-platform_url}}。' 'MR 类型 feature。'; do
  fixture
  line='交付说明:目标分支为 master(x)。ticket-platform:{{ticket-platform_url}}。MR 类型 feature。'
  printf '%s\n\n# 修复 x\n' "${line/"$miss"/}" > "$BOOK"
  out=$(run_prepare); rc=$?
  [ $rc -eq 1 ] && [ "$(echo "$out" | jq -r .step)" = task_book ] && ok "缺「${miss}」→ task_book 失败" || bad "缺「${miss}」未拦截: rc=$rc $out"
done

echo "case 7: 缺必填参数"
fixture
out=$(bash "$D" --state "$STATE" --issue-id i1); rc=$?
[ $rc -eq 1 ] && echo "$out" | jq -e '.ok == false and (.error | test("缺少 --slug"))' >/dev/null && ok "报缺 --slug 且是合法 JSON" || bad "rc=$rc $out"

echo "case 8: issue_id 含引号时错误输出仍是一行合法 JSON"
fixture
printf '交付说明:目标分支为 master(x)。ticket-platform:{{ticket-platform_url}}。\n' > "$BOOK"
out=$(ISSUE='i"1' run_prepare); rc=$?
[ $rc -eq 1 ] && echo "$out" | jq -e '.issue_id == "i\"1" and .step == "task_book"' >/dev/null && ok "合法 JSON 且字段正确" || bad "rc=$rc $out"

echo "pass=$PASS fail=$FAIL"
[ $FAIL -eq 0 ]
