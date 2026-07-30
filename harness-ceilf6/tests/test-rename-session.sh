#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
RS="$HERE/../scripts/rename-session.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

T=$(mktemp -d)
PROJ="$T/projects"
mkdir -p "$PROJ/-Users-x-repo"
F="$PROJ/-Users-x-repo/sid-123.jsonl"
jq -cn '{type:"ai-title", aiTitle:"自动生成题", sessionId:"sid-123"}' > "$F"
# 干扰行：消息正文里出现 custom-title 字样，逐行 JSON 解析必须不被它骗到
jq -cn '{type:"user", text:"讨论 \"type\":\"custom-title\" 机制的消息"}' >> "$F"
run() { CLAUDE_CODE_SESSION_ID="$1" CLAUDE_PROJECTS_DIR="$PROJ" bash "$RS" --title "$2"; }
titles() { jq -r 'select(.type=="custom-title") | .customTitle' "$F"; }

echo "== 追加 custom-title =="
run sid-123 '修复图片删除不落库'
[ "$(titles | wc -l | tr -d ' ')" = 1 ] && ok "追加一条" || bad "条数: $(titles | wc -l)"
[ "$(titles | tail -1)" = '修复图片删除不落库' ] && ok "标题正确" || bad "标题: $(titles | tail -1)"
tail -1 "$F" | jq -e '.sessionId == "sid-123"' >/dev/null && ok "sessionId 正确" || bad "sessionId"
tail -1 "$F" | jq -e 'type == "object"' >/dev/null && ok "追加行是合法 JSON" || bad "非法 JSON"

echo "== 同名幂等 =="
run sid-123 '修复图片删除不落库'
[ "$(titles | wc -l | tr -d ' ')" = 1 ] && ok "同名不重复追加" || bad "重复追加"

echo "== 改名（新标题再追加，last 胜出）=="
run sid-123 '改成新的短题'
[ "$(titles | wc -l | tr -d ' ')" = 2 ] && ok "新名追加" || bad "新名未追加"
[ "$(titles | tail -1)" = '改成新的短题' ] && ok "最后一条为新名" || bad "last: $(titles | tail -1)"

echo "== 异常环境不阻塞 =="
# SESSION_ID 必须显式置空：本测试可能就跑在一个真实 Claude Code 会话里，env 已导出
if CLAUDE_CODE_SESSION_ID= CLAUDE_PROJECTS_DIR="$PROJ" bash "$RS" --title x 2>/dev/null; then ok "无 SESSION_ID：exit 0"; else bad "无 SESSION_ID 应 exit 0"; fi
if run sid-nonexistent x 2>/dev/null; then ok "会话文件缺失：exit 0"; else bad "文件缺失应 exit 0"; fi
[ "$(titles | wc -l | tr -d ' ')" = 2 ] && ok "异常路径未写入" || bad "异常路径写入了"

echo "== 参数守卫 =="
rc=0; bash "$RS" 2>/dev/null || rc=$?
[ "$rc" = 1 ] && ok "缺 --title die" || bad "缺 --title：exit $rc"

rm -rf "$T"
echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
