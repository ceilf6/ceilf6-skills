#!/usr/bin/env bash
# MR 评论的拉取、水位、回复单点。bot 巡检（mrwatch）与 claude 会话（值班 / 交互手动处置）都只经本脚本
# 读写评论水位 $CTX/mr-comments.json——谁处理都推进同一份水位，避免「会话处理过、bot 再触发」。
#
# 来源：一次 `bytedcli codebase mr comment list` 拿齐 Codebase 应答里的 threads（讨论线程）与 review_notes
# （Review 提交附言），每条带 source。BITS 详情页（bits.bytedance.net/…/code/detail/<mr_id>）与 Codebase MR 页
# 展示的是同一份评论：BITS 自家的 CodeGuard 机器人评论就落在 Codebase 线程里，bytedcli 也没有 BITS 侧评论接口。
#
# 作者三分（快照里 author_kind / kind）：Username 等于 MR 作者 → self；CreatedBy.Type == app → bot；其余 → human。
# 「只回复机器人」落在机械层：reply 对 kind=human（有人工评审参与）的线程与 review_note 一律拒绝，人工评论
# 由开发者本人在页面处理。判定依据是最近一次 fetch 写入水位的 thread_kinds 缓存，reply 前须 fetch 过。
#
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
    '{mr_id:$m, threads:{}, thread_kinds:{}, trigger_count:0, auto_disabled:false, closed:false, consecutive_failures:0}' \
    > "$wm_init" || die "水位初始化失败：$WM"
  mv "$wm_init" "$WM"
fi
# MR 重建（旧的关掉重开）后，水位里的 repo/iid/threads/closed 仍指着上一个 MR——不清掉，回复会发到旧 MR 上。
# 熔断计数与 auto_disabled 不跟着清：换 MR 不该成为绕过熔断的口子。
wm_mr=$(jq -r '.mr_id // empty' "$WM" 2>/dev/null || true)
if [ "$wm_mr" != "$mr" ]; then
  wm_write --arg m "$mr" \
    '.mr_id = $m | del(.repo, .iid, .mr_url) | .threads = {} | .thread_kinds = {} | .closed = false | .consecutive_failures = 0'
fi

