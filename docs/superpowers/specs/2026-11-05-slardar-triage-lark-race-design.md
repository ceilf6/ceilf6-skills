# Slardar 与群消息并行竞速扫描设计

## 目标

`/slardar-triage` 在一次调用中并行扫描现有 Slardar 数据源与飞书群 `oc_d7ae3bb59ccbfdebe20cb1aa819b8cb7`。两条扫描线都复用现有的候选判断、判定历史、用户决定与经验更新逻辑；任一条线先判出需要处理的候选，就停止另一条线并进入现有的用户对齐流程。

这项改动只增加第二个扫描来源与竞速协调，不改变什么算“需要处理”、判断如何落账、用户决定如何覆盖 agent 结论，以及何时允许派单。

## 已确认行为

- Slardar 与群消息同时开始扫描，执行真实竞速，不交替轮询，也不等待两边都完成后再比较。
- 群消息每次都从最新消息开始，按创建时间倒序逐条处理；不设置时间范围、水位或跨运行游标。
- 群消息不按发送者、消息类型、关键词或卡片类型预筛选。每条消息都进入与 Slardar 候选相同的判定流程。
- 两条扫描线都读取 `references/judging.md` 和现有候选状态；每次新判定继续通过现有状态入口写入，用户捞回、拒绝与纠正的优先级不变。
- 已缓存的 agent 判定仍按现有规则复用；需要因规则变化失效时仍走现有 `rejudge`，不为群消息另建一套经验系统。
- 任一条线首先得到 `fixable` 候选即获胜。另一条线在当前状态写入完成后停止，不能留下“完成判断但没有记录”的半步状态。
- 群消息候选胜出后进入现有引导式收敛；只有用户明确说“派这条”才进入任务链。

## 架构

```text
Slardar source worker ─┐
                       ├─> shared judging and state ─> first-winner gate ─> guided alignment
Lark source worker ────┘
```

主 Agent 是协调器，只负责启动、首胜裁决、共享状态写入协调和最终呈现。两个 worker 使用相同质量档位与独立上下文，均不得直接调用 `botmux send`。

### Slardar source worker

Slardar worker 原样执行当前前置校验、扫描、`merge`、`walk`、读代码与 `judge` 流程。它在现有第 5 步“呈现”之前返回候选，不自行面向用户输出。现有桶跳过、缓存判定、用户捞回、拒绝隐藏、同缺陷关联和分页上限均保持不变。

### Lark source worker

Lark worker 使用 `lark-cli im +chat-messages-list` 读取目标群：

```bash
lark-cli im +chat-messages-list \
  --as bot \
  --chat-id oc_d7ae3bb59ccbfdebe20cb1aa819b8cb7 \
  --order desc \
  --page-size 50 \
  --no-reactions \
  --format json
```

首批消息按返回顺序从新到旧处理；当前页没有可呈现候选时使用 `page_token` 继续。`page_token` 只存在于本次运行，不写入状态。消息正文不足以判断时，可以按需读取该消息的附件、话题回复或消息内链接；这些动作只补足当前消息证据，不改变逐条扫描顺序。

每条消息被归一化成现有状态机可消费的候选。Lark worker 每次只把当前这一条消息送入 `merge -> walk`，不把整页消息交给现有的 Slardar 聚合排序，确保判断顺序严格等于群消息的倒序时间线：

```json
{
  "issue_id": "lark:<message_id>",
  "origin": "lark",
  "origin_id": "<message_id>",
  "chat_id": "oc_d7ae3bb59ccbfdebe20cb1aa819b8cb7",
  "message": "<原始消息正文>",
  "sender": "<发送人>",
  "created_at": "<消息时间>",
  "users": 0,
  "count": 0
}
```

`issue_id` 在状态机里继续作为不透明候选键使用，`lark:` 前缀避免与真实 Slardar issue 冲突。新增的 `origin`、`origin_id` 与消息证据字段用于呈现和派单，不参与排序或判定。这里不用 `source`，因为现有 `walk.items[].source` 已表示 `agent`、`user`、`bucket` 等判定来源。Slardar 候选缺省为 `origin=slardar`，从而保持历史状态文件可直接读取，不做批量迁移。

群消息候选随后执行与 Slardar 候选相同的 `merge -> walk -> judge -> walk` 循环：

1. `merge` 把消息候选放入 `candidates.json`，已有 verdict 和 verdicts 保持不变。
2. `walk` 先读取已有状态；历史 agent 结论、用户捞回、拒绝与已派单状态继续按当前优先级生效。
3. `unjudged` 消息按 `references/judging.md` 判断，不增加 Lark 专属规则。
4. `judge` 把结论和理由写入当前 verdict，并追加到 verdicts；完成后重新 `walk`。

因此“不设水位、不做消息预筛选”只约束消息发现。已经沉淀的判断经验仍会像 Slardar 扫描一样被读取和更新。

## 共享状态与并发

两个 worker 共用同一 `<state>`。`candidates.json` 和 `dispatched.json` 是整文件写入，不能让两个 worker 同时执行会修改状态的命令，否则可能覆盖对方更新。

协调器为所有变更状态的入口提供单写者约束。worker 负责外部读取、代码走查和形成判断请求，不直接执行会修改共享状态的命令；协调器按请求到达顺序调用状态入口，并把结果返回给对应 worker：

