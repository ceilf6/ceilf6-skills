---
name: slardar-triage
description: 并行扫描 Slardar 线上 JS 错误与指定飞书群的最新消息：两条线共用既有判定经验、用户决定和本地状态，从各自最新位置逐条走查，第一条判为需要处理的候选获胜并进入一次一问的技术方案收敛；用户说「派这条」才建 Meego、转交 Harness 任务链。Slardar 与飞书平台只读，判定、拒绝、捞回与派单状态写本地台账。
---

# slardar-triage

技能目录 `<skill>` = 本文件所在目录；状态目录 `<state>` = `<skill>/state`；byteview-web 仓 `<repo>` = 当前 cwd 的 `../byteview-web`（`--repo` 可改）；byteview-pc 仓 `<repo-pc>` = `<repo>` 的同级目录 `byteview-pc`（环境变量 `SLARDAR_TRIAGE_REPO_BYTEVIEW_PC` 可改）。每条候选带 `repo`（`byteview-web` / `byteview-pc`）与 `repo_dir`，读代码、建 Meego、派单都按它选仓。所有脚本 stdout 只有一行 JSON。派单在 byteview-web-harness 仓内进行，`<harness>` = 当前 cwd。

## 双线竞速

默认入口必须由主 Agent 同时启动两个同质量档位、独立上下文的 worker：`slardar` 与 `lark`。worker 不得调用 `botmux send`；只有主 Agent 能呈现最终胜出候选。

两个 worker 都使用 `references/judging.md` 与 `<state>` 中的当前判定。它们可以并行查询外部数据、读代码和形成判断请求，但不得直接写入 `<state>`。任何 `<state>` 写入（包括 scan 落盘、状态命令及派单辅助脚本的持久化）都由主 Agent 按请求到达顺序串行协调；`merge`、`judge`、`rejudge`、`revive`、`reject`、`dispatched` 命令也由主 Agent 执行。一次状态命令连同 `commit-state.sh` 是不可中断的写入单元；保存扫描结果、对应 `merge` 及其 `commit-state.sh` 同属一个写入单元，期间不处理另一来源的写入请求。

worker 只回四种状态：

- `candidate`：共享状态确认当前候选为 `fixable`；Lark 候选还必须通过「已有处理门禁」；
- `continue`：当前候选已按既有逻辑判定并落账，继续下一条；
- `exhausted`：该来源按自身边界扫完；
- `blocked`：该来源因认证、权限、网络或依赖失败不能继续。

第一个 `candidate` 占领首胜门。主 Agent 通知另一 worker 在当前写入单元完成后停止；几乎同时命中时不再比较优先级。`blocked` 或 `exhausted` 只结束对应来源，另一来源继续。两条都到终态且没有 `candidate` 时，只在两条都 `exhausted` 时回答没有候选；只要任一来源为 `blocked`，整体结果就为 `blocked`，明确不可用来源、阻塞原因与所需恢复条件，并说明另一来源已 `exhausted`（若适用）。不得将未覆盖来源当成无候选。一条胜出但另一条曾 `blocked` 时必须说明未覆盖来源。

**默认唤醒不建 Meego、不建 harness 任务、不登记看板、无任何外发动作**，持久状态只写 `<state>/`；worker 的临时扫描材料遵循第 2 步的独享路径约束。agent 读代码得出的候选判定用于选取和安排提问顺序，已落档的 Lark 候选判定及证据理由在首次呈现时回显；技术方案、改动范围与验收由用户在对话里逐项拍板。

**Slardar 与飞书平台只读。** 判定、拒绝、捞回、派单的全部状态都在 `<state>/` 本地文件里，Slardar 上的 issue 状态、处理人、评论等一律不改：平台状态是团队共享视图，本技能的台账是个人工作流，两者互不同步。用户说「不修」「标一下」「关掉」指的都是本地台账。

**Slardar worker 只管「vc-ai / byteview-pc 能修且还没派过单」的告警，agent 判定都不静默丢弃。** 服务端错误码、网络、宿主与 Native 桥三类告警整桶跳过、不逐条读代码；其余先看近 48h 新出现且文案族也是新的告警，再按同文案聚合的合计用户数降序逐条走查，第一条能修即停。排在它前面的整桶跳过、agent 判不能修和已派单条目都带理由出现在跳过清单里，用户一句「捞回 N」即可推翻；用户拒过的条目保留在台账中继续跳过，但不再呈现。派出去的单不再跟踪去向：不查 omh 阶段、不查 MR 是否合入、不看修复是否见效。

## 入口

