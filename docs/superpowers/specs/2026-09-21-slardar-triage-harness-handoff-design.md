# slardar-triage 派单转交 byteview-web-harness 任务链

日期：2026-09-21
状态：已被 `2026-09-24-slardar-triage-harness-handoff-v2-design.md` 取代（main 于 09-22 删除在途跟踪并改建 story，本文的 §4.5 与在途相关内容不再成立；模型约束在新文里）
取代：`2026-09-08-slardar-triage` 系列里「派单机械层」中 worktree、起 omh、核验 runtime、停摆恢复四部分，以及纪律「omh 永远经 `traecli exec` 起」。扫描、候选池、预筛、呈现、引导式收敛、Meego 字段映射、任务书模板、处置账与量级台账不变。

## 1. 背景与目标

slardar-triage 只在 `byteview-web-harness` 仓内被调用。该仓 `AGENTS.md` 规定：对 harness 以外任何 repo 的代码修改只能走 `task-schedule` + `workspace` → `task-execute` → `task-conclude` → `task-finish`。而 slardar-triage 的 `dispatch.sh` 自己开 worktree（`~/Desktop/workspace/omh-runs/`）、自己 `omh-cli setup`、自己 `traecli exec` 起 omh、自己核验 runtime，等于在个人仓里维护了第二套派发链。后果：

- 派出去的任务不在 `workspaces/tasks/`，`task-schedule list` 与 harness 看板看不到，不受 task-execute 心跳与 task-conclude 合入门禁约束。
- 第二套链有自己的缺陷面：setup 失败仍起 exec 得到空会话、verify 在 `platform_workflow_key` 写入前比对而误 cancel。这些都发生在与 harness 重复的那一段。

目标：slardar-triage 只保留 Slardar 特有的部分，派单从 harness 链的 `task-schedule` 一步接入，其后完全按 harness 仓的 skill 执行。

## 2. 已定决策

| 议题 | 决定 |
|---|---|
| omh 宿主 runtime | 完全按 harness：主会话直接发起 `$oh-my-harness:omh-loop`，spawn monitor subagent 陪跑。放弃 traecli 约束与 runtime 核验。技能里不写模型约束（由 botmux bot 配置决定）。 |
| 看板 | 两边都登记：harness 看板由 `task.json` 自动可见；harness-ceilf6 个人看板继续经 `board.sh` 登记。 |
| 接入点 | 从 `task-schedule` 接入。引导式收敛 = 澄清 + 方案，【技术方案】回显 +「派这条」= 用户批准，任务书 = `--approved-plan-file`。派单前用 `harness-context` 把 Slardar issue 与技术方案锚定一笔。 |
| 转交方式 | SKILL.md 文字转交：指示 agent 照 harness 仓 `skills/task-schedule/SKILL.md`、`skills/task-execute/SKILL.md` 原文执行。脚本不直调 harness CLI，个人仓不复制其参数形状。 |

## 3. 职责划分

| 环节 | 归属 |
|---|---|
| 技术方案已回显、issue 为 pending 的核对 | slardar-triage |
| Meego 缺陷单（模板、业务线、端、发现版本、经办人） | slardar-triage `prepare-dispatch.sh` |
| 任务书渲染与首行三项校验（目标分支 master / Meego URL / MR 类型 bug） | slardar-triage `prepare-dispatch.sh` |
| 在途 Task 并发拦截 | slardar-triage `prepare-dispatch.sh` |
| 上下文锚定 | harness `harness-context` |
| managed task、worktree、OMH 项目准备 | harness `task-schedule` + `workspace` |
| 依赖安装等执行前提 | harness `task-execute`（「缺少执行前提」口径） |
| 起 omh、monitor、confirm / unblock、MR 回写 `artifacts.json`、心跳 | harness `task-execute` |
| 处置账落账、个人看板登记、飞书沉淀 | slardar-triage |
| 合入后的知识沉淀与回收 | harness `task-conclude` / `task-finish` |
| 量级回落沉淀 | slardar-triage（主流程第 4 步，不变） |

## 4. 脚本改动

### 4.1 `dispatch.sh` → `prepare-dispatch.sh`

改名，因为它不再派发。头注释改为「派单准备单点：在途检查 → Meego → 任务书」。

- 保留：参数解析、账本读写（`get` / `set_` / `step_done` / `fail`）、步骤 0 在途检查（退出 3）、步骤 meego、步骤 task_book。
- 删除：步骤 worktree（含 `pnpm install` 与依赖完整性检查）、步骤 launch、步骤 verify、步骤 board、退出码 4、参数 `--repo` / `--runs-root` / `--no-board`、环境变量 `OMH_CLI` / `TRAECLI` / `ORCH` / `PNPM` / `THREADS_SH` / `WORKFLOW_WAIT_SECONDS` / `TASK_WAIT_SECONDS`、常量 `WORKFLOW`。`--slardar-url` 保留（写入处置账，供 `board.sh` 读）。
- 渲染后的任务书写到 `<state>/task-books/<slug>.md`（原先写在 `omh-runs/tasks/`，该目录不再存在）。
- 幂等出口由 `step_done verify` 改为 `step_done task_book`。
- stdout：`{ok, issue_id, step:"task_book", meego_url, task_book, reused?}`。退出码：0 成功，3 有未到终态的单，1 其他。

