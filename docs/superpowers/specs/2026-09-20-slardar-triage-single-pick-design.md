# slardar-triage 改为「单条极简呈现、对话收敛方案」

日期：2026-09-20
状态：已口头认可，待实施
取代：`2026-09-11-slardar-triage-report-first-design.md` 第 3、4、5 节（分档全量呈现、十栏详细信息、五块报告）以及第 2 节中「补充必须含 native 结论与 leader 口径」的硬门。派单机械层（`dispatch.sh`、看板登记、`progress.mjs`）与「任何情况下不自动派单」的纪律不变。

## 1. 背景与目标

现行默认唤醒把高、中两档全部展开，每条带 master 点位、根因假设、改动方向。实际使用中：

- 一次报告上百行，量最大的几条往往已派过单、只是 MR 没合入，对「接下来修哪条」没有信息量。
- agent 先写出根因与改法，用户只能被动审阅；技术方案应当由用户在对话里逐步拍板。

目标：默认唤醒只给出**一条**最可能在 vc-ai 内通过代码修复、且无人在途处理的告警，只呈现现象；随后 agent 以一次一问的方式引导用户收敛出技术方案，用户显式说「派这条」才派单。量级与分布不展示，但每次扫描全量留档，供转正答辩取「修复前 → 修复后」对比。

## 2. 指令

| 用户意图 | 动作 | 副作用 |
|---|---|---|
| 默认（「扫一下线上告警」「看看 Slardar」「挑一个告警看看」） | 扫描 → 合并候选池并记台账 → 预筛 → 逐条验证到第一条通过 → 三行呈现 + 第一个引导问题 | 写 `state/`；已派单修复见效时另有一次飞书沉淀（7.3） |
| 「换一条」 | 从同一份短名单接着往下验证，呈现下一条；当前这条保持 pending | 只写 `state/` |
| 「说说你的判断」 | 直接给出 agent 对当前这条的初步判断（点位、根因、改法） | 无 |
| 「派这条」 | 见第 6 节；前提是本会话已回显过【技术方案】 | 建 Meego、起 omh、看板登记、飞书沉淀 |
| 「这条不修 <issue>，原因：…」 | 候选标 rejected | 只写 `state/` |
| 「看看进度」 | `progress.mjs`，输出已派单进展 | 无 |

默认唤醒的输出里不再出现「已派单进展」「已拒绝 / 自动移出」「低 / 排除清单」；前者只在「看看进度」时给，后两者只留在 `state/`。

## 3. 选取

### 3.1 脚本预筛（`state.mjs pick --dir <state> --scan <scan.json> [--skip <id,id>]`）

输入是合并后的候选池与本次扫描快照（帧、分布只在快照里）。输出一行 JSON：`{ shortlist, covered, filtered, in_flight }`（`in_flight` 是已派单未合入的条数）。

从 status=pending 的候选里依次剔除：

1. **排除**：message 以 `[warn]` 开头。
2. **低**：message 命中 `code: \d{6}` / `larkErrorCode` / `invalid user` / `APINotProvided`；或 `pid_dist` 的键全部以 `/webview/doubao-` 开头；或 `latest_event.raw_filename` 为 `[native code]`。
3. **帧不在我们仓**：`latest_event.mapped_path` 不以 `vc-ai/` 或 `packages/` 开头。`detail_error` 非空（Sourcemap 没取到）的不剔除，排到短名单末尾。
4. **在途覆盖**：候选的 `covered_by` 指向某条「已派单且未合入」的候选；或 `latest_event.mapped_path` 落在这类候选的 `decision.fix_paths` 里（此时 `pick` 顺手写入 `covered_by`）。进 `covered`。

命中 1、2 的候选由 `pick` 直接写入 `likelihood` 与规则原文作为 `summary`；命中 3 的写「低」。`covered_by` 只是一条持久的归属链接，候选状态仍是 pending；是否被剔除每次 `pick` 按「归属的单是否仍未合入」现算——那张单合入后候选自动回到短名单，由 agent 的「master 已修复」判据接管。

同族覆盖沿用 `mergeScan` 现有行为：与非 pending 候选同 `family_key` 的新 issue 不入池。第 4 条补的是「同一缺陷因报错文案改名而成为新族」的情形（如 7.77 超时文案改名）。超时类错误的最新帧常落在共享的 throw 点（如 `mobile-native-client.ts`），`fix_paths` 匹配不到，这类归属由 agent 在 3.2 里读代码后用 `state.mjs cover` 手工建立。

`shortlist` 按 24h 族用户数降序；`--skip` 用于「换一条」时跳过本会话已呈现过的 issue。

### 3.2 agent 逐条验证

对 `shortlist` 从头开始，读 `git -C <repo> show origin/master:<mapped_path>` 帧位置前后各 30 行（位置已变时 `git log --oneline -5` / `git grep` 找等价位置）：

