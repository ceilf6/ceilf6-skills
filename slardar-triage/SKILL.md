---
name: slardar-triage
description: 扫描 Slardar 近 24h 线上 JS 错误（只看 vc_ai，即 vc-ai 方向），挑出一条最可能在 vc-ai 内通过代码修复、且尚未派过单的告警，只呈现现象、报错与 Issue 链接，随后一次一问引导用户收敛技术方案；用户说「派这条」才建 Meego、转交 byteview-web-harness 任务链修复（omh 固定跑 opus）、登记看板。派出去的单不跟踪去向，只永久算已处理。量级与分布不展示但每次扫描记台账。当用户说「扫一下线上告警」「看看 Slardar」「挑一个告警看看」「换一条」「派这条」「这条不修」时使用。
---

# slardar-triage

技能目录 `<skill>` = 本文件所在目录；状态目录 `<state>` = `<skill>/state`；byteview-web 仓 `<repo>` = 当前 cwd 的 `../byteview-web`（`--repo` 可改）。所有脚本 stdout 只有一行 JSON。派单在 byteview-web-harness 仓内进行，`<harness>` = 当前 cwd。

**默认唤醒不建 Meego、不建 harness 任务、不登记看板、无任何外发动作**，只写 `<state>/`。agent 读代码得出的判断只用来选取和安排提问顺序；技术方案由用户在对话里逐项拍板。

**本技能只管「适合修且还没派过单」的告警。** 派出去的单不再跟踪去向：不查 omh 阶段、不查 MR 是否合入、不看修复是否见效。`status=dispatched` 与 `status=rejected` 一律永久算已处理，只用于把同一缺陷的候选排除出短名单。

## 入口

| 用户意图 | 动作 |
|---|---|
| 默认（「扫一下线上告警」「看看 Slardar」「挑一个告警看看」） | 主流程第 1–5 步，随后进入「引导式收敛」 |
| 「换一条」 | 用同一份 scan 重跑第 4 步，`--skip` 带上本会话已呈现过的 issue；当前这条保持 pending |
| 「说说你的判断」 | 直接给出对当前这条的初步判断（点位、根因、改法），之后回到一次一问 |
| 「派这条」 | 「派单」一节 |
| 「这条不修 <摘要或 issue_id>，原因：<文本>」 | `node <skill>/scripts/state.mjs reject --dir <state> --issue-id <id> --reason "<原话>"`，回话题确认 |

参数：`--bid`（默认 `vc_ai`；本技能只看 vc-ai 方向，不加 vc_web / vc_pages）、`--hours`（24）、`--top`（首轮 10，扩量阶梯 30 → 100，见第 4 步）。

## 主流程

### 1. 前置校验（缺一即停）

```bash
ls <repo>/node_modules/.bin/slardar-web-cli
<repo>/node_modules/.bin/slardar-web-cli --raw js-error list --bid vc_ai --env online --site-type web --start-time $(( $(date +%s) - 600 )) --end-time $(date +%s) --page-size 1
git -C <repo> fetch origin master
```
失败对应的补法：JWT → 让用户在本机执行 `npx -y agentbuddy get-jwt`；fetch 失败 → 报网络/权限。默认路径不需要 Meego，它只在派单前校验。

### 2. 扫描

```bash
node <skill>/scripts/scan.mjs --bid <bids> --hours <hours> --top <top> --repo <repo> --out <state>/scans/scan-$(date -u +%Y%m%dT%H%M%SZ).json
```
`skipped_bids` 非空说明 vc_ai 本身没扫成：回话题说明原因并停在这一步。

### 3. 合并候选池并记台账

```bash
node <skill>/scripts/state.mjs merge --dir <state> --scan <scan.json>
```
每次扫描的每个族都会在 `<state>/ledger.jsonl` 留一行（次数、用户、session、各分布主项、状态）。这些数字不出现在呈现里。

### 4. 预筛与验证

```bash
node <skill>/scripts/state.mjs pick --dir <state> --scan <scan.json> [--skip <id,id>]
```
按 `<skill>/references/likelihood.md` 对 `shortlist` 从头逐条读代码验证，**第一条判「高」就停**。读代码：`git -C <repo> show origin/master:<mapped_path> | sed -n '<line-30>,<line+30>p'`，位置已变时 `git -C <repo> log --oneline -5 origin/master -- <mapped_path>`、`git -C <repo> grep -n '<函数名>' origin/master -- <project_dir>`。线上 release 对应 commit：`bytedcli --json scm repo version list <scm_repo> --type online --version <release> --page-size 10` 取 `data.versions[].base_commit_hash`（vc_ai 同时试 `ee/lark/vc_ai` 与 `ee/lark/vc_ai_doubao`，type 再试 test）。

