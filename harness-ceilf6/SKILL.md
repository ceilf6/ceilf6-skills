---
name: harness-ceilf6
description: 个人需求交付 harness：装载 harness-context 的需求上下文，过计划门（轻量复述自动过门 / 实在不明确才转 superpowers 完整规划 / 续入跳过），当前会话直接开发（TDD 红绿纪律），自动驱动 codex 对抗式 CR 循环（送审→结构化判定→修复→再送审）直至通过或熔断，通过后自动 push 并经 bytedcli-bits-mr 建 MR；支持无人值守模式（bot 场景由调用方声明）。人工 CR / 测试发现问题后可带全部历史续跑。当用户在装载上下文后要求「开始开发」「跑 harness」「继续 CR 循环」「续跑」时使用。前置：需求分支 + harness-context 已 init。
---

# harness-ceilf6：开发 + 对抗式 CR 循环

**权限前提**：循环全程不允许权限打断。codex 侧已在脚本内固化 `--dangerously-bypass-approvals-and-sandbox`；claude 侧即当前会话——建议以 bypass permissions 模式启动会话跑循环。

**开发者是当前会话本身**（不 shell 出 claude 子进程）；只有评审员是外部进程。用户全程在场、随时可插话纠偏。

机械层脚本：`~/.claude/skills/harness-ceilf6/scripts/cr-round.sh`（依赖 git、jq、codex CLI）。

## 模式

默认**交互模式**。当调用方在会话开头明确声明「无人值守模式」（如任务大厅 bot 的 bootstrap prompt）时，仅以下三处分叉，其余（**含计划门自动过门**）两种模式一致：

- 计划门·完整路径：交互模式转 superpowers brainstorming 与用户协商；无人值守模式**不可用**，按调用方约定输出 escalate 结果后结束。
- 僵局熔断：交互模式停下交用户裁决；无人值守模式不等人，按调用方约定输出 fused 结果后结束。
- 结果输出：无人值守模式结束时按调用方约定输出结果行（如 RESULT 契约）；交互模式面向用户汇总。

## 流程

### 前置：装载上下文

1. `CTX=$(bash ~/.claude/skills/harness-context/scripts/ctx-dir.sh resolve)`。resolve 在主分支/detached 上失败，或 `$CTX` 缺 meta.json（未初始化）→ 走 harness-context 的 init（其**主分支恢复流**会从需求源派生分支名、经用户确认后创建并切换，再初始化）；detached HEAD 由用户自行处理。
2. 按 harness-context 的 get 约定读取 `$CTX` 全部内容装入会话。

### 阶段 0：计划门（开发不允许直接开始）

出口统一为 `$CTX/plan.md`（目标 / 范围 / 改法 / 验收标准 四段）。三条路径：

1. **续入路径**：`$CTX/plan.md` 已存在 → 跳过门。本轮新增问题以「## 验收增补（<日期>）」小节追加进 plan.md。用户明确说「重新规划」才走重规划：旧内容整体降级为「## 历史版本（<日期>归档）」小节保留于文件尾部，新四段写在文件头。
2. **轻量路径（默认，自动过门）**：能从上下文复述出可信的目标/范围/改法/验收四段 → 写入 plan.md 并向用户播报（交互场景你在场，随时可打断修正），**不等待确认直接过门**——用户 2026-07-29 裁定：只有实在不明确的需求才需要人工协商。plan.md 头部加一行「> 计划门自动通过（<日期>）」。
3. **完整路径（实在不明确才走）**：复述不出可信四段（缺关键信息或解读分歧大），或用户点名「走 brainstorming」→ 交互模式转 superpowers 的 brainstorming → writing-plans 全流程与用户协商，结束后把最终 plan 内容归一写入 plan.md；无人值守模式按「模式」节输出 escalate。

过门后：`bash ~/.claude/skills/harness-context/scripts/ctx-dir.sh set-status developing`。

### 阶段 1：开发（TDD 红绿纪律）

当前会话按 plan.md 实现，测试先行：