| 用户意图 | 动作 |
|---|---|
| 默认（「扫一下线上告警」「看看 Slardar」「挑一个告警看看」） | 主 Agent 按「双线竞速」同时启动 Slardar 主流程与「群消息扫描」，胜出候选进入「引导式收敛」 |
| 「换一条」 | 当前条加入 session skip；按「群消息扫描」的换条规则接续两条来源，当前这条不落档 |
| 「捞回 N」 | 按上次呈现的跳过清单编号取 issue_id，`node <skill>/scripts/state.mjs revive --dir <state> --issue-id <id>`，切到这条按第 5 步格式呈现（标题加「（你捞回的）」，不再附清单），随后进入「引导式收敛」；用户点名待处理清单里的条目时，它已是捞回项，直接切过去，不再 revive；编号对应的是真实派单（`source=dispatched` 且 `reason` 为空）时 `revive` 会拒绝，回话题说明这条已派单、后续归 harness 任务链 |
| 「展开 <桶名>」 | 用同一份 `walk` 把该桶（`source=bucket` 且 `category` 对应）的条目按用户数全部列出，编号接着上次呈现的清单往下排；之后「捞回 N」按这个编号 |
| 「先记录 / 下次继续 <摘要或 issue_id>」 | 候选尚未派单时，用 `state.mjs revive` 把它记成用户待处理项；本轮停止收敛、不派单。若已经是用户待处理项则不重复写。后续扫描在「待处理」中持续展示，用户再次点名时直接续上 |
| 「说说你的判断」 | 直接给出对当前这条的初步判断（点位、根因、改法），之后回到一次一问 |
| 「派这条」 | 「派单」一节 |
| 「这条不修 <摘要或 issue_id>，原因：<文本>」 | `node <skill>/scripts/state.mjs reject --dir <state> --issue-id <id> --reason "<原话>"`，回话题确认。只写本地台账，不调用 Slardar 的 set_status 等写接口 |

参数：`--bid`（默认 `vc_ai,minutes_record,lark_vc_pc`，三个 bid 并行扫、合并成一个顺序；不加 vc_web / vc_pages）、`--hours`（24）、`--page-size`（20，每个 bid 按影响用户数各取一页；最多翻到第 5 页）、`--new-hours`（48，首次出现落在这段时间内算新）、`--new-depth`（300，每个 bid 检查 24h 内按用户数排前多少条的新旧；0 关闭）、`--baseline-days`（7，判首次出现用的基线窗口）、`--new-min-users`（2，24h 内用户数低于它的不当新增看）。

三个 bid 的差别（脚本已处理，判定时要知道）：
- `vc_ai`：会中 / 妙记 / 豆包里的 AI 视图自己上报，环境名 `online`，sourcemap 已绑定，`mapped_path` 直接指到源码。
- `minutes_record`：录音页（`pid=record-page`）的 bid，环境名 `production`。录音 SDK（byteview-mm-web `apps/record/record-sdk`）把页内挂载的 vc-ai bundle 抛出的错误统一加 `[RECORD_SDK] [warn|error]` 前缀后上报，`message_core` 是剥掉前缀的原文。vc-ai 的 sourcemap 只绑在 vc_ai bid，所以这里的帧停在 `feishu-static/byteview/vc-ai/static/js/*-ai.js` 这类 CDN chunk 上：`latest_event.sourcemap_missing=true`、`mapped_path=null`、`project_frames` 是落在 vc-ai bundle 的帧数、`chunk_files` 是涉及的 chunk 文件名。`release` 与 `release_dist` 在这个 bid 里是飞书客户端版本（如 8.2.14），不是 vc-ai 的 web 发布版本，不能拿去查 SCM；vc-ai 侧版本信息事件里没有。
- `lark_vc_pc`：会议 PC 客户端前端（byteview-pc，Electron webcontent 里的页面），环境名 `production`。`pid` 是扩展名加 hash 路由：`video-conference-page` 是会中与导航页，`video-conference-native` 是原生弹窗类页。`release` 形如 `8.2.3_2026_9_23_16_51_41_288`，首段是 lerna 版本，对应 byteview-pc 的 tag `v<版本>`（`git -C <repo-pc> rev-parse v8.2.3`），不查 SCM。帧 `webpack://@byteview/<包>/./src/…` 已映射为 `packages/byteview-<包>/src/…`；`…/../../node_modules/@lark/services/…` 是 rust-sdk 的 JS 封装、不算项目帧；`native-resource://…/lark-api-core.js` 是宿主内置脚本；老版本的 `file:///…/webcontent/…` 帧 sourcemap 缺失，`project_frames` 按 `/webcontent/video-conference-` 计数。判定口径同 vc-ai，只是看 byteview-pc 的 `packages/` 能否修。

## 主流程

本节的只读查询、走查与证据分析由 `slardar` worker 执行；第 1–4 步的查询、排序、分页、桶与缓存语义保持现有行为。扫描结果保存与所有状态写入由主 Agent 按「双线竞速」串行执行，worker 只提交材料和写入请求。第 5 步不由 worker 直接发送，而是把候选与跳过清单返回主 Agent。只有它赢得首胜门后，主 Agent 才按第 5 步呈现。

### 1. 前置校验（缺一即停）

