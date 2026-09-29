# slardar-triage 选取核心重构设计

## 背景与问题

slardar-triage 的目标：按影响从高到低，找出第一条 vc-ai 能修、且没处理过的线上告警，引导用户收敛技术方案后派单。

现状的误判是**不对称**的：

- 假阳性（agent 说能修、其实不值得修）会呈现给用户，由用户在引导式收敛中拦下。
- 假阴性（agent 说不能修、其实能修）有多个静默出口：6 条机械预筛规则、agent 判「低 / 排除」、判档永久化、`fix_paths` 自动覆盖；呈现规则又明确「不附低 / 排除清单」。用户看不到，无从纠正。

2026-09-28 的实际状态：候选池 63 条中 54 条被永久判低 / 排除，按用户数前 12 名里只有 1 条进入过派单，其余全被规则挡掉。影响最大的 `APINotProvided`（7.1 万用户 / 24h，帧在 `packages/vc-web-utils/gateway/request.ts`）09-11 被判低后再未重评。

另一个偏置：旧口径「高」要求写出「文件:行 + 缺陷」，天然排斥 catch、降级、能力探测这类缓解型修法。

## 目标

1. 取消任何永久且不可见的剔除：每个「不能修」判断都出现在呈现里，用户可一句话捞回。
2. 按族用户数从高到低走查，第一条能修即停。
3. 判定口径放宽到「vc-ai 仓内有改动能减少该上报或改善用户侧表现」。
4. 收窄机制：判定只有一个入口（agent 读代码或用户决定）、一个出口（跳过清单）。

非目标：派单链路（SKILL.md「派单」第 1–13 步、`prepare-dispatch.sh`、`board.sh`、`task-model.mjs`）、台账与 `history`、判定有效期、对抗式复核 agent、按理由分组。

## 数据流

一次唤醒：

1. **扫描** `scan.mjs --page N --page-size 20`：`js-error list --order-by user_descend --page-num N --page-size 20`，每条仍取样本分布与最新帧（只用于贴事实与写任务书，不参与判定），按 `family.mjs` 合并家族，按族用户数降序输出。
2. **合并记账** `state.mjs merge`：入池、追加台账，行为同现状，但不再删除缺席候选。
3. **走查** `state.mjs walk`：纯函数，按族用户数逐条输出归类（见下）。
4. **agent 判定**：从头读，遇到 `unjudged` 就沿完整堆栈读 `origin/master` 代码，按 `references/judging.md` 判定并 `judge` 落档，然后重跑 `walk`，直到第一条非 skip 项为 `fixable`。本页走完仍无能修的，扫 `--page N+1` 并重复 2–4，最多到第 5 页（前 100 条）。
5. **呈现**：当前条 + 待处理清单 + 跳过清单 + 第一个引导问题。

agent 的判定会缓存，第二次唤醒时头部大 issue 不会重读代码。

## 状态模型

`candidates.json` 以 issue_id 为键：

```jsonc
{
  "issue_id": "...", "family_key": "...", "bid": "vc_ai", "member_issue_ids": [...],
  "message": "...", "issue_url": "...", "slardar_url": "...",
  "users": 71192, "count": 126342, "first_seen": 0, "first_seen_at": "...", "refreshed_at": "...",
  "status": "pending | dispatched | rejected",
  "verdict": { "fixable": false, "reason": "...", "by": "agent | user", "at": "<ISO>" },
  "verdicts": [ /* 历次 verdict，只追加 */ ],
  "decision": { /* reject / dispatch 细节，同现状 */ },
  "covered_by": "<已派单 issue_id>"
}
```

- 删除字段：`likelihood`、`summary`、`stale_count`。
- `covered_by` 只由 `judge --same-as` 写入，`history()` 继续用它汇总被覆盖族的台账行。
- `dispatched.json` 结构不变（`prepare-dispatch.sh` / `board.sh` 依赖）；`markDispatched` 的 `decision` 不再带 `fix_paths`。

