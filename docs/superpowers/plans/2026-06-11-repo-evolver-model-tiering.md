# repo-evolver 模型分层实施计划

> **2026-06-13 修订二**：澄清「并行 ≠ 子代理」后，最终方案为**串行子代理分层**——一次只处理一个 issue，phase 内串行派单个子代理（并发上限 1、不用 worktree），靠 Agent tool 的 `model` 参数切模型。撤销修订一的 `next_model`/运行器依赖。详见 spec 修订历史。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 串行实现本计划（task 子代理一次 1 个）。

**Goal:** 为 repo-evolver 引入「串行子代理模型分层 + 不可用兜底」：在不并行（任意时刻 ≤1 个代理、一次 1 个 issue）的前提下，靠串行派发子代理切模型，并支持 fable5 下线时自动降级。

**Architecture:** 状态机四阶段不变。主循环（编排/判断，跑在继承会话模型）在 phase 内串行派子代理：规划 `fable`、执行 `sonnet`（subagent-driven-development）、轮询 `haiku`；每个子代理派发后阻塞等返回再派下一个，不传 worktree/后台。模型切换经 Agent `model` 参数在技能内完成，不依赖运行器。

**Tech Stack:** Markdown skill 文档；Claude Code Agent tool 的 `model` 参数（`fable`/`sonnet`/`haiku`/`opus`）；状态字段 `unavailable_models`；能力阶梯 `haiku < sonnet < opus < fable`。

**Spec:** `docs/superpowers/specs/2026-06-11-repo-evolver-model-tiering-design.md`

---

### Task 1: SKILL.md「模型分配（串行子代理）」节

**Files:** Modify `repo-evolver/SKILL.md`

- [x] 写入串行子代理声明（并发上限 1、不 worktree、不后台）+ 角色模型表 + 判断不下放/机械必下放两原则 + 不可用兜底规则。

### Task 2: Phase 1 轮询派 haiku 子代理

**Files:** Modify `repo-evolver/SKILL.md`

- [x] 第 9 步改为派 1 个 `model: "haiku"` 子代理轮询 issue review，阻塞等返回；第 10 步评分仍由主循环做。
- [x] 第 11 步移除 `next_model` 写入。

### Task 3: Phase 2 串行子代理流程

**Files:** Modify `repo-evolver/SKILL.md`

- [x] 主循环编排：派 fable 规划子代理 → 检查覆盖 → subagent-driven-development（task 子代理 `model: sonnet`）→ 主循环建 PR → haiku 轮询 PR review → 主循环取舍、派 sonnet 修复 → haiku 轮询 CI → sonnet 修复 → 主循环合并。
- [x] 升级兜底：同一 task sonnet 连续失败 2 次 → 派 opus 子代理重试一次。
- [x] 第 14 步移除 `next_model` 写入。

### Task 4: 状态机 dot 图 + 防护边界

**Files:** Modify `repo-evolver/SKILL.md`

- [x] dot 图各 phase 节点标注派发的子代理模型。
- [x] 防护边界：串行子代理（并发 1、不 worktree、不后台）、判断不下放、升级兜底、模型不可用兜底；移除 `next_model` 相关条目。

### Task 5: state-schema.md

**Files:** Modify `repo-evolver/references/state-schema.md`

- [x] 移除 `next_model`，保留 `unavailable_models: [fable]`，改写「模型分层字段」说明节为串行子代理口径。

### Task 6: 整体校验与提交

- [ ] 校验：`grep -nE 'model: "' repo-evolver/SKILL.md` 仅 fable/sonnet/haiku/opus；无 `next_model`、无 `isolation: "worktree"`、无 `run_in_background`。
- [ ] 运行 `gitnexus_detect_changes()` 确认仅 markdown 变更。
- [ ] 提交。
