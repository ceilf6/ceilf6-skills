#!/usr/bin/env bash
# MR 评审群与求CR。子命令：
#   group   --ctx-dir <路径> [--dry-run]                       建群并把 reviewer 拉进来
#   request --ctx-dir <路径> [--message <文案>] [--dry-run]     一键提醒 RD 并往群里发求CR消息
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

# 从 bits mr chat create 的应答里取群标识。真机应答把 chat_id 裸放在 data 字段
# （{"code":200,"data":"oc_…","message":"success"}），同时容忍任意层级的 chat_id 键；
# 裸字符串必须带 oc_ 前缀——失败应答的 data 可能是错误文案，不设前缀会把它当群标识落盘。
parse_chat_id() {
  printf '%s' "${1:-}" \
    | jq -r 'first((.. | .chat_id? // empty), (.data? | strings | select(startswith("oc_"))))' 2>/dev/null \
    || true
}

save_chat_id() { # <chat_id>：落 meta.cr_chat_id，供求CR 复用
  local tmp
  tmp=$(mktemp)
  jq --arg c "$1" '.cr_chat_id = $c' "$meta" > "$tmp" || die "meta 不可解析：$meta"
  mv "$tmp" "$meta"
}

# 降级发消息用的 bot 身份：优先 harness 自己的 bot（无人值守 bot 的 lark profile，
# 现读 harness-ceilf6-bot/config.json——群里喊人的是 harness 流程，应以 harness 的名义，
# 而非个人 CLI 应用）；bot 未部署时退回当前活跃应用。env HARNESS_LARK_BOT_PROFILE 可覆盖。
bot_profile() {
  if [ -n "${HARNESS_LARK_BOT_PROFILE:-}" ]; then printf '%s' "$HARNESS_LARK_BOT_PROFILE"; return; fi
  jq -r '.profile // empty' "$HERE/../../harness-ceilf6-bot/config.json" 2>/dev/null || true
}

