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
bash "$TH" web --port "$PORT" >/dev/null 2>&1 &
SRV=$!
trap 'kill "$SRV" 2>/dev/null || true; rm -rf "$T"' EXIT
up=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -s -o /dev/null "http://127.0.0.1:${PORT}/"; then up=1; break; fi
  sleep 0.5
done
[ "$up" = 1 ] && ok "server 启动" || { bad "server 启动"; echo "PASS=$PASS FAIL=$FAIL"; exit 1; }

curl -s "http://127.0.0.1:${PORT}/" | grep -q '看板' && ok "首页 HTML" || bad "首页 HTML"
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

echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
