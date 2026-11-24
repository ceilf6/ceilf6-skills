# web-monitor Triage 群聊候选处理中门禁

## 目标

`monitor-triage` 的群消息支线只有在当前候选没有被其他人处理时，才允许返回 `candidate` 并占领首胜门。

用户口径中，“其他人已经在处理”就等同于本技能的“不能修”：即使代码侧存在改动点，也不应再向用户呈现、收敛方案或重复派单。

## 范围

只修改 `monitor-triage/SKILL.md` 的群消息扫描与判定流程，不改 web-monitor 支线的排序和桶规则，不增加新的状态类型、命令或脚本，不修改外部平台状态。

不做全局 ticket-platform 或 Oncall 搜索。

## 处理中门禁

群消息 worker 先按现有 `references/judging.md` 判断当前消息是否存在可修问题；准备返回 `candidate` 前，必须检查该具体问题是否已有处理。

检查来源按以下顺序执行：

1. 当前消息、话题回复、附件和消息内链接中是否有明确的接手、处理中、已报 Oncall、已有任务或已有 MR 的正向证据。
2. 使用当前问题的精确证据，例如报错原文、Issue ID、文件或函数名、已知任务标题，针对性检查当前 Harness 任务和目标仓开放中的 CI平台 MR：
   - Harness 任务只通过 `node scripts/task-runtime/schedule/task-schedule.js list` 读取，再按候选仓库与精确证据过滤；不逐个扫描 `harness-workspaces/*/task.json`。
   - MR 查询先遵守 `internal-cli-enhanced` 与 `internal-cli-ci-mr`，在候选仓库上下文中使用 `internal-cli --json ci-platform mr search --state opened --keyword '<精确关键词>'`。关键词必须来自当前消息证据；可以依次查询多个精确词，不能退化成无关键词的开放 MR 全量搜索。
3. 只有当前消息材料提供了明确的 ticket-platform 或 Oncall 链接时，才读取该具体条目的状态；不做无目标的全局检索。

“处理中”必须有能关联到当前具体问题的正向证据，不能只凭宽泛关键词、相邻告警或相似标题判断。Harness 任务或 MR 的标题命中后，还要核对其描述、改动点或来源证据确实覆盖当前问题。

## 判定与状态

确认已有处理时，worker 请求主 Agent 执行：

```bash
node <skill>/scripts/state.mjs judge \
  --dir <state> \
  --issue-id <lark:message_id> \
  --fixable no \
  --reason "已有处理：<处理人、动作或任务/MR/Oncall 证据>"
```

主 Agent 落账并提交状态后重跑 `walk`；该消息返回 `continue`，群消息支线继续按原顺序处理下一条。后续扫描复用该 agent/no 判定，不再呈现这条消息。

没有发现处理中正向证据时，不持久化“无人处理”结论；本轮允许该候选返回 `candidate`。这样以后有人开始处理时，下一次准备呈现仍会重新检查。

若必查材料或针对性任务/MR 查询因认证、权限、网络或依赖失败而无法完成，群消息 worker 返回 `blocked`，不能把“未完成检查”解释成“没有人在处理”。web-monitor 支线仍按双线竞速规则独立继续。

## 多问题消息

门禁只判断当前准备呈现的具体问题是否已有处理。群消息里存在多个独立问题时，处理证据必须与该问题的现象、调用链或改动点对应；不能因同一消息里的另一个问题有人处理，就直接认定当前问题已有处理。

当前候选仍以 `lark:<message_id>` 为唯一状态键。本次不扩展一条消息拆成多个持久候选的模型。

## 验证

### RED

用本次误报构造压力场景：群卡片包含技术上可修的报错，话题回复明确写“我去报个 oncall”，同时存在代码改动点。旧 Skill 若直接返回 `candidate`，证明缺少处理中门禁。

再覆盖两种诱因：

- 只看到“可修”证据而忽略同一话题的接手回复；
- 本地台账没有派单记录，就把它误当成无人处理。

### GREEN

修改 Skill 后，使用相同场景验证 worker 必须返回 `judge --fixable no` 请求，理由包含具体处理证据，并在落账后继续下一条。

补充验证：

- 当前回复没有处理证据、针对性任务与开放 MR 也没有命中时，仍允许返回 `candidate`；
- 相似但不能关联到当前问题的任务或 MR 不能触发跳过；
- 明确链接的 ticket-platform / Oncall 读取失败，或任务/MR 查询失败时返回 `blocked`；
- 不触发全局 ticket-platform / Oncall 搜索；
- web-monitor 支线行为不变。

仓库级验证运行：

```bash
bash monitor-triage/tests/run.sh
/opt/homebrew/bin/python3 /Users/<user>/.claude/skills/skill-creator/scripts/quick_validate.py monitor-triage
git diff --check
```

## 交付边界

实现提交只包含 Skill 正文及必要的验证材料；`state/` 扫描和处置记录保持为独立 operational chore，不混入功能提交。该设计文档与后续计划不提交、不推送。
