#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
PB="$HERE/../scripts/publish-board.sh"
TH="$HERE/../scripts/threads.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
has() { case "$3" in *"$2"*) ok "$1" ;; *) bad "${1}（未见「${2}」）" ;; esac }

export PATH="$HERE/stubs:$PATH"
T=$(mktemp -d); T=$(cd "$T" && pwd -P)
BOTPID=""
# 本机 AI IDE 守护进程会异步往新 .git 下写 ai/ 目录，与删除竞争导致 ENOTEMPTY，故重试
trap '[ -n "$BOTPID" ] && kill "$BOTPID" 2>/dev/null; rm -rf "$T" 2>/dev/null || { sleep 1; rm -rf "$T" 2>/dev/null || true; }' EXIT
export HARNESS_THREADS_FILE="$T/threads.jsonl"
export CLAUDE_PROJECTS_DIR="$T/projects"; mkdir -p "$CLAUDE_PROJECTS_DIR/-proj"
export STUB_STATE="$T/stub"; mkdir -p "$STUB_STATE"
export HARNESS_PUBLISH_CONF="$T/publish.json"
export HARNESS_MR_URL_CACHE="$T/mr-urls.json"
export HARNESS_BOT_CONTROL="http://127.0.0.1:1"

REPO="$T/repo"; mkdir -p "$REPO"
git -C "$REPO" init -q -b master
git -C "$REPO" config user.email t@t
git -C "$REPO" config user.name t
git -C "$REPO" commit -q --allow-empty -m init
git -C "$REPO" checkout -q -b feat/pub
CTX="$REPO/.harness-ceilf6/feat__pub"; mkdir -p "$CTX"
jq -n '{branch:"feat/pub", base_branch:"master", status:"awaiting_human", mr_id:"8300200",
        milestones:{plan_gate:"2026-08-07T00:00:00Z"}, archived:true}' > "$CTX/meta.json"
SECRET_TITLE='内部需求短题勿外泄'
(cd "$REPO" && bash "$TH" register --ctx-dir "$CTX" --title "$SECRET_TITLE") >/dev/null
echo '{"url":"https://bits.example/mr/8300200"}' > "$STUB_STATE/status.json"

echo "== 缺 publish.json：拒绝执行 =="
rc=0; bash "$PB" 2>/dev/null || rc=$?
[ "$rc" != 0 ] && ok "无配置非零退出" || bad "无配置 exit 0"
[ ! -f "$STUB_STATE/calls.log" ] && ok "无配置零外部调用" || bad "无配置有调用"

echo "== 正常发布 =="
jq -n --arg d "root@203.0.113.9:/var/www/site/harness" --arg k "$T/fake.pem" \
  '{dest:$d, key:$k}' > "$HARNESS_PUBLISH_CONF"
: > "$T/fake.pem"
out=$(bash "$PB")
has "回显发布" '已发布' "$out"
[ "$(ls "$STUB_STATE/dest" | sort | tr '\n' ' ')" = "data.json index.html " ] \
  && ok "只上传两个文件" || bad "上传清单: $(ls "$STUB_STATE/dest")"
grep -q -- '-i '"$T"'/fake.pem' "$STUB_STATE/calls.log" && ok "scp 带密钥" || bad "scp 参数: $(cat "$STUB_STATE/calls.log")"
# launchd 下无 TTY：scp 不得停在口令提示或黑洞连接上等到天荒地老
grep -q -- '-o BatchMode=yes' "$STUB_STATE/calls.log" && ok "scp 禁交互" || bad "scp 缺 BatchMode"
grep -q -- '-o ConnectTimeout=' "$STUB_STATE/calls.log" && ok "scp 带连接超时" || bad "scp 缺 ConnectTimeout"
D="$STUB_STATE/dest/data.json"
jq -e '.generated_at and (.threads | type == "array") and (.running.tasks | type == "array")' "$D" >/dev/null \
  && ok "data.json 结构" || bad "data.json: $(jq -c 'keys' "$D")"
jq -e '.running.offline == true' "$D" >/dev/null && ok "bot 离线降级" || bad "running: $(jq -c .running "$D")"
jq -e '.threads[0].mr_url == "https://bits.example/mr/8300200"' "$D" >/dev/null \
  && ok "mr_url 已解析" || bad "mr_url: $(jq -c '.threads[0].mr_url' "$D")"
jq -e '.threads | length == 1' "$D" >/dev/null && ok "--all 含已归档线程" || bad "线程数: $(jq '.threads|length' "$D")"
jq -e '.["8300200"] == "https://bits.example/mr/8300200"' "$HARNESS_MR_URL_CACHE" >/dev/null \
  && ok "mr_url 已入缓存" || bad "缓存: $(cat "$HARNESS_MR_URL_CACHE")"
grep -Fq '<script>window.BOARD = {"mode": "public", "generated_at":' "$STUB_STATE/dest/index.html" \
  && ok "public 配置已注入" || bad "public 注入缺失"
grep -q 'BOARD_CONFIG' "$STUB_STATE/dest/index.html" && bad "注入点残留" || ok "注入点已替换"