在途检查按处置账里每条的 `task_id` + `workspace` 读 `<workspace>/.omh/tasks/<task_id>/meta.json`，与路径无关，不改。

### 4.2 `state.mjs dispatched`

新增 `--task-slug`、`--workspace`，与 `--task-id` 一并写入 `dispatched.json[issue]`（`task_slug` / `workspace` / `task_id` / `dispatched_at`）。`--workspace` 是 repo worktree 绝对路径（`<harness>/workspaces/tasks/<taskSlug>/byteview-web`）。`--task-id` 与 `--workspace` 缺任一即报错——`progress.mjs`、在途检查、`board.sh` 都按这两项定位 omh Task，缺了这条单会静默查不到。

### 4.3 `board.sh`

由 SKILL.md 在落账之后单独调用。看板 ctx 目录放在 `<state 绝对路径>/board/<slug>`，不放在 workspace 内：workspace 是 harness 托管的 worktree，`task-finish` 回收时整体删除，而看板条目（含 Meego 绑定）要活到缺陷流转完成；ctx 也不应作为未跟踪目录出现在 omh 提交代码的 worktree 里。`board.sh` 把 `ctx_dir` 记进处置账的 `board` 字段，`progress.mjs` 回填 mr_id 时以它为准，没有这条记录的历史单回落到 `<workspace>/.harness-ceilf6/<slug>`。`meta.branch` 继续记会话 cwd（harness 仓）的当前分支——threads.sh 唤回时发现 cwd 分支与 `meta.branch` 不一致会插一句 `git checkout`，而任务分支只存在于 worktree。两处跟随调整：头注释去掉「不是 traecli 宿主」的对照说法；读不到 cwd 分支时的兜底值由 `omh-base/$slug` 改为 `fix-$slug`（workspace skill 的分支命名）。

### 4.4 删除

`launch-traex.sh`、`resume-traex.sh`，以及 `tests/stubs/` 下的 `traecli`、`omh-cli`、`orchestrator`、`pnpm`、`git`。

### 4.5 `progress.mjs`

删除 `host_alive`（`pgrep -f 'traecli exec'`）：宿主是陪跑的主会话，进程探测没有意义，任务是否在推进看输出里的 `phase`。输出多带一个 `task_slug`（处置账有则给，无则 null）。其余不改——它按处置账的 `workspace` 读 `.omh/tasks/<tid>`，路径无关，`omh-runs/` 下的历史在途单照常可查，不迁移。

### 4.6 不改

`scan.mjs`、`state.mjs` 其余子命令（仅第 3 行头注释里的 `dispatch.sh` 跟随改名）。

### 4.7 `references/task-book-template.md`

首行的分支说明改为「当前 worktree 的分支从 origin/master {{base_commit}} 切出,MR 合回 master」：harness 的 workspace skill 只建一条 `fix-<taskSlug>` 分支，没有 `omh-base/<slug>` 基线分支。任务书会成为 `TASK.md` 的 Approved Plan 并被 omh-loop 原样读取，首行还是 `prepare-dispatch.sh` 校验的那一行。三个校验关键词保持不变。`references/` 其余不动。

## 5. SKILL.md 改动

### 5.1 description 与开头

description 中「才建 Meego、经 traecli 起 omh、登记看板」改为「才建 Meego、转交 byteview-web-harness 任务链、登记看板」。开头一段补一句：派单须在 `byteview-web-harness` 仓内进行，`<harness>` = 当前 cwd。

### 5.2 「派单」一节

1. 本会话没有回显过【技术方案】：不派（不变）。
2. 核对 issue 为 pending（不变）。
3. 派单前校验：`test -f skills/task-schedule/scripts/task-schedule.js`（不在 harness 仓则停，回话题说明）；Meego 用户校验（不变）。去掉 `command -v traecli omh-cli orchestrator`。
4. 写任务书（不变）。
5. 写 Meego 描述文件（不变）。
6. 准备：
   ```bash
   bash <skill>/scripts/prepare-dispatch.sh --state <state> --issue-id <id> --slug <kebab-摘要>-$(date +%F) --task-book <任务书路径> --meego-desc <描述文件> --meego-name "<Meego 标题>" --os <os_dist 主项> --release <release_dist 主项> --slardar-url "<issue_url>"
   ```
   退出 3：有在跑的单，附其进展；退出 1：写停在哪一步，下次「派这条」续做。
