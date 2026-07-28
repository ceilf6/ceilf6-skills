#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
CR="$HERE/../scripts/cr-round.sh"
STUB="$HERE/stubs/codex"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
check_fail() {
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then bad "$d"; else ok "$d"; fi
}

# 构造 fixture：git 仓 + 手工搭建的上下文目录（不依赖 ctx-dir.sh，契约即目录布局）
# 直接调用（不经命令替换子 shell），设置全局变量 ctx（上下文目录）、R（仓库根）
make_ctx() {
  R=$(mktemp -d)
  R=$(cd "$R" && pwd -P)   # macOS 路径归一化
  git -C "$R" init -q -b master
  git -C "$R" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
  git -C "$R" checkout -q -b feat/x
  ctx="$R/.harness-ceilf6/feat__x"
  mkdir -p "$ctx/context" "$ctx/cr"
  jq -n '{branch:"feat/x", wiki_url:null, base_branch:"master", status:"developing",
          max_rounds:null, mr_id:null, created_at:"2026-07-28T00:00:00Z"}' > "$ctx/meta.json"
  printf '# plan\n\nPLAN-MARKER 目标：修 bug\n' > "$ctx/plan.md"
  printf '# seed\n\n## 提示词\n\nPROMPT-MARKER 按提示词验收\n\n## 其他\n\nOTHER-SECTION\n' > "$ctx/context/00-seed.md"
}
run_cr() { # run_cr <mode> <ctx>
  local state; state=$(mktemp -d)
  STUB_STATE="$state" STUB_MODE="$1" CODEX_BIN="$STUB" bash "$CR" --dir "$2"
}
# 本机 AI IDE 守护进程会异步往新 .git 下写 ai/ 目录，与删除竞争导致 ENOTEMPTY，故重试
cleanup_repo() {
  rm -rf "$R" 2>/dev/null && return 0
  sleep 1
  rm -rf "$R" 2>/dev/null && return 0
  sleep 2
  rm -rf "$R"
}

echo "== 前置校验 =="
make_ctx
rm "$ctx/plan.md"
check_fail "无 plan.md 拒绝送审" run_cr pass "$ctx"
cleanup_repo

echo "== round-1 通过路径 =="
make_ctx
out=$(run_cr pass "$ctx")
[ -f "$ctx/cr/round-1/instructions.md" ] && ok "instructions 落盘" || bad "instructions 落盘"
grep -q 'PLAN-MARKER' "$ctx/cr/round-1/instructions.md" && ok "含 plan 全文" || bad "含 plan 全文"
grep -q 'PROMPT-MARKER' "$ctx/cr/round-1/instructions.md" && ok "含提示词段" || bad "含提示词段"
if grep -q 'OTHER-SECTION' "$ctx/cr/round-1/instructions.md"; then bad "提示词段截断"; else ok "提示词段截断"; fi
grep -q '对抗式' "$ctx/cr/round-1/instructions.md" && ok "含静态模板" || bad "含静态模板"
[ -f "$ctx/cr/round-1/verdict.json" ] && ok "verdict 捕获" || bad "verdict 捕获"
grep -q 'pass' "$ctx/cr/round-1/review.md" && ok "review 渲染" || bad "review 渲染"
[ "$(jq -r .status "$ctx/meta.json")" = awaiting_human ] && ok "pass 后 status=awaiting_human" || bad "status: $(jq -r .status "$ctx/meta.json")"
echo "$out" | grep -q '第 1 轮' && ok "摘要回显轮次" || bad "摘要回显"
cleanup_repo

echo "== round-1 未通过路径 =="
make_ctx
run_cr fail "$ctx" >/dev/null
[ "$(jq -r .status "$ctx/meta.json")" = cr ] && ok "未通过 status 保持 cr" || bad "未通过 status"
grep -q 'major' "$ctx/cr/round-1/review.md" && ok "review 含 severity" || bad "review 含 severity"

echo "== round-2 前置与上下文注入 =="
check_fail "缺 fixes.md 拒绝 round-2" run_cr fail "$ctx"
printf '# Round 1 处置\n\nFIXES-MARKER 已修复\n' > "$ctx/cr/round-1/fixes.md"
run_cr pass "$ctx" >/dev/null
[ -d "$ctx/cr/round-2" ] && ok "轮次自增" || bad "轮次自增"
grep -q 'FIXES-MARKER' "$ctx/cr/round-2/instructions.md" && ok "注入上轮 fixes" || bad "注入上轮 fixes"
grep -q '"severity"' "$ctx/cr/round-2/instructions.md" && ok "注入上轮 verdict" || bad "注入上轮 verdict"
cleanup_repo

echo "== 重试逻辑 =="
make_ctx
state=$(mktemp -d)
STUB_STATE="$state" STUB_MODE=garbage_then_pass CODEX_BIN="$STUB" bash "$CR" --dir "$ctx" >/dev/null
[ "$(cat "$state/calls")" = 2 ] && ok "垃圾输出后重试一次成功" || bad "重试次数: $(cat "$state/calls")"
cleanup_repo

make_ctx
check_fail "两次垃圾输出后终止" run_cr always_garbage "$ctx"
cleanup_repo

make_ctx
check_fail "codex 持续退出非 0 时终止" run_cr exit1 "$ctx"
cleanup_repo

echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
