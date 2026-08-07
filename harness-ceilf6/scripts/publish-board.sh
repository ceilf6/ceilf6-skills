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
CACHE="${HARNESS_MR_URL_CACHE:-$HOME/.harness-ceilf6/mr-urls.json}"
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

# 判内容而非判存在：0 字节缓存会让每轮全量重查且 mr_url 恒空，非 JSON / 非对象会让下面的
# jq 在 set -e 下每轮硬失败、页面冻在旧快照——两种损坏都不会自己好，故先重建
jq -e 'type == "object"' "$CACHE" >/dev/null 2>&1 \
  || { mkdir -p "$(dirname "$CACHE")"; echo '{}' > "$CACHE"; }
# mr_url：每个 MR 只解析一次（bytedcli 走网络且慢）；解析不到不入缓存，下轮再试，
# 页面对空 mr_url 显示纯文本 MR 号
for id in $(printf '%s' "$threads" | jq -r '.[].mr_id // empty' | sort -u); do
  hit=$(jq -r --arg k "$id" '.[$k] // empty' "$CACHE")
  [ -n "$hit" ] && continue
  st=$(bytedcli bits mr status --mr-id "$id" --json 2>/dev/null || true)
  url=$(printf '%s' "$st" | jq -r '.url // .web_url // .mr_url // empty' 2>/dev/null || true)
  if [ -z "$url" ]; then
    url=$(printf '%s' "$st" | jq -r '[.. | strings | select(startswith("https://"))][0] // empty' 2>/dev/null || true)
  fi
  [ -n "$url" ] || continue
  tmp=$(mktemp)
  jq --arg k "$id" --arg v "$url" '.[$k] = $v' "$CACHE" > "$tmp" && mv "$tmp" "$CACHE"
done

at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
# 白名单式脱敏：对外只出页面真正消费的字段。threads 去掉需求短题（线程对外由 MR 链接标识）；
# running 逐条收窄到 worktree/state，把 bot 控制端口带来的指令正文、agent 提问、会话与消息
# 标识挡在本机——离线降级的 {tasks:[],offline:true} 过同一收窄仍成立
printf '%s' "$threads" | jq --slurpfile urls "$CACHE" --argjson running "$running" --arg at "$at" '
  {generated_at: $at,
   threads: map(del(.title) + {mr_url: (if .mr_id == null then ""
                              else ($urls[0][(.mr_id | tostring)] // "") end)}),
   running: {tasks: [($running.tasks // [])[] | select(type == "object") | {worktree, state}],
             offline: ($running.offline // false)}}' > "$out/data.json"
sed "s|<!--BOARD_CONFIG-->|<script>window.BOARD = {\"mode\": \"public\", \"generated_at\": \"$at\"}</script>|" \
  "$BOARD" > "$out/index.html"
# BatchMode/ConnectTimeout：launchd 下无 TTY，口令提示或黑洞连接会把这轮发布永久挂住
scp -q -o BatchMode=yes -o ConnectTimeout=10 -i "$key" "$out/index.html" "$out/data.json" "$dest/"
echo "publish-board: 已发布 $(printf '%s' "$threads" | jq 'length') 条线程 → ${dest}（${at}）"