**短名单为空即扩量重扫。** 可修的告警往往用户数少、次数低，按次数降序排在头部之外；扫描窗口不是瓶颈，页宽才是。`pick` 输出 `shortlist` 为空（不论 `covered` / `filtered` 多少）时，`--top` 按 10 → 30 → 100 的阶梯取下一档，从第 2 步起重跑（新的 scan 文件、merge 记台账、pick），直到短名单非空或 `--top` 已到 100。用户显式给了 `--top` 时以该值为起点、仍按阶梯往上扩。「换一条」`--skip` 后短名单为空同样扩量，不直接回「没有可修告警」。

读 web 代码判不出责任方（超时、无响应、数据与预期不符）时，按 `<skill>/references/log-forensics.md` 往下查：Slardar 事件级 context → 网关与业务 PSM 日志 → Logifier 端侧日志。那份文档同时写了和其他 bot 要结论时的纪律。

每条验证的结局落档：
```bash
node <skill>/scripts/state.mjs judge --dir <state> --issue-id <id> --likelihood <高|中|排除> --summary "<点位与一句话缺陷描述，或归档原因>"
node <skill>/scripts/state.mjs cover --dir <state> --issue-id <id> --by <已派单 issue_id>
```
结局与命令的对应：判「高」写 `judge`，随后停止验证并进入第 5 步呈现；判为某条已派单的同一缺陷写 `cover --by <已派单 issue_id>`；master 已修复而线上版本未带上该提交，按「排除」写 `judge`；写不出单一缺陷点位，按「中」写 `judge`。后三种都继续看下一条。`--summary` 只存档，不出现在呈现里。

### 5. 呈现

`botmux send` 一条消息，格式见 `<skill>/references/example-report.md`：

```
【Slardar · vc_ai 近 24h】
现象：<一句人话：哪个端、哪个页面、用户侧或运行时发生了什么>
报错：<原始 message>
Issue：<issue_url>

<第一个引导问题>
```
「现象」只写可观察事实，不写代码路径、函数名、根因、改法。这条消息整体——三行加第一个引导问题——不出现次数、用户数和分布数字，也不附已派单、已拒绝、低 / 排除清单。第二轮起，问题需要时可按「引导式收敛」的事实来源贴分布与量级原文。

整份短名单没有「高」时，呈现第一条「中」。扩量到 100 之后短名单仍为空、或验证下来高与中都没有：只回「没有可修告警」。这句不带「新」字：候选池不看告警首次出现的时间，老告警只要还在上报就会进池，回复里说「新」会被读成「最近没出新告警」。

## 引导式收敛

每轮只做一件事：**贴一个事实原文，提一个待用户决定的问题**。

- 事实来源：堆栈、`git show` 代码片段、`<scan.json>` 里这条的分布与量级、`git log`、线上 release 对应 commit。贴原文，不转述成结论。
- 收敛清单（顺序可依对话调整，逐项由用户拍板）：
  1. 复现条件：哪个端、页面、操作或时序下触发
  2. 缺陷点位：文件:行
  3. 根因归属：web 侧可独立解释 / 依赖 native 或服务端。判为依赖时问用户是否已向对方确认及结论，不强制
  4. 改动范围：文件级，并明确不动什么
  5. 验收方式：首条红灯测试如何复现
- 初步判断可以用来决定先问什么、先贴哪段证据，不抢先说结论。用户的说法与代码或数据不一致时，贴出不一致的原文再问。

清单走完后回显，然后停下等用户说「派这条」或继续修改：

```
【技术方案】<issue 短 id>
复现条件：…
缺陷点位：…
根因：…（native / 服务端确认情况：…）
改动范围：…
验收：…
```

## 派单（只在用户显式指令后）

派的 Meego 条目是**技术需求（story，模板 498109）**，不是缺陷：这批是自查出来的稳定性治理，有技术方案、排期、MR 与验收，对应的就是技术需求的节点流；缺陷的 `RESOLVED` 确认表单要求缺陷引入版本 / 引入日期 / 关联需求这类 per-case 值，机械层给不出默认值，每条都得人工点完才能收束。建单不自持字段配方，走 `bytedcli-meego` 的机械层（`MEEGO_SH` / `MEEGO_REPO` 可覆盖）。

派单 = 本技能做 Slardar 特有的准备，随后把任务交给 byteview-web-harness 的任务链。引导式收敛承担澄清与方案，【技术方案】回显加「派这条」即用户批准，所以从 `task-schedule` 一步接入；本技能不开 worktree、不起 omh。

