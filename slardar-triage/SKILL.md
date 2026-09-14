---
name: slardar-triage
description: 扫描 Slardar 近 24h 线上 JS 错误（只看 vc_ai，即 vc-ai 方向），按 web 侧改动可能性排序并逐条详细呈现（Issue 链接、分布、代码点位、根因假设、要向 native 确认的问题），决策交给用户；只有用户说「派这条 <issue>，补充：<敲定的细节>」才建 Meego、经 traecli 起 omh、登记看板。当用户说「扫一下线上告警」「看看 Slardar」「挑一个告警看看」「派这条」「这条不修」「看看进度」时使用。
---

# slardar-triage

技能目录 `<skill>` = 本文件所在目录；状态目录 `<state>` = `<skill>/state`；byteview-web 仓 `<repo>` = 当前 cwd 的 `../byteview-web`（`--repo` 可改）。所有脚本 stdout 只有一行 JSON。

**默认唤醒零副作用**：不建 Meego、不起 omh、不登记看板，只写 `<state>/`。agent 的判断只用来排序和呈现；是否动手由用户去问 native 同学、与 leader 确认后决定。

## 四个入口

| 用户意图 | 动作 |
|---|---|
| 默认（「扫一下线上告警」「看看 Slardar」「挑一个告警看看」） | 主流程第 1–5 步 |
| 「派这条 <摘要或 issue_id>，补充：<细节>」 | 「派单」一节 |
| 「这条不修 <摘要或 issue_id>，原因：<文本>」 | `node <skill>/scripts/state.mjs reject --dir <state> --issue-id <id> --reason "<原话>"`，回话题确认 |
| 「看看进度」 | `node <skill>/scripts/progress.mjs --state <state>`，按报告第 2 块格式回话题 |

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
`skipped_bids` 非空说明 vc_ai 本身没扫成，原因写进报告第 4 块并停在这一步；候选 `detail_error` 非空说明 Sourcemap 没取到，档位按中处理并把原因写进详细信息的「不确定点」。

### 3. 合并候选池

```bash
node -e '
import("<skill>/scripts/state.mjs").then(async (m) => {
  const fs = await import("node:fs");
  const scan = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const s = m.loadState(process.argv[2]);
  const { state, removed } = m.mergeScan(s, scan.candidates, scan.scanned_at);
  m.saveState(process.argv[2], state);
  fs.writeFileSync(process.argv[3], JSON.stringify({ pending: m.pendingSorted(state), removed }, null, 2));
})' <scan.json> <state> <state>/scans/merge-latest.json
```
`pending` 是本次要呈现的候选（含上次已判档但还没决策的）；`removed` 进报告第 3 块。

### 4. 判档并写详细信息

对 `pending` 里每条按 `<skill>/references/likelihood.md` 判档。判「高」必须真的读代码：`git -C <repo> show origin/master:<mapped_path> | sed -n '<line-30>,<line+30>p'`，位置已变时 `git -C <repo> log --oneline -5 origin/master -- <mapped_path>`、`git -C <repo> grep -n '<函数名>' origin/master -- <project_dir>`。线上 release 对应 commit：`bytedcli --json scm repo version list <scm_repo> --type online --version <release> --page-size 10` 取 `data.versions[].base_commit_hash`（vc_ai 同时试 `ee/lark/vc_ai` 与 `ee/lark/vc_ai_doubao`，type 再试 test）。

每条落档：
```bash
node <skill>/scripts/state.mjs judge --dir <state> --issue-id <id> --likelihood <高|中|低|排除> --summary "<一句话缺陷描述或归档原因>"
```

高、中两档的详细信息栏目（顺序固定）：Issue 链接（`issue_url`）；错误信息、同族 Issue、状态、首次出现；24h 族次数 / 用户 / 抽样 session；分布（页面、系统、release、宿主版本、source_type）；最新帧 `mapped_path:line`（页面、release → commit）；master 点位与一句话缺陷描述；根因假设（web 侧可独立解释 / 依赖 native 或服务端）；要向 native / 服务端确认的问题（每条一句，可直接复制去问）；若在 web 侧动手的改动方向与范围（文件级）；不确定点。低、排除各一行：档位、bid、message 摘要、原因、Issue 链接。

### 5. 报告

`botmux send` 一条消息，按 `<skill>/references/example-report.md` 的五块：候选清单；已派单进展（`progress.mjs`）；已拒绝 / 自动移出；本次未扫（仅 vc_ai 扫描失败时有内容）；下一步一行。

## 派单（只在用户显式指令后）

1. 从指令里取 issue 与「补充」。补充为空：停下，回话题要两样东西——native 侧同学的结论、leader 是否同意在 web 侧动手；拿到前不派。
2. 核对：`node <skill>/scripts/state.mjs pending --dir <state>` 里存在该 issue 且 status=pending；否则回话题说明（已派 / 已拒 / 不在池中）。
3. 派单前校验：`bytedcli --json meego user search --project-key 5e96d7bff4e7c525510f9156 --user-keys '["wangjinghong.ceilf6"]'`、`command -v traecli omh-cli orchestrator`，缺则停。
4. 写任务书：按 `<skill>/references/task-book-template.md`，第 0 节原样收录补充；第 2 节线上代码用第 4 步查到的 commit；第 5 节首条 AC 写复现步骤、改动前实际表现、期望表现。`{{meego_url}}` 保留占位。
5. 写 Meego 描述文件：现象 / 根因 / 修法 / Slardar 链接（`issue_url`，用 `[]` 包裹），末尾「【人工确认】<补充原文>」。
6. 派发（在本会话 cwd 下执行，不要先 `cd` 进工作区）：
```bash
bash <skill>/scripts/dispatch.sh --state <state> --issue-id <id> --slug <kebab-摘要>-$(date +%F) --task-book <任务书路径> --meego-desc <描述文件> --meego-name "<Meego 标题>" --os <os_dist 主项> --release <release_dist 主项> --repo <repo> --slardar-url "<issue_url>"
```
退出 3：有在跑的单，附其进展；退出 4：runtime 不符已 cancel，不重试；退出 1：写停在哪一步，下次「派这条」会续派。输出的 `board` 字段是看板登记结果，失败写原因。
7. 成功后：
```bash
node <skill>/scripts/state.mjs dispatched --dir <state> --issue-id <id> --task-id <task_id> --supplement "<补充原文>"
```
8. 回话题：Issue 一句话、Meego 链接、Task ID、工作区、看板登记结果、预计约 3 小时、叫停命令 `orchestrator task-cancel --task-id <id>`。

## 纪律

- 任何情况下不自动派单，包括只有一条高可能性、用户上次说过「以后都派」——每次都要显式指令与补充。
- 判档不看 users / count；拿不准归中。
- omh 永远经 `traecli exec` 起（dispatch.sh 内置）。
- 看板登记的是调用本技能的 claude 线程；meta 带 meego_id / meego_type=issue / meego_url / slardar_url，`progress.mjs` 发现 MR 后回填 mr_id。补登记：`bash <skill>/scripts/board.sh --state <state> --issue-id <id> [--mr-id] [--session-id] [--slardar-url]`。
- 停摆恢复：phase=failed 且死于 code-review → `bash <skill>/scripts/resume-traex.sh <workspace> <task_id> impl`；其他节点省略第三个参数；执行后在回复里写动作与理由。
