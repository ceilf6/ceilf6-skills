# slardar-triage 派单登记到 harness 看板

日期：2026-09-09
状态：已口头认可，待实施

## 1. 目标

slardar-triage 每派出一条 omh 任务，就在 harness-ceilf6 的本地看板（`ht web`）上登记一张卡，卡上的启动命令是**调用 slardar-triage 的 claude 线程**的唤回命令（`cd <会话 cwd> && claude --dangerously-skip-permissions --resume <session_id>`），供用户复制后恢复那条线程。不登记 traecli 宿主，不推进节点，不走机审 / 建 MR 等后续流程。

## 2. 看板机制（现状，不改）

- 登记单点 `~/.claude/skills/harness-ceilf6/scripts/threads.sh register --ctx-dir <ctx> [--title <短题>] [--session-id <id>]`。
- 登记表 `~/.harness-ceilf6/threads.jsonl` 存 ctx_dir / cwd / branch / session_id / title / registered_at；cwd 取 register 进程的 `pwd -P`，session_id 取 `CLAUDE_CODE_SESSION_ID`（取不到记 null，唤回退化为新会话续入）。
- register 要求 `<ctx>/meta.json` 存在且含 `branch`；看板从 meta 读 `status`、`milestones`、`archived`、`note`、`mr_id`。
- 唤回命令由 cwd + session_id 拼成，`claude --resume` 严格按 cwd 判定作用域，register 必须在会话自身 cwd 下执行。

## 3. 设计

### 3.1 登记时机

只在 `dispatch.sh` 第 5 步（任务目录出现、runtime 核验通过）之后登记；纯扫描、只报告、派发中途失败都不登记。一张卡对应一条 omh 任务；同一 claude 线程派多条就有多张卡，session_id 相同、ctx 各异。

### 3.2 登记方式

`dispatch.sh` 新增步骤 6「登记看板」，在第 5 步 verify 落账后执行：

1. ctx 目录 `<workspace>/.harness-ceilf6/<slug>/`，写 `meta.json`：
   ```json
   {"branch":"omh-base/<slug>","status":"active","note":"Meego <meego_url> · Task <task_id>","milestones":{}}
   ```
   不写任何里程碑键，卡片停在「计划门」未完成态。
2. 在**当前进程 cwd**（即调用 dispatch.sh 的会话目录，脚本内所有 `cd` 都在子壳中）执行：
   ```bash
   bash "$THREADS_SH" register --ctx-dir "<ctx>" --title "<meego_name>"
   ```
   `THREADS_SH` 默认 `$HOME/.claude/skills/harness-ceilf6/scripts/threads.sh`，env 可覆盖（测试注入 stub）。
3. 结果写入 `dispatched.json[issue].board = {ok, ctx_dir, error}`，`steps.board = done`（成功）或不写（失败，下次续跑重试登记但不重做前五步）。
4. stdout JSON 增加 `board` 字段。

`--no-board` 参数跳过本步。

### 3.3 失败处理

- `THREADS_SH` 不存在、缺 jq、register 非零退出：`board.ok=false` 并带 stderr 摘要，派发结果不受影响，退出码仍为 0。
- `CLAUDE_CODE_SESSION_ID` 为空：照常登记（threads.sh 记 null），`board.warning = "无 session_id，唤回将退化为新会话续入"`。

### 3.4 SKILL.md 与报告

- 报告第 1 块「本次派发」加一行：`看板：已登记（ht web 可复制启动命令）` 或 `看板：登记失败 <原因>`。
- 纪律段加一条：登记的是本会话（调用 slardar-triage 的 claude 线程），dispatch.sh 必须在会话 cwd 下调用，不要先 `cd` 进工作区再调。

## 4. 测试

- `tests/stubs/threads.sh`：记录调用参数与 `$PWD` 到 `$STUB_STATE/calls`，校验 `--ctx-dir` 下 meta.json 存在且 `branch` 匹配，输出「已登记」。
- `test-dispatch.sh` 新增：
  - case 1 断言 `board.ok=true`、stub 记录的 PWD 等于测试进程 cwd、meta.json 的 branch / status / note 正确；
  - case 6：`THREADS_SH` 指向不存在路径时退出 0 且 `board.ok=false`；
  - case 7：`--no-board` 时 calls 无 register。
- 集成：对一条真实派发（或用 `--no-board` 之外的 dry 方式）登记后 `ht` 列表可见，`ht clean --ctx-dir <ctx>` 清理。

## 5. 范围外

- 不改 threads.sh / web.py / board/index.html。
- 不在卡片上 mark 任何节点，不挂 WIP，不建 MR。
- 不给 traecli 宿主或 omh Task 本身登记。
