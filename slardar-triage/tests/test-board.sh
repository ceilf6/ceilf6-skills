#!/usr/bin/env bash
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
B="$HERE/../scripts/board.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
SLARDAR="https://slardar.bytedance.net/node/web/data_search?bid=vc_ai&filter_id=f1"
MEEGO="https://meego.larkoffice.com/larksuite/story/detail/7374348254"

fixture() {
  T=$(mktemp -d); T=$(cd "$T" && pwd -P)
  export STUB_STATE="$T/stub"; mkdir -p "$STUB_STATE"; : > "$STUB_STATE/calls"
  STATE="$T/state"; mkdir -p "$STATE"
  WS="$T/harness/workspaces/tasks/avatar-2026-09-08/byteview-web"; mkdir -p "$WS"
  CTX="$STATE/board/avatar-2026-09-08"
  jq -n --arg ws "$WS" --arg mu "$MEEGO" --arg su "$SLARDAR" \
    '{i1:{slug:"avatar-2026-09-08",workspace:$ws,task_id:"task_stub",meego_id:"7374348254",meego_url:$mu,meego_name:"n",slardar_url:$su}}' > "$STATE/dispatched.json"
  export THREADS_SH="$HERE/stubs/threads.sh"; export CLAUDE_CODE_SESSION_ID=sess-test
}

echo "case 1: 登记成功，ctx 落在 state 目录下"
fixture
out=$(bash "$B" --state "$STATE" --issue-id i1)
echo "$out" | grep -q '"ok":true' && ok "ok=true" || bad "失败: $out"
grep -q "threads.sh register --ctx-dir $CTX --title n PWD=$(pwd -P)" "$STUB_STATE/calls" && ok "register 在调用者 cwd 下执行、title 取 meego_name" || bad "register 调用不符: $(cat "$STUB_STATE/calls")"
EXP_BRANCH=$(git symbolic-ref --short -q HEAD 2>/dev/null || echo feat-avatar-2026-09-08)
node -e "const m=require('$CTX/meta.json'); process.exit(m.branch==='$EXP_BRANCH' && m.status==='active' && JSON.stringify(m.milestones)==='{}' ? 0 : 1)" && ok "meta 形状正确" || bad "meta 形状不符: $(cat "$CTX/meta.json")"
node -e "const m=require('$CTX/meta.json'); process.exit(m.meego_id==='7374348254' && m.meego_type==='story' && m.meego_url==='$MEEGO' ? 0 : 1)" && ok "meta 带 Meego 绑定" || bad "meta 缺 Meego 绑定"
node -e "const m=require('$CTX/meta.json'); process.exit(m.slardar_url==='$SLARDAR' && m.note==='Slardar $SLARDAR · Meego $MEEGO · Task task_stub' ? 0 : 1)" && ok "备注按 Slardar · Meego · Task 排列" || bad "备注不符: $(cat "$CTX/meta.json")"
node -e "const d=require('$STATE/dispatched.json'); process.exit(d.i1.steps.board==='done' && d.i1.board.ok===true ? 0 : 1)" && ok "steps.board 落账" || bad "steps.board 未落账"
[ ! -e "$WS/.harness-ceilf6" ] && ok "不往 worktree 里写文件" || bad "worktree 被写入"

echo "case 2: 补登记回填 mr_id，保留既有 status / milestones"
node -e "const fs=require('fs');const p='$CTX/meta.json';const m=JSON.parse(fs.readFileSync(p));m.status='done';m.milestones={plan_gate:'x'};fs.writeFileSync(p,JSON.stringify(m))"
out=$(bash "$B" --state "$STATE" --issue-id i1 --mr-id 8405910 --session-id sess-b)
echo "$out" | grep -q '"ok":true' && ok "ok=true" || bad "失败: $out"
grep -q "register --ctx-dir $CTX --title n --session-id sess-b" "$STUB_STATE/calls" && ok "透传 session-id" || bad "参数不符: $(tail -1 "$STUB_STATE/calls")"
node -e "const m=require('$CTX/meta.json'); process.exit(m.mr_id==='8405910' && m.status==='done' && m.milestones.plan_gate==='x' && m.meego_id==='7374348254' ? 0 : 1)" && ok "mr_id 回填且既有字段保留" || bad "meta 合并不符"

echo "case 3: cwd 不是 git 仓时 branch 兜底为 workspace skill 的分支名"
fixture
out=$(cd "$T" && bash "$B" --state "$STATE" --issue-id i1)
node -e "const m=require('$CTX/meta.json'); process.exit(m.branch==='feat-avatar-2026-09-08' ? 0 : 1)" && ok "branch=feat-<slug>" || bad "branch 不符: $(jq -r .branch "$CTX/meta.json")"

echo "case 4: threads.sh 不存在时 ok=false 且不写 steps.board"
fixture
export THREADS_SH="$T/nope/threads.sh"
out=$(bash "$B" --state "$STATE" --issue-id i1); rc=$?
[ $rc -eq 0 ] && ok "退出 0" || bad "退出 $rc"
echo "$out" | grep -q '"ok":false' && ok "ok=false" || bad "未标失败: $out"
node -e "const d=require('$STATE/dispatched.json'); process.exit(d.i1.steps===undefined && d.i1.board.ok===false ? 0 : 1)" && ok "只记 board 错误" || bad "失败落账不符"

echo "case 5: 处置账缺 workspace 时拒绝登记"
fixture
jq 'del(.i1.workspace)' "$STATE/dispatched.json" > "$STATE/d.tmp" && mv "$STATE/d.tmp" "$STATE/dispatched.json"
out=$(bash "$B" --state "$STATE" --issue-id i1)
echo "$out" | grep -q '处置账缺 slug 或 workspace' && ok "报缺 workspace" || bad "未拒绝: $out"

echo "case 6: --state 为相对路径时 ctx_dir 仍是绝对路径"
fixture
out=$(cd "$T" && bash "$B" --state state --issue-id i1)
echo "$out" | jq -e --arg c "$STATE/board/avatar-2026-09-08" '.ctx_dir == $c' >/dev/null && ok "ctx_dir 为绝对路径" || bad "ctx_dir 不符: $out"

echo "pass=$PASS fail=$FAIL"
[ $FAIL -eq 0 ]