1. 本会话没有回显过【技术方案】：不派，回话题说明要先走收敛对话。「补充」= 回显的技术方案原文（含用户之后的修改）。
2. 核对：`node <skill>/scripts/state.mjs pending --dir <state>` 里存在该 issue 且 status=pending；否则回话题说明（已派 / 已拒 / 不在池中）。
3. 派单前校验，缺则停：`test -f skills/task-schedule/scripts/task-schedule.js`（不成立说明 cwd 不是 byteview-web-harness 仓，回话题说明派单须在该仓内进行）；`bash ~/.claude/skills/bytedcli-meego/scripts/meego.sh map get --repo lark/byteview-web`（应答须含 `template_id` / `dev_owner_key`，回 `{"skipped":true}` 说明仓库没进配置）；`command -v omh-cli orchestrator`。
4. 写任务书：按 `<skill>/references/task-book-template.md`，第 0 节原样收录技术方案；第 1 节的量级与分布取自 `<scan.json>`；第 2 节线上代码用主流程第 4 步查到的 commit；第 3、4 节按方案的缺陷点位、根因、改动范围写；第 5 节首条 AC 写方案的验收方式（复现步骤、改动前实际表现、期望表现）。`{{meego_url}}` 保留占位。
5. 写 Meego 描述文件：现象 / 根因 / 修法 / Slardar 链接（`issue_url`，用 `[]` 包裹），末尾「【人工确认】<技术方案原文>」。标题带「线上告警修复」前缀，这批单日后靠它在需求里捞得出来。
6. 准备：
```bash
bash <skill>/scripts/prepare-dispatch.sh --state <state> --issue-id <id> --slug <kebab-摘要>-$(date +%F) --task-book <任务书路径> --meego-desc <描述文件> --meego-name "<Meego 标题>" --slardar-url "<issue_url>"
```
输出 `meego_url` 与渲染后的 `task_book`。退出 3：已有未到终态的 omh Task，错误信息里带它的 phase 与工作区，原样转述；退出 1：写停在哪一步，下次「派这条」会续做。
7. 锚定：按 `<harness>/skills/harness-context/SKILL.md` 把 Slardar issue 链接、Meego 链接与【技术方案】原文存入 context store。`--task-name` 用第 6 步的 slug，与第 8 步一致——`task-schedule create` 按同名 staging 把上下文落进正式任务目录，名字对不上会被静默跳过。
8. 建任务：按 `<harness>/skills/task-schedule/SKILL.md`「创建任务」执行——`--task-name` 用第 6 步的 slug，`--branch-prefix feat`，`--repos byteview-web`，`--approved-plan-file` 用第 6 步输出的 `task_book`，`--goal-summary` 用呈现时的「现象」一句话；thread 参数按该 skill 的规则取。续派时（第 10 步 cancel 之后再次「派这条」）不走本步，见第 10 步。
9. 执行：按 `<harness>/skills/task-execute/SKILL.md` 执行。**本 Task 起始到终态之间，每一条运行 omh-loop / stage-monitor / omh-resume 脚本（`task-entry.mjs`、`flow-state.mjs`、各 `submit-*.mjs`、`task watch`）或 `orchestrator` 的 Bash 调用，都以 `ANTHROPIC_MODEL=opus` 为前缀**——runtime daemon 由第一条命令起，之后任何一条命令发现 daemon 死了都会用自己的 env 把它重新拉起；omh 起 stage 子进程不带 `--model`，模型从这棵进程树的 env 继承；只改这一棵树，不动 `~/.claude/settings.json` 与团队 `omh.config.yaml`。渲染 omh-loop handoff 时 `<stage_goal>` 写明：workflow 用 `pc-web-bugfix`；任务书即已批准方案，无需再 plan；Meego 已提供（见任务书首行）；以上前缀规则。
10. 核验模型：omh-loop 走到 `next_action === "handoff_monitor"` 时——即最后一次 submit 成功之后、调用 stage-monitor 之前——执行（Bash 工具给 `timeout: 600000`）：`node <skill>/scripts/task-model.mjs --workspace <worktree 绝对路径> --task-id <task_id> --expect opus`（默认最多等 540 秒到第一个 stage 启动；stage 在 handoff_monitor 之后才会起，早于这一步跑必然超时）。`matches:false`、超时、或命令没有输出：在 worktree 内 `ANTHROPIC_MODEL=opus orchestrator task cancel --task-id <task_id>`，然后读 `<worktree>/.omh/tasks/<task_id>/meta.json` 确认 `phase` 为 `cancelled`（最多等 60 秒；仍不是就回话题报「Task 仍在跑」并停，不做下面任何一步）；确认后按 task-schedule 把任务置 `blocked`（原因写实际模型），回话题说明并停。不写处置账，issue 保持 pending。续派：下次「派这条」先 `git -C <worktree> status --short` 确认干净（不干净先 `git -C <worktree> checkout -- . && git -C <worktree> clean -fd`），然后执行第 6 步（复用 Meego 与任务书）并直接跳到第 9 步；第 7、8 步不重做（上下文已 materialize、managed task 已存在）。
11. 第 10 步核验通过后立即落账并登记个人看板——在调用 stage-monitor 之前，不等终态：处置账里的这条记录是拦住并发第二单的依据。`--task-id` 用 omh-loop 建单返回的 `task_id`（不是 monitor 用的 session id，可在 `<worktree>/.omh/tasks/` 下确认）；`--workspace` 是 byteview-web worktree 的绝对路径，即 `<harness>/` 接上 `task-schedule create` 输出的 `repos[].path`；`--fix-paths` 取方案「改动范围」里的仓内路径，逗号分隔，不含测试文件：
```bash
node <skill>/scripts/state.mjs dispatched --dir <state> --issue-id <id> --task-id <task_id> --task-slug <taskSlug> --workspace <worktree 绝对路径> --supplement "<技术方案原文>" --fix-paths <a,b>
bash <skill>/scripts/board.sh --state <state> --issue-id <id>
```
`board.sh` 输出的是个人看板登记结果，失败写原因，不影响任务推进。
12. 经 lark-sediment skill 沉淀：现象、派单时量级（`history` 最后一行 `rows` 的次数 / 用户 / 分布主项）、技术方案、Meego 链接、taskSlug、Task ID。这是本技能唯一的外发动作，只发生在派单当次。
13. 回话题：Issue 一句话、Meego 链接、taskSlug、Task ID、worktree、实际模型、个人看板登记结果。叫停：在 worktree 内 `ANTHROPIC_MODEL=opus orchestrator task cancel --task-id <id>`，再按 task-schedule 把任务置为 `cancelled_pending_confirmation`。派单后本技能不再跟这条单；omh 的陪跑、confirm / unblock 与阻塞上报，是 task-execute 对当前会话的约束。

