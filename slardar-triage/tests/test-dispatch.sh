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
  export THREADS_SH="$HERE/stubs/threads.sh"; export CLAUDE_CODE_SESSION_ID=sess-test
}
run_dispatch() {
  bash "$D" --state "$STATE" --issue-id i1 --slug avatar-2026-09-08 --task-book "$BOOK" --meego-desc "$DESC" --meego-name "n" --os iOS --release 7.76.0.234 --repo "$REPO" --runs-root "$RUNS" "$@"
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
echo "$out" | grep -q '"board":{"ok":true' && ok "board 登记成功" || bad "board 未登记: $out"
grep -q "threads.sh register --ctx-dir $RUNS/avatar-2026-09-08/.harness-ceilf6/avatar-2026-09-08 --title n PWD=$(pwd -P)" "$STUB_STATE/calls" && ok "register 在调用者 cwd 下执行且参数正确" || bad "register 调用不符: $(grep threads "$STUB_STATE/calls")"
EXP_BRANCH=$(git symbolic-ref --short -q HEAD 2>/dev/null || echo omh-base/avatar-2026-09-08)
node -e "const m=require('$RUNS/avatar-2026-09-08/.harness-ceilf6/avatar-2026-09-08/meta.json'); process.exit(m.branch==='$EXP_BRANCH' && m.status==='active' && /Meego .*Task task_stub/.test(m.note) && JSON.stringify(m.milestones)==='{}' ? 0 : 1)" && ok "meta.json 形状正确" || bad "meta.json 形状不符"
node -e "const d=require('$STATE/dispatched.json'); process.exit(d.i1.steps.board==='done' && d.i1.board.ok===true ? 0 : 1)" && ok "steps.board 落账" || bad "steps.board 未落账"

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

echo "case 6: threads.sh 不存在时派发仍成功，board.ok=false"
fixture
export THREADS_SH="$T/nope/threads.sh"
out=$(run_dispatch); rc=$?
[ $rc -eq 0 ] && ok "退出 0" || bad "退出 $rc: $out"
echo "$out" | grep -q '"board":{"ok":false' && ok "board.ok=false" || bad "board 未标失败: $out"
node -e "const d=require('$STATE/dispatched.json'); process.exit(d.i1.steps.board===undefined && d.i1.board.ok===false ? 0 : 1)" && ok "steps.board 未写、board 记错误" || bad "失败落账不符"

echo "case 7: --no-board 跳过登记"
fixture
out=$(run_dispatch --no-board); rc=$?
[ $rc -eq 0 ] && ok "退出 0" || bad "退出 $rc: $out"
grep -q "threads.sh register" "$STUB_STATE/calls" && bad "仍调用了 register" || ok "未调用 register"
echo "$out" | grep -q '"board":{"ok":false,"skipped":true' && ok "board 标 skipped" || bad "board 未标 skipped: $out"

echo "pass=$PASS fail=$FAIL"
[ $FAIL -eq 0 ]
