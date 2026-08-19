#!/usr/bin/env bash
# bytedcli-meego 机械层单点：meego 条目的解析(resolve)/创建(create)/评论(comment)/排期(schedule)/
# done 流转(advance、done)/映射配置(map) 全部经本脚本，bytedcli meego 不在别处直调。
# 配置 ~/.bytedcli-meego/config.json 按仓库 slug 键控：仓库未绑定空间 → 输出 {"skipped":true} 且
# exit 0（个人仓豁免的机械表达，调用方据此静默略过）。
# 一切调用显式带 --project-key：simple_name 检索存在同名歧义（larksuite 撞 larksuite$，2026-08-11 实测）。
# 流转仅发生在 done 时刻（事实完成才流转，宁迟勿早——返工必在流转前，回滚场景由此不存在）。
set -euo pipefail
die() { echo "meego: $*" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || die "缺少依赖：jq"
command -v git >/dev/null 2>&1 || die "缺少依赖：git"
command -v bytedcli >/dev/null 2>&1 || die "缺少依赖：bytedcli"

CFG="${BYTEDCLI_MEEGO_CONFIG:-$HOME/.bytedcli-meego/config.json}"

usage() {
  cat >&2 <<'EOF'
用法：meego.sh resolve  (--ctx-dir <路径> | --repo <slug>) (--url <链接> | --id <id> --type story|issue)
      meego.sh create   (--ctx-dir <路径> | --repo <slug>) --title <标题> --description-file <文件> [--dry-run]
      meego.sh comment  (--ctx-dir <路径> | --repo <slug> --id <id>) (--message-file <文件> | --preset qa)
      meego.sh schedule (--ctx-dir <路径> | --repo <slug> --id <id> --type story|issue) --start <YYYY-MM-DD> --due <YYYY-MM-DD> [--points <数>]
      meego.sh advance  (--ctx-dir <路径> | --repo <slug> --id <id> --type story|issue) [--mr-id <MR id>]
      meego.sh done     --ctx-dir <路径>
      meego.sh map      get|set --repo <slug> [--json-file <文件>]
EOF
  exit 1
}

sub="${1:-}"; [ -n "$sub" ] || usage; shift
mapop=""
if [ "$sub" = map ]; then mapop="${1:-}"; case "$mapop" in get|set) shift ;; *) usage ;; esac; fi
ctx="" repo="" id="" wtype="" url_in="" title="" descfile="" msgfile="" preset="" start="" due="" points="" jsonfile="" dry="" mr_id_opt=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1; shift ;;
    --ctx-dir) ctx="${2:?--ctx-dir 需要值}"; shift 2 ;;
    --repo) repo="${2:?--repo 需要值}"; shift 2 ;;
    --id) id="${2:?--id 需要值}"; shift 2 ;;
    --type) wtype="${2:?--type 需要值}"; shift 2 ;;
    --url) url_in="${2:?--url 需要值}"; shift 2 ;;
    --title) title="${2:?--title 需要值}"; shift 2 ;;
    --description-file) descfile="${2:?--description-file 需要值}"; shift 2 ;;
    --message-file) msgfile="${2:?--message-file 需要值}"; shift 2 ;;
    --preset) preset="${2:?--preset 需要值}"; shift 2 ;;
    --start) start="${2:?--start 需要值}"; shift 2 ;;
    --due) due="${2:?--due 需要值}"; shift 2 ;;
    --points) points="${2:?--points 需要值}"; shift 2 ;;
    --json-file) jsonfile="${2:?--json-file 需要值}"; shift 2 ;;
    --mr-id) mr_id_opt="${2:?--mr-id 需要值}"; shift 2 ;;
    *) usage ;;
  esac
