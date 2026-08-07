# harness-ceilf6-bot 控制面（刹车）与看板线程管理 设计

- 日期：2026-08-05
- 状态：已与用户逐条确认（刹车通道 / 准入规则不动 / 本轮含看板 / 停止≠隐藏）
- 本文档按用户偏好只落盘，不提交 git。

## 背景

2026-08-05 事故：用户在任务话题内回复「@harness-ceilf6 这个需求先在计划门节点暂停，等待指示」，bot 未停——该消息按现行设计只写进 `context/`（供下次续入），**不喂给正在跑的会话**。会话照常过计划门、开发、提交、跑了五轮机审 CR。同期另有两个同集群任务在跑，其中 becfb5 是话题内补充消息抢在 worktree 就绪前到达、退化成的独立任务。

止血靠人工：外部 `kill -TERM -<pgid>`、手改 `awaiting.jsonl`、手打表情、`launchctl unload` 停机。

**根因**：bot 没有任何刹车。群话题回复只存不喂；私信通道只服务「bot 提问 → 用户回答」，用户无法主动发起控制；看板只有节点推进/回退，没有运行态管理。

## 目标

- 任何时刻能立即叫停一个正在跑的任务，**不依赖会话轮次边界**（长轮次如全量测试、机审 CR 期间按下的停必须立刻生效）。
- 停止/暂停两种语义分开：停止=作废，暂停=可续跑。
- IM 与看板共用同一套停止能力，语义与终态一致。
- 看板能管理线程的显示与生命周期（停止 / 归档 / 清理）。

## 非目标

- **准入规则不动**（用户裁定）：仍是「群里发消息即任务」，不改 @ 点名才跑，不加话题静音、不加全局暂停接单开关。误起的任务靠主动 `/stop` 收拾。
- **话题回复仍只存不喂**：刹车由 listener 层解决，不推翻 2026-08-04 的「只存不喂」裁定；自然语言「暂停」不再被期待生效（文档需明写）。
- 不做多用户鉴权：控制端口绑 127.0.0.1，沿用 ht web 既有的本机单用户安全姿态。

## 1. 停止与暂停的语义

`stop` 按任务当前状态分三种处置，统一收敛到新终态 `stopped`：

| 任务状态 | 处置 | 群消息表情 |
|---|---|---|
| 活跃轮次中 | 杀进程组（连同会话自布的后台任务，如 pre-commit 钩子、traex 机审——实测同组随杀） | 👍 → 🛑 |
| 挂起等回复 | 杀保活进程 + 删 awaiting 条目 | ⚠️ → 🛑 |
| 排队中（未起进程） | 出队 | 无 → 🛑 |

`pause` 只作用于活跃/挂起任务（对排队中任务返回错误并提示改用 `/stop`——尚未起进程，无可暂停之物）：杀进程但**保留（或补写）awaiting 条目**（`waiting:true`，question 记为「人工暂停，回复即续跑」），表情落 ⚠️。用户之后私信回复即走既有懒续跑（`--resume`）继续——claude 会话历史在盘上，已执行的工具副作用留在 worktree，恢复无损。

两者共同点：**现场（worktree / 分支 / 提交）一律保留**，私信回执带 worktree 路径与手工接管命令。

新增 `reactions.stopped` 配置键，**不复用 `failed`**——「人工叫停」与「跑挂了」是不同事件，混用会让群里的历史无法区分。出厂值暂定 `"Mute"`，真机验收第 1 条确认；键名不被平台接受时按 runbook 既有做法照 API 报错提示改 config，无需改码。

`stopped` 是 RESULT 契约之外的**编排器终态**——会话不产出该 verdict，`result.mjs` 的 VERDICTS 不变；`runTask` 的 promise 以 `verdict: 'stopped'` resolve，listener 的 settleTask 照常 `dropAwaiting`，且**不注销线程登记**（仅 skip 注销的既有规则不变）。

## 2. 控制通道

### 2.1 bot 本地控制端口（IM 与看板的唯一停止入口）

新增 `src/control.mjs`：一个绑 127.0.0.1 的 node http server，由 listener 在启动时拉起，端口取 `config.controlPort`（默认 7659，避开 ht web 的 7657）。