echo "== 对外快照脱敏 =="
# 页面对外只以 MR 链接/分支名标识线程，需求短题一律不出本机
jq -e '.threads[0] | has("title") | not' "$D" >/dev/null \
  && ok "threads 无 title 键" || bad "threads 含 title: $(jq -c '.threads[0]|keys' "$D")"
grep -Fq "$SECRET_TITLE" "$D" && bad "快照泄漏需求短题" || ok "快照全文无需求短题"
jq -e '.running | keys == ["offline","tasks"]' "$D" >/dev/null \
  && ok "离线 running 只留 tasks/offline" || bad "running: $(jq -c '.running|keys' "$D")"

echo "== 二次发布：缓存命中零 bytedcli 调用 =="
n1=$(grep -c 'mr status' "$STUB_STATE/calls.log" || true)
bash "$PB" >/dev/null
n2=$(grep -c 'mr status' "$STUB_STATE/calls.log" || true)
[ "$n1" = "$n2" ] && ok "缓存命中不再查 MR" || bad "重复查询: $n1 -> $n2"

echo "== url 解析失败：不入缓存、mr_url 为空 =="
echo '{"nothing":true}' > "$STUB_STATE/status.json"
tmp=$(mktemp); jq '.mr_id = "8300201"' "$CTX/meta.json" > "$tmp" && mv "$tmp" "$CTX/meta.json"
bash "$PB" >/dev/null
jq -e '.threads[0].mr_url == ""' "$STUB_STATE/dest/data.json" >/dev/null \
  && ok "解析失败 mr_url 空" || bad "mr_url: $(jq -c '.threads[0].mr_url' "$STUB_STATE/dest/data.json")"
jq -e 'has("8300201") | not' "$HARNESS_MR_URL_CACHE" >/dev/null && ok "失败不入缓存" || bad "缓存被污染"

echo "== 缓存内容损坏：自愈重建，不永久空转也不硬失败 =="
echo '{"url":"https://bits.example/mr/8300202"}' > "$STUB_STATE/status.json"
tmp=$(mktemp); jq '.mr_id = "8300202"' "$CTX/meta.json" > "$tmp" && mv "$tmp" "$CTX/meta.json"
: > "$HARNESS_MR_URL_CACHE"
rc=0; bash "$PB" >/dev/null 2>&1 || rc=$?
[ "$rc" = 0 ] && ok "0 字节缓存仍发布成功" || bad "0 字节缓存 rc=$rc"
jq -e '.["8300202"] == "https://bits.example/mr/8300202"' "$HARNESS_MR_URL_CACHE" >/dev/null \
  && ok "0 字节缓存自愈后写回" || bad "0 字节缓存未写回: $(cat "$HARNESS_MR_URL_CACHE")"
jq -e '.threads[0].mr_url == "https://bits.example/mr/8300202"' "$D" >/dev/null \
  && ok "0 字节缓存下 mr_url 正常" || bad "mr_url: $(jq -c '.threads[0].mr_url' "$D")"
printf 'not json at all' > "$HARNESS_MR_URL_CACHE"
rc=0; bash "$PB" >/dev/null 2>&1 || rc=$?
[ "$rc" = 0 ] && ok "非 JSON 缓存仍发布成功" || bad "非 JSON 缓存 rc=$rc"
jq -e '.["8300202"] == "https://bits.example/mr/8300202"' "$HARNESS_MR_URL_CACHE" >/dev/null \
  && ok "非 JSON 缓存自愈后写回" || bad "非 JSON 缓存未写回: $(cat "$HARNESS_MR_URL_CACHE")"

if command -v python3 >/dev/null 2>&1; then
echo "== bot 在线：running 只带页面消费的字段 =="
BOTP=$(( (RANDOM % 2000) + 49000 ))
python3 -c '
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
BODY = json.dumps({"tasks": [{"worktree": "/w/feat-pub", "state": "active",
                              "title": "指令正文前二十字勿外泄",
                              "question": "agent 反问用户的原文勿外泄",
                              "sessionId": "sid-勿外泄", "messageId": "msg-勿外泄",
                              "branch": "feat/pub"},
                             "条目形状不符也不该让发布硬失败"]}).encode("utf-8")
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(BODY)))
        self.end_headers()
        self.wfile.write(BODY)
    def log_message(self, *a): pass
HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
' "$BOTP" >/dev/null 2>&1 &
BOTPID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -s -o /dev/null "http://127.0.0.1:${BOTP}/api/tasks" && break
  sleep 0.5
done
HARNESS_BOT_CONTROL="http://127.0.0.1:${BOTP}" bash "$PB" >/dev/null
jq -e '.running.tasks | length == 1' "$D" >/dev/null \
  && ok "在跑任务进快照、形状不符的条目被丢弃" || bad "running: $(jq -c .running "$D")"
jq -e '[.running.tasks[] | keys] | all(. == ["state","worktree"])' "$D" >/dev/null \
  && ok "任务条目只留 worktree/state" || bad "任务条目: $(jq -c '.running.tasks' "$D")"
jq -e '.running.offline == false' "$D" >/dev/null && ok "在线 offline=false" || bad "offline: $(jq -c '.running.offline' "$D")"
grep -Fq '勿外泄' "$D" && bad "快照泄漏任务标题/提问/会话标识" || ok "快照无任务标题、agent 提问与会话标识"
fi

echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
