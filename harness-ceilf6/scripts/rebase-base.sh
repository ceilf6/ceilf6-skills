#!/usr/bin/env bash
# harness-ceilf6 变基机械层：fetch base 远端最新后，把需求分支 rebase 到 base tip。
# 用于收尾（squash 之后、push 之前——单提交重放，冲突至多解一次）与续入（回阶段 1 开发前）。
#
# 独立于 squash-branch.sh：squash 的契约是不碰网络，而变基必须先 fetch——本地远程跟踪 ref
# 常年滞后（见 base-ref.sh 头注），不 fetch 会假性「已最新」，这正是本脚本要消灭的状态，
# 故 fetch 失败即停、不降级。
#
# 冲突不代解：git rebase 自带半途现场（--continue / --abort 自回退），停下把指引交给调用方
# 会话处置。也不动 harness-backup/*（变基回退靠 --abort 与 reflog），squash 留下的备份指针
# 因此不被覆盖。
set -euo pipefail

die() { echo "rebase-base: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "缺少依赖：$1"; }
need jq; need git

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
BASE_LIB="$SCRIPT_DIR/base-ref.sh"
[ -f "$BASE_LIB" ] || die "缺少 $BASE_LIB"
. "$BASE_LIB"

CTX_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) CTX_DIR="${2:?--dir 需要值}"; shift 2 ;;
    *) die "未知参数：${1}（用法: rebase-base.sh --dir <上下文目录>）" ;;   # ${} 必须：bash 3.2 对 $var 紧跟多字节字符会解析出错误变量名
  esac
done
[ -n "$CTX_DIR" ] || die "用法: rebase-base.sh --dir <上下文目录>"
[ -d "$CTX_DIR" ] || die "目录不存在：$CTX_DIR"
[ -f "$CTX_DIR/meta.json" ] || die "$CTX_DIR 缺 meta.json：先用 harness-context init"

REPO_ROOT=$(git -C "$CTX_DIR" rev-parse --show-toplevel)
GITDIR=$(git -C "$REPO_ROOT" rev-parse --absolute-git-dir)
BASE=$(jq -r .base_branch "$CTX_DIR/meta.json")
{ [ -n "$BASE" ] && [ "$BASE" != null ]; } || die "meta.base_branch 缺失"

# 半途现场先于 symbolic-ref 检查：变基中 HEAD 是 detached，后者的诊断会误导
if [ -d "$GITDIR/rebase-merge" ] || [ -d "$GITDIR/rebase-apply" ]; then
  die "已有变基半途现场：解决冲突后 git rebase --continue（或 git rebase --abort 放弃）再重跑"
fi

BRANCH=$(git -C "$REPO_ROOT" symbolic-ref --short -q HEAD) || die "detached HEAD：无法确定分支，不做变基"
[ "$BRANCH" != "$BASE" ] || die "当前在 base 分支（${BRANCH}）上，拒绝变基"   # ${} 必须：bash 3.2

BASE_REF=$(resolve_base_ref "$REPO_ROOT" "$BASE")

# BASE_REF 是远程跟踪 ref 才有远端可同步；纯本地仓（离线/测试）跳过 fetch，按本地 ref 变基
if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/remotes/${BASE_REF}"; then
  REMOTE=${BASE_REF%%/*}
  git -C "$REPO_ROOT" fetch --quiet "$REMOTE" "${BASE_REF#*/}" \
    || die "fetch ${REMOTE} ${BASE_REF#*/} 失败：变基必须基于远端最新（不降级用本地滞后 ref），确认网络后重跑"
fi

TIP=$(git -C "$REPO_ROOT" rev-parse --verify --quiet "${BASE_REF}^{commit}") || die "解析 ${BASE_REF} 失败"
MB=$(git -C "$REPO_ROOT" merge-base "$BASE_REF" HEAD) || die "merge-base ${BASE_REF}...HEAD 求解失败"
if [ "$MB" = "$TIP" ]; then
  echo "rebase-base: ${BRANCH} 已基于 ${BASE_REF} 最新（$(git -C "$REPO_ROOT" rev-parse --short "$TIP")），无需变基"   # ${} 必须：bash 3.2
  exit 0
fi

# 已跟踪文件的未提交改动会卡死变基半途的 checkout，先行拒绝；未跟踪文件不阻塞
[ -z "$(git -C "$REPO_ROOT" status --porcelain -uno)" ] || die "工作区有未提交改动：先提交或自行收纳，再变基"

OLD=$(git -C "$REPO_ROOT" rev-parse HEAD)
BEHIND=$(git -C "$REPO_ROOT" rev-list --count "${MB}..${TIP}")
if ! OUT=$(git -C "$REPO_ROOT" rebase "$BASE_REF" 2>&1); then
  if [ -d "$GITDIR/rebase-merge" ] || [ -d "$GITDIR/rebase-apply" ]; then
    printf '%s\n' "$OUT" >&2
    echo "rebase-base: 变基到 ${BASE_REF}（落后 ${BEHIND} 提交）遇冲突，已停在冲突现场" >&2   # ${} 必须：bash 3.2
    echo "  处置：解决冲突后 git add <文件> && git rebase --continue；放弃则 git rebase --abort（回到 ${OLD}）" >&2   # ${} 必须：bash 3.2
    echo "  冲突解决是未经机审的新改动：解完必须重跑自检并记录，建议补一轮 cr-round 复核" >&2
    exit 2
  fi
  printf '%s\n' "$OUT" >&2
  die "git rebase ${BASE_REF} 失败（非冲突半途），诊断见上方输出"
fi

NEW=$(git -C "$REPO_ROOT" rev-parse HEAD)
echo "rebase-base: ${BRANCH} 已变基到 ${BASE_REF} 最新，吸收上游 ${BEHIND} 个提交"   # ${} 必须：bash 3.2
echo "  旧 HEAD：${OLD} → 新 HEAD：${NEW}（回退靠 reflog）"   # ${} 必须：bash 3.2
echo "  上游已推进：push 前重跑自检（typecheck + 相关测试）"
