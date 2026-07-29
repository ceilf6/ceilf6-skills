#!/usr/bin/env bash
# 安装/更新 taskhall-bot 的 launchd 常驻。幂等：重复执行即重装重启。
set -euo pipefail

# pwd -P：把 __ROOT__ 钉成物理路径，plist 里不留 symlink（listener 的 isMain 两种都认）。
here=$(cd "$(dirname "$0")" && pwd -P)
node_bin=$(command -v node) || { echo "缺少依赖：node" >&2; exit 1; }
command -v lark-cli >/dev/null || { echo "缺少依赖：lark-cli" >&2; exit 1; }
command -v claude >/dev/null || { echo "缺少依赖：claude" >&2; exit 1; }

# Node 地板 20.11：低版本不会报错，只会在运行期以难懂的语法/行为差异挂掉常驻进程。
node_major=$("$node_bin" -p 'process.versions.node.split(".")[0]')
node_minor=$("$node_bin" -p 'process.versions.node.split(".")[1]')
if [ "$node_major" -lt 20 ] || { [ "$node_major" -eq 20 ] && [ "$node_minor" -lt 11 ]; }; then
  echo "Node 版本过低：${node_major}.${node_minor}（${node_bin}），需要 >= 20.11" >&2
  exit 1
fi

config="${here}/config.json"
[ -f "$config" ] || { echo "缺少配置：${config}" >&2; exit 1; }
# dmOpenId 仍是占位符时装载会得到一个「跑得起来但所有私信投空」的 bot：
# 群里只剩 reaction，pass/fail 详情与 escalate 恢复命令全部静默丢失，所以在装载前拦住。
dm_open_id=$("$node_bin" -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).dmOpenId||""))' "$config") \
  || { echo "配置解析失败：${config}" >&2; exit 1; }
case "$dm_open_id" in
  ou_*) ;;
  *) echo "config.json 的 dmOpenId 未填（当前：${dm_open_id}），取值见 runbook「本机绑定与配置」" >&2; exit 1 ;;
esac

mkdir -p "${here}/logs" "${here}/state"

path_extra="$(dirname "$node_bin"):$(dirname "$(command -v lark-cli)"):$(dirname "$(command -v claude)")"
# & 是 sed 替换里的「整个匹配」、& 与 < 又是 XML 元字符：含这些字符的路径会静默渲染出错误的 plist。
case "${here}${node_bin}${path_extra}" in
  *"&"*|*"|"*|*"<"*|*">"*) echo "路径含 & | < > ，无法安全渲染 plist：${here}" >&2; exit 1 ;;
esac

plist="${HOME}/Library/LaunchAgents/com.ceilf6.taskhall-bot.plist"
mkdir -p "$(dirname "$plist")" # 新机器上 ~/Library/LaunchAgents 可能不存在
sed -e "s|__NODE__|${node_bin}|g" -e "s|__ROOT__|${here}|g" -e "s|__PATH_EXTRA__|${path_extra}|g" \
  "${here}/com.ceilf6.taskhall-bot.plist.tpl" > "$plist"

launchctl unload "$plist" 2>/dev/null || true
launchctl load "$plist"
echo "已装载：${plist}"
echo "查看日志：tail -f ${here}/logs/launchd.err.log"
