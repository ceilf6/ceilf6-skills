# State Schema

状态文件 `.claude/repo-evolver.local.md` 的格式定义。

## 位置

在目标仓库根目录下：`.claude/repo-evolver.local.md`

此文件应加入 `.gitignore`（运行时状态，不应提交）。

## 格式

YAML frontmatter + Markdown body。

### Frontmatter 字段

```yaml
---
phase: scan | dispatch | collect | meta_improve
iteration: 1         # 当前迭代次数（ralph-loop 每次 +1）
active_issues: []    # 当前批次的 issue 编号列表
active_prs: []       # 当前批次的 PR 编号列表
meta_improvement_count: 0          # 累计 meta-improvement 次数
last_meta_iteration: 0             # 上次 meta-improvement 的迭代号
meta_improvement_exhausted: false  # 是否已放弃 meta-improvement
consecutive_empty_scans: 0         # 连续空 backlog 扫描次数
---
```

### Body 结构

```markdown
## Backlog

- [ ] [P0/10] Fix type error in packages/core/src/agent.ts (正确性)
- [ ] [P2/5] Remove unused export `legacyHelper` from shared/utils.ts (死代码)
- [x] [P0/10] Fix failing test in executor.test.ts (done: PR #18)
- [~] [P2/4] Reduce complexity of planner.ts:generatePlan (skipped: 连续失败 2 次)

## Active Batch

| Issue | PR | Branch | Status | Agent |
|-------|-----|--------|--------|-------|
| #42 | #50 | improve/remove-legacy-helper | merged | agent-1 |
| #44 | - | improve/add-tests | implementing | agent-3 |

Status 取值：`implementing` → `pr_created` → `ci_passing` → `merged`

## Quality Log

| PR | Score | Details |
|----|-------|---------|
| #18 | 4.2 | 3 正确可操作(+6), 1 泛泛(+1), raw=1.75, norm=4.7 |
| #19 | 2.1 | 1 正确(+2), 2 误报(-2), 1 遗漏(-2), raw=-0.5, norm=1.9 |

**Rolling Average:** 3.15

## Meta-Improvement Log

| Iteration | Target | Strategy | Result |
|-----------|--------|----------|--------|
| 12 | review-rubric.md | B (添加检查项) | 有效，下次分数 +1.2 |
```

## Backlog 条目格式

```
- [ ] [优先级/分数] 描述 (类别)
- [x] [优先级/分数] 描述 (done: PR #N)
- [~] [优先级/分数] 描述 (skipped: 原因)
```

- `[ ]`：待处理
- `[x]`：已完成
- `[~]`：已跳过

## 初始状态

首次运行时创建：

```markdown
---
phase: scan
iteration: 1
current_issue: null
current_pr: null
current_branch: null
meta_improvement_count: 0
last_meta_iteration: 0
meta_improvement_exhausted: false
consecutive_empty_scans: 0
---

## Backlog

(empty)

## Quality Log

| PR | Score | Details |
|----|-------|---------|

**Rolling Average:** N/A

## Current Work

Phase: scan (initial)

## Meta-Improvement Log

| Iteration | Target | Strategy | Result |
|-----------|--------|----------|--------|
```
