#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
TH="$HERE/../scripts/threads.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
command -v python3 >/dev/null 2>&1 || { echo "skip: 无 python3"; exit 0; }

T=$(mktemp -d); T=$(cd "$T" && pwd -P)
export HARNESS_THREADS_FILE="$T/threads.jsonl"
export CLAUDE_PROJECTS_DIR="$T/projects"
mkdir -p "$CLAUDE_PROJECTS_DIR/-proj"
REPO="$T/repo-w"; mkdir -p "$REPO"
git -C "$REPO" init -q -b master
git -C "$REPO" config user.email t@t
git -C "$REPO" config user.name t
git -C "$REPO" commit -q --allow-empty -m init
git -C "$REPO" checkout -q -b feat/web
CTX="$REPO/.harness-ceilf6/feat__web"; mkdir -p "$CTX"
jq -n '{branch:"feat/web", base_branch:"master", status:"awaiting_human", mr_id:null, wiki_url:null,
        milestones:{plan_gate:"2026-08-03T00:00:00Z", dev_done:"2026-08-03T00:00:01Z",
                    cr_passed:"2026-08-03T00:00:02Z", mr_created:"2026-08-03T00:00:03Z"}}' > "$CTX/meta.json"
(cd "$REPO" && CLAUDE_CODE_SESSION_ID=sid-web bash "$TH" register --ctx-dir "$CTX" --title 'web冒烟') >/dev/null

PORT=$(( (RANDOM % 2000) + 47000 ))
# 固定指向无人监听的端口：本用例覆盖的是 bot 离线时的降级路径，不能受本机是否在跑 bot 影响
export HARNESS_BOT_CONTROL="http://127.0.0.1:1"
# 改 HOME 是为了让 web 子命令走「同目录 web.py」的回退分支：否则它优先加载已安装技能里的副本，
# 测的就不是本仓库的这份代码了
HOME="$T" bash "$TH" web --port "$PORT" >/dev/null 2>&1 &
SRV=$!
trap 'kill "$SRV" ${SRV2:-} ${STUB:-} 2>/dev/null || true; rm -rf "$T"' EXIT
up=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -s -o /dev/null "http://127.0.0.1:${PORT}/"; then up=1; break; fi
  sleep 0.5
done
[ "$up" = 1 ] && ok "server 启动" || { bad "server 启动"; echo "PASS=$PASS FAIL=$FAIL"; exit 1; }

page=$(curl -s "http://127.0.0.1:${PORT}/")
echo "$page" | grep -q '看板' && ok "首页 HTML" || bad "首页 HTML"
# 清理 = 对着工作树 rm -rf：有任务正在这棵树里跑时按钮必须置灰，且说明先停任务
echo "$page" | grep -q "clean.disabled = true" && ok "运行中禁用清理按钮" || bad "清理按钮缺运行态防护"
echo "$page" | grep -q '先停止该任务' && ok "禁用态提示指向停止" || bad "禁用态无提示"
# 运行态徽标的状态字面量与 listener 的 STATE_LABEL 同一套，缺一个就渲染成裸英文
echo "$page" | grep -q '启动中' && ok "starting 状态标签在册" || bad "缺 starting 标签"
echo "$page" | grep -q '已滞留' && ok "stranded 状态标签在册" || bad "缺 stranded 标签"
out=$(curl -s "http://127.0.0.1:${PORT}/api/threads")
echo "$out" | jq -e 'type == "array" and (.[0].node == "待人工CR")' >/dev/null && ok "api/threads 透传" || bad "api/threads: $out"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/mark" \
  -d "{\"ctx_dir\": \"$CTX\", \"node\": \"human_cr_done\"}")
[ "$code" = 200 ] && ok "mark 接口 200" || bad "mark 接口: $code"
jq -e '.milestones.human_cr_done' "$CTX/meta.json" >/dev/null && ok "mark 落盘" || bad "mark 落盘"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/mark" \
  -d "{\"ctx_dir\": \"$CTX\", \"node\": \"dev_done\"}")
[ "$code" = 400 ] && ok "非人工节点 400" || bad "非人工节点: $code"
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/nope")
[ "$code" = 404 ] && ok "未知路径 404" || bad "未知路径: $code"

out=$(curl -s "http://127.0.0.1:${PORT}/api/threads")
echo "$out" | jq -e '.[0] | has("current") and has("cr_rounds") and has("resume")' >/dev/null \
  && ok "看板字段 current/cr_rounds/resume" || bad "看板字段: $out"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/set-node" \
  -d "{\"ctx_dir\": \"$CTX\", \"target\": \"dev_done\"}")
