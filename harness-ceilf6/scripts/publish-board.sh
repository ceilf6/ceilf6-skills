#!/usr/bin/env bash
# 对外看板发布：本机生成静态快照（index.html + data.json）scp 到服务器。
# launchd 每 5 分钟跑一次；Mac 休眠即停更，页面以 generated_at 标注数据时刻。
# 无 publish.json 即拒绝执行——这是防误发闸门（测试机/他人机器不该有此配置）。
# 只上传 index.html 与 data.json 两个文件，不得携带其他本地文件。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
TH="$HERE/threads.sh"
BOARD="$HERE/board/index.html"
die() { echo "publish-board: $*" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || die "缺少依赖：jq"
[ -f "$BOARD" ] || die "缺看板页：$BOARD"
CONF="${HARNESS_PUBLISH_CONF:-$HOME/.harness-ceilf6/publish.json}"
BOT="${HARNESS_BOT_CONTROL:-http://127.0.0.1:7659}"
[ -f "$CONF" ] || die "缺发布配置：${CONF}（{\"dest\":\"root@host:/path\",\"key\":\"~/.ssh/xx.pem\"}）"
dest=$(jq -r '.dest // empty' "$CONF")
key=$(jq -r '.key // empty' "$CONF")
{ [ -n "$dest" ] && [ -n "$key" ]; } || die "publish.json 需含 dest 与 key"
key="${key/#\~/$HOME}"

threads=$(bash "$TH" list --json --all)
running=$(curl -s --max-time 5 "$BOT/api/tasks" 2>/dev/null || true)
printf '%s' "$running" | jq -e '.tasks | type == "array"' >/dev/null 2>&1 \
  || running='{"tasks":[],"offline":true}'

at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
# 白名单式脱敏：对外只出枚举出的字段，别处一律不出——需求短题、备注、分支名、启动命令、
# 本机路径（cwd/ctx_dir）、内部平台链接都留在本机；mr_id 裸编号保留是用户 2026-08-10 对
# 自身红线的显式豁免（其余内部标识零出现）。running 徽标在此配对成线程序号后只发
# {idx, state}，工作树路径不出；离线降级的 {tasks:[],offline:true} 过同一收窄仍成立。
printf '%s' "$threads" | jq --argjson running "$running" --arg at "$at" '
  . as $raw
  | {generated_at: $at,
     threads: map({idx, mr_id, status, node, current, cr_rounds, progress, archived, milestones}),
     running: {tasks: [($running.tasks // [])[]
                       | select(type == "object") | . as $t
                       | ($raw | map(select(.cwd == $t.worktree)) | first) as $m
                       | select($m != null) | {idx: $m.idx, state: $t.state}],
               offline: ($running.offline // false)}}' > "$out/data.json"
sed "s|<!--BOARD_CONFIG-->|<script>window.BOARD = {\"mode\": \"public\", \"generated_at\": \"$at\"}</script>|" \
  "$BOARD" > "$out/index.html"
# BatchMode/ConnectTimeout：launchd 下无 TTY，口令提示或黑洞连接会把这轮发布永久挂住
# 目标目录可能被站点部署的原子替换清掉、或以缺执行位的权限重建（nginx 进不了目录即 403）——
# 每轮发布前自愈目录与权限，幂等
rhost="${dest%%:*}"; rpath="${dest#*:}"
ssh -q -o BatchMode=yes -o ConnectTimeout=10 -i "$key" "$rhost" "mkdir -p '$rpath' && chmod 755 '$rpath'"
scp -q -o BatchMode=yes -o ConnectTimeout=10 -i "$key" "$out/index.html" "$out/data.json" "$dest/"
echo "publish-board: 已发布 $(printf '%s' "$threads" | jq 'length') 条线程 → ${dest}（${at}）"
