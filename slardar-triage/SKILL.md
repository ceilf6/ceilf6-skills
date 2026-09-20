---
name: slardar-triage
description: 扫描 Slardar 近 24h 线上 JS 错误（只看 vc_ai，即 vc-ai 方向），挑出一条最可能在 vc-ai 内通过代码修复、且无人在途处理的告警，只呈现现象、报错与 Issue 链接，随后一次一问引导用户收敛技术方案；用户说「派这条」才建 Meego、经 traecli 起 omh、登记看板。量级与分布不展示但每次扫描记台账。当用户说「扫一下线上告警」「看看 Slardar」「挑一个告警看看」「换一条」「派这条」「这条不修」「看看进度」时使用。
---

# slardar-triage

技能目录 `<skill>` = 本文件所在目录；状态目录 `<state>` = `<skill>/state`；byteview-web 仓 `<repo>` = 当前 cwd 的 `../byteview-web`（`--repo` 可改）。所有脚本 stdout 只有一行 JSON。

**默认唤醒不建 Meego、不起 omh、不登记看板**，只写 `<state>/`；唯一的外发动作是已派单修复见效时的一次飞书沉淀（主流程第 4 步）。agent 读代码得出的判断只用来选取和安排提问顺序；技术方案由用户在对话里逐项拍板。

## 入口

| 用户意图 | 动作 |
|---|---|
| 默认（「扫一下线上告警」「看看 Slardar」「挑一个告警看看」） | 主流程第 1–6 步，随后进入「引导式收敛」 |
| 「换一条」 | 用同一份 scan 重跑第 5 步，`--skip` 带上本会话已呈现过的 issue；当前这条保持 pending |
| 「说说你的判断」 | 直接给出对当前这条的初步判断（点位、根因、改法），之后回到一次一问 |
| 「派这条」 | 「派单」一节 |
| 「这条不修 <摘要或 issue_id>，原因：<文本>」 | `node <skill>/scripts/state.mjs reject --dir <state> --issue-id <id> --reason "<原话>"`，回话题确认 |
| 「看看进度」 | `node <skill>/scripts/progress.mjs --state <state>`，回话题：Issue 一句话、Meego、Task、阶段、MR 链接与是否合入 |

参数：`--bid`（默认 `vc_ai`；本技能只看 vc-ai 方向，不加 vc_web / vc_pages）、`--hours`（24）、`--top`（10）。

## 主流程

### 1. 前置校验（缺一即停）

```bash
ls <repo>/node_modules/.bin/slardar-web-cli
<repo>/node_modules/.bin/slardar-web-cli --raw js-error list --bid vc_ai --env online --site-type web --start-time $(( $(date +%s) - 600 )) --end-time $(date +%s) --page-size 1
git -C <repo> fetch origin master
```
失败对应的补法：JWT → 让用户在本机执行 `npx -y agentbuddy get-jwt`；fetch 失败 → 报网络/权限。默认路径不需要 Meego / traecli，它们只在派单前校验。

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

### 4. 已派单收尾检查

```bash
node <skill>/scripts/state.mjs flight --dir <state>
```
- `in_flight` 里每条先执行 `node <skill>/scripts/progress.mjs --state <state> --issue-id <id>`：它读 omh 任务产出，输出 `mr_url` 与 `phase`；`mr_id` 只在这条派单记录有看板条目时才回填进 `<state>/dispatched.json`。输出为 `{ ok: false }`（这条没有已派发的 Task 或工作区）、或没有 `mr_url`（omh 还没出 MR）的，这一轮跳过。
- 拿到 `mr_url` 的，经 bytedcli-bits-mr skill 查 MR 状态与改动文件。MR 改到的非测试源码文件与该单记着的 `fix_paths` 不一致时，用 `node <skill>/scripts/state.mjs fix-paths --dir <state> --issue-id <id> --paths <a,b>` 改正：下一次扫描的在途覆盖认这份路径。已合入的执行 `node <skill>/scripts/state.mjs merged --dir <state> --issue-id <id> --at <合入时间 ISO>`，然后重跑 `flight`。
- `awaiting_recovery` 里每条执行 `node <skill>/scripts/state.mjs history --dir <state> --issue-id <id>`；只有 `recovery.ratio` 非 null 且 ≤ 0.2 才经 lark-sediment skill 沉淀「现象、修复前那一行的用户 / 分布主项、量级对比、MR 链接、合入时间」，成功后 `node <skill>/scripts/state.mjs sedimented --dir <state> --issue-id <id>`。`ratio` 为 null 或大于 0.2 的不动。量级对比按 `latest_present` 写：为 true 写「修复前 <baseline_count>（<baseline_at>）→ 当前 <latest_count>」；为 false 写「修复前 <baseline_count>（<baseline_at>）→ 已跌出近 24h Top<top>（低于 <latest_floor> 次）」——缺席只说明低于那次扫描记下的最小次数，不写「当前 0」。

### 5. 预筛与验证

```bash
node <skill>/scripts/state.mjs pick --dir <state> --scan <scan.json> [--skip <id,id>]
```
按 `<skill>/references/likelihood.md` 对 `shortlist` 从头逐条读代码验证，**第一条判「高」就停**。读代码：`git -C <repo> show origin/master:<mapped_path> | sed -n '<line-30>,<line+30>p'`，位置已变时 `git -C <repo> log --oneline -5 origin/master -- <mapped_path>`、`git -C <repo> grep -n '<函数名>' origin/master -- <project_dir>`。线上 release 对应 commit：`bytedcli --json scm repo version list <scm_repo> --type online --version <release> --page-size 10` 取 `data.versions[].base_commit_hash`（vc_ai 同时试 `ee/lark/vc_ai` 与 `ee/lark/vc_ai_doubao`，type 再试 test）。

