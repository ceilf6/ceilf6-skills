# harness-ceilf6 设计文档

日期：2026-07-28
状态：已与用户逐节确认

## 背景与问题

当前需求生命周期按 wiki「02-需求」流程执行：建 wiki 子文档 → 收集需求上下文（bug 另做复现）→ 逻辑梳理 → 撰写提示词 → 开发 → 对抗式 CR + 人工 CR → 测试 → 总结。痛点有二：

1. claude（开发）与 codex（对抗式 CR）之间的上下文靠人工搬运：开发完手工把上下文喂给 codex，等 CR 结果再手工搬回 claude 修复，往复效率极低。
2. 需求上下文散落在飞书 IM 群聊、MR 评论、wiki 文档多处，没有统一的机器可消费入口。

团队 omh（oh-my-harness）覆盖了交付管线，但仪式重（staging、审批凭据、daemon、固定协议句），不适合个人高频使用。本设计**替代 omh**，做个人轻量 harness。

## 目标与非目标

**v1 纳入：**

- 需求上下文管理（harness-context）：按 git 分支建本地目录；从 wiki 子文档导入种子；随时存入 IM 消息区间、飞书文档、Meego、MR 评论、自由文本；随时取出全部上下文。
- 计划门：开发前人机协商对齐，产物为 plan.md，作为开发依据和 CR 验收锚点。
- 开发衔接：当前 Claude Code 会话直接开发（不 headless 化 claude）。
- codex 对抗式 CR 自动循环：自动送审 → 结构化判定 → 回会话修复 → 再送审，直到通过或熔断。
- 续入：人工 CR / 测试发现问题后，存入上下文即可带全部历史继续循环。
- 沉淀供料：为组合式沉淀（如 `/harness-context /lark-sediment`）提供素材与台账。

**v1 不做：**

- 建 MR / Meego 流转 / SCM 打包（已有 bytedcli-bits-mr、workflow-bugfix、scm 技能，手动调用）。
- 测试执行、总结自动撰写。
- 逻辑梳理与提示词的自动生成（保持人工写在 wiki，作为种子导入——它们是人对需求的判断）。
- 任何 headless claude 编排、独立 daemon、状态机监控（明确封死 mini-omh 方向）。

## 总体形态

两个个人技能（`~/.claude/skills/`，跨仓库可用）+ 每仓库一个本地上下文目录：

- **harness-context**：上下文的「入口与仓管」。只定义上下文落在哪里、什么格式；抓取交给调用它的 agent 用现成能力完成（lark-cli、bytedcli）。
- **harness-ceilf6**：计划门 + 开发衔接 + codex CR 循环 + 续入。开发者是当前交互会话本身，用户全程在场可插话；只有 CR 评审员是外部进程（`codex exec review`）。

两技能通过 `.harness-ceilf6/` 目录布局这个契约衔接，不共享代码；harness-ceilf6 直接按契约读目录，不强制先加载 harness-context。

## 生命周期

```
harness-context init          建目录 + 从 wiki 子文档导入种子
        │
harness-ceilf6
        │
  [阶段0 计划门]              三条路径，出口统一为 plan.md
  [阶段1 开发]                当前会话按 plan.md 开发
  [阶段2 CR 循环]             codex exec review ↔ 会话修复，无轮次上限
  [阶段3 人工]                人工 CR / 测试；发现问题 → add → 续入
  [收尾]                      组合 /harness-context /lark-sediment 沉淀
```

### 计划门（阶段 0）

开发永远不允许直接开始。产物统一为 `.harness-ceilf6/<分支>/plan.md`，包含目标 / 范围 / 改法 / 验收标准四段。三条通过路径：

1. **轻量路径（默认）**：上下文已含手写的逻辑梳理与提示词时，会话把理解复述成四段，用户确认或口头修正后落 plan.md，一次确认过门。
2. **完整路径**：需求大、模糊或用户点名时，转 superpowers 的 brainstorming → writing-plans 全流程，结束后把最终 plan 内容归一进 plan.md。
3. **续入路径**：plan.md 已存在则跳过门；新问题作为「验收增补」小节追加。用户明确要求「重新规划」时才生成新版本，旧版本折叠为历史段落留在文件内。

plan.md 三重角色：开发执行依据、codex 每轮 CR 的验收锚点、续入时的历史基线。

## 存储布局