done

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
snippet() { printf '%s' "${1:-}" | tr -d '\r' | tr '\n' ' ' | cut -c1-200; }
# 其 stdout 要被解析的调用一律 2>"$ERRF"（禁 2>&1：错误文本混进应答会让解析失败伪装成应答异常），
# 报错取 err_tail；纯诊断调用不受此限。
ERRF=$(mktemp)
trap 'rm -f "$ERRF"' EXIT
err_tail() { tr -d '\r' < "$ERRF" | tail -3 | tr '\n' ' ' | cut -c1-300; }
cfg_write() { local tmp; tmp=$(mktemp); jq "$@" "$CFG" > "$tmp" || die "配置改写失败：$CFG"; mv "$tmp" "$CFG"; }
meta_write() { local tmp; tmp=$(mktemp); jq "$@" "$META" > "$tmp" || die "meta 改写失败：$META"; mv "$tmp" "$META"; }
# 应答载荷在 MCP 信封 .data.result.content[0].text（字符串化 JSON）。按真机为准：形状漂移只改本段。
# 非信封输入吐空且不中断管道，由调用方的 [ -n ] || die 给出带应答摘要的诊断。
mcp_text() { jq -r '.data.result.content[0].text // empty' 2>/dev/null || true; }

repo_slug() { # <仓根>：origin URL 归一为 host 后路径（lark/byteview-web）；无 origin 输出空
  local u
  u=$(git -C "$1" remote get-url origin 2>/dev/null) || { echo ""; return 0; }
  printf '%s' "$u" | sed -E 's#\.git$##; s#^[a-z+]+://[^/]+/##; s#^[^/]*@[^:]+:##'
}

# map 不需要 ctx / 空间配置齐备（它就是建配置的入口），先处理再走通用装载
if [ "$sub" = map ]; then
  [ -n "$repo" ] || usage
  if [ ! -f "$CFG" ]; then mkdir -p "$(dirname "$CFG")"; printf '{"repos":{}}\n' > "$CFG"; fi
  case "$mapop" in
    get) jq -c --arg r "$repo" '.repos[$r] // {}' "$CFG" ;;
    set)
      [ -n "$jsonfile" ] || usage
      jq -e . "$jsonfile" >/dev/null 2>&1 || die "映射 JSON 不合法：$jsonfile"
      cfg_write --arg r "$repo" --slurpfile m "$jsonfile" '.repos[$r] = $m[0]'
      echo "meego: 映射已落配置（repo ${repo}）" ;;
  esac
  exit 0
fi

META=""
if [ -n "$ctx" ]; then
  META="$ctx/meta.json"
  [ -f "$META" ] || die "缺 meta.json：$ctx（先 harness-context init）"
  repo_root=$(cd "$ctx/../.." && pwd -P)
  [ -n "$repo" ] || repo=$(repo_slug "$repo_root")
fi
[ -n "$repo" ] || die "定位不到仓库：--repo 或 --ctx-dir 必居其一（且 ctx 检出须有 origin）"

rc_cfg=$(jq -c --arg r "$repo" '.repos[$r] // empty' "$CFG" 2>/dev/null || true)
if [ -z "$rc_cfg" ]; then jq -n --arg r "$repo" '{skipped:true, repo:$r}'; exit 0; fi
PK=$(printf '%s' "$rc_cfg" | jq -r '.project_key // empty')
[ -n "$PK" ] || die "配置缺 project_key（repo ${repo}）：先 map set 落首次映射"

# ctx 模式下 id/type 缺省取 meta（resolve/create 除外：它们是写 meta 的入口）
if [ -n "$ctx" ] && [ "$sub" != resolve ] && [ "$sub" != create ]; then
  [ -n "$id" ] || id=$(jq -r '.meego_id // empty' "$META")
  [ -n "$wtype" ] || wtype=$(jq -r '.meego_type // empty' "$META")
fi