- 能写出「文件:行 + 一句话缺陷描述」→ `judge` 为高，**停止验证，呈现这一条**。
- 读下来是某条在途单的同一缺陷（调用链汇到那张单的改动范围）→ `state.mjs cover --dir <state> --issue-id <id> --by <在途单 issue_id>`，看下一条。
- master 已有修复且线上 release 早于修复进入的版本 → `judge` 为排除，看下一条。
- 帧在我们仓但写不出单一缺陷点位 → `judge` 为中，记下，看下一条。

整份短名单没有高时，呈现第一条中。短名单为空或全部被判排除时，只回一句：「没有新的可修告警，在途 N 条」（N = `covered` 条数 + 已派单未合入条数），不展开。

`judge --summary` 里的初步判断（点位、缺陷描述）只存档，不出现在呈现里。

## 4. 呈现

`botmux send` 一条消息，固定格式：

```
【Slardar · vc_ai 近 24h】
现象：<一句人话：哪个端、哪个页面、用户侧或运行时发生了什么>
报错：<原始 message>
Issue：<issue_url>

<第一个引导问题>
```

「现象」只描述可观察事实（如「PC 端 AI 视图拉取会议 AI 总结超时 10s，错误以 unhandledrejection 上报」），不含代码路径、函数名、根因、改法、量级、分布。

## 5. 引导式收敛

呈现之后进入对话。每轮只做一件事：**给一个事实原文 + 提一个待用户决定的问题**。

- 事实来源：堆栈、`git show` 代码片段、`scan.json` 的分布与量级、`git log`、线上 release 对应 commit。贴原文，不转述成结论。
- 收敛清单（顺序可依对话调整，逐项由用户拍板）：
  1. 复现条件：哪个端、页面、操作或时序下触发
  2. 缺陷点位：文件:行
  3. 根因归属：web 侧可独立解释 / 依赖 native 或服务端。判为依赖时，问用户是否已向对方确认及结论；不强制
  4. 改动范围：文件级，明确不动什么
  5. 验收方式：首条红灯测试如何复现
- agent 可以用内部的初步判断决定先问什么、先贴哪段证据，但不抢先说结论；用户的说法与代码或数据不一致时，贴出不一致的原文并再问。
- 用户说「说说你的判断」时直接给出判断，之后仍回到一次一问。

清单走完后回显：

```
【技术方案】<issue 短 id>
复现条件：…
缺陷点位：…
根因：…（native / 服务端确认情况：…）
改动范围：…
验收：…
```

然后停下，等用户说「派这条」或继续修改。

## 6. 派单

1. 本会话未回显过【技术方案】→ 不派，回话题说明需要先走收敛对话。
2. 「补充」= 回显的技术方案原文，原样进任务书第 0 节与 Meego 描述末尾的「【人工确认】」。任务书第 3、4、5 节按方案里的缺陷点位、根因、改动范围、验收填写。
3. `state.mjs dispatched` 新增 `--fix-paths <逗号分隔的仓内路径>`，取自方案的改动范围，写入 `decision.fix_paths`，供 3.1 第 4 条使用。
4. 其余步骤（核对 pending、派单前校验、`dispatch.sh`、看板登记、回话题内容）不变。
5. 派单成功后触发一次飞书沉淀，见 7.3。

`references/task-book-template.md` 第 0 节的占位说明改为「收敛对话回显的技术方案原文」。

## 7. 留档

### 7.1 台账

合并候选池这一步改为子命令 `state.mjs merge --dir <state> --scan <scan.json>`（取代 SKILL.md 里的内联 `node -e`），除原有的 `mergeScan` + 写 `merge-latest.json` 外，向 `<state>/ledger.jsonl` 追加：本次扫描里**每个族一行**，不只是被选中的那条。

```json
{"at":"<scanned_at>","bid":"vc_ai","issue_id":"…","owner_issue_id":"…","family_key":"…","member_issue_ids":["…"],"family_count":0,"family_users":0,"distinct_sessions":0,"pid_top":["ai-layout",256],"os_top":["Windows",224],"release_top":["7.77.0.21",299],"host_version_top":["8.0.3",116],"source_type_top":["unhandledrejection",300],"status":"pending"}
```

`status` 取合并后候选池里的状态；不在池里的族（同族已结案而未入池）记其同族候选的状态。台账只追加、不改写。

### 7.2 时间线查询

`state.mjs history --dir <state> --issue-id <id>` 输出一行 JSON：

