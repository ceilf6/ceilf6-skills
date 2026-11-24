# repo-evolver 模型分层设计

日期：2026-06-11
状态：已确认
改动范围：`repo-evolver/SKILL.md`、`repo-evolver/references/state-schema.md`

## 修订历史

- **初版（06-11）**：基于子代理的四级分层，Phase 2 每 issue 派 opus 编排者，内部再并行派 fable/sonnet/haiku 子代理，多 worktree 隔离。
- **修订一（06-13）**：应用方要求「不要子代理、不要并行」。改为串行单会话 + 按 phase 分层 + 运行器按 phase 切模型（`next_model` 字段）。
- **修订二（06-13，当前）**：澄清「并行 ≠ 子代理」——应用方反对的是*并行*，不是子代理机制本身。改为**串行子代理**：一次只处理一个 issue，phase 内串行派单个子代理（并发上限 1，不用 worktree），靠 Agent tool 的 `model` 参数切模型。撤销 `next_model`/运行器依赖。

## 背景与目标

repo-evolver 在循环（ralph-loop）中运行，每次调用执行一个 phase。目标：让模型档位匹配工作的判断密度——判断密集用强模型，机械执行用弱模型——降低 token 成本，且不牺牲 PR 合并率。

约束：**不并行**（任意时刻最多一个代理在跑，一次只处理一个 issue），但允许**串行子代理**作为切换模型的手段。

## 模型分配（串行子代理）

| 角色 | 模型 | 职责 |
|------|------|------|
| 主循环（编排/判断） | 继承会话（应为强档：fable，下线时 opus） | SCAN 发现与评分、IMPLEMENT 编排 + 审评取舍 + 合并决策、COLLECT 评估、META-IMPROVE 诊断 |
| 方案规划子代理 | `fable`（兜底 opus） | writing-plans 产出技术方案 |
| 任务执行子代理 | `sonnet` | subagent-driven-development 逐任务实现/修复 |
| 轮询子代理 | `haiku` | 等 repo-guard 评论、等 CI，返回原文 |

两条原则：

- **判断不下放**：发现评分、方案审定、repo-guard 建议取舍、合并决策、meta 诊断由主循环完成；子代理只产出 plan、代码、评论原文等原料。
- **机械必下放**：写代码、轮询、等 CI 用弱模型；长等待一律 haiku。

相比初版，去掉了独立的「opus 编排者子代理」——主循环本身就是编排者（因为一次只处理一个 issue，无需为并行而包一层）。

## 串行约束

- 派一个子代理 → 阻塞等返回 → 再派下一个；任意时刻最多 1 个子代理。
- 不传 `run_in_background: true`，不传 `isolation: "worktree"`（串行无文件冲突，共用工作目录与分支）。
- 一次调用只推进一个 issue；合并后下次调用再处理队列下一个。

## 不可用兜底

能力阶梯（弱→强）：`haiku < sonnet < opus < fable`。派子代理时若目标模型在 `unavailable_models` 中，沿阶梯就近取**更强**的可用档；目标已是最强档（fable）或其上无可用档时退到就近**更弱**档。

当前 `unavailable_models: [fable]`（fable5 下线）：规划子代理 fable → opus；sonnet/haiku 不变；主循环由运行器以 opus 启动。fable5 恢复后从列表移除即自动恢复，无需改 SKILL.md。

## 机制：技能内切模型，无运行器依赖

模型切换全在技能内部经 Agent tool 的 `model` 参数完成，**不依赖运行器按 phase 切模型**（这是相比修订一的关键优势——修订一的 `next_model`/运行器机制是个未确认的外部依赖，现已撤销）。主循环自身模型由启动 repo-evolver 时确定，应为强档。

## 具体改动

1. **SKILL.md「模型分配（串行子代理）」节**：替换原节，含串行子代理声明 + 角色模型表 + 两条原则 + 串行约束 + 兜底规则。
2. **Phase 1**：第 9 步轮询改为派 1 个 haiku 子代理；评分仍由主循环做。
3. **Phase 2**：主循环编排，串行派 fable 规划子代理 → subagent-driven-development（task 子代理 `model: sonnet`）→ haiku 轮询 → 主循环审评取舍 → sonnet 修复 → 合并；升级兜底用 opus。
4. **状态机 dot 图**：phase 节点标注各自派发的子代理模型。
5. **防护边界**：串行子代理（并发上限 1、不 worktree、不后台）+ 判断不下放 + 升级兜底 + 模型不可用兜底。
6. **state-schema.md**：保留 `unavailable_models`（子代理兜底依据），移除 `next_model`。

## 不变项

- 状态机四阶段、HARD-GATE、红线、Issue→repo-guard→PR 流程纪律全部保留。
- Phase 3 COLLECT、Phase 4 META-IMPROVE 职责不变。
- 不新增 references 文件。

## 验证方式

- 静态审查：每处子代理派发都有显式 `model`，取值仅 `fable`/`sonnet`/`haiku`/`opus`；无 `isolation: "worktree"`、无 `run_in_background: true`；无 `next_model` 残留。
- 实跑验证：下一次迭代观察各子代理实际模型、是否始终串行（≤1 并发）、PR 合并率与 token 消耗对比。
