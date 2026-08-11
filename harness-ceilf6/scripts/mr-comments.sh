#!/usr/bin/env bash
# MR 评论的拉取、水位、回复单点。bot 巡检（mrwatch）与 claude 会话（交互模式手动处置）都只经
# 本脚本读写评论水位 $CTX/mr-comments.json——谁处理都推进同一份水位，避免「会话处理过、bot 再触发」。
# 子命令：
#   fetch   --ctx-dir <路径>                                    拉全量线程，与水位 diff，快照打到 stdout
#   mark    --ctx-dir <路径> --from-snapshot <文件> [--count-trigger]   按快照推进水位（--count-trigger 计熔断配额）
#   reply   --ctx-dir <路径> --thread <id> --message-file <文件> [--handled fixed|rejected|pending_user]
#   enable  --ctx-dir <路径>     熔断人工复位（清 auto_disabled 与 trigger_count）
#   disable --ctx-dir <路径>     置 auto_disabled
# 无 MR 一律 exit 3（与 cr-group.sh 同契约码）；fetch 拉取失败 exit 4（巡检据此计连败）。
# 回复强制【bot】前缀：措辞红线落在机械层，调用方想漏都漏不掉。
set -euo pipefail
die() { echo "mr-comments: $*" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || die "缺少依赖：jq"
command -v git >/dev/null 2>&1 || die "缺少依赖：git"
command -v bytedcli >/dev/null 2>&1 || die "缺少依赖：bytedcli"

usage() {
  cat >&2 <<'EOF'
用法：mr-comments.sh fetch   --ctx-dir <路径>
      mr-comments.sh mark    --ctx-dir <路径> --from-snapshot <文件> [--count-trigger]
      mr-comments.sh reply   --ctx-dir <路径> --thread <id> --message-file <文件> [--handled fixed|rejected|pending_user]
      mr-comments.sh enable|disable --ctx-dir <路径>
EOF
  exit 1
}

sub="${1:-}"; [ -n "$sub" ] || usage; shift
ctx="" snap="" thread="" msgfile="" handled="" count_trigger=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ctx-dir) ctx="${2:?--ctx-dir 需要值}"; shift 2 ;;
    --from-snapshot) snap="${2:?--from-snapshot 需要值}"; shift 2 ;;
    --thread) thread="${2:?--thread 需要值}"; shift 2 ;;
    --message-file) msgfile="${2:?--message-file 需要值}"; shift 2 ;;
    --handled) handled="${2:?--handled 需要值}"; shift 2 ;;
    --count-trigger) count_trigger=1; shift ;;
    *) usage ;;
  esac
done
[ -n "$ctx" ] || usage
meta="$ctx/meta.json"
[ -f "$meta" ] || die "缺 meta.json：$ctx"
mr=$(jq -r '.mr_id // empty' "$meta")
if [ -z "$mr" ]; then echo "mr-comments: 无 MR"; exit 3; fi
WM="$ctx/mr-comments.json"
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# 外部调用的 stderr 收在这里：无人值守时 fail4 那行诊断是唯一现场，stderr 丢了就只剩一个 exit 4
ERRF=$(mktemp)
trap 'rm -f "$ERRF"' EXIT
err_tail() { tr -d '\r' < "$ERRF" | tail -3 | tr '\n' ' ' | cut -c1-300; }
# 应答不是 JSON（鉴权过期横幅之类）时截一段原文进诊断：jq 的解析错误本身说不出是谁吐的
snippet() { printf '%s' "${1:-}" | tr -d '\r' | tr '\n' ' ' | cut -c1-200; }

wm_write() { # <jq 参数...>：原子改写水位（tmp+mv，与 meta.json 同手法）
  local tmp; tmp=$(mktemp)
  jq "$@" "$WM" > "$tmp" || die "水位改写失败：$WM"
  mv "$tmp" "$WM"
}
fail4() { wm_write '.consecutive_failures += 1'; echo "mr-comments: $*" >&2; exit 4; }