```bash
ls <repo>/node_modules/.bin/slardar-web-cli
<repo>/node_modules/.bin/slardar-web-cli --raw js-error list --bid vc_ai --env online --site-type web --start-time $(( $(date +%s) - 600 )) --end-time $(date +%s) --page-size 1
git -C <repo> fetch origin master
git -C <repo-pc> fetch origin master
```
失败对应的补法：JWT → 让用户在本机执行 `npx -y agentbuddy get-jwt`；fetch 失败 → 报网络/权限。默认路径不需要 Meego，它只在派单前校验。minutes_record 不单独探活：它和 vc_ai 共用 JWT，扫不成会落在第 2 步的 `skipped_bids` 里。

### 2. 扫描

worker 的 `<worker-scan.json>` 是本 worker 独享、位于 `<state>` 外的临时材料路径；不得把它指向共享 state。查询完成后，worker 请求主 Agent 将结果保存为 `<scan.json>`（`<state>/scans/scan-<UTC 时间戳>-p<N>.json`），并串行执行第 3 步的合并及提交；后续走查使用主 Agent 保存的 `<scan.json>`。

```bash
node <skill>/scripts/scan.mjs --bid <bids> --hours <hours> --page <N> --page-size 20 --repo <repo> --out <worker-scan.json>
```
首轮 `N=1`。每个 bid 按影响用户数（`user_descend`）各取一页、并行拉取，合并后按**同文案聚合的合计用户数**重排（`family_key` 是抹掉 logId、meeting_id、JSON 位置、压缩标识符等易变量后的文案，`family_users` / `family_size` 是同族合计），同族相邻、族内按单条用户数。

第 1 页同时做**新增检测**：Slardar 列表返回的 `min_crash_time`（候选里的 `first_seen`）是查询窗口内的最早事件，24h 窗口里几乎等于窗口起点，不能当首次出现用。脚本把每个 bid 24h 内按用户数排前 `--new-depth` 条的 issue 拿到 `--baseline-days` 天的基线窗口里再查一次，基线内最早事件落在最近 `--new-hours` 内的标 `is_new: true`，`baseline_first_seen` 是这个时间（毫秒）；它不在常规页里时追加进 `candidates`（按用户数最多追加 `page_size` 条），stdout 的 `new_issues` 是各 bid 的新 issue 数。Slardar 按堆栈拆 issue，老文案在新版本下换了堆栈也会成为新 issue，所以只有文案族在非新 issue 里没出现过的才标 `new_family: true`，排序时这些排在所有候选之前（它们用户数小，按量级排永远轮不到），其余新 issue 仍按量级排、只带标记。基线里查不到的 issue 不算新；24h 内不足 `--new-min-users` 个用户的也不算（单人环境问题，且在小 bid 里每天成批出现又消失），要看它们就把参数降到 1。判定仍以 Slardar issue 为单位、不合并：同文案的 issue 是 Slardar 按堆栈拆开的，各自判定；两个 bid 里出现同一文案也各算一条，是否同缺陷要读过调用链再归（`--same-as`）。每条还带 `category`：`server`（错误码、限流、invalid user）/ `network`（Failed to fetch、Load failed、NetError、网络代理失败）/ `host`（APINotProvided、native-api 超时、Java bridge、WKWebView 释放）/ `business`（其余），规则在 `<skill>/scripts/lib/category.mjs`。stdout 的 `bids` 是各 bid 的候选数。`skipped_bids` 里有 vc_ai：回话题说明原因并停在这一步；只有 minutes_record 没扫成：继续走，但呈现时带一句「录音页本次未扫到：<reason>」。

### 3. 合并候选池并记台账

以下写入命令由主 Agent 执行，与第 2 步扫描结果保存同属一个不可中断的写入单元。

```bash
node <skill>/scripts/state.mjs merge --dir <state> --scan <scan.json>
```
候选池只增不删：没扫到的页里的候选及其判定都保留。每次扫描的每个 issue 在 `<state>/ledger.jsonl` 留一行（次数、用户、session、各分布主项、状态）。

状态目录在 git 仓内时，`merge` / `judge` / `rejudge` / `revive` / `reject` / `dispatched` 与 `prepare-dispatch.sh` / `board.sh` 每次落盘都经 `<skill>/scripts/commit-state.sh` 记一笔 `chore(slardar-triage): 记录 <日期> 扫描状态（N 个文件）`：只暂存 state 目录；同一天且未推送的 chore 用 amend 合并；只提交不推送。输出里的 `commit` 字段是这次提交的结果（无变更或不在仓内时省略）。设 `SLARDAR_TRIAGE_NO_COMMIT=1` 可关掉。推送由用户说了算，技能不自动 push。

### 4. 走查与判定

```bash
node <skill>/scripts/state.mjs walk --dir <state> --scan <scan.json> [--skip <id,id>]
```
`items` 先是 `new_family` 的新族候选，再按族合计用户数降序（同第 2 步的顺序），每条带 `is_new`、`new_family`、`baseline_first_seen`、`category`、`family_key`、`family_users`、`family_size` 与 `class`；`new_issues` 是本页标为新的条数：
- `skip`：`source` 为 `dispatched`（已派单或同缺陷已派单）/ `rejected`（用户拒过）/ `agent`（agent 判不能修）/ `session`（本会话看过）/ `bucket`（环境桶整桶跳过，`reason` 是桶名），带 `reason`、`at`
- `fixable`：`source` 为 `user`（用户捞回）或 `agent`
- `unjudged`：还没判过