case "$sub" in
  resolve)
    if [ -n "$url_in" ]; then
      case "$url_in" in
        */story/detail/*) wtype=story ;;
        */issue/detail/*) wtype=issue ;;
        *) die "无法从链接解析工作项（期望 …/story/detail/<id> 或 …/issue/detail/<id>）：$url_in" ;;
      esac
      id=$(printf '%s' "$url_in" | sed -E 's#.*/(story|issue)/detail/([0-9]+).*#\2#')
    fi
    { [ -n "$id" ] && [ -n "$wtype" ]; } || die "resolve 需要 --url，或 --id 加 --type story|issue"
    case "$id" in ''|*[!0-9]*) die "工作项 id 非数字：$id" ;; esac
    case "$wtype" in story|issue) : ;; *) die "--type 只收 story|issue" ;; esac
    url_out="${url_in:-https://meego.larkoffice.com/$(printf '%s' "$rc_cfg" | jq -r '.space // "larksuite"')/${wtype}/detail/${id}}"
    if [ -n "$ctx" ]; then
      cur=$(jq -r '.meego_id // empty' "$META")
      if [ -n "$cur" ] && [ "$cur" != "$id" ]; then
        die "meta 已关联 meego ${cur}，拒绝换绑为 ${id}（确要换绑先人工清掉 meta 的 meego_* 字段）"
      fi
      meta_write --arg i "$id" --arg t "$wtype" --arg u "$url_out" \
        '.meego_id = $i | .meego_type = $t | .meego_url = $u'
    fi
    jq -n --arg i "$id" --arg t "$wtype" --arg u "$url_out" --arg p "$PK" \
      '{id:$i, type:$t, url:$u, project_key:$p}'
    ;;
  create)
    # ctx 模式落 meta（harness 主路径）；--repo 模式只建单并输出 id/url（harness 之外的存量 MR 补建）
    { [ -n "$title" ] && [ -n "$descfile" ]; } || usage
    [ -r "$descfile" ] || die "description 文件不可读：$descfile"
    if [ -n "$ctx" ]; then
      cur=$(jq -r '.meego_id // empty' "$META")
      [ -z "$cur" ] || die "meta 已关联 meego ${cur}，拒绝重复创建（续入复用既有条目）"
    fi
    TID=$(printf '%s' "$rc_cfg" | jq -r '.template_id // empty')
    [ -n "$TID" ] || die "配置缺 template_id（repo ${repo}）：先 map set 落首次映射"
    desc=$(cat "$descfile")
    # 走底层 workitem create：快捷 `meego create` 传不了模板必填自定义字段（498109 要求业务线、关联 Story），
    # 绑定空间的仓库必报 `{field} 必填`。必填项按仓库配置 story.create_fields 原样附加；
    # 配了 dev_roles 时把 dev_owner_key 挂到这些角色（如 tech_owner：技术评审 / 需求合入 节点 owner 由此而来）。
    # field_value 一律字符串：裸数字会被序列化成 float64 遭 thrift 拒收，对象/数组按 tojson 字符串化
    # （multi-select / role_owners 的入参形状即如此）。
    fields=$(printf '%s' "$rc_cfg" | jq -c --arg t "$TID" --arg n "$title" --arg d "$desc" '
      def s: if type == "string" then . elif type == "number" then tostring else tojson end;
      [ {field_key:"template", field_value:$t}, {field_key:"name", field_value:$n},
        {field_key:"description", field_value:$d} ]
      + (if ((.dev_owner_key // "") | tostring) != "" and ((.story.dev_roles // []) | length) > 0
         then [ {field_key:"role_owners",
                 field_value:([ .dev_owner_key as $o | .story.dev_roles[] | {role:., owners:[($o | tostring)]} ] | tojson)} ]
         else [] end)
      + [ (.story.create_fields // [])[] | {field_key, field_value:(.field_value | s)} ]') \
      || die "组装 create 字段失败（检查配置 story.create_fields 形状 [{field_key, field_value}] 与 story.dev_roles 形状 [角色key]）"
    if [ -n "$dry" ]; then
      bytedcli --json meego workitem create --project-key "$PK" --work-item-type story \
        --fields "$fields" --dry-run
      exit $?
    fi
    out=$(bytedcli --json meego workitem create --project-key "$PK" --work-item-type story \
      --fields "$fields" 2>"$ERRF") \
      || die "meego workitem create 失败：$(err_tail)"
    # 新条目 id 的键名按真机为准：递归找第一个数字型 work_item_id / id（同 cr-group.sh 手法）
    nid=$(printf '%s' "$out" | mcp_text | jq -r 'first(.. | objects | (.work_item_id? // .id? // empty) | select(type=="number" or (type=="string" and test("^[0-9]+$")))) // empty' 2>/dev/null | head -1)
    [ -n "$nid" ] || die "create 应答解析不出新条目 id：$(snippet "$out")"
    url_out="https://meego.larkoffice.com/$(printf '%s' "$rc_cfg" | jq -r '.space // "larksuite"')/story/detail/${nid}"
    [ -z "$ctx" ] || meta_write --arg i "$nid" --arg u "$url_out" \
      '.meego_id = ($i|tostring) | .meego_type = "story" | .meego_url = $u'
    jq -n --arg i "$nid" --arg u "$url_out" '{id:$i, url:$u}'
    ;;
  comment)
    [ -n "$id" ] || { jq -n '{skipped:true, reason:"无 meego 关联（meta 缺 meego_id）"}'; exit 0; }
    if [ -n "$preset" ]; then
      case "$preset" in
        qa)
          mr=$(jq -r '.mr_id // empty' "${META:-/dev/null}" 2>/dev/null || true)
          msg="【bot】已发起 QA 提测（MR ${mr:-未知}），辛苦验收。此为值班自动评论，最终以开发者复核为准。" ;;
        *) die "--preset 只收 qa" ;;
      esac
    else
      [ -n "$msgfile" ] || usage
      msg=$(cat "$msgfile" 2>/dev/null) || die "message 文件不可读：$msgfile"
      [ -n "$msg" ] || die "评论内容为空"
      case "$msg" in "【bot】"*) : ;; *) msg="【bot】${msg}" ;; esac
    fi
    out=$(bytedcli --json meego comment create --project-key "$PK" --work-item-id "$id" \
      --comment-content "$msg" 2>&1) || die "评论失败（条目 ${id}）：$(snippet "$out")"
    echo "meego: 已评论条目 ${id}"
    ;;
  schedule)
    [ -n "$id" ] || { jq -n '{skipped:true, reason:"无 meego 关联（meta 缺 meego_id）"}'; exit 0; }
    [ -n "$wtype" ] || die "缺工作项类型（meta.meego_type 或 --type）"
    { [ -n "$start" ] && [ -n "$due" ]; } || usage
    case "$points" in ''|*[!0-9]*) [ -z "$points" ] || die "--points 须为数字：$points" ;; esac
    if [ "$wtype" != story ]; then
      jq -n --arg t "$wtype" '{skipped:true, reason:("排期节点仅 story 有，type=" + $t)}'; exit 0
    fi
    SN=$(printf '%s' "$rc_cfg" | jq -r '.story.schedule_node // empty')
    [ -n "$SN" ] || die "配置缺 story.schedule_node（repo ${repo}）：先 map set 落首次映射"
    out=$(bytedcli --json meego node get --project-key "$PK" --work-item-id "$id" 2>"$ERRF") \
      || die "node get 失败（条目 ${id}）：$(err_tail)"
    nodes=$(printf '%s' "$out" | mcp_text)
    [ -n "$nodes" ] || die "node get 应答形状不符（条目 ${id}）：$(snippet "$out")"
    node_key=$(printf '%s' "$nodes" | jq -r --arg n "$SN" 'first(.list[]? | .basic | select(.name == $n) | .node_key) // empty')
    [ -n "$node_key" ] || die "条目 ${id} 无「${SN}」节点（节点流与配置不符，需重跑首次映射）"
    OWNER=$(printf '%s' "$rc_cfg" | jq -r '.dev_owner_key // empty')
    # 排期 JSON 形状按真机 update_node schema（2026-08-11 实测核对）：estimate_*_date 为
    # 按时区 00:00:00 的毫秒级时间戳（number），字符串日期会被 thrift 拒收；points 单位为天
    start_ms=$(( $(date -j -f "%Y-%m-%d %H:%M:%S" "$start 00:00:00" +%s 2>/dev/null || date -d "$start 00:00:00" +%s) * 1000 ))
    due_ms=$(( $(date -j -f "%Y-%m-%d %H:%M:%S" "$due 00:00:00" +%s 2>/dev/null || date -d "$due 00:00:00" +%s) * 1000 ))
    sched=$(jq -n -c --argjson s "$start_ms" --argjson d "$due_ms" --arg p "${points:-}" \
      '{estimate_start_date:$s, estimate_end_date:$d} + (if $p != "" then {points:($p|tonumber)} else {} end)')
    if [ -n "$OWNER" ]; then
      out=$(bytedcli --json meego node update --project-key "$PK" --work-item-id "$id" \
        --node-id "$node_key" --node-schedule "$sched" --node-owners "[\"${OWNER}\"]" 2>&1) \
        || die "排期回填失败（条目 ${id} 节点 ${SN}）：$(snippet "$out")"
    else
      out=$(bytedcli --json meego node update --project-key "$PK" --work-item-id "$id" \
        --node-id "$node_key" --node-schedule "$sched" 2>&1) \
        || die "排期回填失败（条目 ${id} 节点 ${SN}）：$(snippet "$out")"
    fi
    echo "meego: 已回填排期（条目 ${id} 节点 ${SN}，${start} → ${due}${points:+，估分 ${points}}）"
    ;;
  advance)
    [ -n "$id" ] || { jq -n '{skipped:true, reason:"无 meego 关联（meta 缺 meego_id）"}'; exit 0; }
    [ -n "$wtype" ] || die "缺工作项类型（meta.meego_type 或 --type）"
    OWNER=$(printf '%s' "$rc_cfg" | jq -r '.dev_owner_key // empty')
    [ -n "$OWNER" ] || die "配置缺 dev_owner_key（repo ${repo}）：先 map set 落首次映射"
    if [ "$wtype" = story ]; then
      # 「推到底」语义：done_transition 是按节点流顺序列出的、本端要经过的全部节点（含起点），
      # 从当前停留位置逐个 confirm 到最后一个；已完成的空转、映射里没有的跳过。
      # 他人 owner 的节点不代 confirm（等于替别人声称评审完成）——撞上即停下如实报位置，
      # 后续节点串行依赖它，不再空试；owner 为空的节点（如无 QA 的需求测试）视为可推。
      names=$(printf '%s' "$rc_cfg" | jq -r '.story.done_transition // [] | .[]')
      [ -n "$names" ] || die "配置缺 story.done_transition（repo ${repo}）：先 map set 落首次映射"
      # 表单占位 {{mr_url}}：ctx 模式取 meta.mr_id，--repo 模式取 --mr-id；都没有时含占位的表单项不填，
      # 让服务端的「{field} 必填」如实报出来
      mrid="$mr_id_opt"
      if [ -z "$mrid" ] && [ -n "$META" ]; then mrid=$(jq -r '.mr_id // empty' "$META"); fi
      mr_url=""; [ -z "$mrid" ] || mr_url="https://bits.bytedance.net/bytebus/devops/code/detail/${mrid}"
      # nodes 由 fetch_nodes 刷新，故不能在子 shell 里取（命令替换拿不回刷新结果）
      node_status() { printf '%s' "$nodes" | jq -r --arg n "$1" 'first(.list[]? | select(.basic.name == $n) | .basic.status) // empty'; }
      fetch_nodes() {
        out=$(bytedcli --json meego node get --project-key "$PK" --work-item-id "$id" 2>"$ERRF" </dev/null) \
          || die "node get 失败（条目 ${id}）：$(err_tail)"
        nodes=$(printf '%s' "$out" | mcp_text)
        [ -n "$nodes" ] || die "node get 应答形状不符（条目 ${id}）：$(snippet "$out")"
      }
      # 节点表单字段按角色分组授权（498109 的「是否支持私有化」属技术负责人组）：角色空着时
      # 任何人都无权编辑，服务端回 ErrEditFieldNoPermission。dev_roles 配置的角色缺本人就补上——
      # 只加本人、只加不删（早于 dev_roles 配置建的存量条目靠这一步自愈）。
      roles_cfg=$(printf '%s' "$rc_cfg" | jq -c '.story.dev_roles // []')
      if [ "$roles_cfg" != "[]" ]; then
        wout=$(bytedcli --json meego workitem get --project-key "$PK" --work-item-id "$id" 2>"$ERRF" </dev/null) \
          || die "workitem get 失败（条目 ${id}）：$(err_tail)"
        wattr=$(printf '%s' "$wout" | mcp_text)
        [ -n "$wattr" ] || die "workitem get 应答形状不符（条目 ${id}）：$(snippet "$wout")"
        miss=$(printf '%s' "$wattr" | jq -c --arg o "$OWNER" --argjson r "$roles_cfg" '
          [ .work_item_attribute.role_members[]? ] as $rm
          | [ $r[] | select(. as $k | ([ $rm[] | select(.key == $k) | .members[]?.key ] | index($o)) == null) ]')
        if [ "$miss" != "[]" ]; then
          rop=$(printf '%s' "$miss" | jq -c --arg o "$OWNER" '[ .[] | {role_key:., op:"add", user_keys:[$o]} ]')
          rout=$(bytedcli --json meego workitem update --project-key "$PK" --work-item-id "$id" \
            --role-operate "$rop" 2>&1 </dev/null) \
            || die "角色补位失败（$(printf '%s' "$miss" | jq -r 'join("、")')）：$(snippet "$rout")"
          echo "meego: 已补角色（$(printf '%s' "$miss" | jq -r 'join("、")')）"
        fi
      fi
      fetch_nodes
      fails=0
      while IFS= read -r n; do
        [ -n "$n" ] || continue
        node=$(printf '%s' "$nodes" | jq -c --arg n "$n" 'first(.list[]? | select(.basic.name == $n)) // empty')
        if [ -z "$node" ]; then echo "meego: 节点「${n}」在条目 ${id} 上不存在，跳过（节点流与映射不符？）"; continue; fi
        st=$(printf '%s' "$node" | jq -r '.basic.status // empty')
        if [ "$st" = finished ]; then echo "meego: 节点「${n}」已完成，空转"; continue; fi
        if ! printf '%s' "$node" | jq -e --arg o "$OWNER" \
             '([.assignees.owners[]?.user_key] | length == 0) or ([.assignees.owners[]?.user_key] | index($o) != null)' >/dev/null; then
          echo "meego: 节点「${n}」owner 非本人（dev_owner_key），拒绝流转，停在此处转人工"
          fails=$((fails+1)); break
        fi
        # 入参形状按真机（2026-08-14 实测）：transition 认单数 --node-id 且只收 node_key。
        # --node-ids 复数被工具忽略（服务端等同没传 → code=20018），节点名同样 20018——
        # 「节点名称或节点id」的 CLI help 文案不成立，别照抄。
        nk=$(printf '%s' "$node" | jq -r '.basic.node_key // empty')
        if [ -z "$nk" ]; then echo "meego: 节点「${n}」应答缺 node_key，跳过"; continue; fi
        # 必填表单按 node_forms[节点] 补，只补空值：用户在页面改过的以页面为准，不覆盖
        forms=$(printf '%s' "$rc_cfg" | jq -c --arg n "$n" '.story.node_forms[$n] // []')
        if [ "$forms" != "[]" ]; then
          fill=$(printf '%s' "$node" | jq -c --argjson f "$forms" --arg mr "$mr_url" '
            [ .form_items[]? | select(.value == null or .value == "" or .value == [] or .value == {}) | .field_key ] as $empty
            | [ $f[] | select(.field_key as $k | ($empty | index($k)) != null)
                | .field_value |= (if type == "string" then gsub("\\{\\{mr_url\\}\\}"; $mr) else tostring end)
                | select(.field_value != "") ]') \
            || die "组装节点「${n}」表单失败（检查配置 story.node_forms 形状：{节点名: [{field_key, field_value}]}）"
          if [ "$fill" != "[]" ]; then
            uout=$(bytedcli --json meego workitem update --project-key "$PK" --work-item-id "$id" \
              --fields "$fill" 2>&1 </dev/null) \
              || { echo "meego: 节点「${n}」表单回填失败：$(snippet "$uout")" >&2; fails=$((fails+1)); break; }
            echo "meego: 节点「${n}」已补必填表单（$(printf '%s' "$fill" | jq -r '[.[].field_key] | join("、")')）"
          fi
        fi
        # </dev/null 必须：循环体共享 heredoc 作 stdin，CLI 若读 stdin 会吞掉剩余节点名（静默漏流转）
        # 20016 可能只是上一节点刚 confirm、服务端还没把本节点推到 doing：重取节点流再试一次
        try=0 owner_try=0
        while :; do
          tout=$(bytedcli --json meego node transition --project-key "$PK" --work-item-id "$id" \
            --action confirm --node-id "$nk" 2>&1 </dev/null) && break
          case "$tout" in
            *ErrAPIReCompleteNode*|*"Node Is Completed"*) break ;;
            *ErrOwnerRequired*|*负责人必填*)
              # 设了「负责人必填」的节点 owner 空着不让 confirm。补本人再试一次——
              # 他人 owner 的节点在上面已停下，走到这里的只可能是空 owner
              if [ "$owner_try" = 0 ]; then
                owner_try=1
                if oout=$(bytedcli --json meego node update --project-key "$PK" --work-item-id "$id" \
                     --node-id "$nk" --node-owners "[\"${OWNER}\"]" 2>&1 </dev/null); then
                  echo "meego: 节点「${n}」负责人为空，已补本人"
                  fetch_nodes; continue
                fi
                echo "meego: 节点「${n}」补负责人失败：$(snippet "$oout")" >&2
              else
                echo "meego: 节点「${n}」补了负责人仍报必填：$(snippet "$tout")" >&2
              fi ;;
            *20016*|*ErrAPIOperateNotArrivedNode*|*"Node Is Not Arrived"*)
              if [ "$try" = 0 ]; then try=1; sleep "${MEEGO_RETRY_SLEEP:-2}"; fetch_nodes; continue; fi
              at=$(printf '%s' "$nodes" | jq -r '[.list[]? | select(.basic.status == "doing") | .basic.name] | join("、") | if . == "" then "未知" else . end')
              echo "meego: 节点「${n}」尚未到达（节点流停在「${at}」），前序节点未推进，转人工（参见 SKILL.md「转人工后的处理参考」）" >&2 ;;
            *) echo "meego: 节点「${n}」confirm 失败：$(snippet "$tout")" >&2 ;;
          esac
          fails=$((fails+1)); break 2
        done
        # 应答成功不等于节点真的完成（真机见过 exit 0 而节点仍 doing）：回读校验，否则看板收到的是假报告。
        # 首读可能撞上服务端传播延迟（真机 2026-08-19 见过 confirm 已生效、紧接的 node get 仍是 doing），
        # 隔一拍再读一次才判死。顺带刷新 nodes，后续节点的状态与表单值都取最新。
        fetch_nodes; nst=$(node_status "$n")
        if [ "$nst" != finished ]; then sleep "${MEEGO_RETRY_SLEEP:-2}"; fetch_nodes; nst=$(node_status "$n"); fi
        if [ "$nst" != finished ]; then
          echo "meego: 节点「${n}」confirm 应答成功但回读仍为 ${nst:-未知}，未生效，停下转人工" >&2
          fails=$((fails+1)); break
        fi
        echo "meego: 节点「${n}」已流转完成"
      done <<EOF