# 首次使用即初始化空水位：MR 建成时可能已有机器人评论，它们也要走一遍 new 判定
if [ ! -f "$WM" ]; then
  wm_init=$(mktemp)
  jq -n --arg m "$mr" \
    '{mr_id:$m, threads:{}, trigger_count:0, auto_disabled:false, closed:false, consecutive_failures:0}' \
    > "$wm_init" || die "水位初始化失败：$WM"
  mv "$wm_init" "$WM"
fi
# MR 重建（旧的关掉重开）后，水位里的 repo/iid/threads/closed 仍指着上一个 MR——不清掉，回复会发到旧 MR 上。
# 熔断计数与 auto_disabled 不跟着清：换 MR 不该成为绕过熔断的口子。
wm_mr=$(jq -r '.mr_id // empty' "$WM" 2>/dev/null || true)
if [ "$wm_mr" != "$mr" ]; then
  wm_write --arg m "$mr" \
    '.mr_id = $m | del(.repo, .iid) | .threads = {} | .closed = false | .consecutive_failures = 0'
fi

case "$sub" in
  fetch)
    repo=$(jq -r '.repo // empty' "$WM"); iid=$(jq -r '.iid // empty' "$WM")
    if [ -z "$repo" ] || [ -z "$iid" ]; then
      gl=$(bytedcli --json bits mr code-review gitlab --mr-id "$mr" 2>"$ERRF") \
        || fail4 "GitLab MR 解析调用失败（mr ${mr}）：$(err_tail)"
      # 应答形状按真机为准（同 cr-group.sh parse_chat_id 手法）：递归找第一个命中的键；真机不符只改本段。
      # jq 的失败必须收进 fail4：裸 jq 会带着自己的退出码掀掉整个脚本，连败计数与 exit 4 契约都落空
      repo=$(printf '%s' "$gl" | jq -r 'first(.. | objects | (.project_path? // .path_with_namespace? // empty)) // empty' 2>/dev/null) \
        || fail4 "GitLab MR 应答不是 JSON（mr ${mr}）：$(snippet "$gl")"
      iid=$(printf '%s' "$gl" | jq -r 'first(.. | objects | (.iid? // empty)) // empty' 2>/dev/null) \
        || fail4 "GitLab MR 应答不是 JSON（mr ${mr}）：$(snippet "$gl")"
      { [ -n "$repo" ] && [ -n "$iid" ]; } || fail4 "GitLab MR 解析不出 repo/iid（输出形状不符？）：$(snippet "$gl")"
      wm_write --arg r "$repo" --arg i "$iid" '.repo = $r | .iid = $i'
    fi
    out=$(bytedcli --json codebase mr comment list -R "$repo" "$iid" 2>"$ERRF") || {
      list_err=$(err_tail)
      # 拉取失败先探一次 MR 状态：合入/关闭是正常终点，不是故障
      st=$(bytedcli --json bits mr status --mr-id "$mr" 2>"$ERRF" || true)
      st_err=$(err_tail)
      # 状态探测是尽力而为：应答不可解析时落空串，照常按拉取失败计连败，不能反过来掀掉 exit 4 契约
      state=$(printf '%s' "$st" | jq -r 'first(.. | objects | (.state? // .status? // empty)) // empty' 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)
      case "$state" in
        merged|closed)
          wm_write '.closed = true'
          jq -n --arg m "$mr" '{mr_id:$m, closed:true}'
          exit 0 ;;
      esac
      fail4 "comment list 拉取失败（repo ${repo} iid ${iid}）：${list_err}${st_err:+ | mr status: ${st_err}}"
    }
    # 本人 username 从需求仓 git 配置读（ctx 固定在 <检出>/.harness-ceilf6/<分支> 两层之下，同 cr-group.sh）
    repo_root=$(cd "$ctx/../.." && pwd -P)
    me=$(git -C "$repo_root" config user.name 2>/dev/null || true)
    # 线程归一：字段名按真机为准，递归收集「有 id + 回复数组」形状的对象；真机不符只改本段 jq
    norm=$(printf '%s' "$out" | jq '
      [.. | objects
        | select((.id? // .Id?) != null and (((.comments? // .Comments? // .notes?) | type) == "array"))
        | { id: ((.id // .Id) | tostring),
            resolved: ((((.resolved // .Resolved // "") | tostring) | ascii_downcase) == "true"),
            replies: [ (.comments // .Comments // .notes)[]
                       | { author: ((.author.username? // .author.name? // .author? // "") | tostring),
                           body: ((.body // .Body // .content // "") | tostring) } ] } ]' 2>/dev/null) \
      || fail4 "comment list 输出无法归一（非 JSON 或形状不符）：$(snippet "$out")"
    snapshot=$(printf '%s' "$norm" | jq --arg me "$me" --arg m "$mr" --arg r "$repo" --arg i "$iid" \
      --arg at "$(now)" --slurpfile wm "$WM" '
      ($wm[0].threads) as $seen
      | { mr_id:$m, repo:$r, iid:$i, fetched_at:$at, closed:false, threads: .,
          new: [ .[]
                 | select(.resolved | not)
                 | ($seen[.id].reply_count // 0) as $known
                 | select((.replies | length) > $known)
                 | { id, handled_before: ($seen[.id].handled // null), new_replies: .replies[$known:] }
                 | select([.new_replies[].author] | any(. != $me)) ] }
      | .loop_suspect = ((.new | length) > 0 and ([.new[] | .handled_before != null] | all))') \
      || fail4 "快照构建失败（水位 ${WM} 不可解析？）"
    wm_write '.consecutive_failures = 0'
    printf '%s\n' "$snapshot"
    ;;
  mark)
    [ -n "$snap" ] || usage
    [ -f "$snap" ] || die "快照不存在：$snap"
    wm_write --slurpfile s "$snap" --arg at "$(now)" --argjson ct "$count_trigger" '
      ($s[0]) as $sn
      | .threads = (reduce $sn.threads[] as $t (.threads;
          .[$t.id] = ((.[$t.id] // {}) + { reply_count: ($t.replies | length), resolved: $t.resolved })))
      | (reduce $sn.new[] as $n (.; .threads[$n.id].triggered_at = $at))
      | .trigger_count = (if $ct == 1 then .trigger_count + 1 else .trigger_count end)
      | .last_poll_at = $at'
    echo "mr-comments: 水位已推进（$(jq -r '.new | length' "$snap") 条新评论线程）"
    ;;
  reply)
    { [ -n "$thread" ] && [ -n "$msgfile" ]; } || usage
    msg=$(cat "$msgfile" 2>/dev/null) || die "message 文件不可读：$msgfile"
    [ -n "$msg" ] || die "回复内容为空"
    case "$msg" in "【bot】"*) : ;; *) msg="【bot】${msg}" ;; esac
    if [ -n "$handled" ]; then
      case "$handled" in fixed|rejected|pending_user) : ;; *) die "--handled 只收 fixed|rejected|pending_user" ;; esac
    fi
    repo=$(jq -r '.repo // empty' "$WM"); iid=$(jq -r '.iid // empty' "$WM")
    { [ -n "$repo" ] && [ -n "$iid" ]; } || die "水位缺 repo/iid：先执行 fetch"
    # handled 落在回复成功之后：先落再发会让失败的线程被当成已处置，永远不再触发
    bytedcli codebase mr comment reply -R "$repo" "$iid" --thread "$thread" -m "$msg" >/dev/null \
      || die "回复失败（thread ${thread}），handled 未落位，可重试"
    if [ -n "$handled" ]; then
      wm_write --arg t "$thread" --arg h "$handled" '.threads[$t] = ((.threads[$t] // {}) + {handled:$h})'
    fi
    echo "mr-comments: 已回复 thread ${thread}${handled:+（handled=${handled}）}"
    ;;
  enable)
    wm_write '.auto_disabled = false | .trigger_count = 0'
    echo "mr-comments: 已复位（auto_disabled=false，trigger_count=0）"
    ;;
  disable)
    wm_write '.auto_disabled = true'
    echo "mr-comments: 已停用自动触发"
    ;;
  *) usage ;;
esac