7. 锚定：按 `<harness>/skills/harness-context/SKILL.md` 把 Slardar issue 链接、Meego 链接与【技术方案】原文存入 context store。`--task-name` 用第 6 步的 slug，与第 8 步一致——`task-schedule create` 按同名 staging 自动 materialize，名字对不上会被静默跳过。
8. 建任务：按 `<harness>/skills/task-schedule/SKILL.md`「创建任务」执行，`--task-name` 用第 6 步的 slug、`--branch-prefix fix`、`--repos byteview-web`、`--approved-plan-file` 用第 6 步输出的 `task_book`、`--goal-summary` 用现象一句话；thread 参数按该 skill 的规则取。
9. 执行：按 `<harness>/skills/task-execute/SKILL.md` 执行。渲染 omh-loop handoff 时，`<stage_goal>` 写明：workflow 用 `pc-web-bugfix`；任务书即已批准方案，不再 plan；Meego 已提供（任务书首行）。
10. omh-loop 建单返回 `task_id` 后立即落账并登记个人看板（在 spawn monitor 之前，不等终态——处置账记录是拦住并发第二单的依据；`task_id` 不是 monitor 用的 session id；`--workspace` = `<harness>/` + create 输出的 `repos[].path`）：
    ```bash
    node <skill>/scripts/state.mjs dispatched --dir <state> --issue-id <id> --task-id <task_id> --task-slug <taskSlug> --workspace <repo worktree 绝对路径> --supplement "<技术方案原文>" --fix-paths <a,b>
    bash <skill>/scripts/board.sh --state <state> --issue-id <id>
    ```
11. 经 lark-sediment 沉淀（不变，补 taskSlug）。
12. 回话题：Issue 一句话、Meego 链接、taskSlug、Task ID、worktree、个人看板登记结果、主会话陪跑中。叫停：在 worktree 内 `orchestrator task-cancel --task-id <id>`，再按 task-schedule 把任务置为 `cancelled_pending_confirmation`。

第 9 步起主会话受 task-execute 约束：confirm / unblock 由主会话答，阻塞即时上报，不再有「派完即走」。

### 5.3 主流程第 4 步

`in_flight` 里已合入的单，执行 `state.mjs merged` 之后补一句：该单的 managed task 按 harness 走 `task-conclude`，用户确认后 `task-finish` 回收。处置账里没有 `task_slug` 的历史单（`omh-runs/` 下）跳过这一句。

### 5.4 纪律

- 删：「omh 永远经 `traecli exec` 起（dispatch.sh 内置）」。
- 删：`resume-traex.sh` 停摆恢复一条，改为「停摆恢复按 `<harness>/skills/task-execute/SKILL.md` 与 `oh-my-harness:omh-resume`」。
- 加：「派单只经 harness 任务链；本技能不开 worktree、不起 omh。」
- 看板一条里的「登记的是调用本技能的 claude 线程」保留。

## 6. 测试

- `tests/test-dispatch.sh` 改名 `tests/test-prepare-dispatch.sh`，用例收缩为：meego 步骤建单并落账；重跑不重复建单；任务书首行三项各缺一项时失败；处置账里有未到终态 Task 时退出 3；`step_done task_book` 后重跑直接返回 `reused`。只保留 `bytedcli` stub。
- `tests/state.test.mjs` 补：`dispatched` 带 `--task-slug --workspace` 时三者落入 `dispatched.json`；缺 `--workspace` 报错。
- `tests/progress.test.mjs`：输出不含 `host_alive`，含 `task_slug`。
- `tests/run.sh` 跟随文件名调整。
- harness 链本身不在个人仓测。

## 7. 风险与首次实跑核对

- harness 的 omh-loop handoff 模板没有 workflow 参数；`pc-web-bugfix` 能否仅凭 `<stage_goal>` 的文字被选中，首次真实派单时核对 `orchestrator task-get` 的 `platform_workflow_key`。选不中则回来在第 9 步补更明确的写法，不在本次预先加机制。
- 同理，原先以 CLI 参数强制的 `--no-plan` 也变成了 `<stage_goal>` 里的文字（`--no-meego` 另有 harness handoff 模板的「不补」规则兜底，`--no-plan` 没有）；首次实跑同时核对 omh 是否在已批准任务书之上又跑了一轮 plan。
- 主会话陪跑约 3 小时，会话成本由 bot 所用模型决定，属已知取舍。

## 8. 不在范围

- 今天已在 `omh-runs/` 下跑着的 `task_20260921T101716Z_5d8f0631` 如何处置。
- harness 仓任何 skill 或脚本的修改。
- 把 slardar-triage 迁入 harness 仓。
