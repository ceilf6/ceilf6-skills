#!/usr/bin/env bash
# MR 评审群与求CR。子命令：
#   group   --ctx-dir <路径> [--dry-run]                       建群并把 reviewer 拉进来
#   request --ctx-dir <路径> [--message <文案>] [--dry-run]     往群里发求CR消息
#   qa      --ctx-dir <路径> [--message <文案>] [--dry-run]     一键提醒 QA 并往群里发消息
#   wip     --ctx-dir <路径> [--dry-run]                       返工时给 MR 挂 WIP
# 拆成独立子命令是因为返工只需重新喊人：群一旦建成就长期有效，回退到开发再走一遍时不必重建。
# 名单不设配置：现读 MR 上建 MR 时自动配置的 reviewer（bits mr reviewer info）。
# 完成判据分两类——group 宽容（群多半已在，建群失败、拉人失败都只告警）；request 与 qa 严格
# （提醒或消息没送达就不标完成，节点留黄可重试），否则「已发起CR」「已发起QA」会掩盖没人收到消息。
# 群标识落 meta.cr_chat_id：建群那次拿到的 chat_id 是后续发消息的唯一入口。
# 无 MR 一律 exit 3（契约码，web.py 据此回 400）；meta 缺失阻断。
# 全部 bytedcli / lark-cli 调用收敛在本脚本，web.py 只转调。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
TH="$HERE/threads.sh"
die() { echo "cr-group: $*" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || die "缺少依赖：jq"
DEFAULT_MSG='大佬们，有空辛苦 CR 一下[送心]'
DEFAULT_QA_MSG='辛苦 QA 老师有空测一下[送心]'

usage() {
  cat >&2 <<'EOF'
用法：cr-group.sh group   --ctx-dir <路径> [--dry-run]
      cr-group.sh request --ctx-dir <路径> [--message <文案>] [--dry-run]
      cr-group.sh qa      --ctx-dir <路径> [--message <文案>] [--dry-run]
      cr-group.sh wip     --ctx-dir <路径> [--dry-run]
EOF
  exit 1
}

# 从 bits mr chat create 的应答里取群标识；应答形状按真机为准，故递归找第一个 chat_id
parse_chat_id() { printf '%s' "${1:-}" | jq -r 'first(.. | .chat_id? // empty)' 2>/dev/null || true; }

save_chat_id() { # <chat_id>：落 meta.cr_chat_id，供求CR 复用
  local tmp
  tmp=$(mktemp)
  jq --arg c "$1" '.cr_chat_id = $c' "$meta" > "$tmp" || die "meta 不可解析：$meta"
  mv "$tmp" "$meta"
}

sub="${1:-}"
[ -n "$sub" ] || usage
shift
ctx="" msg="" dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ctx-dir) ctx="${2:?--ctx-dir 需要值}"; shift 2 ;;
    --message) msg="${2:?--message 需要值}"; shift 2 ;;
    --dry-run) dry=1; shift ;;
    *) usage ;;
  esac
done
[ -n "$ctx" ] || usage
# 两条消息路径各有默认文案，--message 未给时按子命令取
if [ -z "$msg" ]; then
  case "$sub" in qa) msg="$DEFAULT_QA_MSG" ;; *) msg="$DEFAULT_MSG" ;; esac
fi
meta="$ctx/meta.json"
[ -f "$meta" ] || die "缺 meta.json：$ctx"
# mr_id 历史上 string / number 两种形态都有，jq -r 皆输出裸值
mr=$(jq -r '.mr_id // empty' "$meta")