1. 从 plan.md 的验收标准（含验收增补）派生可测试的行为点；bug 类需求的复现步骤直接写成失败测试——**复现即红灯**。
2. 先写测试并**实际运行确认红**：记录命令与关键失败输出，并确认失败原因正是「行为尚未实现/缺陷存在」，不是环境或拼写问题。
3. 实现最小改动让测试转绿，重跑记录通过输出。测试写法遵循仓库自身的测试技能与规范（如 unit-test、storybook 等），本技能只管纪律不管框架。
4. 红绿证据（每个行为点：测试文件、红灯命令+失败摘要、绿灯命令+通过摘要）落 `$CTX/tdd-evidence.md`，按需求进展追加。
5. **豁免规则**：纯文案、样式微调等确无可断言行为的变更可豁免红绿，但豁免理由必须写进 tdd-evidence.md——不可测是性质判断，不是成本判断。

完成自检（typecheck、全量相关测试）后进入阶段 2。

### 阶段 2：CR 循环（无轮次上限）

循环体，直到出口条件：

1. **送审前必须 commit**：将本轮改动落成迭代式小提交（合入前由用户人工 squash）。未提交改动不会被 review 覆盖。
2. 送审：`bash ~/.claude/skills/harness-ceilf6/scripts/cr-round.sh --dir "$CTX"`。
3. 读 `$CTX/cr/round-N/verdict.json`：
   - `pass=true` → 循环结束（脚本已置 status=awaiting_human），进入 **MR 收尾**：push 当前需求分支到远端（此动作经用户 2026-07-29 裁定豁免 byteview-web「禁止自动 push」规则，仅限 harness 需求分支）；调用 bytedcli-bits-mr 技能创建 MR——标题从 plan.md 目标提炼，描述必含：任务来源（bot 场景带 chat/message id）、plan 四段摘要、CR 轮次表、遗留 minor/nit 清单。**续入场景不重复建 MR**：当前分支已存在由本流程创建的开放 MR 时，只 push 并在既有 MR 上追加一条评论（本轮变更摘要 + 新增 CR 轮次），MR 链接沿用。然后输出收尾汇总（模板见下，MR 链接置顶）。失败/熔断/超时**不 push、不建 MR**——半成品不进团队远端视野。
   - `pass=false` → **逐条处置**每个 finding：修复，或书面不采纳。全部 blocker/major 处置完后写 `$CTX/cr/round-N/fixes.md`（格式见下），回到第 1 步。
4. **僵局熔断**（会话判断）：同一条 finding，codex 连续两轮坚持、你连续两轮书面不采纳 → 停止循环，`bash ~/.claude/skills/harness-context/scripts/ctx-dir.sh set-status awaiting_human`，把分歧点整理给用户裁决。
5. 脚本自身失败（两次尝试后）→ 停止并如实报告 stderr，不静默重试第三次。

meta.max_rounds 非 null 时，达到该轮数也停下交用户（默认 null 不限）。每轮结束向用户回显脚本输出的「第 N 轮 / 耗时」信息。

**fixes.md 格式**（finding 按 verdict.json 数组序号 F1、F2…编号）：

```markdown
# Round N 处置

## F1 <severity> <file>:<line>
- 处置：修复 | 不采纳
- 说明：修复→改了什么、在哪个提交；不采纳→理由与依据
```

**收尾汇总模板**（pass 或熔断后输出给用户）：

```markdown
## CR 循环收尾
- MR：<链接>（失败/熔断时写「未创建」）
- 结果：通过（第 N 轮）｜ 熔断待裁决
- 改动概览：<一段话>
- 轮次记录：cr/round-1..N（verdict / fixes 齐全）
- 遗留 minor/nit：<清单，含文件位置>（修不修由你定）
- 下一步：人工 CR / 测试；发现问题用 harness-context add 存入后再喊我续跑
```

### 阶段 3：人工阶段与续入

用户人工 CR / 测试。发现问题 → 用户经 harness-context add 存入（或直接口述）→ 再次调用本技能：走续入路径（plan.md 增补验收条目），回到阶段 1 修复、阶段 2 再循环。全部完成后用户可 `set-status done`。

## 约束

- 收尾自动 push + 建 MR 是本技能职责（用户 2026-07-29 裁定，经 bytedcli-bits-mr 技能执行）；不动 Meego、不打 SCM 包（workflow-bugfix / scm 技能另行处理）。
- 不修改 cr/round-*/ 下的历史产物；每轮产物只写本轮目录。
- 对 verdict 的每条 blocker/major 必须显式处置（修复或书面不采纳），禁止静默忽略。
