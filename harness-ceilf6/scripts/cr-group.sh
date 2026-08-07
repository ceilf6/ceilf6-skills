#!/usr/bin/env bash
# MR 求CR 拉群与 WIP。子命令：
#   request --ctx-dir <路径> [--message <文案>] [--dry-run]   自测完成后的拉群求CR 全流
#   wip     --ctx-dir <路径> [--dry-run]                       返工时给 MR 挂 WIP
# 名单不设配置：现读 MR 上建 MR 时自动配置的 reviewer（bits mr reviewer info）。
# 失败处置分级：建群失败容忍（群可能已存在）、拉人逐个告警、发消息失败降级提示——半途失败可整体
# 重试，全流幂等；只有「无 MR」（exit 3，契约码）与 meta 缺失阻断。全部外部 CLI 调用收敛在本脚本，
# web.py 只转调。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
TH="$HERE/threads.sh"
die() { echo "cr-group: $*" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || die "缺少依赖：jq"
DEFAULT_MSG='大佬们，有空辛苦 CR 一下[送心]'

usage() {
  cat >&2 <<'EOF'
用法：cr-group.sh request --ctx-dir <路径> [--message <文案>] [--dry-run]
      cr-group.sh wip     --ctx-dir <路径> [--dry-run]
EOF
  exit 1
}

sub="${1:-}"
[ -n "$sub" ] || usage
shift
ctx="" msg="$DEFAULT_MSG" dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ctx-dir) ctx="${2:?--ctx-dir 需要值}"; shift 2 ;;
    --message) msg="${2:?--message 需要值}"; shift 2 ;;
    --dry-run) dry=1; shift ;;
    *) usage ;;
  esac
done
[ -n "$ctx" ] || usage
meta="$ctx/meta.json"
[ -f "$meta" ] || die "缺 meta.json：$ctx"
# mr_id 历史上 string / number 两种形态都有，jq -r 皆输出裸值
mr=$(jq -r '.mr_id // empty' "$meta")

case "$sub" in
  wip)
    if [ -z "$mr" ]; then echo "cr-group: 无 MR，跳过 WIP"; exit 0; fi
    if [ "$dry" = 1 ]; then echo "DRY: bytedcli bits mr update --mr-id $mr --wip"; exit 0; fi
    bytedcli bits mr update --mr-id "$mr" --wip >/dev/null
    echo "cr-group: MR $mr 已挂 WIP"
    ;;
  request)
    if [ -z "$mr" ]; then echo "cr-group: 无 MR，未拉群"; exit 3; fi
    if [ "$dry" = 1 ]; then
      echo "DRY: bytedcli bits mr reviewer info --mr-id $mr --json"
      echo "DRY: bytedcli bits mr chat create --mr-id $mr --json"
      echo "DRY: bytedcli bits mr chat add --mr-id $mr --username <各 reviewer> --member-type reviewer"
      echo "DRY: lark-cli im +messages-send --chat-id <解析所得> --text $msg"
      echo "DRY: threads.sh mark --ctx-dir $ctx cr_group_created"
      echo "DRY: bytedcli bits mr update --mr-id $mr --wip false"
      exit 0
    fi
    # 本人 username 从需求仓 git 配置读（ctx 固定在 <检出>/.harness-ceilf6/<分支> 两层之下），
    # 不依赖调用方 cwd——web.py 的工作目录不定
    repo_root=$(cd "$ctx/../.." && pwd -P)
    me=$(git -C "$repo_root" config user.name 2>/dev/null || true)
    rev=$(bytedcli bits mr reviewer info --mr-id "$mr" --json 2>/dev/null || echo '[]')
    reviewers=$(printf '%s' "$rev" | jq -r --arg me "$me" \
      '[.[]?.username // empty] | unique | .[] | select(. != "" and . != $me)' 2>/dev/null || true)
    created=1
    create_out=$(bytedcli bits mr chat create --mr-id "$mr" --json 2>/dev/null) \
      || { created=0; echo "cr-group: 警告——建群失败（群可能已存在），继续" >&2; }
    # added 是成功数而非尝试数：收尾行是唯一到达用户眼前的回执，鉴权过期导致全员拉失败时
    # 报「拉入 N 人」会让人以为已经喊到人
    added=0
    for u in $reviewers; do
      if bytedcli bits mr chat add --mr-id "$mr" --username "$u" --member-type reviewer >/dev/null 2>&1; then
        added=$((added + 1))
      else
        echo "cr-group: 警告——拉人失败：${u}（可能已在群内）" >&2
      fi
    done
    # 名单空可能是真空，也可能是 reviewer info 换了包装形状导致解析不出——两者都得让人看见
    if [ -z "$reviewers" ]; then
      echo "cr-group: 警告——未解析到任何 reviewer（名单为空或输出形状不符），群将无 reviewer，可手动拉人" >&2
    fi
    chat_id=$(printf '%s' "${create_out:-}" | jq -r 'first(.. | .chat_id? // empty)' 2>/dev/null || true)
    if [ -n "$chat_id" ]; then
      lark-cli im +messages-send --chat-id "$chat_id" --text "$msg" >/dev/null \
        || echo "cr-group: 警告——群已建但消息发送失败" >&2
    elif [ "$created" = 1 ]; then
      echo "cr-group: 群已建但消息未发（未解析到 chat_id）" >&2
    else
      echo "cr-group: 消息未发（建群失败且无 chat_id）" >&2
    fi
    bash "$TH" mark --ctx-dir "$ctx" cr_group_created
    bytedcli bits mr update --mr-id "$mr" --wip false >/dev/null 2>&1 || true
    echo "cr-group: 求CR 已发起（MR ${mr}，拉入 ${added} 人）"
    ;;
  *) usage ;;
esac