### walk 归类（优先级从高到低）

| 条件 | class | source |
|---|---|---|
| `status=dispatched`，或 `covered_by` 指向 dispatched 候选 | `skip` | `dispatched`（日期取 decision.at） |
| `status=rejected` | `skip` | `rejected`（reason 取 decision.reason） |
| `verdict.by=user` 且 `fixable` | `fixable` | `user` |
| `verdict.by=agent` 且 `fixable` | `fixable` | `agent` |
| `verdict.by=agent` 且不能修 | `skip` | `agent` |
| 无 verdict | `unjudged` | — |

扫描到的族按以下任一匹配池内候选（称「相关候选」）：issue_id 相同、issue_id 在对方 `member_issue_ids` 里、`family_key` 相同。归类所依据的「主候选」按序取：相关候选中 dispatched 的 → rejected 的 → 自己（有 verdict 时）→ 任一有 verdict 的 → 自己 → 任一相关候选。`walk.items[].issue_id` 输出主候选的 issue_id（即 `judge` / `revive` / `pending` 要用的池内键），`issue_url` 与帧信息仍取本次扫描快照。已派单的族换了 issue_id 仍以「已派单」出现在跳过清单。家族合并只在单页内做；同族跨页时后一页的成员按 `family_key` 匹配到前一页已判定的候选，沿用其判定，不重读代码。

`walk --dir <state> --scan <scan.json> [--skip <id,id>]` 输出一行 JSON：

```jsonc
{
  "items": [{ "issue_id", "users", "count", "message", "issue_url", "class", "source", "reason", "at",
              "mapped_path", "line", "function", "page", "release", "detail_error" }],
  "todo": [ /* 池内 verdict.by=user 且 fixable 且 status=pending 的，不限本次扫描 */ ],
  "exhausted": false   // 本页没有 fixable 也没有 unjudged
}
```

- `items` 覆盖本次扫描全部族，按族用户数降序；`message` 取本次扫描快照。
- `--skip`：本会话「换一条」跳过的 issue，在 `items` 里记 `class=skip, source=session`，不落档。

### 子命令

| 子命令 | 说明 |
|---|---|
| `merge --scan` | 同现状，去掉 stale 删除 |
| `walk --scan [--skip]` | 替代 `pick` |
| `judge --issue-id --fixable yes\|no --reason "…" [--same-as <id>]` | 写 `verdict{by:agent}` 并追加 `verdicts`；`--same-as` 要求目标为 dispatched，同时写 `covered_by`，隐含 `fixable=no`；目标非 pending 或 `verdict.by=user` 时拒绝（agent 不改判用户的捞回） |
| `revive --issue-id` | 写 `verdict{by:user, fixable:true, reason:"捞回"}` 并追加 `verdicts`，清掉 `covered_by`；原 status 为 rejected 时改回 pending、`decision` 置 null；已 dispatched 的拒绝（派单续作归 harness 任务链，`dispatched.json` 的续做记录不能被重开） |
| `reject` | 保留，另追加 `verdict{by:user, fixable:false, reason:<原话>}`，使 `verdicts` 成为完整决策史（revive 清掉 `decision` 后拒绝记录仍在） |
| `dispatched` / `pending` / `history` | 保留；`dispatched` 去掉 `--fix-paths`；`pending` 改按用户数降序 |

删除：`pick`、`cover`、`mechanicalVerdict`、`LOW_MESSAGE` / `OUR_SOURCE`、`LIKELIHOOD_ORDER`、`pendingSorted` 的按档排序（改为按用户数）。

## 判定口径（`references/judging.md`，替代 `likelihood.md`）