```
GET  /api/tasks   → {tasks:[{messageId, short, title, branch, worktree, state, startedAt, sessionId}]}
POST /api/stop    → {messageId} | {short} | {index}  → {ok, was, title}
POST /api/pause   → 同上入参 → {ok, was, title}
```

`state ∈ active | waiting | queued`。`short` = messageId 后 6 位（人可读定位符）。`index` 为按 `startedAt` 升序的 1 基序号，与 `/api/tasks` 当轮输出一致。

端口占用时 listener **响亮失败并退出**（与既有 config 校验同姿态）——静默降级会让看板的停止按钮一直连不上却无从排查。

### 2.2 分层与真源

- `runner.mjs` 拥有进程与轮次状态（`liveTasks`），新增导出：
  - `taskSnapshot()` → 活表内每个任务的 `{messageId, title, branch, worktree, state, startedAt, sessionId}`（`state` 取内存态，非 store）。
  - `stopLive(messageId, mode)` → `mode ∈ 'stop' | 'pause'`；命中活表则杀进程组并按模式收敛（stop 走新终态、pause 只杀进程不终态），返回处置前的状态；未命中返回 null。
- `listener.mjs` 拥有 store 与编排，新增 `controlStop(target, mode)`：依次尝试活表（`stopLive`）→ awaiting 条目（bot 重启后无进程的残留等待态：删条目 / 保留条目 + 换表情 + 私信回执）→ 队列（出队）。三处都未命中返回未找到。控制端口的 handler 只调它。

「bot 重启后无进程的残留等待态」正是本次人工处置的场景，必须由代码覆盖。

### 2.3 IM 侧拦截

控制命令**不进会话**，由 listener 在分发早期拦截：

- **话题内回复**：文本以 `/stop`、`/pause` 开头 → 对该话题登记的任务执行，**不写 context 条目、不打 📝**。话题无登记任务、或该任务已到终态时私信告知（不在群里回文字）。
- **私信**：`handleDm` 在既有「路由到等待任务」之前先解析控制命令——`/stop` 必须能作用于**活跃**任务，而活跃任务不在 `listWaiting()` 里。
  - `/tasks` → 私信当前列表（序号、short、状态、标题、分支、已跑时长）。
  - `/stop` / `/pause` 无参：**在册任务**（active + waiting + queued 三类合计）恰有一个时作用于它；多个则回列表并提示带序号或 short；零个时告知无任务在册。
  - `/stop <序号|short>` → 精确作用。回执**回显标题**，误指可立即看出。

`commands.mjs` 扩展为两类命令：`COMMANDS`（既有 `/model` `/effort`，转成续跑 spawn 参数）与 `CONTROL`（`/stop` `/pause` `/tasks`，由 listener 执行）。`parseDmReply` 返回增加 `control: [{name, arg}]`；控制命令与正文/参数命令**互斥**——一条消息含控制命令时，其余部分不注入会话，回执说明。

群消息侧仍**零文字消息**：`/stop` 的确认由目标任务消息上的表情变为 🛑 承载，失败或需要澄清时才走私信。

## 3. 看板（harness-ceilf6）

### 3.1 三个动作，各自独立

- **停止**：`POST /api/stop` 转调 bot 控制端口。线程**留在板上**，标灰显示「已停」，卡片上直接出「归档」「清理」两个后续按钮。
- **归档**：`meta.json` 写 `archived: true`。默认视图不显示，顶部「显示已归档」开关可看回来。**不删任何文件**——这是用户要的「不显示」。
- **清理**：删 worktree + 分支（复用 runner 既有的「删目录 → `worktree prune` → `branch -D`」三步秒级清理逻辑），需二次确认。清理后线程从盘上消失。

停止与归档正交：可以停而不归档（想稍后手工续跑），也可以归档一个已完成的线程（板面清爽）。

### 3.2 运行态与 bot 的解耦

`threads.sh` 保持 bot 无关（它服务所有 harness 线程，含用户手工跑的），新增：
- `archive --ctx-dir <路径>` / `unarchive --ctx-dir <路径>`（jq 写 `archived` 字段，与 `set-node` 同一写入纪律）；
- `list --json` 输出增加 `archived` 字段；默认视图过滤掉 `archived`，`--all` 或 `--include-archived` 包含。

