# repo-evolver 模型分层实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 repo-evolver 技能引入四级模型分层（fable 判断 / opus 编排 / sonnet 执行 / haiku 轮询），降低成本与迭代时间且不牺牲 PR 合并率。

**Architecture:** 状态机与状态文件零变化，全部改动集中在 `repo-evolver/SKILL.md` 的提示词层：新增「模型分配」契约节，Phase 1 轮询下放 haiku，Phase 2 派发指令与子智能体 prompt 模板按分层改写，防护边界新增升级兜底与判断不下放两条。

**Tech Stack:** Markdown skill 文档；Claude Code Agent tool 的 `model` 参数（`sonnet`/`opus`/`haiku`/`fable`）。

**Spec:** `docs/superpowers/specs/2026-06-11-repo-evolver-model-tiering-design.md`

---

### Task 1: 新增「模型分配」一节

**Files:**
- Modify: `repo-evolver/SKILL.md`（「执行模型」节末尾、「Phase 1: SCAN + ISSUE」之前）

- [ ] **Step 1: 在「执行模型」节与「Phase 1」节之间插入新节**

在 SKILL.md 中找到这段文字（「执行模型」节的最后一段）：

```markdown
这意味着：Phase 1 结束后退出，Phase 2 在下次调用时执行，以此类推。这确保每个 phase 之间有明确的状态持久化点，且 repo-guard 有时间产生评论。
```

在其后、`### Phase 1: SCAN + ISSUE` 之前插入：

```markdown
### 模型分配

各环节按判断密度分配模型档位。**派发子智能体时必须显式传 `model` 参数**，与下表一致：

| 角色 | 模型 | 职责 |
|------|------|------|
| 主循环 | 继承会话 | SCAN 发现与评分、COLLECT 质量评估、META-IMPROVE |
| 每 issue 编排者 | `opus` | 流程协调、repo-guard 审评建议取舍、合并决策 |
| 方案规划者 | `fable` | 在 worktree 内探索代码，用 writing-plans 产出技术方案 |
| 任务执行者 | `sonnet` | 按 plan 逐任务实现 |
| 轮询者 | `haiku` | 等 repo-guard 评论、等 CI，超时或到点返回结果原文 |

两条原则：

- **判断不下放**：发现与评分、方案设计、审评建议取舍、合并决策、meta-improve 诊断必须由主循环或 opus 编排者完成，禁止交给 sonnet/haiku。
- **机械必下放**：按 plan 写代码、轮询 API、等 CI、汇总报告用弱模型；长时间等待一律 haiku。
```

- [ ] **Step 2: 验证插入位置正确**

Run: `grep -n "### 模型分配" repo-evolver/SKILL.md && grep -n "### Phase 1" repo-evolver/SKILL.md`
Expected: 「模型分配」行号小于「Phase 1」行号，且大于「执行模型」所在行号。

### Task 2: Phase 1 轮询下放 haiku

**Files:**
- Modify: `repo-evolver/SKILL.md`（Phase 1 第 9 步）

- [ ] **Step 1: 替换 Phase 1 第 9 步**

旧文本：

```markdown
9. 等待 repo-guard 的 issue review 评论（轮询每个 issue，最多等待 3 分钟）。
```

替换为：

```markdown
9. 派发一个轮询子智能体（`model: "haiku"`）等待 repo-guard 的 issue review 评论：每 30 秒轮询一次所有 issue，最多等待 3 分钟，返回每个 issue 的评论原文（无评论则报告超时）。主循环不自行轮询。
```

- [ ] **Step 2: 验证第 10 步未受影响**

Run: `grep -n "quality-evaluation.md" repo-evolver/SKILL.md`
Expected: 第 10 步「对 repo-guard 评论评分」仍存在且紧跟第 9 步——评分判断保留在主循环。

### Task 3: Phase 2 派发指令与 prompt 模板改造

**Files:**
- Modify: `repo-evolver/SKILL.md`（Phase 2 第 2 条 + 子智能体 prompt 模板）

- [ ] **Step 1: 修改 Phase 2 第 2 条派发说明**

旧文本：

```markdown
2. 对每个 issue，使用 Agent tool 派发一个子智能体（`isolation: "worktree"`），prompt 包含：
```

替换为：

```markdown
2. 对每个 issue，使用 Agent tool 派发一个编排子智能体（`model: "opus"`, `isolation: "worktree"`），prompt 包含：
```

- [ ] **Step 2: 替换子智能体 prompt 模板**

