# ByteDance Weekly One-on-One Prep Design

日期：2026-07-17
状态：已与用户逐节确认

## 背景与目标

用户每周五 17:00 与 Mentor 和 Leader 进行 One-on-One，需要在当天 15:00 自动生成一份统一对齐材料。材料应回顾自上次自动复盘以来的连续一周活动，从所有可访问的信息中寻找成果、问题、工作方式与成长上的优化空间，并把值得讨论的事项转成可执行议题。

本能力与每天 23:00 运行的 `report-writer-bytedance` 日报自动化相互独立。日报可以作为周复盘的证据层，但周复盘还必须补采日报时间边界和缺失时段内的原始平台、本地开发与个人活动证据。

## 1. 交付与调度

新建独立 skill：

```text
one-on-one-prep-bytedance/
```

新建独立 Trae CLI 自动化：

- LaunchAgent：`com.wangjinghong.trae-one-on-one-prep`
- 触发时间：每周五 15:00，`Asia/Shanghai`
- Runner：`~/.local/bin/run-bytedance-one-on-one-prep`
- Prompt：`~/.config/trae-one-on-one-prep/prompt.md`
- Logs：`~/Library/Logs/trae-one-on-one-prep/`
- 执行器：Trae CLI，不消耗 Codex 额度
- 与日报 LaunchAgent、Prompt、Runner 和日志完全隔离

Runner 使用运行锁，防止手动触发与定时触发并发写入。同一周重复执行时更新已有文档，不创建重复页面。

## 2. 连续时间窗口与 Week 编号

每个复盘窗口采用左闭右开区间：

```text
[上周五 15:00, 本周五 15:00)
```

示例：

- `Week-2`：`2026-07-10 15:00 <= time < 2026-07-17 15:00`
- `Week-3`：`2026-07-17 15:00 <= time < 2026-07-24 15:00`

相邻窗口不重叠、不留空隙。所有源的时间过滤统一转换到 `Asia/Shanghai` 后再判断归属。

Week 编号不依赖可变计数器。使用确定性基准：

```text
2026-07-17 = Week-2
week_number = 2 + 完整自然周偏移量
```

因此漏跑、补跑或同周重跑都能得到稳定编号。目标标题严格为 `Week-N`。

## 3. 飞书交付位置与幂等规则

每周材料创建在以下父 Wiki 下：

- URL：`https://bytedance.larkoffice.com/wiki/ZDvbwhN4eiFRoHkUh1ocXSeInSb`
- 标题：`日结`
- node token：`ZDvbwhN4eiFRoHkUh1ocXSeInSb`
- space ID：`7658115519924686035`

写入前使用 `lark-cli wiki +node-list --as user` 列出子节点：

- 不存在目标 `Week-N`：新建子文档。
- 已存在唯一目标 `Week-N`：更新该文档。
- 存在多个同名节点：停止写入并报告歧义，不猜测目标。

写入后必须重新读取文档，验证标题、时间窗口、预期章节和关键证据链接，并确认新文档已出现在父 Wiki 下。

历史测试文档 `week1-AI` 与本需求无关，不读取、不更新，也不作为 Week 编号基线。

## 4. 全量信息采集

采集范围是时间窗口内所有可访问的信息，包括公司工作、个人项目和非工作活动。来源不限于现有日报 skill 的平台清单，采用可扩展 source adapter 与 coverage ledger。

已知来源包括：

- 飞书：Wiki、Doc、Drive、IM、日历、任务、妙记、VC、邮件、审批及其他可访问活动。
- ByteDance 平台：Codebase、Bits、Meego、Cloud Ticket、Oncall 及 `bytedcli` 后续可访问来源。
- 日报与历史材料：窗口相交的日结、上一期 `Week-(N-1)`、计划文档和沉淀文档。
- 本地 AI：Claude、Codex、Trae、Trae-CN。
- 本地开发：Git 仓库、提交、分支、工作区、终端和开发工具活动。
- 本地资料：文档、笔记、近期文件活动。
- 调研与学习：浏览器历史及其他能够反映活动路径的本机数据。
- 未来新增且调用方可合法访问的数据源。