```
.harness-ceilf6/                  ← 仓库根，init 幂等写入 .git/info/exclude，不动团队 .gitignore
└── <分支名>/                     ← 分支名中 / 替换为 __
    ├── meta.json                 ← branch、wiki_url、base_branch（默认取仓库主分支）、
    │                                status（planning/developing/cr/awaiting_human/done）、
    │                                max_rounds（默认 null 不限）、mr_id（可选）、created_at
    ├── context/                  ← 上下文条目，只增不改，文件名 <YYMMDD-HHmm>-<类型>-<slug>.md
    │   ├── 00-seed.md            ← wiki 子文档种子，头部记来源 URL 与导入时间
    │   └── ...                   ← im / doc / meego / mr / note 各类条目，头部记 provenance
    ├── plan.md                   ← 计划门产物（含验收增补、历史版本段落）
    ├── cr/
    │   └── round-N/
    │       ├── instructions.md   ← 本轮实际喂给 codex 的完整指令（审计用）
    │       ├── verdict.json      ← codex 结构化判定（原始捕获）
    │       ├── review.md         ← 脚本从 verdict.json 确定性渲染的人读版
    │       └── fixes.md          ← 会话对每条 finding 的处置：修复说明 / 不采纳+理由
    └── sediment.md               ← 沉淀台账：哪些内容何时进了哪个文档，防重复沉淀
```

设计原则：每个文件单一职责、全部人类可读、汇总视图现读现拼（不存聚合缓存）。已知取舍：git worktree 删除时目录随之消失；按现有流程 worktree 删除发生在合入与沉淀之后，接受此代价换取「上下文在代码旁边」。

## CR 循环协议

### verdict schema（`--output-schema` 强制）

```json
{
  "pass": true,
  "summary": "一句话总评",
  "findings": [
    { "severity": "blocker|major|minor|nit", "file": "src/x.ts", "line": 42,
      "issue": "问题描述", "suggestion": "修改建议" }
  ]
}
```

**pass 只由 blocker/major 决定**；minor/nit 照记不阻塞，最终出现在收尾汇总里由人决定修不修。

### 每轮指令组装（脚本拼装）

- 第 1 轮：对抗式评审角色 + 评审范围小节（指明 `git diff <base>...HEAD`，由 codex 持全权自行运行获取；已提交变更为界，工作区未提交内容不在范围）+ 验收基准（plan.md 全文）+ 种子中的提示词段 + 要求参考 code-review、karpathy-guidelines 两个 SKILL.md + 输出契约。diff 本身不进 prompt。
- 第 N>1 轮：附上一轮 verdict.json + fixes.md，指令为「先逐条核验处置（修复是否真实生效、不采纳理由是否成立），再审新增 diff」。
- 防发散条款：已被书面不采纳且理由成立的意见，无新证据不得重提；新 finding 必须锚定具体文件位置。

### 会话侧修复义务

逐条处置 verdict：每条 blocker/major 要么修复、要么在 fixes.md 写明不采纳及理由，全部处置完才允许送下一轮。**每轮送审前先 commit**（迭代式小提交，合入前人工 squash，符合既有 git 习惯，也让每轮 review 边界干净）。

### 终止条件（三个出口，无轮次上限）

1. `pass=true` → status 置 awaiting_human，输出收尾汇总（改动概览、轮数、遗留 minor/nit 清单）。
2. **僵局熔断**：同一条 finding，codex 连续两轮坚持且会话连续两轮不采纳 → 停，交人裁决。
3. codex 调用失败（非零退出 / verdict 不过 schema 校验）→ 脚本重试一次，再失败停下如实报告。

meta.max_rounds 为可选旋钮（默认 null 不限）；每轮结束回显「第 N 轮 / 累计耗时」，纯信息不设卡点（用户在会话内随时可打断）。

### codex 调用（固化在 cr-round 脚本内）

```bash
# 脚本先把本轮指令拼装落盘为 round-N/instructions.md（含「评审范围」小节），再执行：
codex exec \
  --output-schema <技能目录绝对路径>/references/verdict.schema.json \
  -o .harness-ceilf6/<分支>/cr/round-N/verdict.json \
  --dangerously-bypass-approvals-and-sandbox \
  - < .harness-ceilf6/<分支>/cr/round-N/instructions.md
```

