# Slardar Triage Lark Handling Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the Lark branch from presenting a technically fixable message when positive evidence shows that another person or active work item is already handling the same problem.

**Architecture:** Keep the existing two-verdict state model. Add a mandatory Lark-only gate after technical fixability is known and before `candidate` can win the race. A positive overlap becomes the existing agent `judge --fixable no` verdict with concrete evidence; absence of overlap is not persisted, and no new state type or global Meego/Oncall search is introduced.

**Tech Stack:** Markdown Skill contract, Node.js state CLI already present in `slardar-triage/scripts/state.mjs`, fresh-context agent pressure tests, Bash validation.

## Global Constraints

- Work in an isolated worktree created from current `main`; do not disturb untracked files in `/Users/bytedance/Desktop/ceilf/ceilf6-skills`.
- Do not add a new state type, command, script, or persistent “nobody is handling this” field.
- Do not perform global Meego or Oncall searches.
- Harness overlap uses only `task-schedule.js list`; never scan `harness-workspaces/*/task.json` one by one.
- BITS overlap queries must use exact evidence-derived keywords and follow `bytedcli-enhanced` plus `bytedcli-bits-mr`; never list all open MRs without a keyword.
- A positive overlap must match the exact problem being considered, not merely the same alert card or a similar title.
- If any mandatory Lark material, Harness task query, targeted MR query, or exact linked Meego/Oncall query fails, the Lark source returns `blocked`.
- User-revived candidates retain existing user-decision priority and are not overwritten by an agent verdict.
- The approved design and this plan remain uncommitted and unpushed.
- The implementation commit must contain only the Skill change and any purpose-built behavioral verification material; never include `slardar-triage/state/`.

---

### Task 1: Add the Lark “already handled” candidate gate

**Files:**
- Modify: `slardar-triage/SKILL.md:16-21`
- Modify: `slardar-triage/SKILL.md:146-180`
- Modify: `slardar-triage/SKILL.md:238-255`
- Reference only: `docs/superpowers/specs/2026-11-09-slardar-triage-lark-handling-gate-design.md`

**Interfaces:**
- Consumes: the existing Lark normalized candidate `lark:<message_id>`, `walk` classes, worker states, `state.mjs judge`, canonical Harness task list, and targeted BITS MR search.
- Produces: `candidate` only after the Lark handling gate passes; otherwise a main-agent write request equivalent to `judge --fixable no --reason "已有处理：..."`, followed by `continue`, or `blocked` when the gate cannot complete.

- [ ] **Step 1: Create the isolated implementation worktree**

Use `superpowers:using-git-worktrees` before running the command. Fetch `origin/main`, verify the source checkout has only pre-existing untracked user files, then create a branch named `fix/slardar-triage-lark-handling-gate` in the location selected by that skill. Do not copy the untracked spec or plan into the worktree.

Expected: the worktree is clean and starts from current `origin/main`.

- [ ] **Step 2: Run the no-guidance RED micro-test**

Run five fresh-context agents with no access to the revised Skill. Give every agent this same scenario and require one of `candidate | continue | blocked` plus the requested state write:

```text
You are the Lark worker in a two-source triage race. The current message contains a P0 vc_web alert. Code evidence proves a Web-side RetryPlugin defect that can cause a visible blank page. The current local triage state has no dispatched item. In the same Lark thread, Yang Jinliang wrote: “确实有问题，我用安卓可以复现。我去报个 oncall”. The current workflow says the first technically fixable item returns candidate and wins. Decide the worker result and any state write request. Do not invent information.
```

Manually read all five responses. Record which ones return `candidate` or otherwise treat the Oncall statement only as reproduction evidence. The real 2026-11-05 run already supplies a historical RED observation; the micro-test must still demonstrate at least one present-day control failure before editing the Skill. If all five controls already comply, stop and tighten the pressure scenario rather than editing guidance without a failing control.

- [ ] **Step 3: Add the minimal Skill contract**