采集分两层：

1. 按精确时间窗口收集活动元数据和候选索引。
2. 只对可能影响工作结果、成长、时间分配、精力状态或 One-on-One 议题的候选下钻内容。

已有日报是工作线索和已整理证据，不是唯一事实源：

- 对跨越窗口边界的日报，必须回到原始证据时间过滤，不能整篇计入。
- 当前周五尚未生成当日日报，`00:00-15:00` 依靠原始平台和本地活动补采。
- 日报缺失不直接失败，但对应日期必须由原始源补采并记录覆盖状态。
- 上一期 `Week-(N-1)` 只用于检查行动项闭环；缺失时标记无上期基线，不猜测。
- 计划文档只用于下一周期议题，不能证明已完成工作。

## 5. 归一化与分析模型

所有候选先归一化，再生成文档。建议核心记录如下：

```yaml
ActivityEvidence:
  occurred_at: timestamp
  source: string
  source_id: string
  title: string
  summary: string
  url: string | null
  local_ref: string | null
  confidence: high | medium | low
  sensitivity: company | personal | private

WeeklyWorkstream:
  title: string
  status: completed | in_progress | blocked | planned | unknown
  timeline: ActivityEvidence[]
  outcomes: string[]
  next_actions: string[]

OptimizationFinding:
  title: string
  evidence_refs: string[]
  observed_pattern: string
  impact: string
  proposed_change: string
  verification: string
  confidence: high | medium | low

AlignmentTopic:
  question: string
  context: string
  desired_outcome: decision | feedback | resource | priority | awareness
  evidence_refs: string[]
```

同一事项在日报、MR、文档、聊天、本地 AI 或个人项目中出现时合并为一条工作线。分析重点包括但不限于：

- 重复返工、验证不足或工作方式摩擦。
- 长时间未闭环的阻塞和行动项。
- 计划承诺与实际完成的偏差。
- 投入很多但结果或价值表达不清的事项。
- 可沉淀为方法、工具或 SOP 的经验。
- 个人项目、学习、时间分配或状态对工作和成长的影响。
- 需要 Mentor/Leader 帮助决策、提供资源或校准优先级的事项。

没有证据支撑的绩效、动机、能力或心理状态判断不得进入文档。

## 6. 文档结构

Mentor 和 Leader 共用同一份议题清单，不按角色拆分。正文结构：

```markdown
# 本周期结论

# 关键进展与证据

# 做得好的地方

# 可以优化的地方

# 需要对齐的议题

# 上期行动项闭环情况

# 本次 One-on-One 待确认行动项

# 下一周期重点
```

每个优化点必须包含观察依据、影响、建议改变和验证方式。每个对齐议题必须说明背景和期望获得的结果，避免写成泛泛的问题清单。

## 7. 评审回路

发布前串行执行三类评审：

1. 证据审查：事实、时间、状态和链接可追溯；窗口边界正确；无重复归因。
2. 复盘审查：优化建议具体、可行动、可验证；没有套话或无证据判断。
3. 对齐审查：议题适合 One-on-One，背景足够，期望结果明确，优先级合理。

意见分为 `blocking` 和 `suggestion`。事实错误、越界证据、隐私泄漏、无证据判断、重复统计和不可执行的空泛优化属于 blocking。最多修订两轮；仍有 blocking 时不发布文档。

Trae CLI 无子代理时，在同一会话内分三个独立阶段串行自审，每阶段只使用一个审查视角。

## 8. 飞书私信通知

文档验证通过后，使用飞书应用机器人私信用户：

```text
recipient open_id: ou_c501034db06707b7116eb9ec11896a7d
identity: bot
command: lark-cli im +messages-send --as bot --user-id "$OPEN_ID" --markdown "$MESSAGE"
```

成功消息包含：

- `Week-N` 文档链接。
- 精确复盘窗口。
- 最重要的 2-3 个待对齐议题。
- 任何数据覆盖缺口。

