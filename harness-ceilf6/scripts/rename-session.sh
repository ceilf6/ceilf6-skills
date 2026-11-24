#!/usr/bin/env bash
# 会话改名为需求短题：向当前会话 JSONL 追加 custom-title 记录。
# 机制依据（Claude Code 2.1.220 二进制读取逻辑实测）：标题解析取最后一条 custom-title，
# 优先于自动 ai-title——这正是 /rename 的写入形态，追加即改名，append-only 无覆写风险。
# 已知边界：/resume 列表立即生效；当前活跃窗口标题（进程内存）到下次进入才刷新。
# 异常环境（无 env / 找不到会话文件）exit 0 不阻塞：改名是便利，不是正确性。
set -euo pipefail

die() { echo "rename-session: $*" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || die "缺少依赖：jq"

TITLE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --title) TITLE="${2:?--title 需要值}"; shift 2 ;;
    *) die "未知参数：${1}（用法: rename-session.sh --title <需求短题>）" ;;   # ${} 必须：bash 3.2 对 $var 紧跟多字节字符会解析出错误变量名
  esac
done
[ -n "$TITLE" ] || die "用法: rename-session.sh --title <需求短题>"

SID="${CLAUDE_CODE_SESSION_ID:-}"
if [ -z "$SID" ]; then
  echo "rename-session: 无 CLAUDE_CODE_SESSION_ID（非 Claude Code 会话环境），跳过" >&2
  exit 0
fi
PROJ="${CLAUDE_PROJECTS_DIR:-$HOME/.claude/projects}"
FILE=""
for f in "$PROJ"/*/"$SID.jsonl"; do
  [ -f "$f" ] && FILE="$f" && break
done
if [ -z "$FILE" ]; then
  echo "rename-session: 未找到会话文件（${PROJ}/*/${SID}.jsonl），跳过" >&2   # ${} 必须：bash 3.2
  exit 0
fi

# 逐行 JSON 解析取最后一条 custom-title（grep 子串会被消息正文里的同字样骗到）
LAST=$(jq -r 'select(.type=="custom-title") | .customTitle' "$FILE" 2>/dev/null | tail -1 || true)
if [ "$LAST" = "$TITLE" ]; then
  echo "rename-session: 会话名已是「${TITLE}」，跳过"   # ${} 必须：bash 3.2
  exit 0
fi

jq -cn --arg t "$TITLE" --arg s "$SID" '{type:"custom-title", customTitle:$t, sessionId:$s}' >> "$FILE"
echo "rename-session: 会话已改名「${TITLE}」（/resume 立即可见；当前窗口标题下次进入刷新）"   # ${} 必须：bash 3.2