- `rows`：属于该 issue 的全部台账行，按时间升序。候选的 `family_key` 冻在首见那次，台账行记的是各自扫描当时算出的 key，报错文案一改两者就对不上，所以一行属于某候选的条件是：`family_key` 相同，或该行的 `issue_id` / `owner_issue_id` / `member_issue_ids` 命中候选的 `issue_id` 或 `member_issue_ids`
- `covered_rows`：`covered_by` 指向它的候选按同一条规则认下的台账行；同时属于本族的行只算进 `rows`
- `events`：处置事件（入池、派单 / 拒绝、合入、收尾沉淀）及时间，按时间升序
- `recovery`：`{ baseline_count, baseline_at, latest_at, latest_present, latest_count, latest_floor, ratio }`
  - 只有已派单的候选才有基线：`baseline_count` / `baseline_at` 取派单时刻之前最近一行（台账晚于派单的旧单取最早一行），其余候选两者为 null
  - `latest_at` 取整份台账最新的扫描时刻；`latest_present` 表示这条单的行在那一刻是否出现；`latest_count` 是那一刻本族与被覆盖族的次数之和（每族只计一次），缺席为 0
  - `latest_floor` 是那一刻全部台账行里最小的族次数。每次扫描只记前 top N 个族，缺席只说明低于这个下限而不是降到 0
  - `ratio` 无基线时为 null，否则为 `(latest_present ? latest_count : latest_floor) / baseline_count`；缺席时它是真实回落比的上界，`≤ 0.2` 的判定因此不会把未修好的说成修好了

写答辩材料时由此取「派单时量级 → 合入后量级」。

### 7.3 飞书沉淀（经 `lark-sediment`）

- **派单成功后**：现象、派单时的族次数 / 用户 / 分布主项、技术方案、Meego 链接、Task ID。
- **修复见效后**：默认唤醒时，`state.mjs flight` 列出在途（已派单未合入）与待收尾（已合入未沉淀）两组；对在途的检查 MR 状态（经 `bytedcli-bits-mr`），已合入的用 `state.mjs merged --dir <state> --issue-id <id> --at <合入时间>` 记下。对已合入且未做过收尾沉淀的候选，`history` 的 `recovery.ratio` 非 null 且 ≤ 0.2 时沉淀「修复前量级 → 现在的量级、MR 链接、合入时间」，再 `state.mjs sedimented --dir <state> --issue-id <id>` 标记，避免重复。
- 量级对比按 `latest_present` 写：为 true 写「修复前 <baseline_count>（<baseline_at>）→ 当前 <latest_count>」；为 false 写「修复前 <baseline_count>（<baseline_at>）→ 已跌出近 24h Top<top>（低于 <latest_floor> 次）」。缺席不等于 0，沉淀文案里不出现「当前 0」。
- `recovery.latest_count` 已把挂在这单下的改名新族加总，文案改名不会被误判成回落。

这两次沉淀是默认唤醒与派单路径上仅有的外发动作；默认唤醒「零副作用」的表述相应改为「除修复见效沉淀外不产生外部副作用」。

## 8. 文件改动

| 文件 | 改动 |
|---|---|
| `SKILL.md` | frontmatter description、入口表、主流程第 3–5 步、派单第 1–2、7 步、纪律；新增「引导式收敛」一节 |
| `references/likelihood.md` | 改为「选取规则」：脚本预筛四条 + agent 验证三种结局 + 兜底 |
| `references/example-report.md` | 重写：三行呈现、一段收敛对话示例、技术方案回显、「没有新的可修告警」的一句话形态 |
| `references/task-book-template.md` | 第 0 节占位说明 |
| `scripts/state.mjs` | 新增 `merge`、`pick`、`cover`、`fix-paths`、`flight`、`history`、`merged`、`sedimented`；`dispatched` 增 `--fix-paths` |
| 本机 `state/`（不入 git） | 一次性回填：旧派单的 `fix_paths`、改名新族到旧单的 `covered_by`、用历史 `scan-*.json` 回填台账 |
| `tests/state.test.mjs` | 见第 9 节 |

`scan.mjs`、`dispatch.sh`、`progress.mjs`、`board.sh` 不动。

## 9. 测试

`tests/state.test.mjs` 增补：

- `pick`：`[warn]`、服务端错误码、豆包页面、`[native code]`、帧不在仓内各自被剔除并写入对应 likelihood；`detail_error` 非空的排到末尾；短名单按族用户数降序；`--skip` 生效。
- 在途覆盖：帧命中未合入单的 `fix_paths` → 进 `covered`；该单 `merged` 后同一候选回到 `shortlist`。
- `merge`：行为与现有 `mergeScan` 用例一致，且台账每族追加一行；重复执行只追加不改写。
- `history`：台账行按时间升序，处置事件齐全。
- `dispatched --fix-paths`、`merged`、`sedimented` 的状态写入。

## 10. 不做

- 不把选取分析隔离到子 agent：引导式提问需要主 agent 持有初步判断。
- 不做台账入 git 或写入 resume 仓库；本机台账 + 飞书沉淀两层已够。
- 不改 `--top`、`--hours`、`--bid` 的语义。