$names
EOF
      [ "$fails" = 0 ] || die "有 ${fails} 个节点未流转成功（advance 幂等，消掉上述原因后可重跑）"
    else
      DS=$(printf '%s' "$rc_cfg" | jq -r '.issue.done_state // empty')
      [ -n "$DS" ] || die "配置缺 issue.done_state（repo ${repo}）：先 map set 落首次映射"
      out=$(bytedcli --json meego state list --project-key "$PK" --work-item-id "$id" \
        --work-item-type 缺陷 --user-key "$OWNER" 2>"$ERRF") \
        || die "state list 失败（条目 ${id}）：$(err_tail)"
      states=$(printf '%s' "$out" | mcp_text)
      [ -n "$states" ] || die "state list 应答形状不符（条目 ${id}）：$(snippet "$out")"
      cur=$(printf '%s' "$states" | jq -r '.state_key // empty')
      if [ "$cur" = "$DS" ]; then echo "meego: 条目 ${id} 已在 ${DS} 状态，空转"; exit 0; fi
      tid=$(printf '%s' "$states" | jq -r --arg s "$DS" 'first(.transition[]? | select(.state_key == $s) | .id) // empty')
      [ -n "$tid" ] || die "当前状态 ${cur} 无到 ${DS} 的合法转移，转人工在 meego 上处理"
      # 必填确认表单一律转人工：CLI 传表单的形状未知，猜错会污染团队侧数据。
      # 判定按数组长度（缺 name 的字段 join 后为空串会漏拦），字段名仅用于文案。
      form_n=$(printf '%s' "$states" | jq -r --arg s "$DS" 'first(.transition[]? | select(.state_key == $s) | (.confirm_form // []) | length) // 0')
      form=$(printf '%s' "$states" | jq -r --arg s "$DS" '[first(.transition[]? | select(.state_key == $s)) | .confirm_form[]? | (.name // "（未命名字段）")] | join("、")')
      [ "$form_n" = 0 ] || die "转移 ${cur} → ${DS} 带必填确认表单（${form}），不代填，转人工"
      tout=$(bytedcli --json meego state transition --project-key "$PK" --work-item-id "$id" \
        --transition-id "$tid" 2>&1) || die "状态流转失败（条目 ${id}）：$(snippet "$tout")"
      echo "meego: 条目 ${id} 已流转到 ${DS}"
    fi
    ;;
  done)
    [ -n "$ctx" ] || usage
    mid=$(jq -r '.meego_id // empty' "$META")
    [ -n "$mid" ] || { jq -n '{skipped:true, reason:"无 meego 关联"}'; exit 0; }
    adv="ok"
    if ! adv_out=$(bash "$0" advance --ctx-dir "$ctx" 2>&1); then
      adv="failed: $(snippet "$adv_out")"
    else
      # 不变量：advance 的跳过/拒绝属如实报告，必须穿透 done 的 JSON 到达看板——exit 0 不等于全部流转。
      # 调用方只认 advance 值是否为 "ok"，故未流转在此改写为非 ok 文案（错配的 dev_owner_key
      # 与映射漂移只有这一条出路）。
      undone=$(printf '%s\n' "$adv_out" | grep -c -e '拒绝流转' -e '不存在，跳过' || true)
      if [ "${undone:-0}" -gt 0 ]; then
        first=$(printf '%s\n' "$adv_out" | grep -e '拒绝流转' -e '不存在，跳过' | head -1 | cut -c1-120)
        adv="ok，但 ${undone} 节点未流转：${first}"
      fi
    fi
    mr=$(jq -r '.mr_id // empty' "$META")
    cmt="ok"
    tmpmsg=$(mktemp)
    printf '【bot】MR %s 已合入，本需求交付收束。此为值班自动评论，最终以开发者复核为准。\n' "${mr:-未知}" > "$tmpmsg"
    if ! cmt_out=$(bash "$0" comment --ctx-dir "$ctx" --message-file "$tmpmsg" 2>&1); then cmt="failed: $(snippet "$cmt_out")"; fi
    rm -f "$tmpmsg"
    jq -n --arg a "$adv" --arg c "$cmt" '{advance:$a, comment:$c}'
    ;;
  *) usage ;;
esac
