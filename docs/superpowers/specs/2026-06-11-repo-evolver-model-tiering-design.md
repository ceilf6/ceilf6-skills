# repo-evolver 模型分层设计

日期：2026-06-11
状态：已确认
改动范围：仅 `repo-evolver/SKILL.md`

## 背景与目标

repo-evolver 当前所有环节继承调用者模型（通常是 fable），没有任何模型分层：Phase 2 中每个 issue 的子智能体用最强模型完成 plan → implement → PR → 轮询 → 处理审评的全流程，其中大量是机械执行和长时间等待。

目标（两者兼顾）：在不明显牺牲 PR 合并率的前提下，降低 token 成本并缩短迭代时间。原则是**模型档位匹配环节的判断密度**——判断密集用强模型，照单执行用弱模型，机械等待用最便宜的模型。

## 模型分配总则

| 角色 | 模型 | 职责 |
|------|------|------|
| 主循环 | 继承会话（预期 fable） | SCAN 发现与评分、COLLECT 质量评估、META-IMPROVE |
| 每 issue 编排者 | `opus` | 流程协调、repo-guard 审评建议的取舍判断、合并决策 |
| 方案规划者 | `fable` | 在 worktree 内探索后用 writing-plans 产出技术方案 |
| 任务执行者 | `sonnet` | 按 plan 逐任务实现（subagent-driven-development 的 task agents） |
| 轮询者 | `haiku` | 等 repo-guard 评论、等 CI，超时或到点返回结果原文 |

判断密集环节（必须强模型）：改进点发现与评分、技术方案设计、repo-guard 建议有效性判断、meta-improve 诊断。
机械环节（可弱模型）：按 plan 写代码跑测试、轮询 API、等 CI、汇总报告。

## 具体改动

### 1. SKILL.md 新增「模型分配」一节

放在「执行模型」之后，内容为上面的分配表 + 两条原则说明，作为各 phase 派发子智能体时的模型契约。

### 2. Phase 1 第 9 步：轮询下放 haiku

现状：「轮询每个 issue，最多等待 3 分钟」发生在 fable 主循环内，是最贵的轮询。

改为：派发一个 `model: "haiku"` 子智能体执行轮询（每 30 秒一次，3 分钟超时），返回所有 repo-guard 评论原文。第 10 步的质量评分和约束提取仍由主循环（fable）完成——判断活不下放。

### 3. Phase 2：派发指令与 prompt 模板改造（核心）

派发改为 `Agent(model: "opus", isolation: "worktree", ...)`。子智能体 prompt 模板更新为：

1. 创建分支 `improve/{slug}`（opus 编排者自己做）
2. 派发 **fable planner** 子智能体（`model: "fable"`）：在 worktree 内探索代码，用 writing-plans 写技术方案，输出 plan 文件路径后退出
3. opus 检查 plan 是否覆盖 issue 的约束条件；不覆盖则带反馈重新派发 planner（最多 1 次）
4. 用 subagent-driven-development 执行 plan，**每个 task agent 显式 `model: "sonnet"`**
5. 用 finishing-a-development-branch 创建 PR，描述中引用 "Closes #{number}"
6. 派发 **haiku poller**（`model: "haiku"`）等待 repo-guard PR review（每 30 秒轮询 gh api，5 分钟超时），返回评论原文
7. opus 逐条判断建议有效/无效：有效的派 sonnet 实施修复并 push；无效的记录忽略理由
8. CI 等待同样派 haiku poller；CI 失败时 opus 诊断原因，派 sonnet 修复
9. 审评处理完且 CI 通过后合并 PR
10. 报告：PR 编号、合并状态、repo-guard 质量分、建议采纳情况（不变）

### 4. 防护边界新增两条

- **升级兜底**：同一任务 sonnet 连续失败 2 次 → 编排者用 `opus` 重试一次该任务；仍失败才按原有失败流程标记上报。降级永远可逆，保住合并率。
- **判断不下放**：repo-guard 建议的取舍、plan 的设计、合并决策不得交给 sonnet/haiku 级别的子智能体。

## 不变项

- 状态机四阶段、状态文件格式（references/state-schema.md）零变化
- HARD-GATE、红线、现有防护边界全部保留
- 不新增 references 文件
- Phase 3 COLLECT、Phase 4 META-IMPROVE 仍在主循环执行，不分层

## 验证方式

- 静态审查：prompt 模板中每处派发都有显式 `model` 参数，且与分配表一致
- 实跑验证：下一次 repo-evolver 迭代观察各子智能体实际使用的模型、PR 合并率与 token 消耗对比
