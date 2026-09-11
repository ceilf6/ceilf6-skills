# slardar-triage 改为「呈现优先、派单显式」

日期：2026-09-11
状态：已口头认可，待实施
取代：`2026-09-08-slardar-triage-design.md` 第 4、6、7、8、9 节中与自动派发相关的内容；`2026-09-09-slardar-triage-board-design.md` 的登记机制不变，只是触发点从自动派单改为显式派单。

## 1. 背景与目标

2026-09-08 首单（Slardar Issue 938f8ba3…，MR 8405910）暴露的问题：agent 判定「前端可独立修」后自动建 Meego、起 omh 出了 MR，但正确顺序应该是用户先向 native 侧同学问清宿主行为、再与 leader 确认 web 侧是否要动手，细节敲定后才进 omh。agent 的判断只能用来排序和呈现，不能触发动作。

目标：默认唤醒只做「扫描 → 判断 web 侧改动可能性 → 逐条详细呈现」，零副作用；建 Meego、起 omh、登记看板只在用户显式说「派这条」且带上敲定的细节后执行。

## 2. 指令

| 用户意图 | 动作 | 副作用 |
|---|---|---|
| 默认（「扫一下线上告警」「看看 Slardar」「挑一个告警看看」） | 扫描、刷新候选池、判断可能性、呈现报告 | 只写 `state/` |
| 「派这条 <issue 摘要或 id>，补充：<敲定的细节>」 | 核对候选在池中且 pending；补充为空先向用户要，问清 native 侧结论与 leader 口径再动；写任务书（含「人工确认信息」节）、Meego 描述（含同一段）；`dispatch.sh` 建 Meego、建工作区、起 omh、登记看板；候选标 dispatched | 建 Meego、起 omh、看板登记 |
| 「这条不修 <issue>」 | 候选标 rejected，附用户原因 | 只写 `state/` |
| 「看看进度」 | `progress.mjs` | 无 |

参数：`--bid`（默认 `vc_ai,vc_web,vc_pages`）、`--hours`（24）、`--top`（10）。删除 `--max-dispatch`、`--dry-run`。

## 3. 可能性判断（`references/likelihood.md`）

判据沿用原 A–D，改名为四档「web 侧改动可能性」，只影响排序与展开与否，不触发动作：

- **高**：最新帧 mapped_path 落在 `vc-ai/`、`vc-web/`、`vc-pages/`、`packages/` 源码，且 agent 在 `<repo>` origin/master 读到对应文件并能写出「文件:行 + 一句话缺陷描述」。
- **中**：帧在我们仓源码，但读完代码写不出单一缺陷点位（共享 throw、跨 await 候选调用链多于一条）。
- **低**：message 含服务端错误码 / `invalid user` / `APINotProvided`；或页面全在豆包宿主；或帧在 `[native code]`。
- **排除**：message 以 `[warn]` 开头；或 master 已有修复且线上 release 早于修复所在版本。
- 拿不准归中。同档内按 24h 族用户数排序。

## 4. 每条候选的详细信息

高、中两档每条展开，栏目固定：

1. Slardar Issue 详情页链接：`https://slardar.bytedance.net/node/web/js/detail?env=online&bid=<bid>&lang=zh&start_time=<窗口起>&end_time=<窗口止>&site_type=web&region=cn&issue_id=<issue_id>&layout=normal&release=<最新事件 release>`，由 `scan.mjs` 生成为 `issue_url`；原 7 天分享链接 `slardar_url` 保留作备用。
2. 错误信息、同族 Issue 列表、Issue 状态、首次出现时间。
3. 24h 族次数 / 族用户数 / 抽样 distinct session 数。
4. 分布：页面、系统、release、宿主版本、source_type。
5. 最新事件帧 `mapped_path:line`（页面、release），线上 release 对应的 SCM commit（`bytedcli scm repo version list`）。
6. master 上的代码点位与一句话缺陷描述（agent 读 `git show origin/master:<path>`）。
7. 根因假设，分两栏：web 侧可独立解释的部分；依赖 native / 服务端行为的部分。
8. 要向 native / 服务端同学确认的问题清单（每条一句，可直接复制去问）。
9. 若确认后在 web 侧动手的建议改动方向与范围（文件级）。
10. 不确定点。

低、排除两档每条一行：可能性、bid、message 摘要、归档原因、Issue 链接。

## 5. 状态目录

- `state/candidates.json`：`{ issue_id: { family_key, bid, message, member_issue_ids, issue_url, slardar_url, likelihood, summary, first_seen_at, refreshed_at, stale_count, status: pending|dispatched|rejected, decision: { reason?, supplement?, at? } } }`。
- 扫描后合并：池中条目本次出现的刷新影响数与 issue_url，未出现的 `stale_count + 1`，连续两次未出现且 status=pending 的移出；dispatched / rejected 不移出、不展开。
- `state/dispatched.json` 沿用（dispatch.sh 的处置账），派单成功后 candidates 里同步标 dispatched 并记 task_id。
- 删除 `queue.json` 及 `enqueue / nextToDispatch / markDispatched`；`skip` 改为 `reject`。

## 6. 派单时的人工确认信息

「派这条」指令必须带补充，形态自由（一段话、几条要点、飞书消息转述都行）。技能把它原样写入：

- 任务书新增「## 0. 人工确认信息（<日期>）」节，放在「线上事实」之前，omh 据此理解范围边界；
- Meego 描述末尾「【人工确认】…」段；
- `candidates.json[issue].decision.supplement`。

补充为空时不派，回复一句要哪两样东西（native 侧结论、leader 是否同意 web 侧动手）。

## 7. 报告格式

1. 候选清单：先高后中，每条按第 4 节栏目展开；低与排除各一行。
2. 已派单进展：`progress.mjs` 的阶段序列与 MR 链接。
3. 已拒绝与自动移出的条目各一行。
4. 本次未扫的 BID 与原因。
5. 下一步一行：「确认后回复『派这条 <id>，补充：…』；不修回复『这条不修 <id>，原因：…』」。

## 8. 测试

- `state.test.mjs`：候选池合并（刷新、连续两次缺席移出、dispatched / rejected 不移出不返回）、`reject`、`markDispatched`。
- `scan.test.mjs`：`issue_url` 形态断言（含 issue_id、release、窗口）。
- `test-dispatch.sh` 不变。
- `references/example-report.md` 按第 7 节用 2026-09-08 批次重写，getAvatarBase64 那条的「要向 native 确认的问题」写真实样例。

## 9. 范围外

- 不改 dispatch.sh / board.sh / launch-traex.sh 的机制。
- 不做自动派单的任何形态，包括「只有一条高可能性时也派」。