每条验证的结局落档：
```bash
node <skill>/scripts/state.mjs judge --dir <state> --issue-id <id> --likelihood <高|中|排除> --summary "<点位与一句话缺陷描述，或归档原因>"
node <skill>/scripts/state.mjs cover --dir <state> --issue-id <id> --by <在途单 issue_id>
```
结局与命令的对应：判「高」写 `judge`，随后停止验证并进入第 6 步呈现；判为某条在途单的同一缺陷写 `cover --by <在途单 issue_id>`；master 已修复而线上版本未带上该提交，按「排除」写 `judge`；写不出单一缺陷点位，按「中」写 `judge`。后三种都继续看下一条。`--summary` 只存档，不出现在呈现里。

### 6. 呈现

`botmux send` 一条消息，格式见 `<skill>/references/example-report.md`：

```
【Slardar · vc_ai 近 24h】
现象：<一句人话：哪个端、哪个页面、用户侧或运行时发生了什么>
报错：<原始 message>
Issue：<issue_url>

<第一个引导问题>
```
「现象」只写可观察事实，不写代码路径、函数名、根因、改法。这条消息整体——三行加第一个引导问题——不出现次数、用户数和分布数字，也不附已派单进展、已拒绝、低 / 排除清单。第二轮起，问题需要时可按「引导式收敛」的事实来源贴分布与量级原文。

整份短名单没有「高」时，呈现第一条「中」。短名单为空、或验证下来高与中都没有：只回「没有新的可修告警，在途 N 条」（N = `pick` 输出的 `covered` 条数 + `in_flight`）。

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

1. 本会话没有回显过【技术方案】：不派，回话题说明要先走收敛对话。「补充」= 回显的技术方案原文（含用户之后的修改）。
2. 核对：`node <skill>/scripts/state.mjs pending --dir <state>` 里存在该 issue 且 status=pending；否则回话题说明（已派 / 已拒 / 不在池中）。
3. 派单前校验：`bytedcli --json meego user search --project-key 5e96d7bff4e7c525510f9156 --user-keys '["wangjinghong.ceilf6"]'`、`command -v traecli omh-cli orchestrator`，缺则停。
4. 写任务书：按 `<skill>/references/task-book-template.md`，第 0 节原样收录技术方案；第 1 节的量级与分布取自 `<scan.json>`；第 2 节线上代码用主流程第 5 步查到的 commit；第 3、4 节按方案的缺陷点位、根因、改动范围写；第 5 节首条 AC 写方案的验收方式（复现步骤、改动前实际表现、期望表现）。`{{meego_url}}` 保留占位。
5. 写 Meego 描述文件：现象 / 根因 / 修法 / Slardar 链接（`issue_url`，用 `[]` 包裹），末尾「【人工确认】<技术方案原文>」。
6. 派发（在本会话 cwd 下执行，不要先 `cd` 进工作区）：
```bash
bash <skill>/scripts/dispatch.sh --state <state> --issue-id <id> --slug <kebab-摘要>-$(date +%F) --task-book <任务书路径> --meego-desc <描述文件> --meego-name "<Meego 标题>" --os <os_dist 主项> --release <release_dist 主项> --repo <repo> --slardar-url "<issue_url>"
```
退出 3：有在跑的单，附其进展；退出 4：runtime 不符已 cancel，不重试；退出 1：写停在哪一步，下次「派这条」会续派。输出的 `board` 字段是看板登记结果，失败写原因。
7. 成功后（`--fix-paths` 取方案「改动范围」里的仓内路径，逗号分隔，不含测试文件）：
```bash
node <skill>/scripts/state.mjs dispatched --dir <state> --issue-id <id> --task-id <task_id> --supplement "<技术方案原文>" --fix-paths <a,b>
```
8. 经 lark-sediment skill 沉淀：现象、派单时量级（`history` 最后一行 `rows` 的次数 / 用户 / 分布主项）、技术方案、Meego 链接、Task ID。
9. 回话题：Issue 一句话、Meego 链接、Task ID、工作区、看板登记结果、预计约 3 小时、叫停命令 `orchestrator task-cancel --task-id <id>`。

## 纪律

- 任何情况下不自动派单，包括短名单只有一条、用户上次说过「以后都派」——每次都要本会话的技术方案与显式「派这条」。
- 选取不看 users / count，它们只决定短名单里的验证顺序；拿不准归中。
- 呈现与收敛对话里，结论由用户说出或在用户要求「说说你的判断」后给出。
- 写答辩或复盘材料要某条告警的量级时间线：`node <skill>/scripts/state.mjs history --dir <state> --issue-id <id>`。没派过单的候选没有「修复前」参照，`recovery.ratio` 为 null；`latest_present` 为 false 时 `ratio` 按那次扫描的最小次数算，是上界而不是实测值。
- omh 永远经 `traecli exec` 起（dispatch.sh 内置）。
- 看板登记的是调用本技能的 claude 线程；meta 带 meego_id / meego_type=issue / meego_url / slardar_url，`progress.mjs` 发现 MR 后回填 mr_id。补登记：`bash <skill>/scripts/board.sh --state <state> --issue-id <id> [--mr-id] [--session-id] [--slardar-url]`。
- 停摆恢复：phase=failed 且死于 code-review → `bash <skill>/scripts/resume-traex.sh <workspace> <task_id> impl`；其他节点省略第三个参数；执行后在回复里写动作与理由。