`bucket` 只落在 `category` 为 `server` / `network` / `host` 且还没判过的条目上：它是走查的捷径，不是判定，不写进候选池；用户捞回、agent 判过或已派单的条目按自己的状态归类，不受桶影响。`buckets` 是各桶的条数、族数与合计用户数，呈现时用。

已缓存的 agent 结论如果被新证据或判定口径推翻，先用 `node <skill>/scripts/state.mjs rejudge --dir <state> --issue-id <id>` 清空当前结论，再按本节重新走查。`rejudge` 只接受 pending 的 agent 判定，保留 `verdicts` 历史；用户拒绝或捞回的条目不得用它改判。

从头往下看：第一条非 `skip` 的是 `fixable` 就停，进第 5 步；是 `unjudged` 就按 `<skill>/references/judging.md` 读代码判定、`judge` 落档，然后重跑 `walk`。`items[].issue_id` 就是 `judge` / `rejudge` / `revive` 要用的池内键。同族的其他 issue（`family_key` 相同）不用各自再读一遍代码：调用链相同就跟着当前这条的结论一起 `judge`（理由注明「同文案族，调用链同 <issue_id>」），派单后再用 `--same-as` 归到那张单。

读代码（`<repo>` 按候选的 `repo` 取：byteview-web 或 byteview-pc）：`git -C <repo> show origin/master:<mapped_path> | sed -n '<line-30>,<line+30>p'`，位置已变时 `git -C <repo> log --oneline -5 origin/master -- <mapped_path>`、`git -C <repo> grep -n '<函数名>' origin/master -- <project_dir>`。完整堆栈：`<repo>/node_modules/.bin/slardar-web-cli --raw log detail --bid <bid> --env <vc_ai→online / minutes_record→production> --site-type web --start-time <window.start> --end-time <window.end> --ev-type js_error --dh-key <dh_key>`（`dh_key` 取 `log query --filter issue_id` 的样本）。线上 release 对应 commit：`bytedcli --json scm repo version list <scm_repo> --type online --version <release> --page-size 10` 取 `data.versions[].base_commit_hash`（vc_ai 同时试 `ee/lark/vc_ai` 与 `ee/lark/vc_ai_doubao`，type 再试 test）。

`minutes_record` 候选（`walk` 项带 `bid`、`message_core`、`sourcemap_missing`、`chunk_files`）的定位方法：`mapped_path` 为空是常态，用文案定位——`git -C <repo> grep -n -F '<message_core 里的关键片段>' origin/master -- vc-ai packages`，错误名（`FishBoneError`、`ParseDiagramError`、`CommonError` 等）再 grep 一次收窄到抛出点；堆栈里的函数名是压缩后的单字母，不用它。`project_frames=0` 且文案在 vc-ai / packages 里 grep 不到，才看它是不是录音 SDK 自身（byteview-mm-web）的代码。线上版本对位：`release` 是飞书客户端版本，不查 SCM；要判「master 已修」用 `git log -S` 加提交日期与告警的 `min_crash_time` / 最近事件时间对照，并说明线上 vc-ai 版本未知。

读 web 代码判不出责任方时（超时、无响应、数据与预期不符），按 `<skill>/references/log-forensics.md` 往下查：Slardar 事件级 context → 网关与业务 PSM 日志 → Logifier 端侧日志。那份文档同时写了和其他 bot 要结论时的纪律。

`exhausted: true`（本页全是 `skip`）：`N+1` 从第 2 步重跑，最多到 `N=5`（前 100 条）。跨页时把各页 `walk` 的 `skip` 项按页序累积，作为第 5 步的跳过清单，按 `issue_id` 去重、保留先出现的那条。本页 `candidates` 少于 `page_size` 说明已到末页，不再往后翻。

### 5. 呈现

Lark 候选胜出时，主 Agent 呈现发送人、消息时间、`message_id`、原始消息正文、判断使用的附件/回复/链接，以及共享状态中按 `references/judging.md` 已落档的候选判定及其证据理由。明确标为「共享判定回显」，这是候选判定的依据，不代表用户已批准技术方案、改动范围或验收；随后进入同一套一次一问收敛。

以下格式与清单规则适用于 Slardar 胜出候选；Lark 使用上述共享判定回显及群消息格式。主 Agent 呈现胜出候选，格式见 `<skill>/references/example-report.md`：