- `merge`、`judge`、`rejudge`、`revive`、`reject`、`dispatched` 继续调用现有 `state.mjs`，其业务语义不变。
- worker 可以并行拉取数据、读取代码和形成判断；所有真正的状态写入都由协调器串行执行。
- 一次状态命令及其 `commit-state.sh` 提交构成不可中断的写入单元。首胜取消只能发生在写入单元之间。
- 若两条线几乎同时产生 `fixable`，以最先成功占领首胜门的一条为准；另一条已完成的判定仍先落账，再停止呈现。

该约束保护现有状态文件与自动提交行为，不引入第二份 Lark 状态，也不改变 verdict 的覆盖规则。

## 首胜与生命周期

worker 向协调器报告四种状态：

- `candidate`：已按共享判断逻辑得到 `fixable` 候选。
- `continue`：当前候选不应呈现，判定已落账，可以继续下一条。
- `exhausted`：该来源已按自身边界扫描完，没有候选。
- `blocked`：该来源因权限、认证、网络或依赖失败不能继续。

协调规则：

1. 第一个 `candidate` 占领首胜门。
2. 协调器要求另一 worker 在当前写入单元结束后停止。
3. `blocked` 与 `exhausted` 只终止对应来源，另一来源继续。
4. 两条线都 `exhausted` 才报告本轮没有候选。
5. 一条线胜出但另一条线曾 `blocked` 时，呈现结果同时说明未覆盖的来源，不能声称完成双线扫描。
6. 两条线都 `blocked` 时才整体阻塞，并分别给出恢复方式。

用户说“换一条”时，当前会话把已呈现候选加入 session skip，并恢复竞速：Lark worker 从该消息之后的更早消息继续，Slardar worker 沿用当前扫描与 session skip。新的 `/slardar-triage` 调用仍从两个来源的起点重新开始。

## 呈现与派单

Slardar 候选继续使用现有报告格式。Lark 候选至少呈现：

- 发送人和消息时间；
- `message_id` 与目标群；
- 原始消息正文；
- 判断使用的附件、回复或关联链接；
- 按现有判定口径得出的“为什么需要处理”。

呈现后继续现有一次一问的技术方案收敛。Lark 候选派单时以群消息证据替代 Slardar 链接与量级字段；不得伪造 Slardar issue、用户数或告警次数。任务书其余结构、人工确认、显式“派这条”门禁和 Harness 任务链保持不变。

Slardar 的量级 `ledger.jsonl` 继续只记录 Slardar 扫描统计。Lark 候选的经验保存在 `candidates.json` 的 verdict 和 verdicts 中；零用户、零次数的消息不能进入修复回落比计算。

## 权限与失败处理

目标群读取优先使用 bot 身份，避免依赖个人 token。当前只读探测已确认本机器人不在目标群，API 返回 `230002 Bot/User can NOT be out of the chat`；真实验收前必须把本机器人加入目标群。若改用 user 身份，则当前用户需要授予 `im:message:readonly` 与 `im:chat:read`，且用户本人必须在群内。

Lark 权限失败只令 Lark worker `blocked`，Slardar worker继续。Slardar JWT 或平台失败也只令 Slardar worker `blocked`，Lark worker继续。任何来源都只读外部平台；拒绝、捞回、判定与派单状态仍写本地 `<state>`。

## 修改范围

- `slardar-triage/SKILL.md`
  - 默认入口改为双 source worker 真竞速。
  - 说明 Lark 分页、候选归一化、共同判定、首胜与协作取消。
  - 补充 Lark 胜出后的呈现、收敛与派单差异。
- `slardar-triage/scripts/state.mjs`
  - 在现有候选记录和 `walk` 输出中保留 `origin`、`origin_id` 与 Lark 证据字段，不占用已有判定 `source`。
  - 保持 verdict、verdicts、状态转移和 CLI 行为不变。
  - 阻止 Lark 候选进入 Slardar 量级 history 计算。
- `slardar-triage/tests/state.test.mjs`
  - 覆盖 Lark 候选合并、缓存判定复用、用户决定优先、判定历史追加和 history 隔离。
- `slardar-triage/references/example-report.md`
  - 增加 Lark 候选胜出示例。

不新增群消息筛选器、水位文件、第二套状态机或自动派单能力；不改变 `references/judging.md` 的现有判定口径。

## 验收标准

1. 默认调用同时启动 Slardar 与 Lark 扫描，任一来源先产出 `fixable` 即胜出。
2. Lark 每次从最新消息开始，逐条处理并能通过 `page_token` 继续，无持久水位或预筛选。
3. 相同错误证据来自两个来源时，使用相同 `judging.md` 口径，得到相同判断方向。
4. Lark 判定写入现有 verdict/verdicts；再次扫描时按现有缓存规则复用，用户捞回或拒绝仍优先。
5. 两个 worker 的状态写入不会互相覆盖；取消不会留下只判断未落账的结果。
6. 一条来源 `blocked` 或 `exhausted` 时另一条继续；只有两条均无结果或均阻塞时整体结束。
7. Lark 胜出只呈现一次，不与 Slardar worker 并发发送消息。
8. Lark 派单使用真实消息证据，不伪造 Slardar issue 与量级；Slardar history 不接收 Lark 的零量级行。
9. 现有 `slardar-triage` 测试、skill 校验和 Slardar 单线行为全部保持通过。

## 非目标

- 不按消息内容、发送人或类型给 Lark 消息排序或过滤。
- 不保存消息扫描进度，不保证跨运行只看新消息。
- 不自动从群消息抽取或创建 Slardar issue。
- 不改变现有能修/不能修口径，也不自动把单次 agent 判断提升为新的长期规则。
- 不改变用户显式确认后才能派单的边界。
