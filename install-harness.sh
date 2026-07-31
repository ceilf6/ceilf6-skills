#!/usr/bin/env bash
# 安装/修复 harness 技能到 ~/.claude/skills。
# 用 symlink 而非拷贝：仓库是唯一真源，改动零同步生效；拷贝会静默漂移。
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$HOME/.claude/skills"

for s in harness-context harness-ceilf6 lark-sediment; do
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
ln -sfn "$here/harness-ceilf6/scripts/threads.sh" "$HOME/.local/bin/harness-threads"
echo "linked: $HOME/.local/bin/harness-threads -> $here/harness-ceilf6/scripts/threads.sh"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "提示：$HOME/.local/bin 不在 PATH 中，harness-threads 需加入 PATH 后才能直接调用" >&2 ;;
esac
