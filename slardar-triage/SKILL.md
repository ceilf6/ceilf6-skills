---
name: slardar-triage
description: 扫描 Slardar 近 24h 线上 JS 错误（vc_ai/vc_web/vc_pages），按 A–D 定级并在飞书话题报告；A 档自动建 Meego 缺陷并经 traecli 起 omh pc-web-bugfix 修复，未派发的 A 档入队下次优先派发。当用户说「扫一下线上告警」「看看 Slardar」「挑一个告警修」「派发下一条告警」「看看进度」「这条不修」时使用。
---

# slardar-triage

技能目录 `<skill>` = 本文件所在目录；状态目录 `<state>` = `<skill>/state`；byteview-web 仓 `<repo>` = 当前 cwd 的 `../byteview-web`（`--repo` 可改）。所有脚本 stdout 只有一行 JSON。

## 三个入口

| 用户意图 | 动作 |
|---|---|
| 扫描并派发（默认） | 走「主流程」全部七步 |
| 「看看进度」 | 只跑 `node <skill>/scripts/progress.mjs --state <state>`，按报告第 5 块格式回话题 |
| 「这条不修 <摘要或 issue_id>」 | 从最近一次报告或 `<state>/queue.json` 定位 issue_id，跑 `node <skill>/scripts/state.mjs skip --dir <state> --issue-id <id> --reason "<用户原话>"`，回话题确认 |

参数：`--bid`（默认 `vc_ai,vc_web,vc_pages`）、`--hours`（24）、`--top`（10）、`--max-dispatch`（1）、`--dry-run`。用户说「只看不派」等同 `--dry-run`。

## 主流程

### 1. 前置校验（缺一即停，不产生副作用）

```bash
ls <repo>/node_modules/.bin/slardar-web-cli
<repo>/node_modules/.bin/slardar-web-cli --raw js-error list --bid vc_ai --env online --site-type web --start-time $(( $(date +%s) - 600 )) --end-time $(date +%s) --page-size 1
bytedcli --json meego user search --project-key 5e96d7bff4e7c525510f9156 --user-keys '["wangjinghong.ceilf6"]'
command -v traecli omh-cli orchestrator
git -C <repo> fetch origin master
```
失败对应的补法：JWT → 让用户在本机执行 `npx -y agentbuddy get-jwt`；Meego → `bytedcli meego login`；PATH 缺 → 报缺哪个；fetch 失败 → 报网络/权限。

### 2. 扫描

```bash
node <skill>/scripts/scan.mjs --bid <bids> --hours <hours> --top <top> --repo <repo> --out <state>/scans/scan-$(date -u +%Y%m%dT%H%M%SZ).json
```
读输出文件。`skipped_bids` 非空要写进报告；候选的 `detail_error` 非空说明最新几条事件的 Sourcemap 都没取到，`mapped_path` 会是 null，定级时按 B 处理并把原因写进报告。

### 3. 合并存量

用 node 一次性完成（避免手工改 JSON）：
```bash
node -e '
import("<skill>/scripts/state.mjs").then(async (m) => {
  const fs = await import("node:fs");
  const scan = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const s = m.loadState(process.argv[2]);
  const { state, fresh } = m.mergeScan(s, scan.candidates, scan.scanned_at);
  m.saveState(process.argv[2], state);
  fs.writeFileSync(process.argv[3], JSON.stringify({ fresh, removed_stale: state.removed_stale ?? [], queue: state.queue }, null, 2));
})' <scan.json> <state> <state>/scans/merge-latest.json
```
`fresh` 是待定级候选；`queue` 是刷新后的存量 A 档；`removed_stale` 进报告第 4 块。

### 4. 定级

对 `fresh` 每条按 `<skill>/references/grading.md` 定档。判据 2 必须真的去读代码：`git -C <repo> show origin/master:<mapped_path> | sed -n '<line-30>,<line+30>p'`，帧位置在 master 已变时用 `git -C <repo> log --oneline -5 origin/master -- <mapped_path>` 与 `git -C <repo> grep -n '<函数名>' origin/master -- <project_dir>` 找等价位置。A 档写入队列：
```bash
node -e '
import("<skill>/scripts/state.mjs").then((m) => {
  const s = m.loadState(process.argv[1]);
  m.enqueue(s, JSON.parse(process.argv[2]));
  m.saveState(process.argv[1], s);
})' <state> '{"issue_id":"…","family_key":"…","bid":"…","message":"…","users":<family_users>,"count":<family_count>,"enqueued_at":"<scanned_at>","refreshed_at":"<scanned_at>","stale_count":0,"grade":"A","evidence":["帧 …","master … —— …"]}'
```
B/C/D 只进报告，不入队。

