#!/usr/bin/env bash
# 安装/更新 harness-ceilf6-bot 的 launchd 常驻。幂等：重复执行即重装重启。
set -euo pipefail

# pwd -P：把 __ROOT__ 钉成物理路径，plist 里不留 symlink（listener 的 isMain 两种都认）。
here=$(cd "$(dirname "$0")" && pwd -P)
node_bin=$(command -v node) || { echo "缺少依赖：node" >&2; exit 1; }
command -v lark-cli >/dev/null || { echo "缺少依赖：lark-cli（事件流与所有飞书回应）" >&2; exit 1; }
command -v claude >/dev/null || { echo "缺少依赖：claude（无人值守执行任务）" >&2; exit 1; }
command -v bytedcli >/dev/null || { echo "缺少依赖：bytedcli（harness 收尾建 MR）" >&2; exit 1; }
command -v traex >/dev/null || { echo "缺少依赖：traex（harness 的对抗式 CR 评审员）" >&2; exit 1; }
command -v git >/dev/null || { echo "缺少依赖：git（runner 建 worktree）" >&2; exit 1; }
# /usr/bin/git 是 Command Line Tools 的 shim：未装 CLT 时它照样在 PATH 里、command -v 照样过，
# 只有真正执行才弹窗失败。runner 的第一个动作就是 git worktree add，这里必须用 --version 证伪。
git --version >/dev/null 2>&1 || { echo "git 不可用（多半未装 Xcode Command Line Tools：xcode-select --install）" >&2; exit 1; }

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
# 但本守卫只认前缀：open_id 是 app 维度的，填成别的应用下的 open_id 同样是 ou_ 且照样投空——只能靠 runbook 的取值命令带 --profile 防。
dm_open_id=$("$node_bin" -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).dmOpenId||""))' "$config") \
  || { echo "配置解析失败：${config}" >&2; exit 1; }
case "$dm_open_id" in
  ou_*) ;;
  *) echo "config.json 的 dmOpenId 未填（当前：${dm_open_id}），取值见 runbook「本机绑定与配置」" >&2; exit 1 ;;
esac

# 交叉校验：拿本机 profile 实际授权的 open_id 与 config 比对，堵住上面前缀守卫堵不住的那一类错。
profile=$("$node_bin" -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).profile||""))' "$config")
actual_open_id=$(lark-cli auth status --json --profile "$profile" </dev/null 2>/dev/null \
  | "$node_bin" -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).identities?.user?.openId ?? ""' 2>/dev/null) || actual_open_id=""
if [ -z "$actual_open_id" ]; then
  # 未授权/离线时不拦装载：装机不该被网络与授权时序卡死，此处退回 runbook 的取值命令兜底。
  echo "警告：无法反查 profile ${profile} 的 open_id（未授权或离线），跳过 dmOpenId 交叉校验" >&2
elif [ "$actual_open_id" != "$dm_open_id" ]; then
  echo "dmOpenId 与 profile ${profile} 实际授权的 open_id 不一致，拒绝装载：" >&2
  echo "  config.json：${dm_open_id}" >&2
  echo "  lark-cli   ：${actual_open_id}" >&2
  echo "多半是取值时漏了 --profile ${profile}，拿到了别的应用下的 open_id —— open_id 是 app 维度的，" >&2
  echo "那个值同样是 ou_ 前缀、照样穿过格式守卫，装出来是 reaction 正常、私信全投空的半哑 bot。" >&2
  exit 1
fi

mkdir -p "${here}/logs" "${here}/state"

path_extra="$(dirname "$node_bin"):$(dirname "$(command -v lark-cli)"):$(dirname "$(command -v claude)")"
path_extra="${path_extra}:$(dirname "$(command -v bytedcli)"):$(dirname "$(command -v traex)")"
# & 是 sed 替换里的「整个匹配」、\ 是 sed 的转义引导符（探针实证会被静默吞掉）、& 与 < 又是 XML
# 元字符：含这些字符的路径不会报错，只会静默渲染出一份错误的 plist。
case "${here}${node_bin}${path_extra}" in
  *"&"*|*"|"*|*"<"*|*">"*|*"\\"*) echo "路径含 & | < > \\ ，无法安全渲染 plist：${here}" >&2; exit 1 ;;
esac

plist="${HOME}/Library/LaunchAgents/com.ceilf6.harness-ceilf6-bot.plist"
mkdir -p "$(dirname "$plist")" # 新机器上 ~/Library/LaunchAgents 可能不存在

# 2026-07-30 改名遗留：旧 Label 的 plist 换了名就不再被本脚本 unload，但它还躺在 LaunchAgents 里，
# 带 RunAtLoad+KeepAlive、ProgramArguments 指向已不存在的 taskhall-bot/ ——下次登录即 launchd 重新加载它，
# 变成一个无声刷日志的 crash-loop。装载新常驻前先把它拆掉。
legacy_plist="${HOME}/Library/LaunchAgents/com.ceilf6.taskhall-bot.plist"
if [ -f "$legacy_plist" ]; then
  launchctl unload "$legacy_plist" 2>/dev/null || true
  rm -f "$legacy_plist"
  echo "已清理改名前的旧常驻：${legacy_plist}"
fi
sed -e "s|__NODE__|${node_bin}|g" -e "s|__ROOT__|${here}|g" -e "s|__PATH_EXTRA__|${path_extra}|g" \
  "${here}/com.ceilf6.harness-ceilf6-bot.plist.tpl" > "$plist"

launchctl unload "$plist" 2>/dev/null || true
launchctl load "$plist"
echo "已装载：${plist}"
echo "查看日志：tail -f ${here}/logs/launchd.err.log"