case "$sub" in
  fetch)
    repo=$(jq -r '.repo // empty' "$WM"); iid=$(jq -r '.iid // empty' "$WM")
    if [ -z "$repo" ] || [ -z "$iid" ]; then
      gl=$(bytedcli --json bits mr code-review gitlab --mr-id "$mr" 2>"$ERRF") \
        || fail4 "GitLab MR 解析调用失败（mr ${mr}）：$(err_tail)"
      # 真机应答：data.mrs[].host.{gitlab_url, iid, group_name, project_name}。repo 路径从 gitlab_url 截
      # （…/<namespace>/<project>/merge_requests/<iid>）——group_name 是 BITS 侧分组名，不是 Codebase 命名空间；
      # 显式的 project_path / path_with_namespace 键若存在则优先。
      # jq 的失败必须收进 fail4：裸 jq 会带着自己的退出码掀掉整个脚本，连败计数与 exit 4 契约都落空
      repo=$(printf '%s' "$gl" | jq -r '
        first(.. | objects | (.project_path? // .path_with_namespace? // empty))
        // (first(.. | objects | (.gitlab_url? // .web_url? // empty))
            | capture("^https?://[^/]+/(?<p>.+?)/(-/)?merge_requests/[0-9]+").p)
        // empty' 2>/dev/null) \
        || fail4 "GitLab MR 应答不是 JSON（mr ${mr}）：$(snippet "$gl")"
      iid=$(printf '%s' "$gl" | jq -r 'first(.. | objects | (.iid? // empty)) // empty' 2>/dev/null) \
        || fail4 "GitLab MR 应答不是 JSON（mr ${mr}）：$(snippet "$gl")"
      mr_url=$(printf '%s' "$gl" | jq -r 'first(.. | objects | (.gitlab_url? // .web_url? // empty)) // empty' 2>/dev/null || true)
      { [ -n "$repo" ] && [ -n "$iid" ]; } || fail4 "GitLab MR 解析不出 repo/iid（输出形状不符？）：$(snippet "$gl")"
      wm_write --arg r "$repo" --arg i "$iid" --arg u "$mr_url" '.repo = $r | .iid = $i | .mr_url = $u'
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
    # 应答里 merge_request.Status 直接说明 MR 是否已合入/关闭——不必等拉取失败再去探
    mr_state=$(printf '%s' "$out" | jq -r '.data.merge_request.Status // .data.merge_request.State // "" | ascii_downcase' 2>/dev/null) \
      || fail4 "comment list 应答不是 JSON（repo ${repo} iid ${iid}）：$(snippet "$out")"
    case "$mr_state" in
      merged|closed)
        wm_write '.closed = true'
        jq -n --arg m "$mr" '{mr_id:$m, closed:true}'
        exit 0 ;;
    esac
    # 本人 = MR 作者（应答自带，与 Codebase 用户名天然一致）；应答缺作者时退回需求仓 git user.name
    # （ctx 固定在 <检出>/.harness-ceilf6/<分支> 两层之下，同 cr-group.sh）
    me=$(printf '%s' "$out" | jq -r '.data.merge_request.CreatedBy.Username // empty' 2>/dev/null || true)
    if [ -z "$me" ]; then
      repo_root=$(cd "$ctx/../.." && pwd -P)
      me=$(git -C "$repo_root" config user.name 2>/dev/null || true)
    fi
    url_in=$(printf '%s' "$out" | jq -r '.data.merge_request.URL // empty' 2>/dev/null || true)
    if [ -n "$url_in" ] && [ "$(jq -r '.mr_url // empty' "$WM")" != "$url_in" ]; then
      wm_write --arg u "$url_in" '.mr_url = $u'
    fi
    # 线程归一（字段名按真机为准）：threads[].{Id,Status,Positions,Comments[].{Content,CreatedAt,CreatedBy.{Username,Type}}}；
    # review_notes 按 Comments 同构解析（真机样本为 0 时按此假定，缺 Id 的条目丢弃并在 stderr 报数）。
    norm=$(printf '%s' "$out" | jq --arg me "$me" '
      def kind_of: if ((.CreatedBy.Username // "") | tostring) == $me then "self"
                   elif (((.CreatedBy.Type // "") | tostring) | ascii_downcase) == "app" then "bot"
                   else "human" end;
      def as_reply: { author: ((.CreatedBy.Username // .CreatedBy.DisplayName.Content // "") | tostring),
                      author_kind: kind_of,
                      body: ((.Content // "") | tostring),
                      at: (.CreatedAt // null) };
      def thread_kind: if any(.replies[]; .author_kind == "human") then "human"
                       elif any(.replies[]; .author_kind == "bot") then "bot" else "self" end;
      ((.data.threads // []) | map(select(.Id != null and ((.Comments | type) == "array"))
        | { id: (.Id | tostring), source: "codebase_thread",
            resolved: ((((.Status // "") | tostring) | ascii_downcase) as $s | ($s == "resolved" or $s == "closed")),
            path: (.Positions[0]?.Path // .Comments[0].Position.Path // null),
            line: (.Positions[0]?.StartLine // .Comments[0].Position.StartLine // null),
            replies: [ .Comments[] | as_reply ] }
        | .kind = thread_kind))
      + ((.data.review_notes // []) | map(select(.Id != null)
        | { id: (.Id | tostring), source: "codebase_review_note", resolved: false, path: null, line: null,
            replies: [ as_reply ] }
        | .kind = thread_kind))' 2>/dev/null) \
      || fail4 "comment list 输出无法归一（非 JSON 或形状不符）：$(snippet "$out")"
    dropped=$(printf '%s' "$out" | jq '((.data.review_notes // []) | map(select(.Id == null)) | length)' 2>/dev/null || echo 0)
    [ "$dropped" = 0 ] || echo "mr-comments: 警告：${dropped} 条 review_note 缺 Id，已丢弃（形状与假定不符）" >&2
    snapshot=$(printf '%s' "$norm" | jq --arg me "$me" --arg m "$mr" --arg r "$repo" --arg i "$iid" \
      --arg u "$(jq -r '.mr_url // empty' "$WM")" --arg at "$(now)" --slurpfile wm "$WM" '
      ($wm[0].threads) as $seen
      | { mr_id:$m, repo:$r, iid:$i, mr_url:$u, me:$me, fetched_at:$at, closed:false, threads: .,
          new: [ .[]
                 | select(.resolved | not)
                 | ($seen[.id].reply_count // 0) as $known
                 | select((.replies | length) > $known)
                 | . + { new_replies: .replies[$known:] }
                 | select(any(.new_replies[]; .author_kind != "self"))
                 | { id, source, path, line,
                     handled_before: ($seen[.id].handled // null),
                     kind: (if any(.new_replies[]; .author_kind == "human") then "human" else "bot" end),
                     new_replies } ] }
      | .new_bot_count = ([.new[] | select(.kind == "bot")] | length)
      | .new_human_count = ([.new[] | select(.kind == "human")] | length)
      | ([.new[] | select(.kind == "bot")]) as $b
      | .loop_suspect = (($b | length) > 0 and all($b[]; .handled_before != null))') \
      || fail4 "快照构建失败（水位 ${WM} 不可解析？）"
    # thread_kinds 是 reply 守卫的依据：每次 fetch 全量刷新（线程一旦有人工参与就永久归 human）
    kinds=$(printf '%s' "$norm" | jq 'map({key: .id, value: {kind, source}}) | from_entries')
    wm_write --argjson k "$kinds" '.thread_kinds = $k | .consecutive_failures = 0'
    printf '%s\n' "$snapshot"
    ;;
  mark)
    [ -n "$snap" ] || usage
    [ -f "$snap" ] || die "快照不存在：$snap"
    # 快照由调用方传入，形状不保证：closed 快照（MR 合入时 fetch 只吐 mr_id+closed）与截断文件
    # 都会在下面的 jq 迭代里炸，而报错落在 wm_write 上、指着水位文件——看的人会去查错文件。
    snap_shape=$(jq -r '
      if (.closed // false) == true then "closed"
      elif ((.threads | type) != "array") or ((.new | type) != "array") then "malformed"
      else "ok" end' "$snap" 2>"$ERRF") || die "快照不是合法 JSON：${snap}（$(err_tail)）"
    case "$snap_shape" in
      closed) die "快照为 closed 形态（MR 已合入/关闭），无可推进：$snap" ;;
      malformed) die "快照缺 threads/new 数组（损坏或截断）：$snap" ;;
    esac
    # 串 MR 的快照会把重建防护刚清空的 threads 重新种回去（水位 mr_id 已在防护里与 meta 对齐）。
    # 缺 mr_id 的快照按同源放行：这里守的是喂错 MR，不是快照字段缺失。
    snap_mr=$(jq -r '.mr_id // empty' "$snap")
    { [ -z "$snap_mr" ] || [ "$snap_mr" = "$mr" ]; } || die "快照属 MR ${snap_mr}，当前水位是 MR ${mr}"
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
    # 只回复机器人：守卫落在这里，值班会话与交互会话都绕不过。依据是最近一次 fetch 的 thread_kinds 缓存。
    kind_info=$(jq -r --arg t "$thread" '.thread_kinds[$t] // empty | "\(.kind) \(.source)"' "$WM")
    [ -n "$kind_info" ] || die "线程 ${thread} 不在最近一次 fetch 的线程表里：先执行 fetch"
    t_kind=${kind_info%% *}; t_source=${kind_info#* }
    [ "$t_source" = codebase_thread ] || die "线程 ${thread} 是 ${t_source}，不走自动回复（在页面上处理）"
    [ "$t_kind" != human ] || die "线程 ${thread} 有人工评审参与，不自动回复——人工评论由开发者本人处理"
    # handled 落在回复成功之后：先落再发会让失败的线程被当成已处置，永远不再触发
    bytedcli codebase mr comment reply -R "$repo" "$iid" --thread-id "$thread" -b "$msg" >/dev/null \
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
