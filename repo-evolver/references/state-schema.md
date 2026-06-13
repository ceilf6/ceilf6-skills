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
phase: scan | implement | collect | meta_improve
iteration: 1         # 当前迭代次数（ralph-loop 每次 +1）
issue_queue: []      # 本批次待串行实现的 issue 编号队列
current_issue: null  # 当前正在实现的 issue 编号
current_pr: null     # 当前 issue 对应的 PR 编号
current_branch: null # 当前工作分支
unavailable_models: [fable]        # 当前不可用的模型；派子代理时据此沿能力阶梯就近取更强可用档
meta_improvement_count: 0          # 累计 meta-improvement 次数
last_meta_iteration: 0             # 上次 meta-improvement 的迭代号
meta_improvement_exhausted: false  # 是否已放弃 meta-improvement
consecutive_empty_scans: 0         # 连续空 backlog 扫描次数
---
```

### 模型分层字段

`unavailable_models` 支撑「串行子代理分层 + 不可用兜底」（详见 SKILL.md「模型分配（串行子代理）」节）：

- 模型分层靠串行派发子代理实现：规划子代理 `model: fable`、执行子代理 `model: sonnet`、轮询子代理 `model: haiku`；主循环（编排/判断）跑在继承的会话模型上。
- 能力阶梯（弱→强）：`haiku < sonnet < opus < fable`。
- 派子代理时，若目标模型在 `unavailable_models` 中，沿阶梯就近取更强的可用档传给 `model`（最强档不可用才退更弱档）。
- 当前 `unavailable_models: [fable]`（fable5 下线），故规划子代理的 `fable` 解析为 `opus`，sonnet/haiku 不受影响。fable5 恢复后从列表移除即自动恢复。
- 无需 `next_model` 字段：模型切换由 Agent tool 的 `model` 参数在技能内部完成，不依赖运行器按 phase 切换。

### Body 结构

```markdown
## Backlog

- [ ] [P0/10] Fix type error in packages/core/src/agent.ts (正确性)
- [ ] [P2/5] Remove unused export `legacyHelper` from shared/utils.ts (死代码)
- [x] [P0/10] Fix failing test in executor.test.ts (done: PR #18)
- [~] [P2/4] Reduce complexity of planner.ts:generatePlan (skipped: 连续失败 2 次)

## Current Work

| Issue | PR | Branch | Status |
|-------|-----|--------|--------|
| #44 | - | improve/add-tests | implementing |

队列中其余待处理 issue 编号见 frontmatter `issue_queue`，逐个串行处理。
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
issue_queue: []
current_issue: null
current_pr: null
current_branch: null
unavailable_models: [fable]
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