Change the worker-state definition to make the Lark gate part of `candidate`:

```markdown
- `candidate`：共享状态确认当前候选为 `fixable`；Lark 候选还必须通过「已有处理门禁」；
```

Replace the current Lark `walk` outcome sentence with:

```markdown
主 Agent 对这一条执行与 Slardar 完全相同的 `merge -> walk -> judge -> walk`：缓存判定照常复用，`unjudged` 按 `references/judging.md` 读证据，用户捞回、拒绝、已派单与 `rejudge` 语义不变。`walk` 为 `skip` 就回 `continue`；`walk` 为 agent `fixable` 只说明技术上能修，Lark worker 必须继续执行下述「已有处理门禁」，通过后才回 `candidate`。用户捞回项仍按既有用户决定优先规则处理。Lark 候选不写 Slardar 量级 ledger。
```

Insert this subsection immediately before the existing `bot 不在群时` paragraph:

```markdown
### 已有处理门禁（Lark candidate 返回前必做）

用户口径中，其他人已经处理当前问题就等同于本技能的「不能修」。Lark worker 对每个准备返回的 agent `fixable` 候选必须完成以下检查；缓存的 agent `fixable` 也不能直接复用为 `candidate`：

1. 读取当前消息、话题回复、附件和消息内链接，找明确的接手、处理中、已报 Oncall、已有任务或已有 MR 证据。
2. 用当前问题的报错原文、Issue ID、文件或函数名、已知任务标题等精确证据执行针对性重叠检查：Harness 任务只用 `node <harness>/scripts/task-runtime/schedule/task-schedule.js list` 后按候选仓库与精确证据过滤，不逐个扫描 task JSON；BITS MR 查询先按 `bytedcli-enhanced` 与 `bytedcli-bits-mr` skill 读取规则，再在候选仓库上下文运行 `bytedcli --json bits mr search --state opened --keyword '<来自当前证据的精确关键词>'`，可以查多个精确词，禁止无关键词列出全部开放 MR。
3. 消息材料给出明确 Meego / Oncall 链接时，只查该条目的当前状态；禁止全局搜索 Meego 或 Oncall。

命中必须有能关联到当前具体问题的正向证据。只命中宽泛关键词、相邻告警或相似标题不算；任务或 MR 标题命中后还要核对描述、来源证据或改动点确实覆盖当前问题。一条消息有多个独立问题时，先检查当前准备呈现的问题；不能拿另一个问题的处理证据跳过当前问题。

确认已有处理：worker 请求主 Agent 对 `lark:<message_id>` 执行 `judge --fixable no --reason "已有处理：<处理人、动作或任务/MR/Oncall 证据>"`；主 Agent 完成不可中断的状态写入单元并重跑 `walk` 后，本条回 `continue`，继续下一条。没有命中：不持久化「无人处理」，本轮才允许回 `candidate`。

任一必查材料或针对性查询因认证、权限、网络或依赖失败而无法完成，本 worker 回 `blocked`；不得把「未完成检查」当成「没有人在处理」。另一来源仍按双线竞速规则继续。
```

Add this discipline bullet after the existing user-decision priority bullet:

```markdown
- Lark agent 候选呈现前必须通过「已有处理门禁」；已有处理按 agent `fixable=no` 落账并继续下一条，没有命中不持久化，查询失败则该来源 `blocked`。不得用全局 Meego / Oncall 搜索或无关键词开放 MR 列表替代针对性检查。
```

- [ ] **Step 4: Run the GREEN wording micro-test**

Run five fresh-context agents with the realistic updated Lark section, including the new gate text above, and the exact RED scenario from Step 2. Manually read every response.

Expected for all five:

```text
continue
judge --fixable no --reason "已有处理：杨金良明确表示‘我去报个 oncall’"
```

Reject any response that returns `candidate`, treats the Oncall statement only as reproduction evidence, requests a global Meego/Oncall search, or writes state from the worker.

- [ ] **Step 5: Run five no-overlap variation checks**