`web.py` 负责合并运行态：`GET /api/running` 代理 bot 控制端口的 `/api/tasks`，按 worktree 路径匹配到线程卡片上打「运行中/挂起」徽标。**bot 离线时静默降级**——只显示静态节点进度，不报错、停止按钮置灰并提示「bot 未运行」（离线时本就无任务在跑，逻辑自洽）。bot 控制端口地址取 `HARNESS_BOT_CONTROL` 环境变量，默认 `http://127.0.0.1:7659`。

## 4. 配置

- bot `config.json` 新增：`controlPort`（正整数，默认 7659）、`reactions.stopped`（非空字符串）。两者进 `validateConfig` 校验清单。
- `install.sh` 无需改动（端口不需要额外依赖检查）。

## 5. 已知边界与接受项

- **awaiting 的 `waiting` 标志在自唤醒后不更新**（会话自布的后台任务完成触发新轮次时，内存态转 active 而 store 仍是 `waiting:true`）。不修：`/tasks` 与看板徽标读内存真源不受影响；DM 直发路由到该任务会把消息排进 stdin 作为补充输入，是期望行为；bot 重启后无进程时 `waiting:true` 恰是正确的可续跑态。
- 停止一个任务不影响同话题的其他任务，也不阻止该话题**后续新消息**再起任务（准入规则不动，用户裁定）。
- 控制命令无撤销：`/stop` 后要恢复只能手工 `cd <worktree> && claude` 或在群里重发任务。回执里给出前者的命令原文。
- 看板的「清理」删分支与 worktree，不删 claude 会话历史（`~/.claude/projects/` 下），也不撤群里的表情。

## 6. 测试与验收

单测（沿用 `node --test` + stub 体系）：

- `control`：三个端点的正常与异常（未知 messageId → 404、坏 JSON → 400、端口占用启动失败）；
- `commands`：控制命令解析（`/stop` 带/不带参、与正文互斥、未知命令仍走既有拒绝路径）；
- `runner`：`stopLive` 对 active/waiting 两态的处置差异、`stopped` 终态的表情键与私信内容、promise 以 `verdict:'stopped'` resolve、`pause` 后 awaiting 条目仍可懒续跑；
- `listener`：话题 `/stop` 被拦截（不写 context、不打 📝）、私信 `/stop` 作用于**活跃**任务（不在 listWaiting 时也能命中）、0/1/N 任务的提示、`/tasks` 输出、bot 重启后残留等待态的停止路径；
- `threads.sh`：archive/unarchive 幂等、`list --json` 的 `archived` 字段、默认视图过滤；
- `web.py`：stop 代理、archive、clean 三个端点；bot 离线时 `/api/running` 降级不报错。

真机验收：

1. 群里发一条任务 → 话题内回 `/stop` → 群消息表情变 🛑、进程消失（`pgrep` 确认）、私信回执含 worktree 路径；
2. 同时跑两个任务 → 私信 `/tasks` 见列表 → `/stop` 无参得到「请带序号」提示 → `/stop 2` 精确停掉第二个，回执标题正确；
3. `/pause` 一个活跃任务 → 表情 ⚠️ → 私信回一句 → 懒续跑继续到终态；
4. 看板：运行中徽标出现 → 点停止 → 卡片转「已停」→ 点归档消失 → 开「显示已归档」看回来 → 点清理二次确认后 worktree 与分支消失；
5. `launchctl unload` 停 bot → 看板停止按钮置灰、页面其余部分正常渲染。

## 涉及文件

- `harness-ceilf6-bot/src/control.mjs`（新）、`src/runner.mjs`、`src/listener.mjs`、`src/commands.mjs`、`config.json`
- `harness-ceilf6-bot/tests/*`（含新 `control.test.mjs`）
- `harness-ceilf6-bot/runbook.md`（控制命令速查、停止/暂停语义、新表情键、端口）
- `harness-ceilf6/scripts/threads.sh`、`harness-ceilf6/scripts/web.py`、`harness-ceilf6/SKILL.md`（看板动作说明）
