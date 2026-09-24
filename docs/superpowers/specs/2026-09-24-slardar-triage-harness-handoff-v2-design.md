# slardar-triage 派单转交 byteview-web-harness 任务链，omh 固定跑 opus

日期：2026-09-24
状态：§4.1–4.3、4.5–4.7、§5.1–5.2（除模型相关步骤）、§5.3（除模型一条）已于 09-24 合入 main（`5161e18`）。待实施：§4.4 `task-model.mjs`、§5.2 第 9 步前缀与第 10 步核验、§5.3 模型纪律。团队侧另有 byteview-web MR 8461025 / byteview-pc MR 8461031 在 `omh.config.yaml` 顶层 `runtimes.claude.env.ANTHROPIC_MODEL: opus`（ClaudeAdapter 只注入 env，不读 model / extra_args；09-24 已用该配置真实起一个 omh 任务核实：本机 settings.json 为 fable、shell 无 ANTHROPIC_MODEL，ptd stage 进程 env 带 `ANTHROPIC_MODEL=opus`，events.jsonl 记录 model=`claude-opus-5-5`）；本技能的前缀与核验是它的兜底，不依赖它合入
取代：`2026-09-21-slardar-triage-harness-handoff-design.md`（那份基于 09-21 的 main；09-22 main 已删除在途跟踪、Meego 改建 story，且那份没有模型约束）。分支 `feat/slardar-triage-harness-handoff` 上的 `2ab58c9` 不合入，按本文在当前 main（`15d9c25`）上重做。

## 1. 背景

### 1.1 派单链重复

slardar-triage 只在 `byteview-web-harness` 仓内被调用。该仓 `AGENTS.md` 规定对 harness 以外任何 repo 的代码修改只能走 `task-schedule` + `workspace` → `task-execute` → `task-conclude` → `task-finish`。而 `dispatch.sh` 自己开 worktree（`~/Desktop/workspace/omh-runs/`）、自己 `omh-cli setup`、自己 `traecli exec` 起 omh、自己核验 runtime，是第二套派发链。派出去的任务不在 `workspaces/tasks/`，harness 看板看不到，不受 task-execute 心跳与 task-conclude 合入门禁约束。

### 1.2 omh 跑的模型不受控

omh 起每个 stage 的命令是 `claude --input-format stream-json …`，不带 `--model`，吃 `~/.claude/settings.json` 的 `model`。09-23 的 harness 任务 `task_20260923T035047Z_9a51ae23` 前两个 stage 跑 opus，settings.json 改成 `claude-fable-5-1[1m]` 之后的 20 个 stage 全部跑 fable（5,890 条 assistant 消息，其中 4 轮 code-review 每轮 700–850 条）。单句「ok」的实测成本：opus $0.0057，fable[1m] $0.39。

用户约束：slardar-triage 派出去的 omh 必须跑 opus；不能改 `~/.claude/settings.json`（影响其他 claude 会话），不能改 `byteview-web` 的 `omh.config.yaml`（团队配置）。

### 1.3 orchestrator 里可用的注入口（已读源码 0.1.105 核实）

| 路径 | 结论 |
|---|---|
| `OMH_CHAT_MODEL` → `Task.host.model` → `runtimes.claude.model` | 不通。ClaudeAdapter 主进程不读 `model` 字段，只有辅助会话（标题生成等）用它拼 `--model` |
| `runtimes.claude.extra_args` / `--config <平台配置 id>` | 改团队配置，或复制一份团队 workflow 到个人平台配置。否 |
| 环境变量 `ANTHROPIC_MODEL` | 通。`task-entry create` 以 `{...process.env}` 起 daemon，daemon 以 `buildStageEnv(…, process.env)` 起每个 stage，全程继承。实测 `ANTHROPIC_MODEL=opus` 压过 settings.json 的 fable，只作用于这一棵进程树 |

## 2. 已定决策

| 议题 | 决定 |
|---|---|
| omh 宿主 | 完全按 harness：主会话直接发起 `$oh-my-harness:omh-loop`，spawn monitor 陪跑。放弃 traecli 约束 |
| omh 模型 | 固定 opus。机制：本 Task 的 `task-entry create` 与之后每条 `orchestrator` / omh-resume 命令都以 `ANTHROPIC_MODEL=opus` 前缀执行；起单后核验第一个 stage 实际模型，不是 opus 系就 cancel 并回话题，不重试 |
| 看板 | 两边都登记：harness 看板由 `task.json` 自动可见；个人看板继续经 `board.sh`，ctx 放 `<state>/board/<slug>` |
| 接入点 | 从 `task-schedule` 接入。引导式收敛 = 澄清 + 方案，【技术方案】回显 +「派这条」= 批准，任务书 = `--approved-plan-file`。派单前用 `harness-context` 锚定 |
| 转交方式 | SKILL.md 文字转交 harness 仓的 skill；个人仓脚本不直调 harness CLI |
| 派后不跟踪 | 沿用 main 09-22 的口径：本技能不查阶段、不查 MR、不判修复见效。omh 的陪跑与阻塞上报是 harness task-execute 对当前会话的约束，不是本技能的功能 |