将「**子智能体 prompt 模板：**」下的整个代码块（从 `你负责解决 Issue #{number}: {title}` 到 `完成后报告：…是否采纳了建议。`）替换为：

````markdown
```
你负责解决 Issue #{number}: {title}

约束条件（来自 repo-guard issue review）：
{constraints}

模型分配（派发子智能体时必须显式传 model 参数）：
- 方案规划者用 fable，任务执行者用 sonnet，轮询者用 haiku
- repo-guard 建议的取舍、plan 是否合格、是否合并由你自己判断，不下放给子智能体

执行步骤：
1. 创建分支 improve/{slug}
2. 派发方案规划子智能体（model: "fable"）：在当前 worktree 内探索代码，使用 writing-plans 编写技术方案，返回 plan 文件路径
3. 检查 plan 是否覆盖上述约束条件。不覆盖则附上缺口反馈重新派发规划者（最多重试 1 次）
4. 使用 subagent-driven-development 执行 plan，每个 task 子智能体显式传 model: "sonnet"
5. 使用 finishing-a-development-branch 创建 PR（目标分支: {default_branch}），描述中引用 Issue: "Closes #{number}"
6. 派发轮询子智能体（model: "haiku"）等待 repo-guard PR review 评论：每 30 秒轮询 gh api，最多 5 分钟，返回评论原文
7. 逐条判断建议：有效（具体、可操作）→ 派 sonnet 子智能体实施修复并 push 到同一分支；无效（误报、泛泛）→ 记录忽略理由
8. 派发轮询子智能体（model: "haiku"）等待 CI 结果（gh pr checks）。CI 失败时自己诊断原因，派 sonnet 子智能体修复并 push
9. 同一任务 sonnet 连续失败 2 次时，改用 model: "opus" 重试一次该任务；仍失败则停止该任务并在报告中说明原因
10. 审评反馈已处理且 CI 全部通过后，合并 PR

完成后报告：PR 编号、是否已合并（未合并需附原因）、repo-guard 质量评分（参考 quality-evaluation 标准）、是否采纳了建议。
```
````

- [ ] **Step 3: 验证模板内模型引用完整**

Run: `sed -n '/子智能体 prompt 模板/,/^完成后报告/p' repo-evolver/SKILL.md | grep -c 'model: "'`
Expected: 5（fable ×1、sonnet ×1、haiku ×2、opus ×1）。

### Task 4: 防护边界新增两条

**Files:**
- Modify: `repo-evolver/SKILL.md`（「防护边界」节末尾）

- [ ] **Step 1: 在「防护边界」列表末尾追加**

在最后一条「子智能体必须使用 worktree 隔离…」之后追加：

```markdown
- 模型升级兜底：同一任务 sonnet 连续失败 2 次后，编排者必须用 opus 重试一次，不得直接放弃；仍失败才走失败上报流程。
- 判断不下放：repo-guard 建议取舍、技术方案审定、合并决策必须由主循环或 opus 编排者完成，禁止交给 sonnet/haiku 子智能体。
```

- [ ] **Step 2: 验证防护边界条数**

Run: `sed -n '/## 防护边界/,$p' repo-evolver/SKILL.md | grep -c '^- '`
Expected: 11（原 9 条 + 新增 2 条）。

### Task 5: 整体校验与提交

**Files:**
- Modify: 无（只读校验 + 提交）

- [ ] **Step 1: 校验全文 model 参数与分配表一致**

Run: `grep -n 'model: "' repo-evolver/SKILL.md`
Expected: 只出现 `"fable"`、`"sonnet"`、`"haiku"`、`"opus"` 四种取值，无拼写错误（如 `claude-sonnet` 等长 ID）。

- [ ] **Step 2: 校验状态机与状态文件未被改动**

Run: `git diff repo-evolver/SKILL.md | grep -E '^[+-].*(digraph|state-schema)' || echo CLEAN`
Expected: 输出 `CLEAN`（dot 状态机和 state-schema 引用零改动）。

- [ ] **Step 3: 运行 gitnexus_detect_changes 确认影响范围**

调用 `gitnexus_detect_changes()`。
Expected: 仅 markdown 文件变更，无代码符号或执行流受影响。

- [ ] **Step 4: 提交**

```bash
git add repo-evolver/SKILL.md
git commit -m "feat: repo-evolver 四级模型分层（fable 判断 / opus 编排 / sonnet 执行 / haiku 轮询）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