case "$sub" in
  wip)
    if [ -z "$mr" ]; then echo "cr-group: 无 MR，跳过 WIP"; exit 0; fi
    if [ "$dry" = 1 ]; then echo "DRY: bytedcli bits mr update --mr-id ${mr} --wip"; exit 0; fi
    bytedcli bits mr update --mr-id "$mr" --wip >/dev/null
    echo "cr-group: MR ${mr} 已挂 WIP"
    ;;

  group)
    if [ -z "$mr" ]; then echo "cr-group: 无 MR，未拉群"; exit 3; fi
    if [ "$dry" = 1 ]; then
      echo "DRY: bytedcli bits mr reviewer info --mr-id ${mr} --json"
      echo "DRY: bytedcli bits mr chat create --mr-id ${mr} --json"
      echo "DRY: bytedcli bits mr chat add --mr-id ${mr} --username <各 reviewer> --member-type reviewer"
      echo "DRY: threads.sh mark --ctx-dir ${ctx} cr_group_created"
      exit 0
    fi
    # 本人 username 从需求仓 git 配置读（ctx 固定在 <检出>/.harness-ceilf6/<分支> 两层之下），
    # 不依赖调用方 cwd——web.py 的工作目录不定
    repo_root=$(cd "$ctx/../.." && pwd -P)
    me=$(git -C "$repo_root" config user.name 2>/dev/null || true)
    rev=$(bytedcli bits mr reviewer info --mr-id "$mr" --json 2>/dev/null || echo '[]')
    reviewers=$(printf '%s' "$rev" | jq -r --arg me "$me" \
      '[.[]?.username // empty] | unique | .[] | select(. != "" and . != $me)' 2>/dev/null || true)
    create_out=$(bytedcli bits mr chat create --mr-id "$mr" --json 2>/dev/null) \
      || echo "cr-group: 警告——建群失败（群可能已存在），继续" >&2
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
    chat_id=$(parse_chat_id "${create_out:-}")
    if [ -n "$chat_id" ]; then
      save_chat_id "$chat_id"
    elif [ -n "$(jq -r '.cr_chat_id // empty' "$meta")" ]; then
      # 返工重来时 create 多半失败（群已存在），沿用上次落盘的群标识
      chat_id=$(jq -r '.cr_chat_id' "$meta")
    else
      echo "cr-group: 警告——未拿到群标识，求CR 时会再试一次" >&2
    fi
    bash "$TH" mark --ctx-dir "$ctx" cr_group_created
    echo "cr-group: 群已就绪（MR ${mr}，拉入 ${added} 人）"
    ;;

  request)
    if [ -z "$mr" ]; then echo "cr-group: 无 MR，未发起CR"; exit 3; fi
    if [ "$dry" = 1 ]; then
      echo "DRY: lark-cli im +messages-send --chat-id <meta.cr_chat_id 或现取> --text ${msg}"
      echo "DRY: threads.sh mark --ctx-dir ${ctx} cr_requested"
      echo "DRY: bytedcli bits mr update --mr-id ${mr} --wip false"
      exit 0
    fi
    chat_id=$(jq -r '.cr_chat_id // empty' "$meta")
    if [ -z "$chat_id" ]; then
      # 拉群那步没能解析出群标识时的兜底：再问一次（create 对已存在的群通常会回既有信息）
      chat_id=$(parse_chat_id "$(bytedcli bits mr chat create --mr-id "$mr" --json 2>/dev/null || true)")
      [ -n "$chat_id" ] && save_chat_id "$chat_id"
    fi
    # 消息是本步唯一的实质动作：发不出去就不标完成，节点留黄可重试，
    # 否则「已求CR」会掩盖一条谁都没收到的消息
    [ -n "$chat_id" ] || die "未拿到群标识，消息未发出——请先完成拉群"
    lark-cli im +messages-send --chat-id "$chat_id" --text "$msg" >/dev/null \
      || die "消息未发出（群 ${chat_id}）"
    bash "$TH" mark --ctx-dir "$ctx" cr_requested
    bytedcli bits mr update --mr-id "$mr" --wip false >/dev/null 2>&1 || true
    echo "cr-group: 求CR 消息已发出（MR ${mr}）"
    ;;

  qa)
    if [ -z "$mr" ]; then echo "cr-group: 无 MR，未发起QA"; exit 3; fi
    if [ "$dry" = 1 ]; then
      echo "DRY: bytedcli bits mr remind-qa --mr-id ${mr}"
      echo "DRY: lark-cli im +messages-send --chat-id <meta.cr_chat_id> --text ${msg}"
      echo "DRY: threads.sh mark --ctx-dir ${ctx} qa_requested"
      exit 0
    fi
    # 先走 Bits 原生的一键提醒 QA（QA 侧的待办由它派发），再往群里补一句给人看。
    # 提醒失败就不发群消息：只发消息不提醒是半吊子，QA 的待办列表里仍然没有这条
    bytedcli bits mr remind-qa --mr-id "$mr" >/dev/null || die "一键提醒 QA 失败（MR ${mr}）"
    chat_id=$(jq -r '.cr_chat_id // empty' "$meta")
    [ -n "$chat_id" ] || die "未拿到群标识，消息未发出——请先完成拉群"
    lark-cli im +messages-send --chat-id "$chat_id" --text "$msg" >/dev/null \
      || die "已提醒 QA，但群消息未发出（群 ${chat_id}）"
    bash "$TH" mark --ctx-dir "$ctx" qa_requested
    echo "cr-group: 已提醒 QA 并在群里知会（MR ${mr}）"
    ;;

  *) usage ;;
esac
