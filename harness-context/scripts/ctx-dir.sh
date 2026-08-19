#!/usr/bin/env bash
# harness-context 机械层：分支→目录解析、init、条目路径、状态更新。
# 抓取、拼装、沉淀取舍等判断类工作归调用方 agent，不在本脚本内。
set -euo pipefail

die() { echo "ctx-dir: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "缺少依赖：$1"; }
need git; need jq

repo_root() { git rev-parse --show-toplevel 2>/dev/null || die "不在 git 仓库内"; }

current_branch() {
  git symbolic-ref --short -q HEAD || die "detached HEAD：请先切到需求分支"
}

resolve_dir() {
  local root branch
  root=$(repo_root)
  branch=$(current_branch)
  case "$branch" in
    master|main) die "当前在主分支 ${branch}：请先切到需求分支" ;;   # ${} 必须：bash 3.2 对 $var 紧跟多字节字符会解析出错误变量名
  esac
  echo "$root/.harness-ceilf6/${branch//\//__}"
}

detect_base_branch() {
  local head
  if head=$(git symbolic-ref --short -q refs/remotes/origin/HEAD); then
    echo "${head#origin/}"; return
  fi
  if git show-ref --verify --quiet refs/heads/master; then echo master; return; fi
  if git show-ref --verify --quiet refs/heads/main; then echo main; return; fi
  echo master
}

ensure_exclude() {
  local exclude
  exclude=$(git rev-parse --git-path info/exclude)
  mkdir -p "$(dirname "$exclude")"
  touch "$exclude"
  grep -qxF '.harness-ceilf6/' "$exclude" || echo '.harness-ceilf6/' >> "$exclude"
}

cmd_resolve() { resolve_dir; }

cmd_init() {
  local wiki_url="" dir
  while [ $# -gt 0 ]; do
    case "$1" in
      --wiki-url) wiki_url="${2:?--wiki-url 需要值}"; shift 2 ;;
      *) die "init 未知参数：$1" ;;
    esac
  done
  dir=$(resolve_dir)
  ensure_exclude
  if [ -f "$dir/meta.json" ]; then
    echo "$dir"
    echo "ctx-dir: 已初始化，meta.json 未改动（重拉种子请显式操作）" >&2
    return 0
  fi
  mkdir -p "$dir/context" "$dir/cr"
  jq -n \
    --arg branch "$(current_branch)" \
    --arg wiki_url "$wiki_url" \
    --arg base "$(detect_base_branch)" \
    --arg created "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{branch: $branch,
      wiki_url: (if $wiki_url == "" then null else $wiki_url end),
      selftest_url: null,
      base_branch: $base,
      status: "planning",
      max_rounds: null,
      mr_id: null,
      created_at: $created}' \
    > "$dir/meta.json"
  echo "$dir"
}

cmd_new_entry() {
  local type="${1:?用法: new-entry <im|doc|meego|mr|note> <slug>}"
  local slug="${2:?用法: new-entry <im|doc|meego|mr|note> <slug>}"
  case "$type" in
    im|doc|meego|mr|note) ;;
    *) die "类型须为 im|doc|meego|mr|note，收到：$type" ;;
  esac
  local dir; dir=$(resolve_dir)
  [ -d "$dir/context" ] || die "上下文目录未初始化：先执行 init"
  echo "$dir/context/$(date +%y%m%d-%H%M)-$type-$slug.md"
}

cmd_set_status() {
  local status="${1:?用法: set-status <planning|developing|cr|awaiting_human|done>}"
  case "$status" in
    planning|developing|cr|awaiting_human|done) ;;
    *) die "非法状态：$status" ;;
  esac
  local dir; dir=$(resolve_dir)
  [ -f "$dir/meta.json" ] || die "meta.json 不存在：先执行 init"
  local tmp; tmp=$(mktemp)
  jq --arg s "$status" '.status = $s' "$dir/meta.json" > "$tmp" && mv "$tmp" "$dir/meta.json"
  echo "status=$status"
}

case "${1:-}" in
  resolve)    shift; cmd_resolve "$@" ;;
  init)       shift; cmd_init "$@" ;;
  new-entry)  shift; cmd_new_entry "$@" ;;
  set-status) shift; cmd_set_status "$@" ;;
  *) die "用法: ctx-dir.sh <resolve|init|new-entry|set-status> ..." ;;
esac