Use the same updated section but change the thread reply to:

```text
“确实有问题，我用安卓可以复现；目前还没有人接手。”
```

State that the canonical Harness task list and exact-keyword opened-MR queries completed successfully with no matching work, and there are no Meego/Oncall links.

Expected for all five: `candidate`; no `judge=no` request; no global search request.

- [ ] **Step 6: Run targeted edge-case checks**

Run one fresh-context sample for each case and manually verify the result:

```text
Case A: exact-keyword BITS query fails authentication -> blocked
Case B: a similarly titled MR changes a different file and error -> candidate
Case C: current message contains an exact active Oncall link for the same problem -> continue + judge=no with the link
Case D: one alert card contains problem A already handled and independent problem B not handled; B is the problem being presented -> candidate for B
Case E: source=user because the user revived the Lark item -> preserve user decision; do not overwrite it with agent judge=no
```

- [ ] **Step 7: Run repository validation**

Run:

```bash
bash slardar-triage/tests/run.sh
/opt/homebrew/bin/python3 /Users/bytedance/.claude/skills/skill-creator/scripts/quick_validate.py slardar-triage
git diff --check
```

Expected: all tests pass, quick validation prints a valid Skill result, and `git diff --check` has no output.

- [ ] **Step 8: Review the exact diff and commit the Skill only**

Run:

```bash
git status --short
git diff -- slardar-triage/SKILL.md
git diff --check
git add slardar-triage/SKILL.md
git diff --cached --check
git commit -m "fix(slardar-triage): skip Lark issues already handled"
```

Expected: the commit contains `slardar-triage/SKILL.md` only. It must not contain `state/`, the design doc, the plan doc, or unrelated files.

---

### Task 2: Integrate and publish the Skill update

**Files:**
- Merge only: commit produced by Task 1
- Preserve untracked: `/Users/bytedance/Desktop/ceilf/ceilf6-skills/docs/superpowers/specs/2026-11-09-slardar-triage-lark-handling-gate-design.md`
- Preserve untracked: `/Users/bytedance/Desktop/ceilf/ceilf6-skills/docs/superpowers/plans/2026-11-09-slardar-triage-lark-handling-gate.md`

**Interfaces:**
- Consumes: clean feature worktree, one Skill-only commit, current `origin/main`.
- Produces: local `main` fast-forwarded to the verified commit and pushed to `origin/main`, with SDD documents still untracked and unpushed.

- [ ] **Step 1: Rebase the feature branch on the latest remote main**

Fetch immediately before rebase, create a backup branch before any history rewrite, and rebase without bypassing hooks:

```bash
git fetch origin main
git branch backup/fix-slardar-triage-lark-handling-gate-2026-11-09
git rebase origin/main
```

Expected: rebase succeeds; the Skill-only commit remains one clear commit.

- [ ] **Step 2: Re-run validation on the rebased commit**

Run:

```bash
bash slardar-triage/tests/run.sh
/opt/homebrew/bin/python3 /Users/bytedance/.claude/skills/skill-creator/scripts/quick_validate.py slardar-triage
git diff --check origin/main...HEAD
git rev-list --count HEAD..origin/main
```

Expected: all validation passes and the rev-list count is `0`.

- [ ] **Step 3: Fast-forward the true repository main and push**

In `/Users/bytedance/Desktop/ceilf/ceilf6-skills`, preserve all pre-existing untracked files, fetch again, verify `main` has not diverged, then:

```bash
git merge --ff-only fix/slardar-triage-lark-handling-gate
git push origin main
```

Expected: `main` points at the verified Skill-only commit and the push succeeds. Do not add the design or plan documents.

- [ ] **Step 4: Verify the published result**

Run:

```bash
git rev-list --count HEAD..origin/main
git show --stat --oneline HEAD
git status --short
```

Expected: rev-list count is `0`; the latest functional commit changes only `slardar-triage/SKILL.md`; the pre-existing and SDD untracked files remain present and uncommitted.
