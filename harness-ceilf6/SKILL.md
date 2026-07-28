---
name: harness-ceilf6
description: 个人需求交付 harness：装载 harness-context 的需求上下文，过计划门（轻量复述确认 / 转 superpowers 完整规划 / 续入跳过），当前会话直接开发，然后自动驱动 codex 对抗式 CR 循环（送审→结构化判定→修复→再送审）直至通过或熔断；人工 CR / 测试发现问题后可带全部历史续跑。当用户在装载上下文后要求「开始开发」「跑 harness」「继续 CR 循环」「续跑」时使用。前置：需求分支 + harness-context 已 init。
---

# harness-ceilf6：开发 + 对抗式 CR 循环

**权限前提**：循环全程不允许权限打断。codex 侧已在脚本内固化 `--dangerously-bypass-approvals-and-sandbox`；claude 侧即当前会话——建议以 bypass permissions 模式启动会话跑循环。

**开发者是当前会话本身**（不 shell 出 claude 子进程）；只有评审员是外部进程。用户全程在场、随时可插话纠偏。

机械层脚本：`~/.claude/skills/harness-ceilf6/scripts/cr-round.sh`（依赖 git、jq、codex CLI）。

## 流程

### 前置：装载上下文

1. `CTX=$(bash ~/.claude/skills/harness-context/scripts/ctx-dir.sh resolve)`。失败（未初始化/主分支/detached）→ 引导先完成 harness-context init。
2. 按 harness-context 的 get 约定读取 `$CTX` 全部内容装入会话。

### 阶段 0：计划门（开发不允许直接开始）

出口统一为 `$CTX/plan.md`（目标 / 范围 / 改法 / 验收标准 四段）。三条路径：

1. **续入路径**：`$CTX/plan.md` 已存在 → 跳过门。本轮新增问题以「## 验收增补（<日期>）」小节追加进 plan.md。用户明确说「重新规划」才走重规划：旧内容整体降级为「## 历史版本（<日期>归档）」小节保留于文件尾部，新四段写在文件头。
2. **轻量路径（默认）**：上下文含手写逻辑梳理/提示词 → 把你的理解复述为四段，向用户展示，用户确认或口头修正后写入 plan.md。一次确认即过门。
3. **完整路径**：需求大、模糊、或用户点名「走 brainstorming」→ 调用 superpowers 的 brainstorming（其终点是 writing-plans）；结束后把最终 plan 的内容归一写入 `$CTX/plan.md`（原 spec/plan 文档位置不动，plan.md 为唯一验收锚点）。

过门后：`bash ~/.claude/skills/harness-context/scripts/ctx-dir.sh set-status developing`。

### 阶段 1：开发

当前会话按 plan.md 实现。遵循仓库自身的技能与规范（typecheck、测试等）。完成自检后进入阶段 2。

### 阶段 2：CR 循环（无轮次上限）

循环体，直到出口条件：

1. **送审前必须 commit**：将本轮改动落成迭代式小提交（合入前由用户人工 squash）。未提交改动不会被 review 覆盖。
2. 送审：`bash ~/.claude/skills/harness-ceilf6/scripts/cr-round.sh --dir "$CTX"`。
3. 读 `$CTX/cr/round-N/verdict.json`：
   - `pass=true` → 循环结束（脚本已置 status=awaiting_human），输出收尾汇总（模板见下）。
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
- 结果：通过（第 N 轮）｜ 熔断待裁决
- 改动概览：<一段话>
- 轮次记录：cr/round-1..N（verdict / fixes 齐全）
- 遗留 minor/nit：<清单，含文件位置>（修不修由你定）
- 下一步：人工 CR / 测试；发现问题用 harness-context add 存入后再喊我续跑
```

### 阶段 3：人工阶段与续入

用户人工 CR / 测试。发现问题 → 用户经 harness-context add 存入（或直接口述）→ 再次调用本技能：走续入路径（plan.md 增补验收条目），回到阶段 1 修复、阶段 2 再循环。全部完成后用户可 `set-status done`。

## 约束

- 不建 MR、不动 Meego、不打 SCM 包（用 bytedcli-bits-mr / workflow-bugfix / scm 技能另行处理）。
- 不修改 cr/round-*/ 下的历史产物；每轮产物只写本轮目录。
- 对 verdict 的每条 blocker/major 必须显式处置（修复或书面不采纳），禁止静默忽略。