[ "$code" = 200 ] && ok "set-node 接口 200" || bad "set-node 接口: $code"
jq -e '.milestones | has("plan_gate") and (has("dev_done") | not)' "$CTX/meta.json" >/dev/null \
  && ok "set-node 回退落盘" || bad "set-node 落盘: $(jq -c .milestones "$CTX/meta.json")"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/set-node" \
  -d "{\"ctx_dir\": \"$CTX\", \"target\": \"bogus\"}")
[ "$code" = 400 ] && ok "set-node 非法目标 400" || bad "set-node 非法目标: $code"

# bot 未运行时 /api/running 降级为空列表 + offline，看板照常渲染
out=$(curl -s "http://127.0.0.1:${PORT}/api/running")
echo "$out" | jq -e '.offline == true and (.tasks | length) == 0' >/dev/null \
  && ok "bot 离线时 running 降级" || bad "running 降级：$out"

# 归档 → 默认视图消失 → --all 可见 → 取消归档回来
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/archive" \
  -d "{\"ctx_dir\":\"$CTX\",\"archived\":true}")
[ "$code" = 200 ] && ok "api/archive 200" || bad "api/archive: $code"
jq -e '.archived == true' "$CTX/meta.json" >/dev/null && ok "archive 落盘" || bad "archive 未落盘"
out=$(curl -s "http://127.0.0.1:${PORT}/api/threads")
echo "$out" | jq -e 'length == 0' >/dev/null && ok "默认视图隐藏已归档" || bad "默认视图：$out"
out=$(curl -s "http://127.0.0.1:${PORT}/api/threads?all=1")
echo "$out" | jq -e 'length == 1' >/dev/null && ok "all=1 显示已归档" || bad "all=1：$out"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/archive" \
  -d "{\"ctx_dir\":\"$CTX\",\"archived\":false}")
[ "$code" = 200 ] && ok "api/archive 取消 200" || bad "api/archive 取消: $code"

# bot 离线时停止请求给出 503 而非 500，且不改变任何盘上状态
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/stop" \
  -d "{\"cwd\":\"$REPO\"}")
[ "$code" = 503 ] && ok "bot 离线时 stop 返回 503" || bad "stop 离线码: $code"

# 空 cwd 不得转给 bot：bot 对空选择子会退回「在册只有一个就停它」，定向停止会悄悄变成停别人
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/stop" -d '{"cwd":""}')
[ "$code" = 400 ] && ok "stop 空 cwd 400" || bad "stop 空 cwd: $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/stop" -d '{"cwd":null}')
[ "$code" = 400 ] && ok "stop null cwd 400" || bad "stop null cwd: $code"

# 坏入参一律 400
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/archive" -d '{}')
[ "$code" = 400 ] && ok "api/archive 缺参 400" || bad "api/archive 缺参: $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/clean" -d '{}')
[ "$code" = 400 ] && ok "api/clean 缺参 400" || bad "api/clean 缺参: $code"

# clean 走 threads.sh：主检出被拒绝时返回 500 且仓库安然无恙
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/clean" \
  -d "{\"ctx_dir\":\"$CTX\"}")
[ "$code" = 500 ] && ok "clean 主检出被拒（500）" || bad "clean 主检出码: $code"
[ -d "$REPO/.git" ] && ok "主检出安然无恙" || bad "主检出被删"

# 控制端口在听、但答复不成形（此处是非 JSON 正文）时同样降级，不把异常抛成 500
STUBP=$(( PORT + 1 )); PORT2=$(( PORT + 2 ))
python3 -c '
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        b = b"<html>not json</html>"
        self.send_response(200)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)
    def log_message(self, *a): pass
HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
' "$STUBP" >/dev/null 2>&1 &
STUB=$!
HOME="$T" HARNESS_BOT_CONTROL="http://127.0.0.1:${STUBP}" bash "$TH" web --port "$PORT2" >/dev/null 2>&1 &
SRV2=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -s -o /dev/null "http://127.0.0.1:${PORT2}/" && break
  sleep 0.5
done
out=$(curl -s "http://127.0.0.1:${PORT2}/api/running")
echo "$out" | jq -e '.offline == true' >/dev/null \
  && ok "bot 答复不成形时降级" || bad "坏答复降级：$out"

echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