## 3. 职责划分

| 环节 | 归属 |
|---|---|
| 技术方案已回显、issue 为 pending 的核对 | slardar-triage |
| Meego 技术需求（story，经 bytedcli-meego 机械层） | slardar-triage `prepare-dispatch.sh` |
| 任务书渲染与首行三项校验（目标分支 master / `Meego:<url>` / MR 类型 feature） | slardar-triage `prepare-dispatch.sh` |
| 在途 Task 并发拦截（退出 3） | slardar-triage `prepare-dispatch.sh` |
| 上下文锚定 | harness `harness-context` |
| managed task、worktree、OMH 项目准备 | harness `task-schedule` + `workspace` |
| 起 omh、monitor、confirm / unblock、MR 回写、心跳 | harness `task-execute` |
| omh 模型注入与核验 | slardar-triage（SKILL.md 前缀纪律 + `task-model.mjs`） |
| 处置账落账、个人看板登记、飞书沉淀 | slardar-triage |
| 合入后的沉淀与回收 | harness `task-conclude` / `task-finish` |

## 4. 脚本改动（以当前 main 为基）

### 4.1 `dispatch.sh` → `prepare-dispatch.sh`

头注释：「派单准备单点：在途检查 → Meego → 任务书。工作区、起 omh 与收尾归 byteview-web-harness 任务链。」

- 保留：账本读写、步骤 0 在途检查（读处置账每条的 `task_id` + `workspace` 下 `.omh/tasks/<id>/meta.json` 的 `phase`，退出 3）、步骤 meego（`meego.sh create --repo $MEEGO_REPO`，不变）、步骤 task_book。
- 删除：步骤 worktree、launch、verify、board；退出码 4；参数 `--repo` / `--runs-root` / `--no-board`；`OMH_CLI` / `TRAECLI` / `ORCH` / `PNPM` / `THREADS_SH` / `WORKFLOW_WAIT_SECONDS` / `TASK_WAIT_SECONDS` / `WORKFLOW`。
- 任务书渲染到 `<state>/task-books/<slug>.md`。首行三项校验不变（`目标分支为 master`、`Meego:<meego_url>`、`MR 类型 feature`）。
- 幂等出口：`step_done task_book` 即返回 `reused:true`。
- 三处错误 JSON（未知参数、缺参数、`fail()`）用 `jq -cn --arg` 构造，值含引号也保持一行合法 JSON。
- stdout：`{ok:true, issue_id, step:"task_book", meego_url, task_book, reused}`；失败 `{ok:false, issue_id, step, error}`。退出码 0 / 3 / 1。

### 4.2 `state.mjs dispatched`

新增 `--task-slug`、`--workspace`（repo worktree 绝对路径）。`--task-id` 与 `--workspace` 缺任一即 `{ok:false,error}` 退出 1、不落盘——在途检查与 `board.sh` 都按这两项定位。写入 `dispatched.json[issue]` 的 `task_id` / `task_slug` / `workspace` / `dispatched_at`，保留已有字段。

### 4.3 `board.sh`

ctx 目录 `<state 绝对路径>/board/<slug>`：workspace 是 harness 托管的 worktree，`task-finish` 回收时整体删除，看板条目（含 Meego 绑定）要活到需求节点走完；ctx 也不该作为未跟踪目录出现在 omh 提交代码的 worktree 里。`meta.branch` 继续记会话 cwd 的当前分支；读不到时兜底 `feat-$slug`（workspace skill 的分支命名，story 用 feat 前缀）。头注释去掉「不是 traecli 宿主」。`meego_type=story` 不变。

### 4.4 新增 `task-model.mjs`

```
node <skill>/scripts/task-model.mjs --workspace <abs> --task-id <id> --expect opus [--wait <秒，默认 540>]
```

