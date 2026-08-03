#!/usr/bin/env bash
# harness 线程全局登记与唤回。子命令：register | list | resume | prune
#
# 登记表只存指针（ctx_dir/cwd/branch/session_id/title/registered_at），状态现读各自 meta.json——
# 否则登记表会变成需要跟随需求进展更新的第二真源，必然漂移。
# 写入用 append + 读时 last-wins，不做读-改-写：多条 harness 线程并行时读改写会丢更新。
#
# 唤回必须由用户的 shell 执行：resume 等于起一个新 claude 进程接管终端，
# 跑在已有会话里的 agent 做不到这件事——这也是本功能做成 PATH 命令而非技能的原因。
set -euo pipefail

die() { echo "harness-threads: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "缺少依赖：$1"; }
need jq; need git

REG="${HARNESS_THREADS_FILE:-$HOME/.harness-ceilf6/threads.jsonl}"
# 字段分隔用 \037（US）而非 tab：tab 属 IFS 空白字符，read 会折叠连续 tab，
# 空字段（如未给 --title）将导致后续字段整体左移、cur/sess 取到错值。
SEP=$'\037'
PROJ="${CLAUDE_PROJECTS_DIR:-$HOME/.claude/projects}"

# ---- 里程碑：meta.milestones.<节点>=完成时间戳，缺键=未完成，顺序即交付管道 ----
# cr_passed 只由 cr-round.sh 内联写；其余节点全部经 mark 单点写入，三条确认渠道共用。
MILESTONES="plan_gate dev_done cr_passed mr_created human_cr_done selftest_done"

milestone_label() { # 节点内部名 → 进度图段名
  case "$1" in
    plan_gate) echo "计划门" ;;
    dev_done) echo "开发" ;;
    cr_passed) echo "机审CR" ;;
    mr_created) echo "建MR" ;;
    human_cr_done) echo "人工CR" ;;
    selftest_done) echo "自测" ;;
  esac
}

node_label() { # 当前节点内部名 → 列表「节点」列文案；空串=六节点全齐
  case "$1" in
    plan_gate) echo "规划中" ;;
    dev_done) echo "开发中" ;;
    cr_passed) echo "机审中" ;;
    mr_created) echo "待建MR" ;;
    human_cr_done) echo "待人工CR" ;;
    selftest_done) echo "待自测" ;;
    "") echo "可交付" ;;
  esac
}

current_node() { # <meta.json> → 第一个缺键节点名；全齐输出空串；无 milestones 字段或 meta 不可解析均输出 -（按全未完成降级）
  jq -e . "$1" >/dev/null 2>&1 || { echo "-"; return 0; }
  jq -r --arg order "$MILESTONES" '
    if (.milestones | type) != "object" then "-"
    else .milestones as $ms
      | ($order | split(" ")) | map(select(($ms[.] // "") == "")) | first // ""
    end' "$1"
}

progress_line() { # <meta.json> → 一行进度图；机审CR 段带已有轮数
  local meta="$1" ctx cur m sym label parts="" reached=0 rounds
  ctx=$(dirname "$meta")
  cur=$(current_node "$meta")
  [ "$cur" = "-" ] && cur="plan_gate"   # 无 milestones 字段按全未完成渲染
  for m in $MILESTONES; do
    label=$(milestone_label "$m")
    if [ "$m" = cr_passed ]; then
      rounds=$(find "$ctx/cr" -maxdepth 1 -name 'round-*' 2>/dev/null | grep -c . || true)
      [ "$rounds" != 0 ] && label="${label}(${rounds}轮)"
    fi
    if [ "$m" = "$cur" ]; then sym="◉"; reached=1
    elif [ "$reached" = 0 ]; then sym="●"
    else sym="○"; fi
    [ -n "$parts" ] && parts="${parts} → "
    parts="${parts}${sym} ${label}"
    [ "$m" = "$cur" ] && parts="${parts}（当前）"
  done
  if [ -z "$cur" ]; then parts="${parts} → ● 可交付"; else parts="${parts} → ○ 可交付"; fi
  printf '%s\n' "$parts"
}

alias_to_node() { # 人工节点别名；序号/关键词形式只收这两个，防手滑改写自动节点
  case "$1" in
    human-cr) echo human_cr_done ;;
    selftest) echo selftest_done ;;
    *) echo "" ;;
  esac
}