```
【Slardar · <bid> 近 24h】
现象：<一句人话：哪个端、哪个页面、用户侧或运行时发生了什么>
报错：<原始 message>
Issue：<issue_url>
首次出现：<baseline_first_seen 转 Asia/Shanghai，到分钟>（近 48h 新出现<，老文案换了堆栈>）

同文案另 <family_size-1> 条 issue，合计 <family_users> 用户。

待处理（你捞回过、还没派也没拒）：
- <message 摘要>（<users> 用户）— 捞回 <MM-DD>
排在它前面、判为不能修的：
1. <message 摘要>（<users> 用户）— <来源> <MM-DD>：<理由>
整桶跳过（没逐条读代码）：
- 服务端错误码：<issues> 条 / <users> 用户，最大 3 条：
  2. <message 摘要>（<users> 用户）
  3. …
- 网络：…
- 宿主与 Native 桥：…
要捞回哪条直接说「捞回 2」；要看某桶全部条目说「展开 网络」。

<第一个引导问题>
```
- 标题里的 `<bid>` 写当前这条的 bid（`vc_ai` 或 `minutes_record`）；minutes_record 的「现象」要点明是录音页里的 AI 视图。
- 当前条 `source=user` 时标题后加「（你捞回的）」。
- 「首次出现」一行只在 `is_new` 时写；`new_family=false` 时括号里补「老文案换了堆栈」。不是新 issue 的不写这行，也不要拿 `first_seen` 充当首次出现（它是窗口起点）。
- 跳过清单与整桶跳过里 `is_new` 的条目在摘要前加「新」字，让用户看得出哪些是新出现后被跳过的。
- 待处理 = `walk.todo` 去掉当前这条；为空省略该节。
- 「同文案另 k 条」一行只在 `family_size>1` 时写；`family_size=1` 省略。
- 跳过清单 = 当前这条之前、`source` 不是 `bucket` 或 `rejected` 的 `skip` 项（跨页累积），全部列出、不折叠，从 1 编号，「捞回 N」按这个编号。来源措辞：`agent` → `agent`，`dispatched` → `已派单`，`session` → `本会话看过`（不带理由）。`source=rejected` 的条目仍由 `walk` 跳过，但不进入呈现、编号或「捞回 N」清单。为空省略该节。
- 整桶跳过 = 当前这条之前的 `bucket` 项按 `category` 分桶（跨页累积），每桶一行写条数与合计用户数，桶内按用户数列出最大 3 条，编号接着跳过清单往下排；「展开 <桶名>」把该桶全部条目列出并接着编号。两个清单都为空时省略。
- 「现象」只写可观察事实，不写代码路径、函数名、根因、改法。
- 翻到第 5 页仍没有 `fixable`：Slardar worker 返回 `exhausted` 与「前 100 条和近 48h 新增 <新增条数> 条里没有判为能修的」、跳过清单和待处理清单；主 Agent 按「双线竞速」决定整体结果。

## 群消息扫描

`lark` worker 第一次调用飞书前必须按 `lark-im` skill 读取 `lark-shared` 与 `lark-im-chat-messages-list` 指令。目标群固定为 `oc_d7ae3bb59ccbfdebe20cb1aa819b8cb7`，外部平台只读。

```bash
lark-cli im +chat-messages-list --as bot \
  --chat-id oc_d7ae3bb59ccbfdebe20cb1aa819b8cb7 \
  --order desc --page-size 50 --no-reactions --format json
```

从返回数组第一条开始按顺序逐条处理；不按发送者、消息类型、关键词或内容筛选，不设置时间范围和持久水位。当前页处理完仍没有候选时，带返回的 `page_token` 请求下一页。消息正文不足以判断时，可以按需读取该消息的附件、话题回复或消息内链接，但不能改变消息顺序。

每次只把当前一条消息归一化为 scan candidate，不能把整页交给 Slardar 的族聚合排序：

```json
{
  "issue_id": "lark:<message_id>",
  "origin": "lark",
  "origin_id": "<message_id>",
  "chat_id": "oc_d7ae3bb59ccbfdebe20cb1aa819b8cb7",
  "message": "<原始消息正文>",
  "sender": "<发送人>",
  "created_at": "<消息创建时间>",
  "users": 0,
  "count": 0
}
```

主 Agent 对这一条执行与 Slardar 完全相同的 `merge -> walk -> judge -> walk`：缓存判定照常复用，`unjudged` 按 `references/judging.md` 读证据，用户捞回、拒绝、已派单与 `rejudge` 语义不变。`walk` 为 `skip` 就回 `continue`；`walk` 为 agent `fixable` 只说明技术上能修，Lark worker 必须继续执行下述「已有处理门禁」，通过后才回 `candidate`。用户捞回项仍按既有用户决定优先规则处理。Lark 候选不写 Slardar 量级 ledger。

### 已有处理门禁（Lark candidate 返回前必做）

用户口径中，其他人已经处理当前问题就等同于本技能的「不能修」。Lark worker 对每个准备返回的 agent `fixable` 候选必须完成以下检查；缓存的 agent `fixable` 也不能直接复用为 `candidate`：