读 `<workspace>/.omh/tasks/<id>/sessions/*/stages/*/system/runtime/raw/events.jsonl`，取最早一条 `provider.event == "system/init"` 记录的 `provider.data.model`。`--expect opus` 对应正则 `^claude-opus-`（只认这一个族名；其它值报参数错）。在 `--wait` 秒内每 10 秒重读一次直到出现记录，最后一次睡眠截到 deadline，不越期；默认 540 秒——调用它的 Bash 工具单次上限 600 秒，脚本必须先于它退出。取到的参数值以 `--` 开头按缺失处理。

输出一行 JSON：`{ok:true, model, stage, matches}`；超时 `{ok:false, error:"…秒内未见 stage 启动记录"}` 退出 1。脚本只读不 cancel——cancel 是 SKILL.md 里 agent 的动作，便于单测与人工复核。

单测：fixture 放两个 stage 目录（`1-ptd` opus、`2-impl` fable），断言取最早的 `1-ptd`；无记录且 `--wait 0` 走超时；`--expect` 非 `opus` 报错。

### 4.5 删除

`launch-traex.sh`；`tests/stubs/` 下 `traecli`、`omh-cli`、`orchestrator`、`pnpm`、`git`、`bytedcli`（只被 test-dispatch.sh 引用）。保留 `meego.sh`、`threads.sh`。

### 4.6 `references/task-book-template.md`

首行改为 `交付说明:目标分支为 master(当前 worktree 的分支从 origin/master {{base_commit}} 切出,MR 合回 master)。Meego:{{meego_url}}。MR 类型 feature。`——harness 只建一条 `feat-<taskSlug>` 分支，没有 `omh-base/<slug>`。三个校验关键词不变。

### 4.7 不改

`scan.mjs`、`state.mjs` 其余子命令、`references/` 其余文件。

## 5. SKILL.md 改动

### 5.1 description 与开头

「经 traecli 起 omh」→「转交 byteview-web-harness 任务链修复（omh 固定跑 opus）」。开头补：派单在 `byteview-web-harness` 仓内进行，`<harness>` = 当前 cwd。

### 5.2 「派单」一节

保留开头关于 story 的说明段。步骤：

1. 无【技术方案】回显不派（不变）。
2. issue 为 pending 核对（不变）。
3. 派单前校验：`test -f skills/task-schedule/scripts/task-schedule.js`（不成立说明 cwd 不是 harness 仓，停）；`meego.sh map get --repo lark/byteview-web`（不变）；`command -v omh-cli orchestrator`。
4. 写任务书（不变）。
5. 写 Meego 描述（不变）。
6. 准备：`bash <skill>/scripts/prepare-dispatch.sh --state <state> --issue-id <id> --slug <kebab-摘要>-$(date +%F) --task-book <路径> --meego-desc <路径> --meego-name "<标题>" --slardar-url "<issue_url>"`。退出 3 转述在途单；退出 1 写停在哪步，下次「派这条」续做。
7. 锚定：按 `<harness>/skills/harness-context/SKILL.md` 存入 Slardar issue 链接、Meego 链接与【技术方案】原文。`--task-name` 用第 6 步的 slug，与第 8 步一致——`task-schedule create` 按同名 staging 自动 materialize，名字对不上会被静默跳过。
8. 建任务：按 `<harness>/skills/task-schedule/SKILL.md`。`--task-name` 用 slug、`--branch-prefix feat`、`--repos byteview-web`、`--approved-plan-file` 用第 6 步的 `task_book`、`--goal-summary` 用现象一句话；thread 参数按该 skill 规则取。`workspaces/tasks/<slug>` 已存在（上次因模型核验 cancel 后续派）则跳过本步。
9. 执行：按 `<harness>/skills/task-execute/SKILL.md`。**本 Task 起始到终态之间，每一条运行 omh-loop / stage-monitor / omh-resume 脚本（`task-entry.mjs`、`flow-state.mjs`、各 `submit-*.mjs`、`task watch`）或 `orchestrator` 的 Bash 调用，都以 `ANTHROPIC_MODEL=opus` 为前缀**——runtime daemon 由第一条命令起，之后任何一条命令发现 daemon 死了都会用自己的 env 重新拉起（orchestrator 0.1.105 `sendToRuntime`）；omh 起的每个 stage 从这棵进程树继承模型；只改这一棵树，不动 settings.json 与团队配置。omh-loop handoff 的 `<stage_goal>` 写明：workflow 用 `pc-web-bugfix`；任务书即已批准方案，无需再 plan；Meego 已提供（任务书首行）；以上前缀规则。
10. 核验模型：omh-loop 走到 `next_action === "handoff_monitor"` 时——最后一次 submit 之后、调用 stage-monitor 之前（stage 在此之后才起，早跑必超时）——执行 `node <skill>/scripts/task-model.mjs --workspace <worktree 绝对路径> --task-id <task_id> --expect opus`（Bash 工具 `timeout: 600000`）。`matches:false`、超时或无输出 → `ANTHROPIC_MODEL=opus orchestrator task cancel --task-id <task_id>`（worktree 内），读 `meta.json` 确认 `phase=cancelled`（最多 60 秒；否则报「Task 仍在跑」并停——在途检查只认处置账，一个没落账又没 cancel 成的 Task 会被下次派单撞上），再按 task-schedule 置 `blocked`（原因写实际模型），回话题说明并停；不写处置账，issue 保持 pending。续派：先确认 worktree 干净（否则 checkout + clean），执行第 6 步（复用 Meego 与任务书）后直接到第 9 步；第 7、8 步不重做。
11. 第 10 步通过后立即落账并登记个人看板：`node <skill>/scripts/state.mjs dispatched --dir <state> --issue-id <id> --task-id <task_id> --task-slug <taskSlug> --workspace <worktree 绝对路径> --supplement "<技术方案原文>" --fix-paths <a,b>`，随后 `bash <skill>/scripts/board.sh --state <state> --issue-id <id>`。`--workspace` = `<harness>/` 接 create 输出的 `repos[].path`。
12. 经 lark-sediment 沉淀（不变，补 taskSlug）。
13. 回话题：Issue 一句话、Meego 链接、taskSlug、Task ID、worktree、实际模型、个人看板登记结果。叫停：worktree 内 `orchestrator task cancel --task-id <id>`（orchestrator 0.1.105 的子命令是 `task cancel`，没有 `task-cancel`），再按 task-schedule 置 `cancelled_pending_confirmation`。派单后本技能不再跟进；陪跑与阻塞上报按 task-execute。

