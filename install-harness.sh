#!/usr/bin/env bash
# 安装/修复 harness 技能到 ~/.claude/skills。
# 用 symlink 而非拷贝：仓库是唯一真源，改动零同步生效；拷贝会静默漂移。
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$HOME/.claude/skills"

for s in harness-context harness-ceilf6 mr-comments lark-sediment bytedcli-meego; do
  target="$HOME/.claude/skills/$s"
  if [ -d "$target" ] && [ ! -L "$target" ]; then
    echo "发现普通目录（手动拷贝产物），替换为链接：$target"
    rm -rf "$target"
  fi
  ln -sfn "$here/$s" "$target"
  echo "linked: $target -> $here/$s"
done

# harness-threads 装成 PATH 命令而非 shell alias：alias 只在交互式 bash 生效，
# PATH 命令在 bash/zsh/脚本中一致可用。唤回必须由用户的 shell 执行（见 threads.sh 头注）。
mkdir -p "$HOME/.local/bin"
# ht 是 harness-threads 的短别名，便于快速唤出；两个名字指向同一脚本
for cmd in harness-threads ht; do
  ln -sfn "$here/harness-ceilf6/scripts/threads.sh" "$HOME/.local/bin/$cmd"
  echo "linked: $HOME/.local/bin/$cmd -> $here/harness-ceilf6/scripts/threads.sh"
done
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "提示：$HOME/.local/bin 不在 PATH 中，harness-threads / ht 需加入 PATH 后才能直接调用" >&2 ;;
esac