mark_write() { # <ctx目录> <节点内部名>：幂等不覆盖、乱序警告放行、拒绝 cr_passed
  local ctx="$1" node="$2" meta="$1/meta.json" tmp prev missing="" m2
  [ -f "$meta" ] || die "缺 meta.json：${ctx}"
  case " $MILESTONES " in *" $node "*) ;; *) die "未知节点：${node}（可用：${MILESTONES// cr_passed/}）" ;; esac
  [ "$node" = cr_passed ] && die "cr_passed 由 cr-round.sh 写入，不接受人工 mark"
  prev=$(jq -r --arg k "$node" '.milestones[$k] // empty' "$meta")
  if [ -n "$prev" ]; then
    echo "harness-threads: ${node} 已于 ${prev} 完成，不覆盖"
    progress_line "$meta"
    return 0
  fi
  # 乱序只警告不拦：现实里节点常被跳过或补记，硬序会把人卡死在登记这一步
  for m2 in $MILESTONES; do
    if [ "$m2" = "$node" ]; then break; fi
    if ! jq -e --arg k "$m2" '.milestones[$k] // empty' "$meta" >/dev/null; then
      missing="${missing:+$missing }$m2"
    fi
  done
  if [ -n "$missing" ]; then
    echo "harness-threads: 警告——前序节点未完成（${missing}），仍记录 ${node}" >&2
  fi
  tmp=$(mktemp)
  jq --arg k "$node" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.milestones[$k] = $t' "$meta" > "$tmp" && mv "$tmp" "$meta"
  echo "harness-threads: 已标记 ${node}"
  progress_line "$meta"
}

cmd_progress() {
  local ctx=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --ctx-dir) ctx="${2:?--ctx-dir 需要值}"; shift 2 ;;
      *) usage ;;
    esac
  done
  [ -n "$ctx" ] || die "progress 需要 --ctx-dir"
  [ -f "$ctx/meta.json" ] || die "缺 meta.json：${ctx}"
  progress_line "$ctx/meta.json"
}

cmd_mark() {
  local ctx="" a="" b="" node
  while [ $# -gt 0 ]; do
    case "$1" in
      --ctx-dir) ctx="${2:?--ctx-dir 需要值}"; shift 2 ;;
      -*) usage ;;
      *) if [ -z "$a" ]; then a="$1"; elif [ -z "$b" ]; then b="$1"; else usage; fi; shift ;;
    esac
  done
  if [ -n "$ctx" ]; then
    [ -n "$a" ] && [ -z "$b" ] || die "用法：mark --ctx-dir <路径> <节点>"
    mark_write "$ctx" "$a"
    return 0
  fi
  [ -n "$a" ] && [ -n "$b" ] || die "用法：mark <序号|关键词> <human-cr|selftest>"
  node=$(alias_to_node "$b")
  [ -n "$node" ] || die "序号/关键词形式只接受人工节点：human-cr | selftest"
  local matches idx c cwd branch sid title status cur sess nodecol
  matches=$(locate_thread "$a") || exit $?
  IFS="$SEP" read -r idx c cwd branch sid title status cur sess nodecol <<EOF
$matches
EOF
  mark_write "$c" "$node"
}

usage() {
  cat >&2 <<'EOF'
用法（harness-threads 与短别名 ht 等价）:
  ht [list] [--all] [--json]   列出线程（默认隐藏 status=done）
  ht register --ctx-dir <路径> [--title <短题>] [--session-id <id>]
  ht resume <序号|关键词> [--dry-run]
  ht prune              清除 ctx 目录已消失的登记行
  ht mark <序号|关键词> <human-cr|selftest>   标记人工节点完成
  ht mark --ctx-dir <路径> <节点>             直指形式（cr_passed 除外，供会话流程）
  ht progress --ctx-dir <路径>      输出该线程节点进度图
  ht web [--port 7657]              本地节点看板（127.0.0.1）
EOF
  exit 1
}

# ---- 读取：按 ctx_dir 取最后一条（last-wins），再按登记时间倒序 ----
rows() {
  [ -f "$REG" ] || return 0
  # 逐行 fromjson? 跳过坏行；max_by(.key) 取文件中最后出现的那条
  jq -R 'fromjson? // empty' "$REG" | jq -c -s '
    to_entries | group_by(.value.ctx_dir) | map(max_by(.key).value)
    | sort_by(.registered_at) | reverse | .[]'
}