1. 读取当前消息、话题回复、附件和消息内链接，找明确的接手、处理中、已报 Oncall、已有任务或已有 MR 证据。
2. 用当前问题的报错原文、Issue ID、文件或函数名、已知任务标题等精确证据执行针对性重叠检查：Harness 任务只用 `node <harness>/scripts/task-runtime/schedule/task-schedule.js list` 后按候选仓库与精确证据过滤，不逐个扫描 task JSON；BITS MR 查询先按 `bytedcli-enhanced` 与 `bytedcli-bits-mr` skill 读取规则，再在候选仓库上下文运行 `bytedcli --json bits mr search --state opened --keyword '<来自当前证据的精确关键词>'`，可以查多个精确词，禁止无关键词列出全部开放 MR。
3. 消息材料给出明确 Meego / Oncall 链接时，只查该条目的当前状态；禁止全局搜索 Meego 或 Oncall。

命中必须有能关联到当前具体问题的正向证据。只命中宽泛关键词、相邻告警或相似标题不算；任务或 MR 标题命中后还要核对描述、来源证据或改动点确实覆盖当前问题。一条消息有多个独立问题时，先检查当前准备呈现的问题；不能拿另一个问题的处理证据跳过当前问题。

确认已有处理：worker 请求主 Agent 对 `lark:<message_id>` 执行 `judge --fixable no --reason "已有处理：<处理人、动作或任务/MR/Oncall 证据>"`；主 Agent 完成不可中断的状态写入单元并重跑 `walk` 后，本条回 `continue`，继续下一条。没有命中：不持久化「无人处理」，worker 只回 `candidate`，不请求任何额外状态写入。

任一必查材料或针对性查询因认证、权限、网络或依赖失败而无法完成，本 worker 只回 `blocked`，不请求状态写入；不得把「未完成检查」当成「没有人在处理」。另一来源仍按双线竞速规则继续。

bot 不在群时，`230002 Bot/User can NOT be out of the chat` 只令本 worker `blocked`；不得把它伪装成群里没有消息，也不得阻塞仍可运行的 Slardar worker。改用 user 身份只在用户已授权 `im:message:readonly` 与 `im:chat:read` 且本人在群内时允许。

用户在当前会话说「换一条」时，本条加入 session skip，Lark 从下一条更早消息继续，Slardar 沿用当前扫描与 session skip；新的 `/slardar-triage` 调用仍从两个来源起点重新开始。

## 引导式收敛

每轮只做一件事：**贴一个事实原文，提一个待用户决定的问题**。

- 事实来源：堆栈、`git show` 代码片段、`git log`，以及 Slardar 的 `<scan.json>` 分布与量级、线上 release 对应 commit，或 Lark 的消息正文、附件、回复与链接。贴原文；共享候选判定的回显不替代用户对技术方案的决定。
- 收敛清单（顺序可依对话调整，逐项由用户拍板）：
  1. 复现条件：哪个端、页面、操作或时序下触发
  2. 缺陷点位：文件:行
  3. 根因归属：web 侧可独立解释 / 依赖 native 或服务端。判为依赖时问用户是否已向对方确认及结论，不强制
  4. 改动范围：文件级，并明确不动什么
  5. 验收方式：首条红灯测试如何复现
- 初步判断可以用来决定先问什么、先贴哪段证据；Lark 首次呈现可以回显已落档的候选判定及证据理由，不抢先确定待用户批准的技术方案、改动范围与验收。用户的说法与代码或数据不一致时，贴出不一致的原文再问。
- 当前条是模型产出 JSON 形状不符合类型声明（图表 data 字段类型错位）时，改法不再开放讨论，直接按 `references/judging.md`「AI 产出的 JSON 形状不符合类型声明」的口径提：筛掉不符字段、其余照常展示；只问用户丢弃范围是否到字段级即可。
- 当前条是捞回项时，第一问围绕「vc-ai 能怎么缓解」：贴 vc-ai 调用点的代码原文，问用户倾向能力探测、catch 后降级、还是去掉这次调用。

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

当前候选来自 Lark 时，用户明确说「派这条」后，候选键继续使用 `lark:<message_id>`。任务书的线上事实改为群 ID、消息 ID、发送人、时间、原始正文与关联证据；不得伪造 Slardar issue、用户数、次数或 release。`prepare-dispatch.sh` 的 `--slardar-url` 本来就是可选项，Lark 候选不传该参数；其余 Meego、人工确认和 Harness 任务链不变。

派的 Meego 条目是**技术需求（story，模板 498109）**，不是缺陷：这批是自查出来的稳定性治理，有技术方案、排期、MR 与验收，对应的就是技术需求的节点流；缺陷的 `RESOLVED` 确认表单要求缺陷引入版本 / 引入日期 / 关联需求这类 per-case 值，机械层给不出默认值，每条都得人工点完才能收束。建单不自持字段配方，走 `bytedcli-meego` 的机械层（`MEEGO_SH` / `MEEGO_REPO` 可覆盖）。

