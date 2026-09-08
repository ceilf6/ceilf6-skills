#!/usr/bin/env bash
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
D="$HERE/../scripts/dispatch.sh"
export PATH="$HERE/stubs:$PATH"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

fixture() {
  T=$(mktemp -d); T=$(cd "$T" && pwd -P)
  export STUB_STATE="$T/stub"; mkdir -p "$STUB_STATE"
  REPO="$T/byteview-web"; mkdir -p "$REPO/node_modules/.pnpm/a" "$REPO/node_modules/.pnpm/b"
  /usr/bin/git -C "$T" init -q "$REPO" >/dev/null 2>&1 || true
  STATE="$T/state"; mkdir -p "$STATE"; echo '{}' > "$STATE/dispatched.json"; echo '[]' > "$STATE/queue.json"; echo '{}' > "$STATE/skipped.json"
  BOOK="$T/book.md"; printf '交付说明:目标分支为 master(x)。Meego issue:{{meego_url}}。MR 类型 bug。\n\n# 修复 x\n' > "$BOOK"
  DESC="$T/desc.txt"; echo "desc" > "$DESC"
  RUNS="$T/runs"
  export TASK_WAIT_SECONDS=5
}
run_dispatch() {
  bash "$D" --state "$STATE" --issue-id i1 --slug avatar-2026-09-08 --task-book "$BOOK" --meego-desc "$DESC" --meego-name "n" --os iOS --release 7.76.0.234 --repo "$REPO" --runs-root "$RUNS"
}

echo "case 1: 全流程成功"
fixture
out=$(run_dispatch); rc=$?
[ $rc -eq 0 ] && ok "退出 0" || bad "退出 $rc: $out"
echo "$out" | grep -q '"task_id":"task_stub"' && ok "输出 task_id" || bad "无 task_id: $out"
grep -q "workitem create" "$STUB_STATE/calls" && ok "建了 Meego" || bad "未建 Meego"
grep -q 'field_2f21a0","field_value":"\[{\\"option_id\\":\\"c0dd860ab\\"}\]"' "$STUB_STATE/calls" && ok "发现版本映射 7.76" || bad "发现版本未映射: $(grep create "$STUB_STATE/calls")"
grep -q "Meego issue:https://meego.larkoffice.com/larksuite/issue/detail/7374348254" "$RUNS/tasks/avatar-2026-09-08.md" && ok "任务书 Meego URL 已替换为 larksuite 形态" || bad "任务书未替换"
grep -q "traecli exec" "$STUB_STATE/calls" && ok "经 traecli 起 omh" || bad "未起 traecli"
node -e "const d=require('$STATE/dispatched.json'); process.exit(d.i1 && d.i1.task_id==='task_stub' && d.i1.steps.verify==='done' ? 0 : 1)" && ok "state 落账" || bad "state 未落账"

echo "case 2: 幂等——再跑一次不重复建 Meego"
n_before=$(grep -c "workitem create" "$STUB_STATE/calls")
out=$(run_dispatch); rc=$?
n_after=$(grep -c "workitem create" "$STUB_STATE/calls")
[ $rc -eq 0 ] && [ "$n_before" = "$n_after" ] && ok "未重复建 Meego" || bad "重复建 Meego 或退出 $rc"

echo "case 3: 有在跑的单则拒绝"
fixture
mkdir -p "$RUNS/other/.omh/tasks/task_running"; echo '{"phase":"running"}' > "$RUNS/other/.omh/tasks/task_running/meta.json"
echo '{"i0":{"task_id":"task_running","workspace":"'"$RUNS/other"'","steps":{"verify":"done"}}}' > "$STATE/dispatched.json"
out=$(run_dispatch); rc=$?
[ $rc -eq 3 ] && ok "退出 3" || bad "退出 $rc: $out"

echo "case 4: runtime 不是 traecli 则 cancel 并退出 4"
fixture
export STUB_RUNTIME=claude
out=$(run_dispatch); rc=$?
[ $rc -eq 4 ] && ok "退出 4" || bad "退出 $rc: $out"
grep -q "task-cancel" "$STUB_STATE/calls" && ok "已 cancel" || bad "未 cancel"
unset STUB_RUNTIME

echo "case 5: 断点续跑——Meego 已建、worktree 失败后重跑从 worktree 继续"
fixture
echo '{"i1":{"steps":{"meego":"done"},"meego_url":"https://meego.larkoffice.com/larksuite/issue/detail/1","meego_id":"1","slug":"avatar-2026-09-08"}}' > "$STATE/dispatched.json"
out=$(run_dispatch); rc=$?
[ $rc -eq 0 ] && ok "续跑成功" || bad "续跑退出 $rc: $out"
grep -q "workitem create" "$STUB_STATE/calls" && bad "续跑重复建 Meego" || ok "续跑未建 Meego"

echo "pass=$PASS fail=$FAIL"
[ $FAIL -eq 0 ]