# 输出分隔字段：idx ctx cwd branch sid title status cur_branch sess_ok node_label
enumerate() {
  local show_all="$1" idx=0 line ctx cwd branch sid title status cur sess f node nodecol
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    ctx=$(printf '%s' "$line" | jq -r '.ctx_dir // ""')
    cwd=$(printf '%s' "$line" | jq -r '.cwd // ""')
    branch=$(printf '%s' "$line" | jq -r '.branch // ""')
    sid=$(printf '%s' "$line" | jq -r '.session_id // ""')
    title=$(printf '%s' "$line" | jq -r '.title // ""')
    if [ -f "$ctx/meta.json" ]; then
      status=$(jq -r '.status // "?"' "$ctx/meta.json")
      node=$(current_node "$ctx/meta.json")
      if [ "$node" = "-" ]; then nodecol="-"; else nodecol=$(node_label "$node"); fi
    else
      status="[失效]"   # ctx 目录已消失（检出被删 / worktree 被清）
      nodecol="-"
    fi
    if [ "$show_all" != 1 ] && [ "$status" = done ]; then continue; fi
    cur=$(git -C "$cwd" symbolic-ref --short -q HEAD 2>/dev/null || echo "")
    sess=0
    if [ -n "$sid" ]; then
      for f in "$PROJ"/*/"${sid}.jsonl"; do
        if [ -f "$f" ]; then sess=1; break; fi
      done
    fi
    idx=$((idx + 1))
    printf '%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s\n' \
      "$idx" "$SEP" "$ctx" "$SEP" "$cwd" "$SEP" "$branch" "$SEP" "$sid" "$SEP" \
      "$title" "$SEP" "$status" "$SEP" "$cur" "$SEP" "$sess" "$SEP" "$nodecol"
  done < <(rows)
}

# harness 线程都是无人值守/半无人值守跑，唤回默认全权限，免得恢复后卡在权限确认上
CLAUDE_CMD="claude --dangerously-skip-permissions"

# 唤回命令：会话恢复的只是对话，工作区是该目录此刻的样子——分支漂移时必须先切回需求分支
wake_cmd() {
  local cwd="$1" branch="$2" sid="$3" cur="$4" c
  c="cd $cwd"
  if [ -n "$sid" ]; then
    if [ "$cur" != "$branch" ]; then c="$c && git checkout $branch"; fi
    c="$c && $CLAUDE_CMD --resume $sid"
  else
    c="$c && $CLAUDE_CMD   # 无 session_id：新开会话，装载 harness-context 续入"
  fi
  printf '%s' "$c"
}

# 同 wake_cmd，但拆成两行便于逐行复制：cd 一行，切分支+恢复一行。
# 命令行一律顶格不缩进：终端整行复制时不带前导空格。
wake_lines() {
  local cwd="$1" branch="$2" sid="$3" cur="$4" second
  printf 'cd %s\n' "$cwd"
  if [ -n "$sid" ]; then
    second="$CLAUDE_CMD --resume $sid"
    if [ "$cur" != "$branch" ]; then second="git checkout $branch && $second"; fi
  else
    second="$CLAUDE_CMD   # 无 session_id：新开会话，装载 harness-context 续入"
  fi
  printf '%s\n' "$second"
}

cmd_register() {
  local ctx="" title="" sid="${CLAUDE_CODE_SESSION_ID:-}" branch cwd
  while [ $# -gt 0 ]; do
    case "$1" in
      --ctx-dir) ctx="${2:?--ctx-dir 需要值}"; shift 2 ;;
      --title) title="${2:-}"; shift 2 ;;
      --session-id) sid="${2:-}"; shift 2 ;;
      *) usage ;;
    esac
  done
  [ -n "$ctx" ] || die "register 需要 --ctx-dir"
  [ -d "$ctx" ] || die "ctx 目录不存在：$ctx"
  ctx=$(cd "$ctx" && pwd -P)
  [ -f "$ctx/meta.json" ] || die "$ctx 缺 meta.json：先用 harness-context init"
  branch=$(jq -r '.branch // empty' "$ctx/meta.json")
  [ -n "$branch" ] || die "meta.branch 缺失：$ctx/meta.json"
  # cwd 取当前进程目录即会话启动目录：--resume 严格按此目录，差一层都恢复不了，故不做任何推导
  cwd=$(pwd -P)
  mkdir -p "$(dirname "$REG")"
  jq -cn --arg c "$ctx" --arg w "$cwd" --arg b "$branch" --arg t "$title" --arg s "$sid" \
        --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{ctx_dir:$c, cwd:$w, branch:$b, session_id:(if $s == "" then null else $s end),
      title:$t, registered_at:$at}' >> "$REG"
  echo "harness-threads: 已登记 ${branch}（${cwd}）"
}

cmd_list_json() { # <show_all>：web 看板数据源；文本列表与看板共用 enumerate 聚合
  local show_all="$1" out idx ctx cwd branch sid title status cur sess nodecol ms prog
  # 必须先命令替换捕获再喂 heredoc，不能 `done < <(enumerate ...)`：进程替换子 shell 里
  # errexit 存活，某行 meta.json 坏掉会让 enumerate 中途退出，数组静默截断却仍 rc=0。
  out=$(enumerate "$show_all")
  { while IFS="$SEP" read -r idx ctx cwd branch sid title status cur sess nodecol; do
      [ -n "$idx" ] || continue
      ms=$(jq -c '.milestones // {}' "$ctx/meta.json" 2>/dev/null || echo '{}')
      # 零字节 meta.json 下 jq 退出 0 且零输出，|| 分支不触发，空串会让 --argjson 直接报错
      [ -n "$ms" ] || ms='{}'
      prog=""
      [ -f "$ctx/meta.json" ] && prog=$(progress_line "$ctx/meta.json")
      jq -cn --arg idx "$idx" --arg ctx "$ctx" --arg branch "$branch" --arg title "$title" \
        --arg status "$status" --arg node "$nodecol" --arg progress "$prog" --argjson ms "$ms" \
        '{idx:($idx|tonumber), ctx_dir:$ctx, branch:$branch, title:$title, status:$status,
          node:$node, progress:$progress, milestones:$ms}'
    done <<EOF
$out
EOF
  } | jq -s .
}

# 卡片式而非对齐表格：分支名/中文标题长短悬殊，printf 又按字节算宽，列对齐必崩。
# 每条：标题行（人先认需求）→ 位置行（检出目录 · 分支）→ 可逐行复制的唤回命令，条目间空行分隔。
cmd_list() {
  local show_all=0 json=0 out idx ctx cwd branch sid title status cur sess nodecol mark first=1
  local BOLD="" DIM="" RST=""
  if [ -t 1 ]; then BOLD=$'\033[1m'; DIM=$'\033[2m'; RST=$'\033[0m'; fi
  while [ $# -gt 0 ]; do
    case "$1" in --all) show_all=1; shift ;; --json) json=1; shift ;; *) usage ;; esac
  done
  if [ "$json" = 1 ]; then cmd_list_json "$show_all"; return 0; fi
  out=$(enumerate "$show_all")
  if [ -z "$out" ]; then
    echo "harness-threads: 暂无线程登记（登记表：${REG}）"
    return 0
  fi
  while IFS="$SEP" read -r idx ctx cwd branch sid title status cur sess nodecol; do
    [ -n "$idx" ] || continue
    mark=""
    if [ -n "$cur" ] && [ "$cur" != "$branch" ]; then mark="${mark}  ⚠ 检出在 ${cur}"; fi
    if [ -n "$sid" ] && [ "$sess" = 0 ]; then mark="${mark}  [会话丢失]"; fi
    [ "$first" = 1 ] || echo
    first=0
    printf '%s%2s  %s  [%s · %s]%s%s\n' "$BOLD" "$idx" "${title:-$branch}" "$status" "$nodecol" "$RST" "$mark"
    printf '    %s%s · %s%s\n' "$DIM" "$(basename "$cwd")" "$branch" "$RST"
    wake_lines "$cwd" "$branch" "$sid" "$cur"
  done <<EOF
$out
EOF
  echo
  echo "唤回: 逐行复制命令，或直接 ht resume <序号|关键词>（自动 cd + 切分支 + 恢复会话）"
}

# <序号|关键词> → stdout 命中的那一行（enumerate 格式）；序号精确匹配，关键词按
# branch·title·cwd 子串且须唯一。定位语义与诊断文案只此一份：resume 与 mark 各写一套必然分叉。
# 失败路径全部非零退出，但函数在命令替换的子 shell 里跑，die/exit 只结束子 shell——
# 调用方必须 `|| exit $?` 把状态传出去。
locate_thread() {
  local sel="$1" out matches count
  out=$(enumerate 0)
  [ -n "$out" ] || die "暂无线程登记"
  case "$sel" in
    ''|*[!0-9]*)
      matches=$(printf '%s\n' "$out" | awk -F"$SEP" -v k="$sel" 'index($4,k) || index($6,k) || index($3,k)')
      [ -n "$matches" ] || die "无匹配线程：${sel}"
      count=$(printf '%s\n' "$matches" | grep -c .)
      if [ "$count" -gt 1 ]; then
        echo "harness-threads: 关键词「${sel}」匹配到多条，请用序号或更精确的关键词：" >&2
        printf '%s\n' "$matches" | awk -F"$SEP" '{printf "  %s  %s  %s\n", $1, $4, $3}' >&2
        exit 1
      fi
      ;;
    *)
      matches=$(printf '%s\n' "$out" | awk -F"$SEP" -v i="$sel" '$1 == i')
      [ -n "$matches" ] || die "序号 ${sel} 不存在（先跑 harness-threads list 查看）"
      ;;
  esac
  printf '%s\n' "$matches"
}

cmd_resume() {
  local sel="" dry=0 matches
  local idx ctx cwd branch sid title status cur sess nodecol
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) dry=1; shift ;;
      -*) usage ;;
      *) [ -z "$sel" ] || usage; sel="$1"; shift ;;
    esac
  done
  [ -n "$sel" ] || usage
  matches=$(locate_thread "$sel") || exit $?
  IFS="$SEP" read -r idx ctx cwd branch sid title status cur sess nodecol <<EOF
$matches
EOF
  [ -d "$cwd" ] || die "检出目录已不存在：${cwd}（可跑 harness-threads prune 清理）"
  # 唤回不得弄丢用户手上的改动：需要切分支但工作区脏时只给命令、不代劳
  if [ "$cur" != "$branch" ] && [ -n "$(git -C "$cwd" status --porcelain 2>/dev/null)" ]; then
    echo "harness-threads: ${cwd} 有未提交改动，拒绝自动切分支。请自行判断后执行：" >&2
    wake_lines "$cwd" "$branch" "$sid" "$cur" >&2
    exit 2
  fi
  if [ "$dry" = 1 ]; then
    wake_cmd "$cwd" "$branch" "$sid" "$cur"
    echo
    return 0
  fi
  [ -n "$sid" ] || die "该线程无 session_id：请 cd ${cwd} 新开会话并装载 harness-context 续入"
  cd "$cwd"
  if [ "$cur" != "$branch" ]; then git checkout "$branch"; fi
  # exec：claude 继承本进程 cwd，而 --resume 的作用域正是按进程 cwd 判定
  exec $CLAUDE_CMD --resume "$sid"
}

cmd_prune() {
  local tmp kept=0 dropped=0 line ctx
  [ -f "$REG" ] || { echo "harness-threads: 无登记表（${REG}）"; return 0; }
  tmp=$(mktemp)
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    ctx=$(printf '%s' "$line" | jq -r '.ctx_dir // ""' 2>/dev/null || echo "")
    if [ -n "$ctx" ] && [ -f "$ctx/meta.json" ]; then
      printf '%s\n' "$line" >> "$tmp"
      kept=$((kept + 1))
    else
      dropped=$((dropped + 1))
    fi
  done < "$REG"
  mv "$tmp" "$REG"
  echo "harness-threads: 保留 ${kept} 行，清除 ${dropped} 行"
}

cmd_web() {
  need python3
  # ht 经 ~/.local/bin 符号链接进来时 dirname $0 不指向脚本目录，先按安装路径找
  local py="$HOME/.claude/skills/harness-ceilf6/scripts/web.py"
  [ -f "$py" ] || py="$(cd "$(dirname "$0")" && pwd)/web.py"
  [ -f "$py" ] || die "找不到 web.py"
  exec python3 "$py" "$@"
}

cmd="${1:-list}"
if [ $# -gt 0 ]; then shift; fi
case "$cmd" in
  list) cmd_list "$@" ;;
  --all) cmd_list --all "$@" ;;
  register) cmd_register "$@" ;;
  resume) cmd_resume "$@" ;;
  prune) cmd_prune "$@" ;;
  web) cmd_web "$@" ;;
  mark) cmd_mark "$@" ;;
  progress) cmd_progress "$@" ;;
  -h|--help) usage ;;
  *) echo "harness-threads: 未知子命令 ${cmd}" >&2; usage ;;
esac