# 群消息统一走这里：默认身份（用户）优先——消息以本人名义最自然。本企业安全管控
# 不放行 im:message.send_as_user 且不可申请开通，用户身份被拒时退到 bot 身份补发。
# bot 只能在群内发言，且 harness bot 无用户身份，故拉 bot 进群用本人用户身份
# （有 im:chat.members 写权限；bot 已在群时重复拉为幂等），发送才切 bot profile。
# 错误分类按文案匹配，形状按真机为准：不符只改本段。
send_group_msg() { # <chat_id> <text>；失败返回非零，die 文案由调用方定
  local chat_id="$1" text="$2" err app_id p
  if err=$(lark-cli im +messages-send --chat-id "$chat_id" --text "$text" 2>&1); then
    return 0
  fi
  case "$err" in
    *send_as_user*|*missing_scope*)
      p=$(bot_profile)
      app_id=$(lark-cli auth status --json ${p:+--profile "$p"} 2>/dev/null \
        | jq -r '.appId // empty' || true)
      if [ -n "$app_id" ]; then
        lark-cli im chat.members create --chat-id "$chat_id" --member-id-type app_id \
          --data "{\"id_list\":[\"${app_id}\"]}" --as user >/dev/null 2>&1 || true
      fi
      lark-cli im +messages-send --chat-id "$chat_id" --as bot --text "$text" \
        ${p:+--profile "$p"} >/dev/null 2>&1
      ;;
    *) return 1 ;;
  esac
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
      echo "DRY: bytedcli --json bits mr code-review start --mr-id ${mr}"
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
    # 平台坐标（group_name / project_id）：bytedcli 默认从 cwd 的 .bits/project_config.json 兜底，
    # 需求仓没有这个文件、web.py 的工作目录也不定。缺了它 code-review start 直接拒绝执行
    # （action_required），reviewer info 更隐蔽——静默回空数组，看着像「这个 MR 真没评审人」。
    # mr status 只认 --mr-id，用它现取坐标显式带给下面每条支持的子命令；取不到就照旧不带。
    scope=$(bytedcli bits mr status --mr-id "$mr" --json 2>/dev/null || true)
    gname=$(printf '%s' "$scope" | jq -r 'first((.. | objects | .group_name? // empty))' 2>/dev/null || true)
    pid=$(printf '%s' "$scope" | jq -r 'first((.. | objects | .project_id? // empty))' 2>/dev/null || true)
    [ -n "$gname$pid" ] || echo "cr-group: 警告——未取到 MR 的平台坐标，评审人名单可能不全" >&2
    # 拉群前确保平台代码评审已发起：分支代码评审人由平台按默认规则在 start 时拉取
    # （start_type=MANUALLY_BEGIN、fetch_mode=DEFAULT_RULE），未发起时 reviewer info 里只有
    # 全局 QA/RD 位，建群会只剩本人。已发起的重复 start 按幂等放行；平台 allow_review_wip=false，
    # WIP 挡住 start 时先摘 WIP 重试一次（走到拉群意味着自测已完成、代码已定，提前摘除站得住，
    # 「发起CR」步的摘 WIP 由此成幂等复核）。错误分类按文案匹配、形状按真机为准：不符只改本段。
    if ! start_err=$(bytedcli --json bits mr code-review start --mr-id "$mr" \
        ${gname:+--group-name "$gname"} ${pid:+--project-id "$pid"} 2>&1); then
      case "$start_err" in
        *RUNNING*|*running*|*已发起*|*already*)
          : ;;
        *WIP*|*wip*|*Wip*)
          bytedcli bits mr update --mr-id "$mr" --wip false >/dev/null 2>&1 || true
          bytedcli --json bits mr code-review start --mr-id "$mr" \
            ${gname:+--group-name "$gname"} ${pid:+--project-id "$pid"} >/dev/null 2>&1 \
            || echo "cr-group: 警告——摘 WIP 后发起代码评审仍失败，名单可能不全，可平台手点后重跑拉群" >&2 ;;
        *)
          echo "cr-group: 警告——发起代码评审失败（$(printf '%s' "$start_err" | tr '\n' ' ' | cut -c1-160)），名单可能不全" >&2 ;;
      esac
    fi
    rev=$(bytedcli bits mr reviewer info --mr-id "$mr" \
      ${gname:+--group-name "$gname"} ${pid:+--project-id "$pid"} --json 2>/dev/null || echo '[]')
    reviewers=$(printf '%s' "$rev" | jq -r --arg me "$me" \
      '[.[]?.username // empty] | unique | .[] | select(. != "" and . != $me)' 2>/dev/null || true)
    create_out=$(bytedcli bits mr chat create --mr-id "$mr" ${gname:+--group-name "$gname"} --json 2>/dev/null) \
      || echo "cr-group: 警告——建群失败（群可能已存在），继续" >&2
    # added 是成功数而非尝试数：收尾行是唯一到达用户眼前的回执，鉴权过期导致全员拉失败时
    # 报「拉入 N 人」会让人以为已经喊到人
    added=0
    for u in $reviewers; do
      if bytedcli bits mr chat add --mr-id "$mr" --username "$u" --member-type reviewer \
          ${gname:+--group-name "$gname"} >/dev/null 2>&1; then
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
      echo "DRY: bytedcli bits mr update --mr-id ${mr} --wip false"
      echo "DRY: bytedcli bits mr remind-review --mr-id ${mr}"
      echo "DRY: lark-cli im +messages-send --chat-id <meta.cr_chat_id 或现取> --text ${msg}"
      echo "DRY: threads.sh mark --ctx-dir ${ctx} cr_requested"
      exit 0
    fi
    # 摘 WIP 在前：走到发起CR 意味着代码已定，且 WIP 会挡住平台侧的提醒
    bytedcli bits mr update --mr-id "$mr" --wip false >/dev/null 2>&1 || true
    # 与 qa 步同构：先走 Bits 原生的一键提醒 RD——群里那张「邀请大家进行代码审查 @人」的卡片
    # 和 reviewer 的待办都由它派发，只发群消息的话 reviewer 的待办列表里没有这条
    bytedcli bits mr remind-review --mr-id "$mr" >/dev/null || die "一键提醒 RD 失败（MR ${mr}）"
    chat_id=$(jq -r '.cr_chat_id // empty' "$meta")
    if [ -z "$chat_id" ]; then
      # 拉群那步没能解析出群标识时的兜底：再问一次（create 对已存在的群通常会回既有信息）
      chat_id=$(parse_chat_id "$(bytedcli bits mr chat create --mr-id "$mr" --json 2>/dev/null || true)")
      [ -n "$chat_id" ] && save_chat_id "$chat_id"
    fi
    # 消息是本步唯一的实质动作：发不出去就不标完成，节点留黄可重试，
    # 否则「已求CR」会掩盖一条谁都没收到的消息
    [ -n "$chat_id" ] || die "未拿到群标识，消息未发出——请先完成拉群"
    send_group_msg "$chat_id" "$msg" || die "消息未发出（群 ${chat_id}）"
    bash "$TH" mark --ctx-dir "$ctx" cr_requested
    echo "cr-group: 已提醒 RD 并在群里求CR（MR ${mr}）"
    ;;

  qa)
    if [ -z "$mr" ]; then echo "cr-group: 无 MR，未发起QA"; exit 3; fi
    if [ "$dry" = 1 ]; then
      echo "DRY: bytedcli bits mr qa-status --mr-id ${mr} --json"
      echo "DRY: bytedcli bits mr remind-qa --mr-id ${mr}"
      echo "DRY: lark-cli im +messages-send --chat-id <meta.cr_chat_id> --text ${msg}"
      echo "DRY: threads.sh mark --ctx-dir ${ctx} qa_requested"
      exit 0
    fi
    # 一键提醒只对 MR 上已有的评审人生效：QA 位为空时接口照样回成功，群里却什么都不会出现
    # （Bits 页面上的「一键提醒 QA」此时同样是灰的）。静默的空提醒最误导人，先探一次
    qa_n=$(bytedcli bits mr qa-status --mr-id "$mr" --json 2>/dev/null \
      | jq -r '[.qa_review_info? // empty] | flatten | length' 2>/dev/null || echo 0)
    [ "${qa_n:-0}" != 0 ] \
      || echo "cr-group: 警告——MR 上没有 QA 评审人，一键提醒 QA 不会有人收到，请在 Bits 上先配 QA" >&2
    # 先走 Bits 原生的一键提醒 QA（QA 侧的待办由它派发），再往群里补一句给人看。
    # 提醒失败就不发群消息：只发消息不提醒是半吊子，QA 的待办列表里仍然没有这条
    bytedcli bits mr remind-qa --mr-id "$mr" >/dev/null || die "一键提醒 QA 失败（MR ${mr}）"
    chat_id=$(jq -r '.cr_chat_id // empty' "$meta")
    [ -n "$chat_id" ] || die "未拿到群标识，消息未发出——请先完成拉群"
    send_group_msg "$chat_id" "$msg" || die "已提醒 QA，但群消息未发出（群 ${chat_id}）"
    bash "$TH" mark --ctx-dir "$ctx" qa_requested
    echo "cr-group: 已提醒 QA 并在群里知会（MR ${mr}）"
    ;;

  *) usage ;;
esac
