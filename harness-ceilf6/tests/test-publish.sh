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
trap '{ [ -n "$BOTPID" ] && kill "$BOTPID" 2>/dev/null; rm -rf "$T" 2>/dev/null || { sleep 1; rm -rf "$T" 2>/dev/null; }; } || true' EXIT
export HARNESS_THREADS_FILE="$T/threads.jsonl"
export CLAUDE_PROJECTS_DIR="$T/projects"; mkdir -p "$CLAUDE_PROJECTS_DIR/-proj"
export STUB_STATE="$T/stub"; mkdir -p "$STUB_STATE"
export HARNESS_PUBLISH_CONF="$T/publish.json"
export HARNESS_BOT_CONTROL="http://127.0.0.1:1"

REPO="$T/repo"; mkdir -p "$REPO"
git -C "$REPO" init -q -b master
git -C "$REPO" config user.email t@t
git -C "$REPO" config user.name t
git -C "$REPO" commit -q --allow-empty -m init
git -C "$REPO" checkout -q -b secret/leaky-branch-name
CTX="$REPO/.harness-ceilf6/secret__leaky-branch-name"; mkdir -p "$CTX"
jq -n '{branch:"secret/leaky-branch-name", base_branch:"master", status:"awaiting_human", mr_id:"8300200",
        milestones:{plan_gate:"2026-08-07T00:00:00Z"}, archived:true}' > "$CTX/meta.json"
SECRET_TITLE='内部需求短题勿外泄'
SECRET_NOTE='备注写着同事名字与内部进度'
(cd "$REPO" && bash "$TH" register --ctx-dir "$CTX" --title "$SECRET_TITLE") >/dev/null
bash "$TH" note --ctx-dir "$CTX" "$SECRET_NOTE" >/dev/null

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
grep -q 'bits mr' "$STUB_STATE/calls.log" && bad "发布不该调 bytedcli" || ok "发布零 bytedcli 调用"
D="$STUB_STATE/dest/data.json"
jq -e '.generated_at and (.threads | type == "array") and (.running.tasks | type == "array")' "$D" >/dev/null \
  && ok "data.json 结构" || bad "data.json: $(jq -c 'keys' "$D")"
jq -e '.running.offline == true' "$D" >/dev/null && ok "bot 离线降级" || bad "running: $(jq -c .running "$D")"
jq -e '.threads | length == 1' "$D" >/dev/null && ok "--all 含已归档线程" || bad "线程数: $(jq '.threads|length' "$D")"
grep -Fq '<script>window.BOARD = {"mode": "public", "generated_at":' "$STUB_STATE/dest/index.html" \
  && ok "public 配置已注入" || bad "public 注入缺失"
grep -q 'BOARD_CONFIG' "$STUB_STATE/dest/index.html" && bad "注入点残留" || ok "注入点已替换"

echo "== 对外快照脱敏：白名单字段之外零出现 =="
# 页面对外只以 MR 号/序号标识线程；mr_id 裸编号是用户对自身红线的显式豁免，其余内部标识零出现
jq -e '[.threads[] | keys] | add | unique
       == ["archived","cr_rounds","current","idx","milestones","mr_id","node","progress","status"]' "$D" >/dev/null \
  && ok "threads 字段恰为白名单" || bad "字段: $(jq -c '[.threads[]|keys]|add|unique' "$D")"
jq -e '.threads[0].mr_id == "8300200"' "$D" >/dev/null && ok "mr_id 保留（用户豁免）" || bad "mr_id: $(jq -c '.threads[0].mr_id' "$D")"
grep -Fq "$SECRET_TITLE" "$D" && bad "快照泄漏需求短题" || ok "快照全文无需求短题"
grep -Fq "$SECRET_NOTE" "$D" && bad "快照泄漏备注" || ok "快照全文无备注"
grep -Fq 'leaky-branch-name' "$D" && bad "快照泄漏分支名" || ok "快照全文无分支名"
grep -Fq "$REPO" "$D" && bad "快照泄漏本机路径" || ok "快照全文无本机路径"
grep -Fq 'claude --' "$D" && bad "快照泄漏启动命令" || ok "快照全文无启动命令"
jq -e '.running | keys == ["offline","tasks"]' "$D" >/dev/null \
  && ok "离线 running 只留 tasks/offline" || bad "running: $(jq -c '.running|keys' "$D")"

if command -v python3 >/dev/null 2>&1; then
echo "== bot 在线：running 徽标配对成线程序号，路径不出 =="
BOTP=$(( (RANDOM % 2000) + 49000 ))
python3 -c '
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
# 三个条目：能配到登记线程的、路径配不上的、形状不符的——只有第一个该出现在快照里
BODY = json.dumps({"tasks": [{"worktree": sys.argv[2], "state": "active",
                              "title": "指令正文前二十字勿外泄",
                              "question": "agent 反问用户的原文勿外泄",
                              "sessionId": "sid-勿外泄", "messageId": "msg-勿外泄",
                              "branch": "secret/leaky-branch-name"},
                             {"worktree": "/w/unregistered", "state": "active"},
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
' "$BOTP" "$REPO" >/dev/null 2>&1 &
BOTPID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -s -o /dev/null "http://127.0.0.1:${BOTP}/api/tasks" && break
  sleep 0.5
done
HARNESS_BOT_CONTROL="http://127.0.0.1:${BOTP}" bash "$PB" >/dev/null
jq -e '.running.tasks == [{"idx": 1, "state": "active"}]' "$D" >/dev/null \
  && ok "配对成 {idx,state}，未登记与坏形状条目被丢弃" || bad "running: $(jq -c .running "$D")"
jq -e '.running.offline == false' "$D" >/dev/null && ok "在线 offline=false" || bad "offline: $(jq -c '.running.offline' "$D")"
grep -Fq '勿外泄' "$D" && bad "快照泄漏任务标题/提问/会话标识" || ok "快照无任务标题、agent 提问与会话标识"
grep -Fq '/w/unregistered' "$D" && bad "快照泄漏工作树路径" || ok "快照无工作树路径"
fi

echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