- **能修**：`vc-ai/` 或 `packages/` 内存在改动，能减少这条上报或改善用户侧表现。修缺陷、catch、降级、能力探测、去掉无效调用、校正上报级别都算，不要求单一缺陷点位。
- **判不能修前**必须沿完整堆栈找出 vc-ai 调用点，并对上述每种手段说明为何不成立。理由一句话、点名责任层，例如：
  - 「master 已修（<commit>），线上 <release> 未带上」
  - 「同缺陷已派单 <issue_id>」（用 `--same-as`）
  - 「调用点在宿主内置脚本，vc-ai 无调用点」
- 「宿主问题」「服务端错误码」这类笼统理由不合格。
- 是否**值得**修不由 agent 判断；用户在引导式收敛中拦下（如主要改动只是加日志）。
- 拿不准时判能修：假阳性有用户在收敛中拦截，假阴性只能靠用户读跳过清单兜底，成本不对称。
- 读 web 代码判不出责任方时，按 `references/log-forensics.md` 往下查，同现状。

## 呈现与对话

呈现一条消息：

```
【Slardar · vc_ai 近 24h】（当前条为捞回项时加「（你捞回的）」）
现象：<一句人话：哪个端、哪个页面、发生了什么>
报错：<原始 message>
Issue：<issue_url>

待处理（你捞回过、还没派也没拒）：
- <message 摘要>（<用户数>）— 捞回 <MM-DD>
排在它前面、判为不能修的：
1. <message 摘要>（<用户数>）— agent <MM-DD>：<理由>
2. <message 摘要>（<用户数>）— 已派单 <MM-DD>
3. <message 摘要>（<用户数>）— 你拒过 <MM-DD>：<原话>
要捞回哪条直接说「捞回 2」。

<第一个引导问题>
```

- 待处理不含当前条；为空省略该节。跳过清单为空省略该节。跳过清单全部列出，不折叠。
- 翻到第 5 页仍无能修：回「前 100 条没有判为能修的」，照样附完整跳过清单与待处理清单。
- 「现象」只写可观察事实，不写代码路径、根因、改法（同现状）。
- 删除旧纪律「呈现不出现次数、用户数」「不附已派单、已拒绝、低 / 排除清单」「选取不看 users / count」。

入口指令：

| 指令 | 动作 |
|---|---|
| 默认唤醒 | 数据流 1–5，随后引导式收敛 |
| 「捞回 N」 | `revive`，切到该条，进入引导式收敛，第一问围绕「vc-ai 能怎么缓解」；原当前条不落档 |
| 「换一条」 | `walk --skip` 带上本会话呈现过的 issue，继续往后找 |
| 「这条不修 …」 | `reject`，同现状 |
| 「说说你的判断」「派这条」 | 同现状 |

## 迁移

`state/` 已在 `.gitignore`，只在本机操作：

- `state/candidates.json`、`state/dispatched.json` 改名为 `*.bak-2026-09-29`。
- `ledger.jsonl`、`board/`、`scans/` 保留。
- 首次唤醒从空池开始；此前已派的 3 条会作为新候选重判，可能再次被呈现，由用户说「这条不修」处置。

## 测试

删除：机械规则、`pick`、`cover`、stale 移除、`setJudgment` 四档排序相关用例。

新增 / 改写：

- `walk` 归类优先级：dispatched / covered_by > rejected > user 能修 > agent 能修 > agent 不能修 > unjudged。
- `walk.items` 按族用户数降序，message 取扫描快照；`--skip` 记 `source=session` 不落盘。
- `walk.todo` 只含 `by=user`、fixable、pending，且不限本次扫描。
- 已派单的族换了 issue_id（family_key 相同）仍归为 `skip/dispatched`。
- `judge` 追加 `verdicts`；`--same-as` 目标非 dispatched 时报错；写 `covered_by`。
- `revive` 把 rejected 改回 pending 并写 user verdict。
- `merge` 不再删除缺席候选；同族已结案的新 issue 仍不入池，台账归属不变。
- `dispatched` 不接受 / 不要求 `--fix-paths`。
- `scan` 调用参数含 `--order-by user_descend` 与分页；输出按族用户数降序。
- `history` 现有用例全部保持通过。
