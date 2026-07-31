#!/usr/bin/env bash
# base 的「比较用 ref」解析：远程跟踪 ref 优先，本地分支名保底。被 cr-round.sh 与 squash-branch.sh 共用。
#
# 为何不能直接用本地 base 分支：本地 master 常年落后于 origin/master（2026-07-31 实测 byteview-web
# 落后 16 提交 / 2 天；worktree 流从 origin/<base> 切分支时本地 base 根本不参与，滞后是常态）。
# 按它求 merge-base，分叉点会落到很早的位置，上游别人的提交被算进本分支范围——评审员被喂无关 diff、
# squash 把他人提交吞进单提交、据此建的 MR 把上游改动算作本次改动。
#
# 远程 ref 恒不劣于本地 ref：merge-base 取的是分叉点而非 tip。分支从 origin/<base> 切出时分叉点即切出点；
# 分支从落后的本地 base 切出时分叉点仍是两者的共同祖先——都等于该分支真正的分叉点，且 origin/<base>
# 之后推进多少都不改变结果。
#
# 必须共用同一函数：评审范围与 squash 父提交若各自解析，会出现「评审 A 范围、压 B 范围」的错位。

resolve_base_ref() {
  local repo="$1" base="$2" up
  # 尊重 base 分支自己配置的 upstream（可能不是 origin）；配置指向已删除的远程分支时 show-ref 兜住
  up=$(git -C "$repo" rev-parse --abbrev-ref --verify --quiet "${base}@{upstream}" 2>/dev/null) || up=""
  if [ -n "$up" ] && git -C "$repo" show-ref --verify --quiet "refs/remotes/${up}"; then
    echo "$up"; return
  fi
  if git -C "$repo" show-ref --verify --quiet "refs/remotes/origin/${base}"; then
    echo "origin/${base}"; return
  fi
  echo "$base"   # 无远程 ref（纯本地仓/离线）：退回本地分支名，即历史行为
}
