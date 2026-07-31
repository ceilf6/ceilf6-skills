# harness base ref 解析修复设计

日期：2026-07-31。缺陷发现于 2026-07-31 byteview-web worktree 实测。关联：[harness-ceilf6 v2 五项优化](2026-07-30-harness-ceilf6-v2-optimizations-design.md)（本篇修其中 §3 squash 与既有 CR 评审范围共用的 base 解析）。

## 缺陷

`meta.base_branch` 存的是分支名字面量（如 `master`），两个消费者都按**本地 ref** 解析：

- `cr-round.sh`：评审范围 `git diff ${BASE}...HEAD`；
- `squash-branch.sh`：squash 父提交 `git merge-base "$BASE" HEAD`。

本地 `master` 常年落后 `origin/master`（实测 byteview-web 落后 16 个提交 / 2 天），于是 merge-base 落在很早的分叉点，**上游别人的提交被算进本分支范围**。

**实证**（2026-07-31）：worktree 里从 `origin/master` 切出的测试分支、自身零提交，`squash-branch.sh` 仍压出一个新 commit，把 16 个上游提交收进了单提交。

**影响**：评审员被喂进无关 diff（评审噪声、耗时）；squash 后的单提交在历史上吞掉他人提交；据此建的 MR 把上游改动算作本次改动。树内容不丢（等价验证仍过），坏的是历史归属、评审范围与 MR 体积。

**为何此前没暴露**：主检出习惯 `checkout master && pull` 后再切分支，本地 master 是新的。而 worktree 流推荐 `checkout -b feat/x origin/master`，本地 master 不参与、必然滞后——**这个坑在 worktree 工作流下是常态**。

## 修复

新增共享解析 `harness-ceilf6/scripts/base-ref.sh`，函数 `resolve_base_ref <repo> <base>`，优先级：

1. base 分支配置的 upstream（`<base>@{upstream}`，且该 remote ref 确实存在）——尊重非 origin 远程；
2. `origin/<base>`（remote ref 存在时）；
3. 本地 `<base>`（保底，即现行为；无远程的本地仓、纯离线场景照常工作）。

**为什么远程 ref 恒不劣于本地 ref**：merge-base 取的是**分叉点**而非 tip。分支从 `origin/<base>` 切出时，merge-base 就是切出点；分支从落后的本地 base 切出时，merge-base 仍是本地 base 与远程的共同祖先——两种情况都等于该分支真正的分叉点。`origin/<base>` 之后推进多少都不改变结果。

**为何做成共享文件而非各自内联**：两处必须解析出同一个 base，否则出现"评审 A 范围、squash B 范围"的错位——这是正确性耦合，不只是 DRY。

**不改的部分**：`squash-branch.sh` 的「当前在 base 分支上拒绝 squash」守卫仍比对本地分支名（`$BRANCH != $BASE`），语义是「别在集成分支上动手」，与比较用 ref 无关；`meta.base_branch` 字段形态不变（存分支名，不存 SHA），避免既有上下文目录迁移。

**放弃的方案**：init 时记录分叉点 SHA（`meta.base_commit`）。更精确，但 harness 支持在已有提交的分支上补 init（续入场景），此时记的 SHA 已经晚于真实分叉点；且需要既有 meta 迁移。

## 验收

- `squash-branch.sh`：本地 base 落后两个提交、分支从远程 tip 切出并自带一个提交时，squash 后新 HEAD 的父提交 == 远程 tip（而非落后的本地 base），且 `origin/<base>..HEAD` 只剩 1 个提交。
- `cr-round.sh`：存在 `refs/remotes/origin/master` 时，`instructions.md` 的评审范围写 `git diff origin/master...HEAD`。
- 保底路径：无远程 ref 的既有全部用例（squash 18 项、cr-round 42 项）保持全绿。

## 不做

单独 plan 文档（单点修复，本篇即执行依据）；`meta.base_branch` 语义变更；harness-context init 的 base 探测逻辑（它选的是分支名，本次只改消费侧解析）。
