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

usage() {
  cat >&2 <<'EOF'
用法（harness-threads 与短别名 ht 等价）:
  ht [list] [--all]     列出线程（默认隐藏 status=done）
  ht register --ctx-dir <路径> [--title <短题>] [--session-id <id>]
  ht resume <序号|关键词> [--dry-run]
  ht prune              清除 ctx 目录已消失的登记行
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

# 输出分隔字段：idx ctx cwd branch sid title status cur_branch sess_ok
enumerate() {
  local show_all="$1" idx=0 line ctx cwd branch sid title status cur sess f
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    ctx=$(printf '%s' "$line" | jq -r '.ctx_dir // ""')
    cwd=$(printf '%s' "$line" | jq -r '.cwd // ""')
    branch=$(printf '%s' "$line" | jq -r '.branch // ""')
    sid=$(printf '%s' "$line" | jq -r '.session_id // ""')
    title=$(printf '%s' "$line" | jq -r '.title // ""')
    if [ -f "$ctx/meta.json" ]; then
      status=$(jq -r '.status // "?"' "$ctx/meta.json")
    else
      status="[失效]"   # ctx 目录已消失（检出被删 / worktree 被清）
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
    printf '%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s\n' \
      "$idx" "$SEP" "$ctx" "$SEP" "$cwd" "$SEP" "$branch" "$SEP" "$sid" "$SEP" \
      "$title" "$SEP" "$status" "$SEP" "$cur" "$SEP" "$sess"
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

# 卡片式而非对齐表格：分支名/中文标题长短悬殊，printf 又按字节算宽，列对齐必崩。
# 每条：标题行（人先认需求）→ 位置行（检出目录 · 分支）→ 可逐行复制的唤回命令，条目间空行分隔。
cmd_list() {
  local show_all=0 out idx ctx cwd branch sid title status cur sess mark first=1
  local BOLD="" DIM="" RST=""
  if [ -t 1 ]; then BOLD=$'\033[1m'; DIM=$'\033[2m'; RST=$'\033[0m'; fi
  while [ $# -gt 0 ]; do
    case "$1" in --all) show_all=1; shift ;; *) usage ;; esac
  done
  out=$(enumerate "$show_all")
  if [ -z "$out" ]; then
    echo "harness-threads: 暂无线程登记（登记表：${REG}）"
    return 0
  fi
  while IFS="$SEP" read -r idx ctx cwd branch sid title status cur sess; do
    [ -n "$idx" ] || continue
    mark=""
    if [ -n "$cur" ] && [ "$cur" != "$branch" ]; then mark="${mark}  ⚠ 检出在 ${cur}"; fi
    if [ -n "$sid" ] && [ "$sess" = 0 ]; then mark="${mark}  [会话丢失]"; fi
    [ "$first" = 1 ] || echo
    first=0
    printf '%s%2s  %s  [%s]%s%s\n' "$BOLD" "$idx" "${title:-$branch}" "$status" "$RST" "$mark"
    printf '    %s%s · %s%s\n' "$DIM" "$(basename "$cwd")" "$branch" "$RST"
    wake_lines "$cwd" "$branch" "$sid" "$cur"
  done <<EOF
$out
EOF
  echo
  echo "唤回: 逐行复制命令，或直接 ht resume <序号|关键词>（自动 cd + 切分支 + 恢复会话）"
}

cmd_resume() {
  local sel="" dry=0 out matches count
  local idx ctx cwd branch sid title status cur sess
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) dry=1; shift ;;
      -*) usage ;;
      *) [ -z "$sel" ] || usage; sel="$1"; shift ;;
    esac
  done
  [ -n "$sel" ] || usage
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
  IFS="$SEP" read -r idx ctx cwd branch sid title status cur sess <<EOF
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

cmd="${1:-list}"
if [ $# -gt 0 ]; then shift; fi
case "$cmd" in
  list) cmd_list "$@" ;;
  --all) cmd_list --all "$@" ;;
  register) cmd_register "$@" ;;
  resume) cmd_resume "$@" ;;
  prune) cmd_prune "$@" ;;
  -h|--help) usage ;;
  *) echo "harness-threads: 未知子命令 ${cmd}" >&2; usage ;;
esac