派单 = 本技能按候选来源准备事实材料，随后把任务交给 byteview-web-harness 的任务链。引导式收敛承担澄清与方案，【技术方案】回显加「派这条」即用户批准，所以从 `task-schedule` 一步接入；本技能不开 worktree、不起 omh。

以下步骤共用人工确认与 Harness 任务链。量级、release、Slardar issue 链接和 `history` 的取值说明仅适用于 Slardar 来源；Lark 使用消息及关联证据，缺少线上版本或 commit 证据时写「未知」，不得用本地 `origin/master` 代替线上版本。

1. 本会话没有回显过【技术方案】：不派，回话题说明要先走收敛对话。「补充」= 回显的技术方案原文（含用户之后的修改）。
2. 核对：`node <skill>/scripts/state.mjs pending --dir <state>` 里存在该 issue 且 status=pending；否则回话题说明（已派 / 已拒 / 不在池中）。
3. 派单前校验，缺则停：`test -f skills/task-schedule/scripts/task-schedule.js`（不成立说明 cwd 不是 byteview-web-harness 仓，回话题说明派单须在该仓内进行）；`bash ~/.claude/skills/bytedcli-meego/scripts/meego.sh map get --repo <meego-repo>`（`<meego-repo>` 按候选 `repo`：byteview-web → `lark/byteview-web`，byteview-pc → `ee/byteview-pc`；应答须含 `template_id` / `dev_owner_key`，回 `{"skipped":true}` 说明仓库没进配置）；`command -v omh-cli orchestrator`。
4. 写任务书：按 `<skill>/references/task-book-template.md`，第 0 节原样收录技术方案；Slardar 来源的第 1 节量级与分布取自 `<scan.json>`（按 `issue_id` 在各页 scan 里找这条；捞回项不在本次扫描里时，量级取 `pending` 里这条的 `users` / `count`，分布写「本次扫描未覆盖」）；Slardar 来源的第 2 节线上代码用主流程第 4 步查到的 commit；Lark 来源的第 1 节使用群消息事实与关联证据，第 2 节只使用消息证据可确认的线上版本或 commit，缺证据写「未知」；第 3、4 节按方案的缺陷点位、根因、改动范围写；第 5 节首条 AC 写方案的验收方式（复现步骤、改动前实际表现、期望表现）。`{{meego_url}}` 保留占位。
5. 写 Meego 描述文件：现象 / 根因 / 修法 / 来源证据（Slardar 用 `issue_url`，用 `[]` 包裹；Lark 用群 ID、消息 ID、正文与关联证据），末尾「【人工确认】<技术方案原文>」。标题带「线上告警修复」前缀，这批单日后靠它在需求里捞得出来。
6. 准备：以下命令示例用于 Slardar 来源；当前候选来自 Lark 时，保留其 `lark:<message_id>` 键，删除整个 `--slardar-url "<issue_url>"` 参数，其余参数和任务链相同。
```bash
bash <skill>/scripts/prepare-dispatch.sh --state <state> --issue-id <id> --slug <kebab-摘要>-$(date +%F) --task-book <任务书路径> --meego-desc <描述文件> --meego-name "<Meego 标题>" --slardar-url "<issue_url>" --meego-repo <meego-repo>
```
输出 `meego_url` 与渲染后的 `task_book`。退出 3：已有未到终态的 omh Task，错误信息里带它的 phase 与工作区，原样转述；退出 1：写停在哪一步，下次「派这条」会续做。
7. 锚定：按 `<harness>/skills/harness-context/SKILL.md` 把来源证据（Slardar issue 链接，或 Lark 群 ID、消息 ID、正文与关联证据）、Meego 链接与【技术方案】原文存入 context store。`--task-name` 用第 6 步的 slug，与第 8 步一致——`task-schedule create` 按同名 staging 把上下文落进正式任务目录，名字对不上会被静默跳过。
8. 建任务：按 `<harness>/skills/task-schedule/SKILL.md`「创建任务」执行——`--task-name` 用第 6 步的 slug，`--branch-prefix feat`，`--repos <候选 repo：byteview-web 或 byteview-pc>`，`--approved-plan-file` 用第 6 步输出的 `task_book`，`--goal-summary` 用呈现时的「现象」一句话；thread 参数按该 skill 的规则取。
9. 执行：按 `<harness>/skills/task-execute/SKILL.md` 执行。runtime 与模型由 harness 与 omh 配置决定（`task-schedule` 以 traecli 宿主准备项目），本技能不加前缀、不校验。渲染 omh-loop handoff 时 `<stage_goal>` 写明：workflow 用 `pc-web-bugfix`（byteview-pc 候选用该仓 task-schedule 配置里的 bugfix workflow）；任务书即已批准方案，无需再 plan；Meego 已提供（见任务书首行）。
10. omh-loop 建单成功后立即落账并登记个人看板——在调用 stage-monitor 之前，不等终态：处置账里的这条记录是拦住并发第二单的依据。`--task-id` 用 omh-loop 建单返回的 `task_id`（不是 monitor 用的 session id，可在 `<worktree>/.omh/tasks/` 下确认）；`--workspace` 是 byteview-web worktree 的绝对路径，即 `<harness>/` 接上 `task-schedule create` 输出的 `repos[].path`：
```bash
node <skill>/scripts/state.mjs dispatched --dir <state> --issue-id <id> --task-id <task_id> --task-slug <taskSlug> --workspace <worktree 绝对路径> --supplement "<技术方案原文>"
bash <skill>/scripts/board.sh --state <state> --issue-id <id>
```
`board.sh` 输出的是个人看板登记结果，失败写原因，不影响任务推进。
11. 经 lark-sediment skill 沉淀：现象、来源事实（Slardar 取派单时量级：`history` 最后一行 `rows` 的次数 / 用户 / 分布主项；Lark 取群 ID、消息 ID、发送人、时间、原文与关联证据，不调用量级 `history`）、技术方案、Meego 链接、taskSlug、Task ID。这是本技能唯一的外发动作，只发生在派单当次。
12. 回话题：Issue 一句话、Meego 链接、taskSlug、Task ID、worktree、个人看板登记结果。叫停：在 worktree 内 `orchestrator task cancel --task-id <id>`，再按 task-schedule 把任务置为 `cancelled_pending_confirmation`。派单后本技能不再跟这条单；omh 的陪跑、confirm / unblock 与阻塞上报，是 task-execute 对当前会话的约束。

