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
