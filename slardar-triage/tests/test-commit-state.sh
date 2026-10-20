#!/usr/bin/env bash
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
C="$HERE/../scripts/commit-state.sh"
STATE_CLI="$HERE/../scripts/state.mjs"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
# 临时仓不读全局配置：identity 走环境变量，也避开全局 hooksPath。
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@x GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@x
TODAY=$(date +%F)
PREFIX="chore(slardar-triage): 记录 ${TODAY} 扫描状态"

repo() {
  T=$(mktemp -d); T=$(cd "$T" && pwd -P)
  REPO="$T/repo"; mkdir -p "$REPO/skill/state"; git -C "$REPO" init -q -b main
  echo base > "$REPO/README.md"; git -C "$REPO" add -A; git -C "$REPO" commit -qm init
  STATE="$REPO/skill/state"
}
commits() { git -C "$REPO" rev-list --count HEAD; }
subject() { git -C "$REPO" log -1 --format=%s; }

echo "case 1: 不在 git 仓内 → skipped"
T=$(mktemp -d); mkdir -p "$T/state"; echo x > "$T/state/a.json"
out=$(bash "$C" --state "$T/state")
echo "$out" | grep -q '"skipped":"不在 git 仓内"' && echo "$out" | grep -q '"committed":null' && ok "skipped 且 committed=null" || bad "输出不符: $out"

echo "case 2: 首次变更 → 新 chore，只含 state 目录"
repo
echo '{}' > "$STATE/candidates.json"; echo '{}' > "$STATE/dispatched.json"; echo unrelated > "$REPO/other.txt"
out=$(bash "$C" --state "$STATE")
echo "$out" | grep -q '"ok":true' && echo "$out" | grep -q '"amended":false' && echo "$out" | grep -q '"files":2' && ok "ok / 非 amend / 2 个文件" || bad "输出不符: $out"
[ "$(commits)" = 2 ] && ok "多了一个提交" || bad "提交数 $(commits)"
[ "$(subject)" = "${PREFIX}（2 个文件）" ] && ok "标题格式与文件数" || bad "标题: $(subject)"
git -C "$REPO" show --name-only --format= HEAD | grep -q other.txt && bad "无关文件被卷入" || ok "无关的未暂存改动没进提交"
[ -n "$(git -C "$REPO" status --short other.txt)" ] && ok "无关改动仍留在工作区" || bad "无关改动丢失"

echo "case 3: 同一天再次变更且未推送 → amend，文件数取并集"
echo '{"a":1}' > "$STATE/candidates.json"; echo '{}' > "$STATE/ledger.jsonl"
out=$(bash "$C" --state "$STATE")
echo "$out" | grep -q '"amended":true' && echo "$out" | grep -q '"files":3' && ok "amend 且 3 个文件" || bad "输出不符: $out"
[ "$(commits)" = 2 ] && ok "提交数不变" || bad "提交数 $(commits)"
[ "$(subject)" = "${PREFIX}（3 个文件）" ] && ok "标题文件数更新" || bad "标题: $(subject)"

echo "case 4: 无变更 → skipped，不产生空提交"
out=$(bash "$C" --state "$STATE")
echo "$out" | grep -q '"skipped":"无变更"' && [ "$(commits)" = 2 ] && ok "无变更不提交" || bad "输出不符: $out / $(commits)"

echo "case 5: HEAD 已推送 → 不 amend，新建提交"
BARE="$T/remote.git"; git init -q --bare "$BARE"; git -C "$REPO" remote add origin "$BARE"; git -C "$REPO" push -q origin main
echo '{"a":2}' > "$STATE/candidates.json"
out=$(bash "$C" --state "$STATE")
echo "$out" | grep -q '"amended":false' && [ "$(commits)" = 3 ] && ok "已推送后新建提交" || bad "输出不符: $out / $(commits)"
[ "$(git -C "$REPO" rev-parse origin/main)" = "$(git -C "$REPO" rev-parse HEAD~1)" ] && ok "远端提交未被改写" || bad "远端提交被改写"

echo "case 6: 暂存区有 state 之外的改动 → skipped 且不动暂存区"
echo more >> "$REPO/other.txt"; git -C "$REPO" add other.txt
echo '{"a":3}' > "$STATE/candidates.json"
out=$(bash "$C" --state "$STATE")
echo "$out" | grep -q '"skipped":"暂存区有 state 之外的改动"' && ok "skipped" || bad "输出不符: $out"
[ "$(git -C "$REPO" diff --cached --name-only)" = other.txt ] && [ "$(commits)" = 3 ] && ok "暂存区原样、未提交" || bad "暂存区被动了: $(git -C "$REPO" diff --cached --name-only)"
git -C "$REPO" reset -q other.txt

echo "case 7: SLARDAR_TRIAGE_NO_COMMIT=1 → skipped"
out=$(SLARDAR_TRIAGE_NO_COMMIT=1 bash "$C" --state "$STATE")
echo "$out" | grep -q '"skipped":"SLARDAR_TRIAGE_NO_COMMIT 已设"' && [ "$(commits)" = 3 ] && ok "禁用生效" || bad "输出不符: $out"

echo "case 8: state.mjs judge 落盘后输出带 commit 字段"
printf '%s\n' '{"scanned_at":"2026-10-20T00:00:00.000Z","candidates":[{"issue_id":"i1","bid":"vc_ai","message":"m","users":1,"count":1}]}' > "$T/scan.json"
out=$(node "$STATE_CLI" merge --dir "$STATE" --scan "$T/scan.json")
echo "$out" | grep -q '"commit":{"ok":true,"committed":"' && ok "merge 输出 commit" || bad "merge 输出不符: $out"
out=$(node "$STATE_CLI" judge --dir "$STATE" --issue-id i1 --fixable no --reason x)
echo "$out" | grep -q '"commit":{"ok":true' && echo "$out" | grep -q '"amended":true' && ok "judge 合并进当天 chore" || bad "judge 输出不符: $out"
git -C "$REPO" show --name-only --format= HEAD | grep -q skill/state/candidates.json && ok "候选池进了提交" || bad "候选池未提交"
[ -z "$(git -C "$REPO" status --short skill/state)" ] && ok "state 目录干净" || bad "state 目录有残留: $(git -C "$REPO" status --short skill/state)"

echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