### 5.3 纪律

- 删「omh 永远经 `traecli exec` 起」。
- 加「派单只经 byteview-web-harness 任务链；本技能不开 worktree、不起 omh」。
- 加「slardar-triage 派的 omh 固定跑 opus：`ANTHROPIC_MODEL=opus` 前缀覆盖本 Task 全部 `task-entry` / `orchestrator` / omh-resume 命令，起单后经 `task-model.mjs` 核验，不符即 cancel。不改 `~/.claude/settings.json`，不改 `byteview-web` 的 `omh.config.yaml`」。
- 看板一条：补「ctx 在 `<state>/board/<slug>`，不随 harness 回收 worktree 而消失」。

## 6. 测试

- `tests/test-dispatch.sh` → `tests/test-prepare-dispatch.sh`：meego 步骤建单并落账、重跑不重复建单且 `reused:true`、任务书首行三项各缺一项失败在 `task_book`、在途单退出 3 / 到终态放行、断点续跑只补任务书、`issue_id` 含引号时输出仍是合法 JSON、缺参数报错。stub 只留 `meego.sh`。
- `tests/test-board.sh`（新）：ctx 落 `<state>/board/<slug>` 且不往 worktree 写；相对 `--state` 时 `ctx_dir` 为绝对路径；补登记回填 mr_id 保留既有字段；cwd 非 git 仓时 branch 兜底 `feat-<slug>`；threads.sh 缺失 ok=false 且不写 steps.board；处置账缺 workspace 拒绝。
- `tests/state.test.mjs`：`dispatched` 带 `--task-slug --workspace` 落账且保留已有字段；缺 `--task-id` 或 `--workspace` 退出 1 不落盘。
- `tests/task-model.test.mjs`（新）：见 §4.4。
- harness 链本身不在个人仓测。

## 7. 首次真实派单核对

- `orchestrator task-get` 的 `extras.platform_workflow_key == pc-web-bugfix`（workflow 只靠 `<stage_goal>` 文字选中）。
- omh 是否在已批准任务书上又跑了 plan（`--no-plan` 只是 `<stage_goal>` 文字）。
- `task-model.mjs` 报的 model 为 `claude-opus-*`，且 3 小时后任一 stage 的 `events.jsonl` 仍是 opus（daemon 未被无前缀的命令重起）。

## 8. 不在范围

- 09-23 那条 `task_20260923T035047Z_9a51ae23` 的处置。
- harness 仓与 byteview-web / byteview-pc 仓的任何修改。
- 把模型做成可配置参数：固定 opus，改就改 SKILL.md 那一处。
