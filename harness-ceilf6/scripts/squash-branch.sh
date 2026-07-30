#!/usr/bin/env bash
# harness-ceilf6 收尾 squash 机械层：把当前分支自 merge-base 起的全部提交压成单 commit。
# 手法适配 byteview-web 禁 reset/restore、无 rebase -i：commit-tree 同树重建 + checkout -B 移指针，
# 工作区文件零触碰（树 id 不变），未提交改动天然保留。push 由调用方做，本脚本不碰网络。
set -euo pipefail

die() { echo "squash-branch: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "缺少依赖：$1"; }
need jq; need git

CTX_DIR=""; MSG_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) CTX_DIR="${2:?--dir 需要值}"; shift 2 ;;
    --message-file) MSG_FILE="${2:?--message-file 需要值}"; shift 2 ;;
    *) die "未知参数：${1}（用法: squash-branch.sh --dir <上下文目录> --message-file <路径>）" ;;   # ${} 必须：bash 3.2 对 $var 紧跟多字节字符会解析出错误变量名
  esac
done
[ -n "$CTX_DIR" ] && [ -n "$MSG_FILE" ] || die "用法: squash-branch.sh --dir <上下文目录> --message-file <路径>"
[ -d "$CTX_DIR" ] || die "目录不存在：$CTX_DIR"
[ -f "$CTX_DIR/meta.json" ] || die "$CTX_DIR 缺 meta.json：先用 harness-context init"
# message 文件可能是进程替换 fd，只能读一遍：先整体读入
MSG=$(cat "$MSG_FILE" 2>/dev/null) || die "message 文件不可读：$MSG_FILE"
[ -n "$MSG" ] || die "message 为空：commit message 必须描述实质变更"

REPO_ROOT=$(git -C "$CTX_DIR" rev-parse --show-toplevel)
BASE=$(jq -r .base_branch "$CTX_DIR/meta.json")
{ [ -n "$BASE" ] && [ "$BASE" != null ]; } || die "meta.base_branch 缺失"

BRANCH=$(git -C "$REPO_ROOT" symbolic-ref --short -q HEAD) || die "detached HEAD：无法确定分支，不做 squash"
[ "$BRANCH" != "$BASE" ] || die "当前在 base 分支（${BRANCH}）上，拒绝 squash"   # ${} 必须：bash 3.2
OLD=$(git -C "$REPO_ROOT" rev-parse HEAD)
MB=$(git -C "$REPO_ROOT" merge-base "$BASE" HEAD) || die "merge-base ${BASE}...HEAD 求解失败"
[ "$OLD" != "$MB" ] || die "没有可 squash 的提交（HEAD 即 merge-base）"

# 备份指针：单一引用每次覆盖，更早状态靠 reflog
git -C "$REPO_ROOT" branch -f "harness-backup/$BRANCH" "$OLD"
NEW=$(printf '%s\n' "$MSG" | git -C "$REPO_ROOT" commit-tree "HEAD^{tree}" -p "$MB" -F -)
git -C "$REPO_ROOT" checkout -q -B "$BRANCH" "$NEW"

# 等价验证：树必须一字不差，否则回退并中止
if ! git -C "$REPO_ROOT" diff --quiet "$OLD" HEAD; then
  git -C "$REPO_ROOT" checkout -q -B "$BRANCH" "$OLD"
  die "等价验证失败（diff 非空），已回退到旧 HEAD ${OLD}"   # ${} 必须：bash 3.2
fi

echo "squash-branch: ${BRANCH} 已压成单提交"   # ${} 必须：bash 3.2
echo "  旧 HEAD：${OLD}（备份：harness-backup/${BRANCH}）"   # ${} 必须：bash 3.2
echo "  新 HEAD：$NEW"
