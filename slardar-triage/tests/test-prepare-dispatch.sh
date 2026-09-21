#!/usr/bin/env bash
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
D="$HERE/../scripts/prepare-dispatch.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
MEEGO="https://meego.larkoffice.com/larksuite/story/detail/7374348254"

fixture() {
  T=$(mktemp -d); T=$(cd "$T" && pwd -P)
  export STUB_STATE="$T/stub"; mkdir -p "$STUB_STATE"; : > "$STUB_STATE/calls"
  STATE="$T/state"; mkdir -p "$STATE"; echo '{}' > "$STATE/dispatched.json"
  BOOK="$T/book.md"; printf '交付说明:目标分支为 master(x)。Meego:{{meego_url}}。MR 类型 feature。\n\n# 修复 x\n' > "$BOOK"
  DESC="$T/desc.txt"; echo "desc" > "$DESC"
  export MEEGO_SH="$HERE/stubs/meego.sh"
}
run_prepare() {
  bash "$D" --state "$STATE" --issue-id "${ISSUE:-i1}" --slug avatar-2026-09-08 --task-book "$BOOK" --meego-desc "$DESC" --meego-name "n" --slardar-url "https://slardar.bytedance.net/node/web/data_search?bid=vc_ai&filter_id=f1" "$@"
}

echo "case 1: 准备成功——只建 Meego 与任务书"
fixture
out=$(run_prepare); rc=$?
[ $rc -eq 0 ] && ok "退出 0" || bad "退出 $rc: $out"
[ "$(echo "$out" | jq -r .task_book)" = "$STATE/task-books/avatar-2026-09-08.md" ] && ok "输出 task_book 路径" || bad "task_book 不符: $out"
[ "$(echo "$out" | jq -r .meego_url)" = "$MEEGO" ] && ok "输出 meego_url" || bad "meego_url 不符: $out"
[ "$(echo "$out" | jq -r .reused)" = false ] && ok "reused=false" || bad "reused 不符: $out"
grep -q "meego.sh create --repo lark/byteview-web --title n --description-file $DESC" "$STUB_STATE/calls" && ok "经 bytedcli-meego 机械层建 story" || bad "meego.sh 调用不符: $(cat "$STUB_STATE/calls")"
grep -q "Meego:$MEEGO" "$STATE/task-books/avatar-2026-09-08.md" && ok "任务书 Meego URL 已替换" || bad "任务书未替换"
grep -qv '^meego.sh ' "$STUB_STATE/calls" && bad "调用了 meego.sh 以外的命令: $(grep -v '^meego.sh ' "$STUB_STATE/calls")" || ok "只调用 meego.sh"
node -e "const d=require('$STATE/dispatched.json').i1; process.exit(d.steps.meego==='done' && d.steps.task_book==='done' && d.slug==='avatar-2026-09-08' && d.meego_id==='7374348254' && d.slardar_url.includes('filter_id=f1') && d.task_id===undefined && d.workspace===undefined ? 0 : 1)" && ok "处置账只记准备产物" || bad "处置账不符: $(cat "$STATE/dispatched.json")"

echo "case 2: 幂等——再跑一次不重复建 Meego，reused=true"
n_before=$(grep -c "meego.sh create" "$STUB_STATE/calls")
out=$(run_prepare); rc=$?
n_after=$(grep -c "meego.sh create" "$STUB_STATE/calls")
[ $rc -eq 0 ] && [ "$n_before" = "$n_after" ] && ok "未重复建 Meego" || bad "重复建 Meego 或退出 $rc"
[ "$(echo "$out" | jq -r .reused)" = true ] && ok "reused=true" || bad "reused 不符: $out"

echo "case 3: 有在跑的单则拒绝"
fixture
mkdir -p "$T/other/.omh/tasks/task_running"; echo '{"phase":"running"}' > "$T/other/.omh/tasks/task_running/meta.json"
jq -n --arg ws "$T/other" '{i0:{task_id:"task_running",workspace:$ws}}' > "$STATE/dispatched.json"
out=$(run_prepare); rc=$?
[ $rc -eq 3 ] && ok "退出 3" || bad "退出 $rc: $out"
grep -q "meego.sh create" "$STUB_STATE/calls" && bad "拒绝前已建 Meego" || ok "未建 Meego"

echo "case 4: 在途单到终态后放行"
echo '{"phase":"completed"}' > "$T/other/.omh/tasks/task_running/meta.json"
out=$(run_prepare); rc=$?
[ $rc -eq 0 ] && ok "退出 0" || bad "退出 $rc: $out"

echo "case 5: 断点续跑——Meego 已建，重跑只补任务书"
fixture
echo '{"i1":{"steps":{"meego":"done"},"meego_url":"https://meego.larkoffice.com/larksuite/story/detail/1","meego_id":"1","slug":"avatar-2026-09-08"}}' > "$STATE/dispatched.json"
out=$(run_prepare); rc=$?
[ $rc -eq 0 ] && ok "续跑成功" || bad "续跑退出 $rc: $out"
grep -q "meego.sh create" "$STUB_STATE/calls" && bad "续跑重复建 Meego" || ok "续跑未建 Meego"
grep -q "Meego:https://meego.larkoffice.com/larksuite/story/detail/1。" "$STATE/task-books/avatar-2026-09-08.md" && ok "任务书用已有 Meego" || bad "任务书 Meego 不符"

echo "case 6: 任务书首行缺任一项则失败在 task_book"
for miss in '目标分支为 master(x)。' 'Meego:{{meego_url}}。' 'MR 类型 feature。'; do
  fixture
  line='交付说明:目标分支为 master(x)。Meego:{{meego_url}}。MR 类型 feature。'
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
printf '交付说明:目标分支为 master(x)。Meego:{{meego_url}}。\n' > "$BOOK"
out=$(ISSUE='i"1' run_prepare); rc=$?
[ $rc -eq 1 ] && echo "$out" | jq -e '.issue_id == "i\"1" and .step == "task_book"' >/dev/null && ok "合法 JSON 且字段正确" || bad "rc=$rc $out"

echo "pass=$PASS fail=$FAIL"
[ $FAIL -eq 0 ]