## 纪律

- 任何情况下不自动派单，包括只有一条能修的、用户上次说过「以后都派」——每次都要本会话的技术方案与显式「派这条」。
- 对 Slardar 平台只读：只用查询类接口（issue 列表、详情、堆栈、日志明细），不碰 `api_web/js/issue/set_status`、`add_managers`、评论等任何写接口。拒绝、捞回、派单的记号全部落在 `<state>/`。
- 只修真正的用户侧问题。错误已被 catch 且用户侧表现正常、上报只是记录预期内状态、底层真实失败被忠实展示为失败态，都判不能修；消除告警噪音不是派单目标，只改上报方式的改动不算能修。边界按 `references/judging.md` 的「误报与纯噪音判不能修」执行。
- Slardar 的三个 bid 合在一个候选池、一个走查顺序里，不分开各挑一条；minutes_record 的告警不因为 `[warn]` 前缀或 `source_type=manual` 而降权，lark_vc_pc 的不因为归另一个仓而降权。
- Slardar 走查顺序按同文案聚合的合计用户数、族内按单条用户数，列表已按它排好，第一条能修即全局影响最大；判定仍以 issue 为单位，只有能修 / 不能修两档，拿不准判不能修并写明缺的证据（见 `references/judging.md`）。
- 环境桶（服务端 / 网络 / 宿主）整桶跳过是走查捷径，不是判定：不落盘、不写理由到候选池；桶内条目用户捞回后与普通候选一样走收敛与派单。
- 用户的拒绝与捞回优先于任何 agent 判定；agent 不改判捞回项。
- Lark agent 候选呈现前必须通过「已有处理门禁」；已有处理按 agent `fixable=no` 落账并继续下一条，没有命中不持久化，查询失败则该来源 `blocked`。不得用全局 Meego / Oncall 搜索或无关键词开放 MR 列表替代针对性检查。
- 呈现与收敛对话里，Lark 首次呈现必须回显共享状态中已落档的候选判定及证据理由；这属于「共享判定回显」，不代表用户已批准技术方案、改动范围或验收。技术方案结论由用户逐项决定；其他初步分析在用户要求「说说你的判断」后给出，仍须用户批准后才能派单。
- Slardar 来源写答辩或复盘材料要某条告警的量级时间线：`node <skill>/scripts/state.mjs history --dir <state> --issue-id <id>`，基线取派单时那一行。没派过单的候选没有「派单前」参照，`recovery.ratio` 为 null；`latest_present` 为 false 时 `ratio` 按那次扫描的最小次数算，是上界而不是实测值。技能不判定修复是否见效，这个数只是给人看的原始材料。
- 派单只经 byteview-web-harness 任务链；本技能不开 worktree、不起 omh。
- 个人看板登记的是调用本技能的 claude 线程；meta 带 meego_id / meego_type=story / meego_url / slardar_url，看板点「完成」时 `meego.sh done` 据 meego_type 推需求节点。看板 ctx 在 `<state>/board/<slug>`，不随 harness 回收 worktree 而消失；harness 看板由 `workspaces/tasks/<taskSlug>/task.json` 自动呈现，无需登记。补登记：`bash <skill>/scripts/board.sh --state <state> --issue-id <id> [--mr-id] [--session-id] [--slardar-url]`，`--mr-id` 由调用者手给，技能自己不去查。
- 向其他 bot 要结论时，消息里要显式要求对方 `--mention` 回本 bot，否则回答只到人那里，自己收不到；查 open_id 用 `botmux bots list`，细节见 `<skill>/references/log-forensics.md`。