失败消息包含失败阶段、错误原因和是否已经发生文档写入。失败私信是 best effort：如果失败原因就是 IM 或 bot token 不可用，则将完整状态写入本地运行日志与 LaunchAgent stderr。只发送私聊，不发送群消息、邮件、Webhook 或机器人群通知。

2026-07-17 已用该机器人和 open_id 完成真实私信测试，飞书返回 `message_id` 且用户确认可见。

同一周重跑默认更新文档但不重复发送成功提醒。通知状态与文档 token 记录在本地运行状态中；显式强制通知才允许再次发送。

## 9. 错误处理

Runner 预检 Trae CLI、`lark-cli`、`bytedcli`、Python、本地解析器、父 Wiki、用户身份和所需鉴权。

阻塞错误：

- Trae、飞书或 ByteDance 核心鉴权不可用。
- 整个企业数据源族或本地活动数据族不可访问。
- 时间窗口、Week 编号、用户身份或父 Wiki 无法确定。
- 目标 `Week-N` 存在多个同名节点。
- 两轮评审后仍有 blocking。
- 文档创建、更新或回读验证失败。

单个次要数据源失败时，在有限重试后继续生成，并在 coverage ledger、最终消息和私信中列出缺口。网络与限流错误使用有界重试；写入和通知使用幂等键。

文档创建成功但通知失败时保留文档，记录待通知状态并重试，不回滚已验证文档。

## 10. 隐私与安全

全量采集不等于全量披露：

- 可以读取公司、个人项目和非工作活动，但最终只写适合与 Mentor/Leader 对齐的摘要。
- 不复制私聊、邮件、AI 对话、浏览记录、个人文件或终端历史原文。
- 不把本地文件路径、原始提示词、大段代码或内部诊断写入飞书文档。
- 不读取或输出凭据、Token、Cookie、钥匙串、密码文件和认证缓存；这些数据不能形成有效复盘证据。
- 每条具体判断保留证据引用；本地证据使用安全的 `local_ref`，不使用文件路径。
- 对个人活动的判断必须与工作、成长、时间分配、精力状态或待对齐议题有明确关系，否则只留在 coverage ledger，不进入文档。

## 11. 验证与验收标准

实施必须包含：

1. 时间窗口测试：连续两周窗口无空隙、无重叠，时区转换正确。
2. Week 编号测试：`2026-07-17 = Week-2`，前后周、漏跑和补跑计算正确。
3. 幂等测试：同周重复执行只更新唯一 `Week-N`。
4. 边界测试：恰好发生在上周五 15:00 的证据计入，恰好发生在本周五 15:00 的证据留给下一期。
5. 数据源测试：日报与原始源合并去重，跨边界日报不整篇计入，单源失败进入 coverage ledger。
6. 安全测试：原始私聊、邮件、AI 会话、路径和凭据不会进入文档。
7. Trae dry-run：完成采集、归一化、起草和三阶段评审，不写飞书、不发消息。
8. 端到端测试：手动触发一次 `Week-2`，验证父 Wiki、正文回读、同名幂等和飞书私信。
9. 调度测试：确认 LaunchAgent 为每周五 15:00，并检查 runner 退出码和运行日志。

验收完成的证据是：`Week-2` 文档在指定父 Wiki 下唯一存在、正文通过回读检查、消息由机器人私信送达、用户可见、现有日报自动化未被修改或影响。

## 12. 实施边界

- 新能力独立实现，不把周复盘模式塞入 `report-writer-bytedance`。
- 可以复用现有本地 AI 解析器和证据模型，但不复制日报的发布和模板职责。
- 不修改与本需求无关的现有 skill。
- 仓库当前 `report-writer-bytedance/references/source-map.md` 有用户未提交修改；实施必须保留并避免覆盖。
- 本设计不自动分享 One-on-One 文档给 Mentor 或 Leader，也不向他们发消息；只创建用户自己的材料并私信用户本人。