实现期勘误（已验证，commit 5698975）：原设计用 `codex exec review --base`，但 codex ≥0.124 的 review 子命令与自定义 PROMPT（含 stdin `-`）互斥且无 flag 级出路；且送审时工作区必为干净（送审前 commit 规则），`exec review` 缺省范围行为未文档化、有静默评空 diff 的风险。故改为普通 `codex exec`，评审范围由指令文本钉定——我们的指令模板本就自带完整评审角色与输出契约，`review` 模式仅提供的 diff 计算由 codex 自行运行 git 命令替代，真实冒烟已验证其能正确锚定范围。另：OpenAI strict structured-output 要求 schema 的 `required` 列全所有属性，故 `line` 亦入 required、以 `null` 表达缺省（校验器与渲染器语义不变）。

## harness-context 接口

定位：**入口与仓管，不是抓取器**。抓取由调用它的 agent（一般是 claude）用现成能力完成，SKILL.md 提供来源类型速查表：

| 输入形态 | 抓取方式（agent 自行执行） |
|---|---|
| IM 群聊 chat/session id + 起止消息引文 | lark-cli im 拉消息列表，agent 截取区间 |
| 飞书文档 / wiki 链接 | lark-cli docs +fetch |
| Meego 链接 | bytedcli-meego 技能 |
| MR 号 / 链接 | bytedcli-bits-mr 技能（拉评论） |
| 其他 | 一律自由文本 |

四个动作：

- **init**（输入：wiki 子文档链接，可缺省建空仓）：解析分支 → 建目录 → 写 meta.json → 幂等写 `.git/info/exclude` → 拉 wiki 全文落 `context/00-seed.md`。目录已存在时报告现状不重建；重拉种子需用户明说。
- **add**：识别输入形态 → 按速查表抓取 → 落 `context/` 带时间戳新文件（头部 provenance：来源、拉取时间、范围说明）→ 回显文件名与一行摘要。
- **get**：现场拼装 meta + plan.md + context/*（按文件名序）+ 最近一轮未决 findings 与 fixes，输出结构化块。
- **沉淀（组合式）**：用户以 `/harness-context /lark-sediment` 等组合触发；本技能只供料（get 输出）并在写入完成后记 sediment.md 台账，写入动作归组合的技能，风格沿用「直接写入、事后汇报」。

## 权限模式（用户明确要求：全程不允许权限打断）

- codex 侧：固化 `--dangerously-bypass-approvals-and-sandbox`。
- claude 侧：即当前会话，SKILL.md 顶部注明「建议以 bypass permissions 模式启动会话跑循环」。
- 风险已告知并由用户承担：评审代理持完整 shell 权限，若评审输入混入不可信内容存在被驱动执行任意命令的理论风险；个人机器、用户全程在场。

## 技能文件结构

```
~/.claude/skills/
├── harness-context/
│   ├── SKILL.md                 ← 定位声明、四动作流程、来源速查表、目录契约
│   └── scripts/
│       └── ctx-dir.sh           ← 分支→目录解析；init 机械部分（mkdir/exclude/meta）
└── harness-ceilf6/
    ├── SKILL.md                 ← 计划门三路径、开发衔接、CR 循环驱动、续入语义、权限建议
    ├── scripts/
    │   └── cr-round.sh          ← 读 meta → 拼指令 → 调 codex → 校验 JSON → 渲染 review.md → 回显摘要
    └── references/
        ├── verdict.schema.json
        └── cr-instructions.md   ← 指令模板：对抗式角色、pass 判定、防发散条款、N>1 核验指令
```

脚本只做确定性机械动作；一切判断（怎么修、是否采纳、何时停）归会话。

## 错误处理要点

- ctx-dir.sh / cr-round.sh 均 `set -euo pipefail`；失败向会话输出可读原因，不静默。
- verdict.json 先过 schema 校验再消费；校验失败按「codex 调用失败」出口处理。
- add 抓取失败（无权限、链接失效）时如实报告并允许降级为自由文本手工粘贴。
- 分支为 detached HEAD 或主分支时 init 拒绝执行并提示先切需求分支。

## 验收方式

1. 脚本层：shellcheck 通过；cr-round.sh 用假 codex 桩（echo 固定 JSON）验证轮次文件落盘、schema 校验、渲染与失败重试逻辑。
2. 端到端：在本仓库挑一个真实小需求完整走一遍：init 导种子 → 计划门轻量路径 → 开发 → 至少两轮 CR 循环（人为留一个可发现的问题验证 findings→fixes→复审链路）→ 人工续入一次 → 组合沉淀一次。
3. 验收标准：全程无权限打断；除计划门确认与人工阶段外无手工搬运动作；断开会话后重开、凭目录状态可无损续跑。