### 5. 选单

```bash
node <skill>/scripts/state.mjs next --dir <state>
```
返回 null 或 `--dry-run` 时跳到第 7 步。

### 6. 派发（每单一次）

1. 写任务书：按 `<skill>/references/task-book-template.md` 生成，`{{meego_url}}` 原样保留占位（dispatch 会替换）。第 2 节线上代码用 `bytedcli --json scm repo version list <scm_repo> --type online --version <release> --page-size 10` 取 `data.versions[].base_commit_hash`（vc_ai 要同时试 `ee/lark/vc_ai` 与 `ee/lark/vc_ai_doubao`，type 再试 test），`git -C <repo> show <commit>:<path>` 摘录。第 3 节用第 4 步读到的 master 代码。第 5 节首条 AC 写复现步骤、改动前实际表现、期望表现。
2. 写 Meego 描述文件（现象 / 根因 / 修法 / Slardar 链接，Slardar 链接用扫描 JSON 里该候选的 `slardar_url`，URL 用 `[]` 包裹）。
3. 派发（`--slardar-url` 传同一个 `slardar_url`，它会进处置账、看板卡备注与 meta，CR 评审从看板就能点到告警上下文）：
```bash
bash <skill>/scripts/dispatch.sh --state <state> --issue-id <id> --slug <kebab-摘要>-$(date +%F) --task-book <任务书路径> --meego-desc <描述文件> --meego-name "<Meego 标题>" --os <os_dist 主项> --release <release_dist 主项> --repo <repo> --slardar-url "<slardar_url>"
```
退出 3：报告写「有在跑的单」并附其进展；退出 4：报告标红「runtime 不符已 cancel」，不重试；退出 1：报告写停在哪一步，下次唤醒会续派。
输出里的 `board` 字段是看板登记结果：`ok:true` 表示已在 harness 看板登记本会话的唤回命令；`ok:false` 带 `error` 时照常继续，把原因写进报告。**dispatch.sh 必须在本会话的 cwd 下调用，不要先 `cd` 进工作区再调**，否则登记的唤回命令指向错误目录。
4. 成功后把该条移出队列并登记 dispatch.sh 输出的 task_id / workspace / meego_url：
```bash
node -e '
import("<skill>/scripts/state.mjs").then((m) => {
  const s = m.loadState(process.argv[1]);
  m.markDispatched(s, process.argv[2], JSON.parse(process.argv[3]));
  m.saveState(process.argv[1], s);
})' <state> <issue_id> '{"task_id":"…","workspace":"…","meego_url":"…"}'
```

### 7. 报告

`botmux send` 一条消息，五块，按 `<skill>/references/example-report.md` 的格式：本次派发（A 档两条证据、Meego、Task ID、工作区、预计约 3 小时、叫停命令 `orchestrator task-cancel --task-id <id>`、看板：已登记（ht web 可复制启动命令）/ 登记失败 <原因>）；队列剩余 A 档；新增 B 档（写根因未定位的原因与候选调用链）；C/D 档一行一条；stale 与跳过；上一单进展（`progress.mjs`）。

## 纪律

- omh 永远经 `traecli exec` 起（dispatch.sh 内置），不在本会话直接调 `$oh-my-harness:omh-loop`。
- 定档不看 users / count；拿不准一律 B。
- 每步脚本失败都如实写进报告，不跳步、不重试建 Meego。
- 看板登记的是调用本技能的 claude 线程，不是 traecli 宿主；卡片不推进节点，只用它复制启动命令。meta.json 带 meego_id / meego_type=issue / meego_url，看板点「完成」时 meego.sh 据此流转缺陷；`progress.mjs` 发现 MR 后把 mr_id 回填进 meta。补登记或换线程用 `bash <skill>/scripts/board.sh --state <state> --issue-id <id> [--mr-id <id>] [--session-id <sid>] [--slardar-url <url>]`，同样要在目标会话的 cwd 下跑。
- 停摆恢复：phase=failed 且死于 code-review → `bash <skill>/scripts/resume-traex.sh <workspace> <task_id> impl`；其他节点省略第三个参数。执行后在报告里写动作与理由。