## 纪律

- 任何情况下不自动派单，包括短名单只有一条、用户上次说过「以后都派」——每次都要本会话的技术方案与显式「派这条」。
- 选取不看 users / count，它们只决定短名单里的验证顺序；拿不准归中。
- 呈现与收敛对话里，结论由用户说出或在用户要求「说说你的判断」后给出。
- 写答辩或复盘材料要某条告警的量级时间线：`node <skill>/scripts/state.mjs history --dir <state> --issue-id <id>`，基线取派单时那一行。没派过单的候选没有「派单前」参照，`recovery.ratio` 为 null；`latest_present` 为 false 时 `ratio` 按那次扫描的最小次数算，是上界而不是实测值。技能不判定修复是否见效，这个数只是给人看的原始材料。
- 派单只经 byteview-web-harness 任务链；本技能不开 worktree、不起 omh。
- slardar-triage 派的 omh 固定跑 opus：`ANTHROPIC_MODEL=opus` 前缀覆盖本 Task 起始到终态之间每一条运行 omh-loop / stage-monitor / omh-resume 脚本或 `orchestrator` 的 Bash 调用，起单后经 `task-model.mjs` 核验第一个 stage 的实际模型，不符即 cancel。不改 `~/.claude/settings.json`，不改 `byteview-web` 的 `omh.config.yaml`。
- 个人看板登记的是调用本技能的 claude 线程；meta 带 meego_id / meego_type=story / meego_url / slardar_url，看板点「完成」时 `meego.sh done` 据 meego_type 推需求节点。看板 ctx 在 `<state>/board/<slug>`，不随 harness 回收 worktree 而消失；harness 看板由 `workspaces/tasks/<taskSlug>/task.json` 自动呈现，无需登记。补登记：`bash <skill>/scripts/board.sh --state <state> --issue-id <id> [--mr-id] [--session-id] [--slardar-url]`，`--mr-id` 由调用者手给，技能自己不去查。
- 向其他 bot 要结论时，消息里要显式要求对方 `--mention` 回本 bot，否则回答只到人那里，自己收不到；查 open_id 用 `botmux bots list`，细节见 `<skill>/references/log-forensics.md`。
