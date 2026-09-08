# slardar-triage 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一个可在飞书唤醒机器人后一句话触发的技能：扫 Slardar 近 24h 线上 JS 错误，按 A–D 定级并报告，对 A 档自动建 Meego、经 traecli 起 omh（pc-web-bugfix）修复，未派发的 A 档存入队列供下次唤醒优先派发。

**Architecture:** 三层。确定性脚本层（`scan.js` 采集、`state.js` 队列、`dispatch.sh` 派发、`progress.js` 进展）全部可单测；判断层由 agent 按 `references/grading.md` 定级并写任务书；SKILL.md 只描述编排顺序与报告格式。副作用（Meego、worktree、traecli）集中在 `dispatch.sh`，按步骤落账、可断点续跑。

**Tech Stack:** Node.js 24（ESM `.mjs`，`node:test` 单测，零 npm 依赖）、bash 5、`slardar-web-cli --raw`（byteview-web devDependency）、`bytedcli`、`omh-cli` / `orchestrator` / `traecli`、`botmux send`。

## Global Constraints

- 技能真源目录：`/Users/bytedance/Desktop/ceilf/ceilf6-skills/slardar-triage/`，经 `install-harness.sh` 软链到 `~/.claude/skills/slardar-triage`。
- 状态目录 `slardar-triage/state/` 进 `.gitignore`；`state/scans/` 保留每次扫描 JSON。
- 默认参数：`--bid vc_ai,vc_web,vc_pages`、`--hours 24`、`--top 10`、`--max-dispatch 1`。
- BID → 目录 / SCM 仓：`vc_ai → vc-ai（ee/lark/vc_ai, ee/lark/vc_ai_doubao）`、`vc_web → vc-web（ee/lark/vc_web）`、`vc_pages → vc-pages（ee/lark/vc_landing_pages）`。
- byteview-web 仓库路径默认 `../byteview-web`（相对机器人 cwd `byteview-web-harness`），`--repo` 或环境变量 `SLARDAR_TRIAGE_REPO` 可覆盖；slardar-web-cli 二进制取 `<repo>/node_modules/.bin/slardar-web-cli`，`SLARDAR_WEB_CLI_BIN` 可覆盖。
- omh 工作区根目录 `~/Desktop/workspace/omh-runs/`，任务书放 `~/Desktop/workspace/omh-runs/tasks/`，宿主日志 `~/Desktop/workspace/omh-runs/<slug>-host.log`。
- omh 只经 `traecli exec` 发起，workflow 固定 `pc-web-bugfix`，`--no-plan --no-meego`；起后核验 `task.host.runtime == "traecli"`。
- Meego：project_key `5e96d7bff4e7c525510f9156`，缺陷模板 `4`，business `694269fe841acec8b67164b2`，priority `2`，经办人 user_key `7657492291354954694`；任务书与 MR 用 `https://meego.larkoffice.com/larksuite/issue/detail/<id>`。
- 定档只看两条判据（前端可独立修、根因能定位到文件）；users / count 只排派发顺序。
- 脚本 stdout 只输出一行 JSON（供 agent 解析），人类可读信息走 stderr。
- 注释只写代码表达不了的原因与约束，不写变更叙事。

---

## 文件结构

```
slardar-triage/
  SKILL.md                         # 编排顺序、触发词、报告格式（Task 7）
  .gitignore                       # state/
  scripts/
    lib/
      cli.mjs                      # spawn 封装、--raw JSON 解析、BID 常量（Task 3）
      family.mjs                   # message → 族键（Task 3）
      stats.mjs                    # 事件分布统计（Task 3）
    scan.mjs                       # 扫描入口，产出 scan JSON（Task 3）
    state.mjs                      # queue / dispatched / skipped 读写与合并（Task 2）
    progress.mjs                   # 读 Task 目录 meta/session/stages 汇总进展（Task 6）
    launch-traex.sh                # 脱管起 omh（Task 5）
    resume-traex.sh                # 停摆恢复（Task 5）
    dispatch.sh                    # 幂等派发（Task 5）
  references/
    grading.md                     # A–D 判据与证据要求（Task 4）
    task-book-template.md          # 任务书骨架（Task 4）
    meego-issue-fields.md          # 缺陷模板 4 字段配方（Task 4）
    example-report.md              # 2026-09-08 批次样例报告（Task 4）
  tests/
    fixtures/                      # 录制的 slardar-web-cli --raw 输出
    stubs/                         # bytedcli / omh-cli / traecli / orchestrator 假命令
    state.test.mjs
    scan.test.mjs
    progress.test.mjs
    test-dispatch.sh
  state/                           # gitignore
```

---

### Task 1: 技能骨架、安装与测试入口

**Files:**
- Create: `slardar-triage/.gitignore`
- Create: `slardar-triage/SKILL.md`（占位 frontmatter，Task 7 补全正文）
- Create: `slardar-triage/tests/run.sh`
- Modify: `install-harness.sh:9`（循环列表）

**Interfaces:**
- Produces: `tests/run.sh` 跑全部 `tests/*.test.mjs` 与 `tests/test-*.sh`，任一失败退出 1。

- [ ] **Step 1: 写 .gitignore 与 SKILL.md 占位**

`slardar-triage/.gitignore`：
```
state/
```

`slardar-triage/SKILL.md`：
```markdown
---
name: slardar-triage
description: 扫描 Slardar 近 24h 线上 JS 错误（vc_ai/vc_web/vc_pages），按 A–D 定级并在飞书话题报告；A 档自动建 Meego 缺陷并经 traecli 起 omh pc-web-bugfix 修复，未派发的 A 档入队下次优先派发。当用户说「扫一下线上告警」「看看 Slardar」「挑一个告警修」「派发下一条告警」「看看进度」「这条不修」时使用。
---

（正文见 Task 7）
```

- [ ] **Step 2: 写测试入口**

`slardar-triage/tests/run.sh`：
```bash
#!/usr/bin/env bash
# 单测入口：JS 走 node:test，bash 走各自的 test-*.sh；任一失败整体退出 1。
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
status=0
node --test "$HERE"/*.test.mjs || status=1
for t in "$HERE"/test-*.sh; do
  [ -f "$t" ] || continue
  bash "$t" || status=1
done
exit $status
```

- [ ] **Step 3: 运行入口确认空跑通过**

Run: `bash /Users/bytedance/Desktop/ceilf/ceilf6-skills/slardar-triage/tests/run.sh`
Expected: `node --test` 报 0 个测试文件匹配（退出 0）或 "no test files found"；整体退出 0。若 node 对空 glob 退出非 0，把 `node --test` 一行改为 `ls "$HERE"/*.test.mjs >/dev/null 2>&1 && { node --test "$HERE"/*.test.mjs || status=1; }`。

- [ ] **Step 4: 修改 install-harness.sh**

把第 9 行 `for s in harness-context harness-ceilf6 mr-comments lark-sediment bytedcli-meego; do` 改为：
```bash
for s in harness-context harness-ceilf6 mr-comments lark-sediment bytedcli-meego slardar-triage; do
```

- [ ] **Step 5: 安装并确认软链**

Run: `bash /Users/bytedance/Desktop/ceilf/ceilf6-skills/install-harness.sh && ls -la ~/.claude/skills/slardar-triage`
Expected: 输出 `linked: /Users/bytedance/.claude/skills/slardar-triage -> /Users/bytedance/Desktop/ceilf/ceilf6-skills/slardar-triage`，ls 显示软链。

- [ ] **Step 6: Commit**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
git add slardar-triage install-harness.sh
git commit -m "feat(slardar-triage): 技能骨架与安装入口"
```

---

### Task 2: state.mjs 队列与处置账

**Files:**
- Create: `slardar-triage/scripts/state.mjs`
- Test: `slardar-triage/tests/state.test.mjs`

**Interfaces:**
- Produces（ESM 导出，供 scan/dispatch/SKILL 调用，也可作 CLI）：
  - `loadState(dir) → { queue: Entry[], dispatched: Record<issueId, Dispatch>, skipped: Record<issueId, {reason, at}> }`
  - `saveState(dir, state)`
  - `mergeScan(state, candidates, now) → { state, fresh: Candidate[] }`：刷新存量、标 stale、排除已派发/跳过，返回需要定级的新候选。
  - `enqueue(state, entry)`、`nextToDispatch(state) → Entry | null`、`markDispatched(state, issueId, dispatch)`、`skip(state, issueId, reason, now)`
  - `Entry = { issue_id, family_key, bid, message, users, count, enqueued_at, refreshed_at, stale_count, grade: 'A', evidence: string[] }`
  - CLI：`node state.mjs next --dir <state>`、`node state.mjs skip --dir <state> --issue-id <id> --reason <text>`，stdout 一行 JSON。

- [ ] **Step 1: 写失败测试**

`slardar-triage/tests/state.test.mjs`：
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState, mergeScan, enqueue, nextToDispatch, markDispatched, skip } from '../scripts/state.mjs';

const entry = (over = {}) => ({
  issue_id: 'i1', family_key: 'f1', bid: 'vc_ai', message: 'm', users: 100, count: 1000,
  enqueued_at: '2026-09-01T00:00:00Z', refreshed_at: '2026-09-01T00:00:00Z', stale_count: 0,
  grade: 'A', evidence: ['e1', 'e2'], ...over,
});
const cand = (over = {}) => ({ issue_id: 'i1', family_key: 'f1', bid: 'vc_ai', message: 'm', family_users: 200, family_count: 5000, ...over });

test('空目录加载得到空状态，保存后可回读', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const s = loadState(dir);
  assert.deepEqual(s, { queue: [], dispatched: {}, skipped: {} });
  s.queue.push(entry());
  saveState(dir, s);
  assert.equal(loadState(dir).queue[0].issue_id, 'i1');
});

test('mergeScan 刷新存量影响数并把新候选返回给定级', () => {
  const s = { queue: [entry()], dispatched: {}, skipped: {} };
  const { state, fresh } = mergeScan(s, [cand(), cand({ issue_id: 'i2', family_key: 'f2' })], '2026-09-08T00:00:00Z');
  assert.equal(state.queue[0].users, 200);
  assert.equal(state.queue[0].refreshed_at, '2026-09-08T00:00:00Z');
  assert.equal(state.queue[0].stale_count, 0);
  assert.deepEqual(fresh.map((c) => c.issue_id), ['i2']);
});

test('mergeScan 对本次未出现的存量记 stale，连续两次移出队列', () => {
  const s = { queue: [entry()], dispatched: {}, skipped: {} };
  let r = mergeScan(s, [], '2026-09-08T00:00:00Z');
  assert.equal(r.state.queue[0].stale_count, 1);
  r = mergeScan(r.state, [], '2026-09-09T00:00:00Z');
  assert.equal(r.state.queue.length, 0);
  assert.deepEqual(r.state.removed_stale.map((e) => e.issue_id), ['i1']);
});

test('mergeScan 排除已派发与已跳过的候选，同族按 family_key 去重', () => {
  const s = { queue: [], dispatched: { i9: { task_id: 't' } }, skipped: { i8: { reason: 'r', at: 'x' } } };
  const { fresh } = mergeScan(s, [cand({ issue_id: 'i9' }), cand({ issue_id: 'i8' }), cand({ issue_id: 'i3', family_key: 'f3' }), cand({ issue_id: 'i4', family_key: 'f3' })], 'now');
  assert.deepEqual(fresh.map((c) => c.issue_id), ['i3']);
});

test('nextToDispatch 存量优先，再按 users、count 排序', () => {
  const s = { queue: [], dispatched: {}, skipped: {} };
  enqueue(s, entry({ issue_id: 'new', enqueued_at: '2026-09-08T00:00:00Z', users: 9999 }));
  enqueue(s, entry({ issue_id: 'old-small', enqueued_at: '2026-09-01T00:00:00Z', users: 10 }));
  enqueue(s, entry({ issue_id: 'old-big', enqueued_at: '2026-09-01T00:00:00Z', users: 500 }));
  assert.equal(nextToDispatch(s).issue_id, 'old-big');
  markDispatched(s, 'old-big', { task_id: 't1' });
  assert.equal(nextToDispatch(s).issue_id, 'old-small');
  assert.equal(s.queue.length, 2);
  assert.equal(s.dispatched['old-big'].task_id, 't1');
});

test('stale 条目不派发；skip 从队列移除并落账', () => {
  const s = { queue: [entry({ stale_count: 1 })], dispatched: {}, skipped: {} };
  assert.equal(nextToDispatch(s), null);
  skip(s, 'i1', '不修', 'now');
  assert.equal(s.queue.length, 0);
  assert.equal(s.skipped.i1.reason, '不修');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/bytedance/Desktop/ceilf/ceilf6-skills/slardar-triage && node --test tests/state.test.mjs`
Expected: FAIL，`Cannot find module '../scripts/state.mjs'`。

- [ ] **Step 3: 实现 state.mjs**

`slardar-triage/scripts/state.mjs`：
```js
#!/usr/bin/env node
// 队列与处置账的唯一读写点。三份文件分开存：queue.json 是待派发 A 档，
// dispatched.json / skipped.json 是终态账，扫描合并时只读不改。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILES = { queue: 'queue.json', dispatched: 'dispatched.json', skipped: 'skipped.json' };
// 同一族 24h 内两次扫描都不再出现才移出：一次缺席可能只是 Slardar 采样或时间窗边界。
const STALE_REMOVE_AT = 2;

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function loadState(dir) {
  return {
    queue: readJson(join(dir, FILES.queue), []),
    dispatched: readJson(join(dir, FILES.dispatched), {}),
    skipped: readJson(join(dir, FILES.skipped), {}),
  };
}

export function saveState(dir, state) {
  mkdirSync(dir, { recursive: true });
  for (const [key, file] of Object.entries(FILES)) {
    writeFileSync(join(dir, file), `${JSON.stringify(state[key], null, 2)}\n`);
  }
}

export function mergeScan(state, candidates, now) {
  const byIssue = new Map(candidates.map((c) => [c.issue_id, c]));
  const byFamily = new Map();
  for (const c of candidates) if (!byFamily.has(c.family_key)) byFamily.set(c.family_key, c);

  const kept = [];
  const removed = [];
  for (const entry of state.queue) {
    const hit = byIssue.get(entry.issue_id) ?? byFamily.get(entry.family_key);
    if (hit) {
      kept.push({ ...entry, users: hit.family_users, count: hit.family_count, refreshed_at: now, stale_count: 0 });
    } else if (entry.stale_count + 1 >= STALE_REMOVE_AT) {
      removed.push(entry);
    } else {
      kept.push({ ...entry, stale_count: entry.stale_count + 1 });
    }
  }

  const queuedFamilies = new Set(kept.map((e) => e.family_key));
  const seenFamilies = new Set();
  const fresh = [];
  for (const c of candidates) {
    if (state.dispatched[c.issue_id] || state.skipped[c.issue_id]) continue;
    if (queuedFamilies.has(c.family_key) || seenFamilies.has(c.family_key)) continue;
    seenFamilies.add(c.family_key);
    fresh.push(c);
  }
  return { state: { ...state, queue: kept, removed_stale: removed }, fresh };
}

export function enqueue(state, entry) {
  if (state.queue.some((e) => e.issue_id === entry.issue_id)) return;
  state.queue.push(entry);
}

export function nextToDispatch(state) {
  const live = state.queue.filter((e) => e.stale_count === 0);
  if (!live.length) return null;
  const oldest = live.reduce((a, b) => (a.enqueued_at <= b.enqueued_at ? a : b)).enqueued_at;
  const tier = live.filter((e) => e.enqueued_at === oldest);
  tier.sort((a, b) => b.users - a.users || b.count - a.count);
  return tier[0];
}

export function markDispatched(state, issueId, dispatch) {
  state.queue = state.queue.filter((e) => e.issue_id !== issueId);
  state.dispatched[issueId] = { ...(state.dispatched[issueId] ?? {}), ...dispatch };
}

export function skip(state, issueId, reason, now) {
  state.queue = state.queue.filter((e) => e.issue_id !== issueId);
  state.skipped[issueId] = { reason, at: now };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  const dir = arg('--dir');
  if (!dir) {
    process.stderr.write('用法: state.mjs next|skip --dir <state> [--issue-id <id> --reason <text>]\n');
    process.exit(2);
  }
  const state = loadState(dir);
  if (cmd === 'next') {
    process.stdout.write(`${JSON.stringify(nextToDispatch(state))}\n`);
  } else if (cmd === 'skip') {
    skip(state, arg('--issue-id'), arg('--reason') ?? '', new Date().toISOString());
    saveState(dir, state);
    process.stdout.write(`${JSON.stringify({ ok: true, skipped: arg('--issue-id') })}\n`);
  } else {
    process.stderr.write(`未知子命令: ${cmd}\n`);
    process.exit(2);
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/bytedance/Desktop/ceilf/ceilf6-skills/slardar-triage && node --test tests/state.test.mjs`
Expected: 6 个测试 pass。

- [ ] **Step 5: Commit**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
git add slardar-triage/scripts/state.mjs slardar-triage/tests/state.test.mjs
git commit -m "feat(slardar-triage): 队列与处置账 state.mjs"
```

---

### Task 3: scan.mjs 扫描与族合并

**Files:**
- Create: `slardar-triage/scripts/lib/cli.mjs`
- Create: `slardar-triage/scripts/lib/family.mjs`
- Create: `slardar-triage/scripts/lib/stats.mjs`
- Create: `slardar-triage/scripts/scan.mjs`
- Create: `slardar-triage/tests/fixtures/list-vc_ai.json`、`log-query-938f8ba3.json`、`log-detail-938f8ba3.json`
- Test: `slardar-triage/tests/scan.test.mjs`

**Interfaces:**
- Consumes: 无（独立于 state）。
- Produces:
  - `familyKey(message) → string`
  - `summarize(rows) → { pid_dist, os_dist, release_dist, source_type_dist, host_version_dist, distinct_sessions }`（`rows` 为 `table_list[].metric_map` 展平后的 `{pid, os, release, source_type, session_id, user_agent}`）
  - `runSlardar(args, {bin}) → parsed JSON`（内部 `--raw`）
  - `scan({bids, hours, top, repo, now, runner}) → ScanResult`，`ScanResult = { scanned_at, window: {start, end}, skipped_bids: [{bid, reason}], candidates: Candidate[] }`
  - `Candidate = { issue_id, family_key, member_issue_ids, bid, project_dir, message, count, users, family_count, family_users, first_seen, status, pid_dist, os_dist, release_dist, source_type_dist, host_version_dist, distinct_sessions, latest_event: { page, release, mapped_path, line, function, source_type } }`
  - CLI：`node scan.mjs --bid vc_ai,vc_web,vc_pages --hours 24 --top 10 --repo <path> --out <file>`，stdout 一行 `{ ok, out, candidates: <count>, skipped_bids }`。
  - `runner` 参数是可注入的 `(args) => JSON`，测试用它喂 fixture。

- [ ] **Step 1: 录制 fixture**

用本会话已采样过的真实输出（去掉 user_id / device_id 字段）写三份文件。

`tests/fixtures/list-vc_ai.json`（`js-error list --raw` 结果，两条）：
```json
{"data":{"result":[
 {"message":"业务错误，ErrorInfo: code: 220301,larkErrorCode: 220301,debugMessage: invalid user,displayMessage: invalid user,userErrTitle: ,requestID: ,ttLogId: Optional(\"202609081552070C7659AD1649166AED32\")","name":"Error","filename":"webpack://@byteview-web/vc-ai/./src/utils/native.ts","issue_id":"aaaed08b947f7c1730c780ec481b0cee","issue_status":"unassigned","min_crash_time":1788796805774,"max_crash_time":1788853928908,"count":72137,"user":8441},
 {"message":"common.getAvatarBase64_165 timeout after 60s","name":"Error","filename":"webpack://@byteview-web/vc-ai/./src/utils/native.ts","issue_id":"938f8ba377ac6484ba8918b19f247350","issue_status":"unassigned","min_crash_time":1754313634583,"max_crash_time":1788853927782,"count":45452,"user":21740},
 {"message":"[InvokeServierPBFast error]: logId=20260908155207554D4C362C984C6977D8, invalid user","name":"InvokeServerPbError","filename":"webpack://@byteview-web/vc-ai/./src/services/transport-layer/webview/utils/server-pb.ts","issue_id":"b1071995655bbebf583ae422aa64c7ae","issue_status":"unassigned","min_crash_time":1788796889000,"max_crash_time":1788853928000,"count":29400,"user":11391}
],"total":2289},"errno":200}
```

`tests/fixtures/log-query-938f8ba3.json`（`log query --raw`，三行，两行 iOS minutes-ai-layout-mobile、一行 iOS end-summary-mobile，session 两个不同）：
```json
{"data":{"table_list":[
 {"ev_type":"js_error","metric_map":{"dh_key":{"value":"k1"},"os":{"value":"iOS"},"pid":{"value":"/webview/minutes-ai-layout-mobile"},"release":{"value":"7.76.0.234"},"session_id":{"value":"s1"},"source_type":{"value":"onunhandledrejection"},"timestamp":{"value":"1788853927782"},"user_agent":{"value":"Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) Lark/7.62.12"}}},
 {"ev_type":"js_error","metric_map":{"dh_key":{"value":"k2"},"os":{"value":"iOS"},"pid":{"value":"/webview/minutes-ai-layout-mobile"},"release":{"value":"7.76.0.234"},"session_id":{"value":"s1"},"source_type":{"value":"onunhandledrejection"},"timestamp":{"value":"1788853927000"},"user_agent":{"value":"Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) Lark/7.62.12"}}},
 {"ev_type":"js_error","metric_map":{"dh_key":{"value":"k3"},"os":{"value":"iOS"},"pid":{"value":"/webview/end-summary-mobile"},"release":{"value":"7.76.0.234"},"session_id":{"value":"s2"},"source_type":{"value":"manual"},"timestamp":{"value":"1788853920000"},"user_agent":{"value":"Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X)"}}}
]},"errno":200}
```

`tests/fixtures/log-detail-938f8ba3.json`（`log detail --raw`，`data.json` 是字符串化事件）：
```json
{"data":{"ev_type":"js_error","metric_map":{"pid":{"value":"/webview/minutes-ai-layout-mobile"},"release":{"value":"7.76.0.234"},"source_type":{"value":"onunhandledrejection"}},"json":"{\"ev_type\":\"js_error\",\"pid\":\"/webview/minutes-ai-layout-mobile\",\"release\":\"7.76.0.234\",\"stack\":{\"values\":[{\"raw_stacktrace\":{\"frames\":[{\"colno\":25,\"lineno\":196,\"filename\":\"webpack://@byteview-web/vc-ai/./src/utils/native.ts\",\"function\":\"\",\"parse_code\":100}]},\"stacktrace\":{\"frames\":[{\"colno\":71318,\"lineno\":1,\"filename\":\"https://sf1-scmcdn-cn.feishucdn.com/x.js\",\"function\":\"?\"}]}}]}}"},"errno":200}
```

- [ ] **Step 2: 写失败测试**

`slardar-triage/tests/scan.test.mjs`：
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { familyKey } from '../scripts/lib/family.mjs';
import { summarize, flattenRows } from '../scripts/lib/stats.mjs';
import { scan } from '../scripts/scan.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

test('familyKey 去掉序号、logId、ttLogId、requestID', () => {
  assert.equal(familyKey('common.getAvatarBase64_165 timeout after 60s'), 'common.getAvatarBase64 timeout after 60s');
  assert.equal(familyKey('common.getAvatarBase64_43 timeout after 60s'), familyKey('common.getAvatarBase64_165 timeout after 60s'));
  assert.equal(
    familyKey('[InvokeServierPBFast error]: logId=20260908155207554D4C362C984C6977D8, invalid user'),
    '[InvokeServierPBFast error]: logId=<id>, invalid user',
  );
  assert.equal(
    familyKey('业务错误，ErrorInfo: code: 220301,requestID: ,ttLogId: Optional("2026")'),
    '业务错误，ErrorInfo: code: 220301,requestID: <id>,ttLogId: <id>',
  );
});

test('summarize 统计分布、宿主版本与 distinct session', () => {
  const rows = flattenRows(fx('log-query-938f8ba3.json'));
  const s = summarize(rows);
  assert.deepEqual(s.pid_dist, { '/webview/minutes-ai-layout-mobile': 2, '/webview/end-summary-mobile': 1 });
  assert.deepEqual(s.os_dist, { iOS: 3 });
  assert.deepEqual(s.source_type_dist, { onunhandledrejection: 2, manual: 1 });
  assert.deepEqual(s.host_version_dist, { '7.62.12': 2, unknown: 1 });
  assert.equal(s.distinct_sessions, 2);
});

test('scan 用注入 runner 产出候选并做族合并，某 BID 失败只记 skipped', async () => {
  const calls = [];
  const runner = (args) => {
    calls.push(args.join(' '));
    if (args.includes('vc_web')) throw new Error('errno=429004001 服务器负载高');
    if (args[0] === 'js-error' && args[1] === 'list') return fx('list-vc_ai.json');
    if (args[0] === 'log' && args[1] === 'query') return fx('log-query-938f8ba3.json');
    if (args[0] === 'log' && args[1] === 'detail') return fx('log-detail-938f8ba3.json');
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const r = await scan({ bids: ['vc_ai', 'vc_web'], hours: 24, top: 3, now: 1788853929000, runner });
  assert.deepEqual(r.skipped_bids.map((s) => s.bid), ['vc_web']);
  assert.equal(r.window.start, 1788853929 - 24 * 3600);
  const byId = Object.fromEntries(r.candidates.map((c) => [c.issue_id, c]));
  assert.equal(byId['938f8ba377ac6484ba8918b19f247350'].latest_event.mapped_path, 'vc-ai/src/utils/native.ts');
  assert.equal(byId['938f8ba377ac6484ba8918b19f247350'].latest_event.line, 196);
  assert.equal(byId['938f8ba377ac6484ba8918b19f247350'].project_dir, 'vc-ai');
  assert.equal(byId['938f8ba377ac6484ba8918b19f247350'].distinct_sessions, 2);
  assert.equal(byId['aaaed08b947f7c1730c780ec481b0cee'].family_users, 8441);
  assert.ok(calls.some((c) => c.startsWith('js-error list --bid vc_ai')));
  assert.ok(calls.some((c) => c.includes('--page-size 300')));
});
```

- [ ] **Step 3: 运行确认失败**

Run: `cd /Users/bytedance/Desktop/ceilf/ceilf6-skills/slardar-triage && node --test tests/scan.test.mjs`
Expected: FAIL，找不到 `../scripts/lib/family.mjs`。

- [ ] **Step 4: 实现 lib/cli.mjs**

```js
// slardar-web-cli 调用封装。--raw 让 CLI 直接吐平台 JSON，但进度提示可能先于 JSON 出现，
// 解析时从第一处 { 或 [ 起尝试。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const PROJECTS = {
  vc_ai: { directory: 'vc-ai', scmRepos: ['ee/lark/vc_ai', 'ee/lark/vc_ai_doubao'] },
  vc_web: { directory: 'vc-web', scmRepos: ['ee/lark/vc_web'] },
  vc_pages: { directory: 'vc-pages', scmRepos: ['ee/lark/vc_landing_pages'] },
};

export const UNRESOLVED_FILTER = JSON.stringify([{ filter_name: 'issue_status', op: 'in', values: ['未处理', '处理中'] }]);

export function resolveRepo(explicit) {
  return resolve(explicit ?? process.env.SLARDAR_TRIAGE_REPO ?? join(process.cwd(), '..', 'byteview-web'));
}

export function resolveBin(repo) {
  if (process.env.SLARDAR_WEB_CLI_BIN) return process.env.SLARDAR_WEB_CLI_BIN;
  const local = join(repo, 'node_modules', '.bin', 'slardar-web-cli');
  return existsSync(local) ? local : 'slardar-web-cli';
}

export function parseJsonOutput(output) {
  const lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const candidate = lines.slice(i).join('\n').trim();
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // 继续向下找 JSON 起点
    }
  }
  throw new Error(`无法从输出解析 JSON：${output.slice(0, 300)}`);
}

export function makeRunner(bin) {
  return (args) => {
    const r = spawnSync(bin, ['--raw', ...args], { encoding: 'utf8', env: process.env, maxBuffer: 50 * 1024 * 1024 });
    if (r.error) throw new Error(`${bin} 启动失败：${r.error.message}`);
    if (r.status !== 0) throw new Error(`${bin} 退出码 ${r.status}：${(r.stderr || r.stdout).trim().slice(0, 500)}`);
    return parseJsonOutput(r.stdout);
  };
}

export function normalizeSourcePath(filename, projectDirectory) {
  if (typeof filename !== 'string' || !filename || filename === '[native code]' || /^(https?:|blob:)/.test(filename)) return null;
  let source = filename.replace(/^webpack:\/\//, '').replace(/^\/+/g, '');
  const marker = `${projectDirectory}/`;
  const idx = source.indexOf(marker);
  if (idx >= 0) source = source.slice(idx + marker.length);
  source = source.replace(/^\.\//, '');
  const parts = [];
  for (const seg of `${projectDirectory}/${source}`.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  const normalized = parts.join('/');
  return normalized.includes('node_modules') ? null : normalized;
}
```

- [ ] **Step 5: 实现 lib/family.mjs**

```js
// 同一根因常带序号、logId 等易变后缀，分成多个 Issue；去掉后聚成一族，避免重复推荐。
const RULES = [
  [/_(\d+)(?=\s+timeout)/g, ''],
  [/logId=[0-9A-Za-z]+/g, 'logId=<id>'],
  [/ttLogId: Optional\("[^"]*"\)/g, 'ttLogId: <id>'],
  [/ttLogId: [0-9A-Za-z]+/g, 'ttLogId: <id>'],
  [/requestID: [^,]*/g, 'requestID: <id>'],
];

export function familyKey(message) {
  let key = String(message ?? '');
  for (const [re, rep] of RULES) key = key.replace(re, rep);
  return key.trim();
}
```

- [ ] **Step 6: 实现 lib/stats.mjs**

```js
export function flattenRows(logQueryResponse) {
  const rows = logQueryResponse?.data?.table_list ?? [];
  return rows.map((row) => {
    const m = row.metric_map ?? {};
    const v = (k) => (m[k] && typeof m[k] === 'object' ? m[k].value : m[k]) ?? '';
    return { pid: v('pid'), os: v('os'), release: v('release'), source_type: v('source_type'), session_id: v('session_id'), user_agent: v('user_agent'), timestamp: v('timestamp'), dh_key: v('dh_key') };
  });
}

function count(rows, pick) {
  const out = {};
  for (const r of rows) {
    const k = pick(r) || 'unknown';
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export function hostVersion(userAgent) {
  const m = /Lark\/([0-9.]+)/.exec(userAgent ?? '');
  return m ? m[1] : 'unknown';
}

export function summarize(rows) {
  return {
    pid_dist: count(rows, (r) => r.pid),
    os_dist: count(rows, (r) => r.os),
    release_dist: count(rows, (r) => r.release),
    source_type_dist: count(rows, (r) => r.source_type),
    host_version_dist: count(rows, (r) => hostVersion(r.user_agent)),
    distinct_sessions: new Set(rows.map((r) => r.session_id).filter(Boolean)).size,
  };
}
```

- [ ] **Step 7: 实现 scan.mjs**

```js
#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PROJECTS, UNRESOLVED_FILTER, makeRunner, normalizeSourcePath, resolveBin, resolveRepo } from './lib/cli.mjs';
import { familyKey } from './lib/family.mjs';
import { flattenRows, summarize } from './lib/stats.mjs';

const SAMPLE_SIZE = 300;

function commonArgs(bid, window) {
  return ['--bid', bid, '--env', 'online', '--site-type', 'web', '--start-time', String(window.start), '--end-time', String(window.end)];
}

function latestFrame(logDetail, projectDir) {
  let event = null;
  try {
    event = typeof logDetail?.data?.json === 'string' ? JSON.parse(logDetail.data.json) : logDetail?.data?.json;
  } catch {
    event = null;
  }
  const values = event?.stack?.values ?? [];
  const frames = values.flatMap((v) => v?.raw_stacktrace?.frames ?? []);
  const frame = frames.find((f) => normalizeSourcePath(f.filename, projectDir)) ?? frames[0] ?? null;
  const metric = logDetail?.data?.metric_map ?? {};
  const mv = (k) => (metric[k] && typeof metric[k] === 'object' ? metric[k].value : metric[k]) ?? '';
  return {
    page: event?.pid ?? mv('pid'),
    release: event?.release ?? mv('release'),
    source_type: mv('source_type'),
    raw_filename: frame?.filename ?? null,
    mapped_path: frame ? normalizeSourcePath(frame.filename, projectDir) : null,
    line: frame?.lineno ?? null,
    function: frame?.function ?? null,
  };
}

async function scanBid(bid, window, top, runner) {
  const project = PROJECTS[bid];
  const list = runner(['js-error', 'list', ...commonArgs(bid, window), '--filter', UNRESOLVED_FILTER, '--order-by', 'count_descend', '--page-size', String(top)]);
  const issues = list?.data?.result ?? [];
  const candidates = [];
  for (const issue of issues) {
    const query = runner(['log', 'query', ...commonArgs(bid, window), '--ev-type', 'js_error', '--filter', JSON.stringify([{ filter_name: 'issue_id', op: 'in', values: [issue.issue_id] }]), '--columns', 'pid,release,os,source_type,session_id,user_agent,dh_key', '--page-size', String(SAMPLE_SIZE), '--order-by', 'timestamp', '--order', 'desc', '--no-share']);
    const rows = flattenRows(query);
    const dhKey = rows[0]?.dh_key;
    const detail = dhKey ? runner(['log', 'detail', ...commonArgs(bid, window), '--ev-type', 'js_error', '--dh-key', dhKey, '--no-share']) : null;
    candidates.push({
      issue_id: issue.issue_id,
      family_key: familyKey(issue.message),
      member_issue_ids: [issue.issue_id],
      bid,
      project_dir: project.directory,
      scm_repos: project.scmRepos,
      message: issue.message,
      error_name: issue.name,
      filename: issue.filename,
      count: issue.count,
      users: issue.user,
      family_count: issue.count,
      family_users: issue.user,
      first_seen: issue.min_crash_time,
      status: issue.issue_status,
      ...summarize(rows),
      latest_event: latestFrame(detail, project.directory),
    });
  }
  return candidates;
}

function mergeFamilies(candidates) {
  const byKey = new Map();
  for (const c of candidates) {
    const key = `${c.bid}::${c.family_key}`;
    const head = byKey.get(key);
    if (!head) {
      byKey.set(key, c);
      continue;
    }
    head.member_issue_ids.push(c.issue_id);
    head.family_count += c.count;
    head.family_users += c.users;
  }
  return [...byKey.values()];
}

export async function scan({ bids, hours, top, repo, now = Date.now(), runner }) {
  const end = Math.floor(now / 1000);
  const window = { start: end - hours * 3600, end };
  const run = runner ?? makeRunner(resolveBin(resolveRepo(repo)));
  const skipped = [];
  let all = [];
  for (const bid of bids) {
    if (!PROJECTS[bid]) {
      skipped.push({ bid, reason: '不支持的 BID' });
      continue;
    }
    try {
      all = all.concat(await scanBid(bid, window, top, run));
    } catch (error) {
      skipped.push({ bid, reason: String(error.message ?? error).slice(0, 300) });
    }
  }
  return { scanned_at: new Date(now).toISOString(), window, skipped_bids: skipped, candidates: mergeFamilies(all) };
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = arg('--out');
  const result = await scan({
    bids: arg('--bid', 'vc_ai,vc_web,vc_pages').split(',').map((s) => s.trim()).filter(Boolean),
    hours: Number(arg('--hours', '24')),
    top: Number(arg('--top', '10')),
    repo: arg('--repo'),
  });
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, out: out ?? null, candidates: result.candidates.length, skipped_bids: result.skipped_bids })}\n`);
}
```

- [ ] **Step 8: 运行确认通过**

Run: `cd /Users/bytedance/Desktop/ceilf/ceilf6-skills/slardar-triage && node --test tests/scan.test.mjs`
Expected: 3 个测试 pass。

- [ ] **Step 9: 真实跑一次扫描（需要本机 JWT 有效）**

Run:
```bash
cd /Users/bytedance/Desktop/workspace/byteview-web-harness && node ~/.claude/skills/slardar-triage/scripts/scan.mjs --bid vc_ai --hours 24 --top 5 --out ~/.claude/skills/slardar-triage/state/scans/smoke.json
```
Expected: stdout 一行 `{"ok":true,"out":"…smoke.json","candidates":<=5,"skipped_bids":[]}`；打开文件确认 getAvatarBase64 族的 `latest_event.mapped_path` 形如 `vc-ai/src/utils/native.ts` 或 `vc-ai/src/utils/native-api/mobile-native-client.ts`（视线上版本）。JWT 失效时 stdout 的 `skipped_bids` 会带 `未完成 JWT` 字样，此时先 `npx -y agentbuddy get-jwt` 再重跑。

- [ ] **Step 10: Commit**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
git add slardar-triage/scripts slardar-triage/tests
git commit -m "feat(slardar-triage): 扫描脚本与族合并"
```

---

### Task 4: 参考文档

**Files:**
- Create: `slardar-triage/references/grading.md`
- Create: `slardar-triage/references/task-book-template.md`
- Create: `slardar-triage/references/meego-issue-fields.md`
- Create: `slardar-triage/references/example-report.md`

**Interfaces:**
- Produces: agent 在 SKILL.md 流程中按名引用这四份文件；`dispatch.sh` 校验任务书首行格式与 `task-book-template.md` 一致。

- [ ] **Step 1: 写 grading.md**

```markdown
# 定级判据

四档与本批次无关。users / count 不参与定档，只决定派发顺序。每条判据在报告里都要给出证据原文。

## A（自动派发）——两条同时满足

1. **前端可独立修**：`latest_event.mapped_path` 落在 `vc-ai/`、`vc-web/`、`vc-pages/` 或 `packages/` 下的源码文件；`mapped_path` 为 null（`[native code]`、`blob:`、CDN URL、node_modules）不算。
   证据格式：`帧 <mapped_path>:<line>（release <release>，页面 <page>）`。
2. **根因能定位到文件**：在 `<repo>` 的 `origin/master` 读该文件（`git show origin/master:<path>`），若线上帧位置在 master 已重构，用 `git log --follow`、`git grep` 找等价位置。写出「文件:行 + 一句话缺陷描述」。
   证据格式：`master <path>:<line> —— <一句话>`。

## B（只报告，等用户说「派这条」）

判据 1 满足，但读完代码仍写不出缺陷点位。典型：帧停在共享 throw、跨 await 丢失调用者且候选调用链多于一条。报告里列出候选调用链与各自依据。

## C（只列出）——任一成立

- message 含服务端错误码（`code: \d{6}`、`larkErrorCode`）、`invalid user`、`APINotProvided`。
- `pid_dist` 全部以 `/webview/doubao-` 开头。
- `latest_event.raw_filename` 为 `[native code]`。

## D（只列出）——任一成立

- message 以 `[warn]` 开头。
- master 上已有修复：`git log -S'<message 关键片段>' origin/master --oneline` 有命中，且线上 `release_dist` 的主版本早于该提交进入的 builds 分支版本（`git branch -r --contains <commit> | grep builds`）。

## 拿不准

一律 B。禁止把 B 往 A 靠。
```

- [ ] **Step 2: 写 task-book-template.md**

```markdown
交付说明:目标分支为 master(工作区分支 omh-base/{{slug}} 从 origin/master {{base_commit}} 切出,修复分支从它切出、MR 合回 master)。Meego issue:{{meego_url}}。MR 类型 bug。

# 修复 {{标题:一句话}}

## 1. 线上事实(Slardar,bid={{bid}},env=online,{{window_start}}–{{window_end}})

- Issue `{{issue_id}}`(同族:{{member_issue_ids}}),错误信息 `{{message}}`,上报文件 `{{filename}}`,状态 {{status}}。
- 24h {{family_count}} 次 / {{family_users}} 用户;首次出现 {{first_seen}}。
- {{sample_size}} 条事件抽样:页面 {{pid_dist}};系统 {{os_dist}};release {{release_dist}};source_type {{source_type_dist}};宿主版本 {{host_version_dist}};distinct session {{distinct_sessions}}。
- 结论:{{一段话:触发面与根因方向}}

## 2. 线上代码({{release}} = SCM {{scm_repo}},{{branch}},commit {{commit}})

- `{{path}}:{{line}}` {{函数}}:{{线上代码形态摘录与说明}}
- 该 commit 只用于说明线上事件对应的代码形态;所有改动都在 master 上做。

## 3. master 现状({{base_commit}},本任务改动基线)

- `{{path}}:{{line}}`:{{缺陷点位一句话}}
- {{其余相关文件与调用链,逐条列文件:行}}
- 既有测试载体:{{可参照的 *.test.ts 与写法}};单测命令 `cd {{project_dir}} && pnpm test <相对路径>`;impl 停止钩子实跑 `pnpm run typecheck && pnpm run test && pnpm --if-present --parallel run test-storybook`。

## 4. 根因与修法

触发器:{{单次/重复触发/竞态,用数据佐证}}
修法(最小抑制):
1. {{…}}

## 5. 验收标准

- AC1 首条红灯测试必须复现缺陷。复现步骤:{{构造方式}};改动前的实际表现:{{…}};期望表现:{{…}}。红灯失败摘要必须能对上这条。
- AC2 {{…}}
- ACn 范围:只改上述文件;不改 native 协议;不新增 i18n。

## 6. 范围外(如实上报,不在本 MR 处理)

- {{…}}
```

- [ ] **Step 3: 写 meego-issue-fields.md**

```markdown
# larksuite 空间缺陷（模板 4 普通缺陷）创建配方

命令：`bytedcli --json meego workitem create --project-key 5e96d7bff4e7c525510f9156 --work-item-type issue --fields '<json>'`

fields 数组，field_value 一律字符串；对象/数组先 JSON 字符串化：

| field_key | 含义 | 取值 |
|---|---|---|
| template | 模板 | `"4"` |
| name | 标题 | `"<一句话>"` |
| description | 描述 | 现象（Slardar 数据）/ 根因 / 修法 / Slardar 链接，URL 用 `[]` 包裹 |
| business | 业务线 | `"694269fe841acec8b67164b2"` |
| priority | 优先级 | `"2"`（P2） |
| field_4fd05c | 缺陷发现环境 | `"option_4"`（online） |
| issue_stage | 缺陷代码所在阶段 | `"stage_online"` |
| field_610176 | Bug 端分类 | os_dist 主项：iOS→`"option_2"`，Android→`"option_1"`，其余→`"option_3"`（PC）。`d300xvqMn` Web(Mobile) 对本业务线报 ErrOptionVisibilityUnmet，不可用 |
| field_2f21a0 | 缺陷发现版本 | multi-select：`"[{\"option_id\":\"<id>\"}]"`。id 用 `bytedcli --json meego workitem config field list --project-key 5e96d7bff4e7c525510f9156 --work-item-type issue --field-keys '["field_2f21a0"]'` 按 option_name 等于 release 主版本（如 `7.76`）查；查不到取最新的 `7.x` 项 |
| role_owners | 经办人 | `"[{\"role\":\"operator\",\"owners\":[\"7657492291354954694\"]}]"` |

应答：`data.result.content[0].text` 是字符串化 JSON `{"url","work_item_id"}`。对外一律改写成 `https://meego.larkoffice.com/larksuite/issue/detail/<work_item_id>`。

错误：`ErrFieldRequired` 会一次列全缺失字段；`field [x] is illegal` 多半是 multi-select 传了裸 option_id。
```

- [ ] **Step 4: 写 example-report.md**

用 2026-09-08 批次写成第 8 节格式的样例（数据取自本会话）：

```markdown
# 样例报告（2026-09-08 vc_ai 批次）

【本次派发】
A｜vc_ai｜common.getAvatarBase64_<n> timeout after 60s（族含 938f8ba3…）
  24h 45452 次 / 21740 用户；iOS 300/300；页面 minutes-ai-layout-mobile 256、doubao-ai-layout-mobile 23、ai-layout-mobile 11、end-summary-mobile 10；unhandledrejection 299/300；269 session/300 事件
  证据 1：帧 vc-ai/src/utils/native.ts:196（release 7.76.0.234，页面 minutes-ai-layout-mobile）
  证据 2：master vc-ai/src/services/transport-layer/mobile/chatter.ts:45 —— getAvatarUrl 直接 await 桥调用，无 catch、无缓存；services/chatter.ts:34 FetchQueue 头像链无 catch，拒绝逃逸为 unhandledrejection
  Meego：https://meego.larkoffice.com/larksuite/issue/detail/7374348254
  Task：task_20260908T085103Z_8f582c38（runtime traecli，workflow pc-web-bugfix）
  工作区：~/Desktop/workspace/omh-runs/avatar-timeout-2026-09-08
  预计约 3 小时；叫停：orchestrator task-cancel --task-id task_20260908T085103Z_8f582c38

【队列剩余 A 档】
（无）

【新增 B 档】
（无）

【C / D 档】
C｜vc_ai｜业务错误 code 220301 invalid user（族含 aaaed08b…、b1071995…）｜服务端错误码；页面 100% doubao-ai-layout-mobile
C｜vc_ai｜APINotProvided（族含 9491f36c…、24097171…、240971…）｜宿主未注入 API；帧在 React 渲染入口 / [native code]
D｜vc_ai｜[warn] FishBoneError: fishBone out of screen｜warn 级上报

【stale / 跳过】
（无）

【上一单进展】
task_20260908T085103Z_8f582c38：gen-test ✓ → impl ✓ → code-review ✗(打回) → impl@2 ✓ → code-review@2 ✓ → storybook-diff ✓(522/0) → handoff ✓
MR https://bits.bytedance.net/bytebus/devops/code/detail/8405910
```

- [ ] **Step 5: Commit**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
git add slardar-triage/references
git commit -m "docs(slardar-triage): 定级判据、任务书模板、Meego 字段配方与样例报告"
```

---

### Task 5: 派发脚本与 traex 启动/恢复

**Files:**
- Create: `slardar-triage/scripts/launch-traex.sh`
- Create: `slardar-triage/scripts/resume-traex.sh`
- Create: `slardar-triage/scripts/dispatch.sh`
- Create: `slardar-triage/tests/stubs/bytedcli`、`omh-cli`、`traecli`、`orchestrator`、`pnpm`、`git`（git 只在 stub PATH 下拦截 `worktree add` 与 `fetch`）
- Test: `slardar-triage/tests/test-dispatch.sh`

**Interfaces:**
- Consumes: `state.mjs` 的 `dispatched.json` 结构（`dispatched[issue_id] = { steps: {meego, worktree, task_book, launch, verify}, meego_url, meego_id, slug, workspace, task_book, host_log, task_id, dispatched_at, error }`）。
- Produces:
  - `dispatch.sh --state <dir> --issue-id <id> --slug <slug> --task-book <path> --meego-desc <path> --meego-name <text> --os <iOS|Android|PC> --release <x.y.z.n> [--repo <byteview-web>] [--runs-root <dir>]`，stdout 一行 JSON `{ ok, issue_id, step, meego_url, task_id, workspace, error }`；退出码 0 成功、3 有在跑的单、4 runtime 不符、1 其他失败。
  - `launch-traex.sh <workspace> <task-book> <workflow>`：脱管起 omh，stdout 打印 host log 路径。
  - `resume-traex.sh <workspace> <task-id> [stage]`。
  - 环境变量注入：`MEEGO_CMD`（默认 `bytedcli`）、`OMH_CLI`（默认 `omh-cli`）、`TRAECLI`（默认 `traecli`）、`ORCH`（默认 `orchestrator`）、`PNPM`（默认 `pnpm`）、`TASK_WAIT_SECONDS`（默认 1800）。

- [ ] **Step 1: 写 launch-traex.sh**

```bash
#!/usr/bin/env bash
# 用 traecli 无人值守发起一个 omh Task。宿主 runtime 从当前会话继承，所以 omh-loop 只能从
# traecli exec 里调；traecli exec 见 stdin 是管道会等 EOF，必须接 /dev/null。
# 用法: launch-traex.sh <workspace> <task-book> <workflow>
set -u
WS=$1; BOOK=$2; WF=$3
TRAECLI=${TRAECLI:-traecli}; OMH_CLI=${OMH_CLI:-omh-cli}
LOG="$(dirname "$WS")/$(basename "$WS")-host.log"
cd "$WS" || exit 1

echo "== $(date +%H:%M:%S) omh-cli setup ($WS)" >> "$LOG"
"$OMH_CLI" setup --agent traecli --scope project --config omh.config.yaml --no-ai-contrib >> "$LOG" 2>&1
echo "setup exit=$?" >> "$LOG"

PROMPT="\$oh-my-harness:omh-loop 在当前工作区创建并推进一个 omh Task。参数:task_input = 文件 $BOOK 的全文(先完整读取该文件,把内容原样作为任务正文传入 task-entry,不改写、不缩略;该任务书是唯一需求来源);--workflow $WF;--no-plan;--no-meego。创建成功后按 skill 流程走到 handoff_monitor,并用 \$oh-my-harness:stage-monitor 监控到终态。本会话无人值守:遇到 blocked / double_confirm 不要向用户提问,按任务书与 skill 纪律自行裁决(双确认 confirm,需要返工的用 user-message 回送具体缺口);环境类阻塞先等环境恢复后用 user-message 让它重跑就绪门,确实修不好就 unblock --decision fail 打回 impl,只有涉及产品级决策时才停下并在最终回复写明原因;全程不要在本会话里自己实现、测试或修改仓库代码。"

echo "== $(date +%H:%M:%S) traecli exec (workflow=$WF, book=$BOOK)" >> "$LOG"
(nohup bash -c '"$0" exec -y "$1" < /dev/null >> "$2" 2>&1; echo "== host exit=$?" >> "$2"' "$TRAECLI" "$PROMPT" "$LOG" >/dev/null 2>&1 &)
echo "$LOG"
```

- [ ] **Step 2: 写 resume-traex.sh**

```bash
#!/usr/bin/env bash
# 恢复 failed 的 omh Task。死于 code-review 时带 stage=impl(直接消费 pending-findings)。
# 用法: resume-traex.sh <workspace> <task-id> [stage]
set -u
WS=$1; TASK=$2; AT=${3:-}
TRAECLI=${TRAECLI:-traecli}
LOG="$(dirname "$WS")/$(basename "$WS")-host.log"
cd "$WS" || exit 1
AT_TEXT=""
[ -n "$AT" ] && AT_TEXT="恢复入口:从 ${AT} 阶段恢复,即调用 resume-task.mjs 时必须带 --at ${AT}(两个 token:\`--at\` 与 \`${AT}\`)。"
PROMPT="\$oh-my-harness:omh-resume 恢复当前工作区的 omh Task ${TASK}。${AT_TEXT}恢复后按 skill 交接给 \$oh-my-harness:stage-monitor 监控到终态。本会话无人值守:遇到 blocked / double_confirm 不要向用户提问,按任务书与 skill 纪律自行裁决;全程不要在本会话里自己实现、测试或修改仓库代码。"
echo "== $(date +%H:%M:%S) traecli resume ${TASK} ${AT}" >> "$LOG"
(nohup bash -c '"$0" exec -y "$1" < /dev/null >> "$2" 2>&1; echo "== resume host exit=$?" >> "$2"' "$TRAECLI" "$PROMPT" "$LOG" >/dev/null 2>&1 &)
echo "$LOG"
```

- [ ] **Step 3: 写 stubs**

`tests/stubs/bytedcli`：
```bash
#!/usr/bin/env bash
# 记录调用；create 返回固定 id；field list 返回一个 7.76 选项。
echo "bytedcli $*" >> "$STUB_STATE/calls"
case "$*" in
  *"workitem create"*) echo '{"status":"success","data":{"result":{"content":[{"type":"text","text":"{\"url\":\"https://meego.larkoffice.com/5e96/issue/detail/7374348254\",\"work_item_id\":7374348254}"}]}}}' ;;
  *"config field list"*) echo '{"status":"success","data":{"result":{"content":[{"type":"text","text":"{\"list\":[{\"field_key\":\"field_2f21a0\",\"option\":[{\"option_id\":\"c0dd860ab\",\"option_name\":\"7.76\"},{\"option_id\":\"68ea01dbd\",\"option_name\":\"7.77\"}]}]}"}]}}}' ;;
  *) echo '{"status":"success"}' ;;
esac
```

`tests/stubs/omh-cli`、`tests/stubs/traecli`：
```bash
#!/usr/bin/env bash
echo "$(basename "$0") $*" >> "$STUB_STATE/calls"
# traecli exec 的假实现：立刻在工作区造出一个 task 目录，模拟 omh-loop 建单。
if [ "$(basename "$0")" = traecli ] && [ "${1:-}" = exec ]; then
  mkdir -p "$PWD/.omh/tasks/task_stub/" && echo '{}' > "$PWD/.omh/tasks/task_stub/meta.json"
fi
exit 0
```

`tests/stubs/orchestrator`：
```bash
#!/usr/bin/env bash
echo "orchestrator $*" >> "$STUB_STATE/calls"
case "$1" in
  task-get) echo "{\"task\":{\"task_id\":\"task_stub\",\"phase\":\"running\",\"host\":{\"runtime\":\"${STUB_RUNTIME:-traecli}\"},\"extras\":{\"platform_workflow_key\":\"pc-web-bugfix\"}}}" ;;
  task-cancel) echo '{"ok":true}' ;;
esac
```

`tests/stubs/pnpm`：
```bash
#!/usr/bin/env bash
echo "pnpm $*" >> "$STUB_STATE/calls"
mkdir -p node_modules/.pnpm/a node_modules/.pnpm/b
```

`tests/stubs/git`：
```bash
#!/usr/bin/env bash
# 只拦截 worktree add 与 fetch，其余透传给真 git。
case "$*" in
  *"worktree add"*) echo "git $*" >> "$STUB_STATE/calls"; d=""; for a in "$@"; do case "$a" in /*) d="$a";; esac; done; mkdir -p "$d/node_modules/.pnpm"; echo "omh" > "$d/omh.config.yaml"; exit 0 ;;
  *"fetch origin"*) echo "git $*" >> "$STUB_STATE/calls"; exit 0 ;;
  *) exec /usr/bin/git "$@" ;;
esac
```

全部 `chmod +x tests/stubs/*`。

- [ ] **Step 4: 写失败测试 test-dispatch.sh**

```bash
#!/usr/bin/env bash
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
D="$HERE/../scripts/dispatch.sh"
export PATH="$HERE/stubs:$PATH"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

fixture() {
  T=$(mktemp -d); T=$(cd "$T" && pwd -P)
  export STUB_STATE="$T/stub"; mkdir -p "$STUB_STATE"
  REPO="$T/byteview-web"; mkdir -p "$REPO/node_modules/.pnpm/a" "$REPO/node_modules/.pnpm/b"
  git -C "$T" init -q "$REPO" >/dev/null 2>&1 || true
  STATE="$T/state"; mkdir -p "$STATE"; echo '{}' > "$STATE/dispatched.json"; echo '[]' > "$STATE/queue.json"; echo '{}' > "$STATE/skipped.json"
  BOOK="$T/book.md"; printf '交付说明:目标分支为 master(x)。Meego issue:{{meego_url}}。MR 类型 bug。\n\n# 修复 x\n' > "$BOOK"
  DESC="$T/desc.txt"; echo "desc" > "$DESC"
  RUNS="$T/runs"
  export TASK_WAIT_SECONDS=5
}
run_dispatch() {
  bash "$D" --state "$STATE" --issue-id i1 --slug avatar-2026-09-08 --task-book "$BOOK" --meego-desc "$DESC" --meego-name "n" --os iOS --release 7.76.0.234 --repo "$REPO" --runs-root "$RUNS"
}

echo "case 1: 全流程成功"
fixture
out=$(run_dispatch); rc=$?
[ $rc -eq 0 ] && ok "退出 0" || bad "退出 $rc: $out"
echo "$out" | grep -q '"task_id":"task_stub"' && ok "输出 task_id" || bad "无 task_id: $out"
grep -q "workitem create" "$STUB_STATE/calls" && ok "建了 Meego" || bad "未建 Meego"
grep -q '"field_2f21a0","field_value":"\[{\\"option_id\\":\\"c0dd860ab\\"}\]"' "$STUB_STATE/calls" && ok "发现版本映射 7.76" || bad "发现版本未映射: $(grep create "$STUB_STATE/calls")"
grep -q "Meego issue:https://meego.larkoffice.com/larksuite/issue/detail/7374348254" "$RUNS/tasks/avatar-2026-09-08.md" && ok "任务书 Meego URL 已替换为 larksuite 形态" || bad "任务书未替换"
grep -q "traecli exec" "$STUB_STATE/calls" && ok "经 traecli 起 omh" || bad "未起 traecli"
node -e "const d=require('$STATE/dispatched.json'); process.exit(d.i1 && d.i1.task_id==='task_stub' && d.i1.steps.verify==='done' ? 0 : 1)" && ok "state 落账" || bad "state 未落账"

echo "case 2: 幂等——再跑一次不重复建 Meego"
n_before=$(grep -c "workitem create" "$STUB_STATE/calls")
out=$(run_dispatch); rc=$?
n_after=$(grep -c "workitem create" "$STUB_STATE/calls")
[ $rc -eq 0 ] && [ "$n_before" = "$n_after" ] && ok "未重复建 Meego" || bad "重复建 Meego 或退出 $rc"

echo "case 3: 有在跑的单则拒绝"
fixture
mkdir -p "$RUNS/other/.omh/tasks/task_running"; echo '{"phase":"running"}' > "$RUNS/other/.omh/tasks/task_running/meta.json"
echo '{"i0":{"task_id":"task_running","workspace":"'"$RUNS/other"'","steps":{"verify":"done"}}}' > "$STATE/dispatched.json"
out=$(run_dispatch); rc=$?
[ $rc -eq 3 ] && ok "退出 3" || bad "退出 $rc: $out"

echo "case 4: runtime 不是 traecli 则 cancel 并退出 4"
fixture
export STUB_RUNTIME=claude
out=$(run_dispatch); rc=$?
[ $rc -eq 4 ] && ok "退出 4" || bad "退出 $rc: $out"
grep -q "task-cancel" "$STUB_STATE/calls" && ok "已 cancel" || bad "未 cancel"
unset STUB_RUNTIME

echo "case 5: 断点续跑——Meego 已建、worktree 失败后重跑从 worktree 继续"
fixture
echo '{"i1":{"steps":{"meego":"done"},"meego_url":"https://meego.larkoffice.com/larksuite/issue/detail/1","meego_id":"1","slug":"avatar-2026-09-08"}}' > "$STATE/dispatched.json"
out=$(run_dispatch); rc=$?
[ $rc -eq 0 ] && ok "续跑成功" || bad "续跑退出 $rc: $out"
grep -q "workitem create" "$STUB_STATE/calls" && bad "续跑重复建 Meego" || ok "续跑未建 Meego"

echo "pass=$PASS fail=$FAIL"
[ $FAIL -eq 0 ]
```

- [ ] **Step 5: 运行确认失败**

Run: `bash /Users/bytedance/Desktop/ceilf/ceilf6-skills/slardar-triage/tests/test-dispatch.sh`
Expected: 全部 FAIL（dispatch.sh 不存在）。

- [ ] **Step 6: 实现 dispatch.sh**

```bash
#!/usr/bin/env bash
# 派发单点：Meego → worktree → 任务书 → traex 起 omh → 核验 runtime → 落账。
# 每步完成写 dispatched.json[issue].steps.<step>=done，重跑跳过已完成步骤，副作用不重复。
# stdout 只输出一行 JSON；退出码：0 成功，3 有未到终态的单，4 runtime 不符，1 其他。
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
MEEGO_CMD=${MEEGO_CMD:-bytedcli}; OMH_CLI=${OMH_CLI:-omh-cli}; TRAECLI=${TRAECLI:-traecli}; ORCH=${ORCH:-orchestrator}; PNPM=${PNPM:-pnpm}
TASK_WAIT_SECONDS=${TASK_WAIT_SECONDS:-1800}
PK=5e96d7bff4e7c525510f9156
OWNER=7657492291354954694
WORKFLOW=pc-web-bugfix

state=""; issue=""; slug=""; book=""; desc=""; name=""; os=""; release=""; repo=""; runs=""
while [ $# -gt 0 ]; do
  case "$1" in
    --state) state=$2; shift 2;; --issue-id) issue=$2; shift 2;; --slug) slug=$2; shift 2;;
    --task-book) book=$2; shift 2;; --meego-desc) desc=$2; shift 2;; --meego-name) name=$2; shift 2;;
    --os) os=$2; shift 2;; --release) release=$2; shift 2;; --repo) repo=$2; shift 2;; --runs-root) runs=$2; shift 2;;
    *) echo "{\"ok\":false,\"error\":\"未知参数 $1\"}"; exit 1;;
  esac
done
repo=${repo:-$(cd "$PWD/../byteview-web" 2>/dev/null && pwd -P)}
runs=${runs:-$HOME/Desktop/workspace/omh-runs}
for v in state issue slug book desc name os release repo; do
  [ -n "${!v}" ] || { echo "{\"ok\":false,\"error\":\"缺少 --${v}\"}"; exit 1; }
done
DJ="$state/dispatched.json"; [ -f "$DJ" ] || echo '{}' > "$DJ"

# --- 账本读写（jq 单点） ---
get()  { jq -r --arg i "$issue" ".[\$i]$1 // empty" "$DJ"; }
set_() { local tmp; tmp=$(mktemp); jq --arg i "$issue" "(.[\$i] //= {}) | .[\$i]$1 = $2" "$DJ" > "$tmp" && mv "$tmp" "$DJ"; }
step_done() { [ "$(get ".steps.$1")" = done ]; }
fail() { set_ ".error" "$(jq -Rn --arg e "$2" '$e')"; echo "{\"ok\":false,\"issue_id\":\"$issue\",\"step\":\"$1\",\"error\":$(jq -Rn --arg e "$2" '$e')}"; exit "${3:-1}"; }

# --- 步骤 0：幂等与并发检查 ---
if step_done verify; then
  echo "{\"ok\":true,\"issue_id\":\"$issue\",\"step\":\"verify\",\"meego_url\":\"$(get .meego_url)\",\"task_id\":\"$(get .task_id)\",\"workspace\":\"$(get .workspace)\",\"reused\":true}"; exit 0
fi
while IFS=$'\t' read -r tid ws; do
  [ -n "$tid" ] && [ -n "$ws" ] || continue
  meta="$ws/.omh/tasks/$tid/meta.json"
  [ -f "$meta" ] || continue
  phase=$(jq -r '.phase // empty' "$meta")
  case "$phase" in completed|failed|cancelled|"") ;; *) fail precheck "已有未到终态的 Task $tid（phase=$phase，工作区 $ws），本次不派发" 3;; esac
done < <(jq -r 'to_entries[] | select(.value.task_id and .value.workspace) | [.value.task_id, .value.workspace] | @tsv' "$DJ")
set_ ".slug" "\"$slug\""

# --- 步骤 1：Meego ---
if ! step_done meego; then
  case "$os" in iOS) endopt=option_2;; Android) endopt=option_1;; *) endopt=option_3;; esac
  major=$(echo "$release" | cut -d. -f1,2)
  vid=$("$MEEGO_CMD" --json meego workitem config field list --project-key "$PK" --work-item-type issue --field-keys '["field_2f21a0"]' 2>/dev/null \
    | jq -r --arg m "$major" '.data.result.content[0].text | fromjson | .list[0].option | (map(select(.option_name == $m)) + map(select(.option_name | test("^7\\.[0-9]+$")))) | .[0].option_id // empty')
  [ -n "$vid" ] || fail meego "缺陷发现版本选项查不到（release $release）"
  fields=$(jq -cn --arg n "$name" --rawfile d "$desc" --arg e "$endopt" --arg v "$vid" --arg o "$OWNER" '[
    {field_key:"template",field_value:"4"},{field_key:"name",field_value:$n},{field_key:"description",field_value:$d},
    {field_key:"business",field_value:"694269fe841acec8b67164b2"},{field_key:"priority",field_value:"2"},
    {field_key:"field_4fd05c",field_value:"option_4"},{field_key:"issue_stage",field_value:"stage_online"},
    {field_key:"field_610176",field_value:$e},
    {field_key:"field_2f21a0",field_value:([{option_id:$v}]|tojson)},
    {field_key:"role_owners",field_value:([{role:"operator",owners:[$o]}]|tojson)}]')
  out=$("$MEEGO_CMD" --json meego workitem create --project-key "$PK" --work-item-type issue --fields "$fields" 2>&1)
  mid=$(echo "$out" | jq -r '.data.result.content[0].text | fromjson | .work_item_id // empty' 2>/dev/null)
  [ -n "$mid" ] || fail meego "Meego 创建失败：$(echo "$out" | head -c 400)"
  set_ ".meego_id" "\"$mid\""; set_ ".meego_url" "\"https://meego.larkoffice.com/larksuite/issue/detail/$mid\""; set_ ".steps.meego" '"done"'
fi
meego_url=$(get .meego_url)

# --- 步骤 2：worktree ---
ws="$runs/$slug"
if ! step_done worktree; then
  mkdir -p "$runs/tasks"
  git -C "$repo" fetch origin master >/dev/null 2>&1 || fail worktree "fetch origin master 失败"
  if [ ! -d "$ws" ]; then
    git -C "$repo" worktree add -b "omh-base/$slug" "$ws" origin/master >/dev/null 2>&1 || fail worktree "worktree add 失败：$ws"
  fi
  (cd "$ws" && "$PNPM" install --frozen-lockfile >/dev/null 2>&1) || fail worktree "pnpm install 失败"
  main_n=$(ls "$repo/node_modules/.pnpm" 2>/dev/null | wc -l | tr -d ' '); ws_n=$(ls "$ws/node_modules/.pnpm" 2>/dev/null | wc -l | tr -d ' ')
  [ "$ws_n" -ge $((main_n * 95 / 100)) ] || fail worktree "依赖不完整：主仓 $main_n / 工作区 $ws_n"
  set_ ".workspace" "\"$ws\""; set_ ".steps.worktree" '"done"'
fi

# --- 步骤 3：任务书 ---
final_book="$runs/tasks/$slug.md"
if ! step_done task_book; then
  sed "s#{{meego_url}}#$meego_url#g" "$book" > "$final_book"
  head -1 "$final_book" | grep -q "目标分支为 master" || fail task_book "任务书首行缺「目标分支为 master」"
  head -1 "$final_book" | grep -q "Meego issue:$meego_url" || fail task_book "任务书首行 Meego URL 未填入"
  head -1 "$final_book" | grep -q "MR 类型 bug" || fail task_book "任务书首行缺「MR 类型 bug」"
  set_ ".task_book" "\"$final_book\""; set_ ".steps.task_book" '"done"'
fi

# --- 步骤 4：起 omh ---
if ! step_done launch; then
  log=$(bash "$HERE/launch-traex.sh" "$ws" "$final_book" "$WORKFLOW")
  set_ ".host_log" "\"$log\""; set_ ".launched_at" "\"$(date -u +%FT%TZ)\""; set_ ".steps.launch" '"done"'
fi

# --- 步骤 5：等任务目录出现并核验 runtime ---
if ! step_done verify; then
  tid=""
  for _ in $(seq 1 $((TASK_WAIT_SECONDS / 5 + 1))); do
    tid=$(ls -td "$ws"/.omh/tasks/task_* 2>/dev/null | head -1 | xargs -n1 basename 2>/dev/null)
    [ -n "$tid" ] && break
    sleep 5
  done
  [ -n "$tid" ] || fail verify "等待 ${TASK_WAIT_SECONDS}s 未见任务目录，宿主日志：$(get .host_log)"
  tg=$(cd "$ws" && "$ORCH" task-get --task-id "$tid" 2>/dev/null)
  rt=$(echo "$tg" | jq -r '.task.host.runtime // empty'); wf=$(echo "$tg" | jq -r '.task.extras.platform_workflow_key // empty')
  if [ "$rt" != traecli ] || [ "$wf" != "$WORKFLOW" ]; then
    (cd "$ws" && "$ORCH" task-cancel --task-id "$tid" >/dev/null 2>&1)
    fail verify "runtime=$rt workflow=$wf 不符，已 cancel $tid" 4
  fi
  set_ ".task_id" "\"$tid\""; set_ ".dispatched_at" "\"$(date -u +%FT%TZ)\""; set_ ".steps.verify" '"done"'; set_ ".error" 'null'
fi

echo "{\"ok\":true,\"issue_id\":\"$issue\",\"step\":\"verify\",\"meego_url\":\"$meego_url\",\"task_id\":\"$(get .task_id)\",\"workspace\":\"$ws\",\"task_book\":\"$final_book\",\"host_log\":\"$(get .host_log)\"}"
```

`chmod +x scripts/*.sh`。

- [ ] **Step 7: 运行确认通过**

Run: `bash /Users/bytedance/Desktop/ceilf/ceilf6-skills/slardar-triage/tests/test-dispatch.sh`
Expected: 末行 `pass=N fail=0`。若 case 4 的 `task-cancel` 未被记录，检查 stub orchestrator 的 `case "$1"` 是否收到 `task-cancel`。

- [ ] **Step 8: Commit**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
git add slardar-triage/scripts slardar-triage/tests
git commit -m "feat(slardar-triage): 幂等派发脚本与 traex 启动/恢复"
```

---

### Task 6: progress.mjs 进展汇总

**Files:**
- Create: `slardar-triage/scripts/progress.mjs`
- Create: `slardar-triage/tests/fixtures/task-dir/`（一个精简的 omh Task 目录）
- Test: `slardar-triage/tests/progress.test.mjs`

**Interfaces:**
- Consumes: `dispatched.json` 里的 `workspace` 与 `task_id`；omh Task 目录布局（实测 0.1.94）：`meta.json.phase`；`sessions/<sid>/session.json.status`；`sessions/<sid>/stages/<n>-<name>[@attempt]/system/result.json` 含 `verdict` 与 `summary`；`sessions/<sid>/stages/*/system/code-deliveries.jsonl` 每行含 `delivery_url`。task 级 `logs/omh-events.jsonl` 只有 task 事件，没有阶段事件，不用它。
- Produces: `summarizeTask(taskDir) → { phase, session_status, stages: [{order, name, attempt, verdict, summary}], mr_url }`；CLI `node progress.mjs --state <dir> [--issue-id <id>]`，默认取最近 `dispatched_at` 的一条，stdout 一行 JSON `{ ok, issue_id, task_id, workspace, meego_url, host_alive, phase, session_status, stages, mr_url }`。

- [ ] **Step 1: 写目录 fixture**

```bash
F=/Users/bytedance/Desktop/ceilf/ceilf6-skills/slardar-triage/tests/fixtures/task-dir
mkdir -p "$F/sessions/20260908T165159/stages/1-gen-test/system" "$F/sessions/20260908T165159/stages/3-code-review/system" "$F/sessions/20260908T165159/stages/5-code-review@2/system" "$F/sessions/20260908T165159/stages/7-handoff/system"
echo '{"task_id":"task_stub","phase":"completed"}' > "$F/meta.json"
echo '{"sid":"20260908T165159","status":"passed"}' > "$F/sessions/20260908T165159/session.json"
echo '{"stage_id":"1","verdict":"passed","summary":"gen-test red tests"}' > "$F/sessions/20260908T165159/stages/1-gen-test/system/result.json"
echo '{"stage_id":"3","verdict":"failed","summary":"requested changes"}' > "$F/sessions/20260908T165159/stages/3-code-review/system/result.json"
echo '{"stage_id":"5","verdict":"passed","summary":"approved"}' > "$F/sessions/20260908T165159/stages/5-code-review@2/system/result.json"
echo '{"stage_id":"7","verdict":"passed","summary":"created bug MR"}' > "$F/sessions/20260908T165159/stages/7-handoff/system/result.json"
echo '{"repository":"x","branch":"bugfix/x","commit":"abc","delivery_url":"https://bits.bytedance.net/bytebus/devops/code/detail/8405910"}' > "$F/sessions/20260908T165159/stages/7-handoff/system/code-deliveries.jsonl"
```

- [ ] **Step 2: 写失败测试**

`tests/progress.test.mjs`：
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { summarizeTask } from '../scripts/progress.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('summarizeTask 读 meta/session/stages 给出阶段序列与 MR', () => {
  const s = summarizeTask(join(here, 'fixtures', 'task-dir'));
  assert.equal(s.phase, 'completed');
  assert.equal(s.session_status, 'passed');
  assert.deepEqual(
    s.stages.map((x) => `${x.name}@${x.attempt}:${x.verdict}`),
    ['gen-test@1:passed', 'code-review@1:failed', 'code-review@2:passed', 'handoff@1:passed'],
  );
  assert.equal(s.mr_url, 'https://bits.bytedance.net/bytebus/devops/code/detail/8405910');
});

test('summarizeTask 对不存在的目录返回 unknown', () => {
  const s = summarizeTask(join(mkdtempSync(join(tmpdir(), 'pg-')), 'nope'));
  assert.deepEqual(s, { phase: 'unknown', session_status: 'unknown', stages: [], mr_url: null });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `cd /Users/bytedance/Desktop/ceilf/ceilf6-skills/slardar-triage && node --test tests/progress.test.mjs`
Expected: FAIL，找不到 `../scripts/progress.mjs`。

- [ ] **Step 4: 实现 progress.mjs**

```js
#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadState } from './state.mjs';

function readJson(file, fallback) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}

// 阶段目录名形如 `3-code-review` 或 `5-code-review@2`：序号-阶段名[@重试次数]。
function parseStageDir(name) {
  const m = /^(\d+)-(.+?)(?:@(\d+))?$/.exec(name);
  return m ? { order: Number(m[1]), name: m[2], attempt: m[3] ? Number(m[3]) : 1 } : null;
}

export function summarizeTask(taskDir) {
  const empty = { phase: 'unknown', session_status: 'unknown', stages: [], mr_url: null };
  if (!existsSync(taskDir)) return empty;
  const phase = readJson(join(taskDir, 'meta.json'), {}).phase ?? 'unknown';
  const sessionsDir = join(taskDir, 'sessions');
  const sids = existsSync(sessionsDir) ? readdirSync(sessionsDir).sort() : [];
  const sid = sids[sids.length - 1];
  if (!sid) return { ...empty, phase };
  const sessionDir = join(sessionsDir, sid);
  const sessionStatus = readJson(join(sessionDir, 'session.json'), {}).status ?? 'unknown';
  const stagesDir = join(sessionDir, 'stages');
  const stages = [];
  let mrUrl = null;
  for (const dir of existsSync(stagesDir) ? readdirSync(stagesDir) : []) {
    const parsed = parseStageDir(dir);
    if (!parsed) continue;
    const result = readJson(join(stagesDir, dir, 'system', 'result.json'), {});
    stages.push({ ...parsed, verdict: result.verdict ?? 'running', summary: result.summary ?? '' });
    const deliveries = join(stagesDir, dir, 'system', 'code-deliveries.jsonl');
    if (existsSync(deliveries)) {
      for (const line of readFileSync(deliveries, 'utf8').split('\n')) {
        const url = readJsonLine(line)?.delivery_url;
        if (url) mrUrl = url;
      }
    }
  }
  stages.sort((a, b) => a.order - b.order);
  return { phase, session_status: sessionStatus, stages, mr_url: mrUrl };
}

function readJsonLine(line) {
  try {
    return line.trim() ? JSON.parse(line) : null;
  } catch {
    return null;
  }
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const state = loadState(arg('--state'));
  const entries = Object.entries(state.dispatched).filter(([, d]) => d.task_id && d.workspace);
  const wanted = arg('--issue-id');
  const picked = wanted
    ? entries.find(([id]) => id === wanted)
    : entries.sort((a, b) => (b[1].dispatched_at ?? '').localeCompare(a[1].dispatched_at ?? ''))[0];
  if (!picked) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: '没有已派发的 Task' })}\n`);
    process.exit(0);
  }
  const [issueId, d] = picked;
  const summary = summarizeTask(join(d.workspace, '.omh', 'tasks', d.task_id));
  const alive = spawnSync('pgrep', ['-f', 'traecli exec'], { encoding: 'utf8' }).status === 0;
  process.stdout.write(`${JSON.stringify({ ok: true, issue_id: issueId, task_id: d.task_id, workspace: d.workspace, meego_url: d.meego_url ?? null, host_alive: alive, ...summary })}\n`);
}
```

- [ ] **Step 5: 运行确认通过**

Run: `cd /Users/bytedance/Desktop/ceilf/ceilf6-skills/slardar-triage && node --test tests/progress.test.mjs`
Expected: 2 个测试 pass。

- [ ] **Step 6: 对真实 Task 核一次并把首单记入处置账**

写入 `~/.claude/skills/slardar-triage/state/dispatched.json`：
```json
{"938f8ba377ac6484ba8918b19f247350":{"steps":{"meego":"done","worktree":"done","task_book":"done","launch":"done","verify":"done"},"slug":"avatar-timeout-r1","meego_id":"7374348254","meego_url":"https://meego.larkoffice.com/larksuite/issue/detail/7374348254","workspace":"/Users/bytedance/Desktop/workspace/omh-eval/web-avatar-timeout-r1","task_book":"/Users/bytedance/Desktop/workspace/omh-eval/tasks/web-avatar-timeout-r1.md","host_log":"/Users/bytedance/Desktop/workspace/omh-eval/web-avatar-timeout-r1-host.log","task_id":"task_20260908T085103Z_8f582c38","dispatched_at":"2026-09-08T08:51:03Z"}}
```
Run: `node ~/.claude/skills/slardar-triage/scripts/progress.mjs --state ~/.claude/skills/slardar-triage/state`
Expected: `phase` 为 `completed`，`session_status` 为 `passed`，`stages` 为 gen-test、impl、code-review(failed)、impl@2、code-review@2、storybook-diff、handoff 共 7 项，`mr_url` 为 8405910 的链接。这条记录保留：它是真实处置账首条，下次扫描会据此排除该族。

- [ ] **Step 7: Commit**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
git add slardar-triage/scripts/progress.mjs slardar-triage/tests
git commit -m "feat(slardar-triage): omh 进展汇总"
```

---

### Task 7: SKILL.md 编排正文与端到端演练

**Files:**
- Modify: `slardar-triage/SKILL.md`

**Interfaces:**
- Consumes: Task 2–6 全部脚本的 CLI 形态与 references。

- [ ] **Step 1: 写 SKILL.md 正文**

```markdown
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
bytedcli meego whoami 2>/dev/null || bytedcli --json meego user search --project-key 5e96d7bff4e7c525510f9156 --user-keys '["wangjinghong.ceilf6"]'
command -v traecli omh-cli orchestrator
git -C <repo> fetch origin master
```
失败对应的补法：JWT → 让用户在本机执行 `npx -y agentbuddy get-jwt`；Meego → `bytedcli meego login`；PATH 缺 → 报缺哪个；fetch 失败 → 报网络/权限。

### 2. 扫描

```bash
node <skill>/scripts/scan.mjs --bid <bids> --hours <hours> --top <top> --repo <repo> --out <state>/scans/scan-$(date -u +%Y%m%dT%H%M%SZ).json
```
读输出文件。`skipped_bids` 非空要写进报告。

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
2. 写 Meego 描述文件（现象 / 根因 / 修法 / Slardar 链接，URL 用 `[]` 包裹）。
3. 派发：
```bash
bash <skill>/scripts/dispatch.sh --state <state> --issue-id <id> --slug <kebab-摘要>-$(date +%F) --task-book <任务书路径> --meego-desc <描述文件> --meego-name "<Meego 标题>" --os <os_dist 主项> --release <release_dist 主项> --repo <repo>
```
退出 3：报告写「有在跑的单」并附其进展；退出 4：报告标红「runtime 不符已 cancel」，不重试；退出 1：报告写停在哪一步，下次唤醒会续派。
4. 成功后用 `<skill>/scripts/state.mjs` 的 `markDispatched` 把该条移出队列（同样用 `node -e` 调用，传 dispatch.sh 输出的 task_id / workspace / meego_url）。

### 7. 报告

`botmux send` 一条消息，五块，按 `<skill>/references/example-report.md` 的格式：本次派发（A 档两条证据、Meego、Task ID、工作区、预计约 3 小时、叫停命令 `orchestrator task-cancel --task-id <id>`）；队列剩余 A 档；新增 B 档（写根因未定位的原因与候选调用链）；C/D 档一行一条；stale 与跳过；上一单进展（`progress.mjs`）。

## 纪律

- omh 永远经 `traecli exec` 起（dispatch.sh 内置），不在本会话直接调 `$oh-my-harness:omh-loop`。
- 定档不看 users / count；拿不准一律 B。
- 每步脚本失败都如实写进报告，不跳步、不重试建 Meego。
- 停摆恢复：phase=failed 且死于 code-review → `bash <skill>/scripts/resume-traex.sh <workspace> <task_id> impl`；其他节点省略第三个参数。执行后在报告里写动作与理由。
```

- [ ] **Step 2: 端到端 dry-run**

Run（在机器人 cwd 下模拟）：
```bash
cd /Users/bytedance/Desktop/workspace/byteview-web-harness
node ~/.claude/skills/slardar-triage/scripts/scan.mjs --bid vc_ai,vc_web,vc_pages --hours 24 --top 10 --out ~/.claude/skills/slardar-triage/state/scans/e2e.json
```
Expected: `ok:true`，三个 BID 无 skipped（或只有 429 的那一个），候选中 getAvatarBase64 族（若 24h 内仍在发生）的 `mapped_path` 非 null；豆包 invalid user 族 `pid_dist` 全部 `/webview/doubao-…`；FishBoneError 族 message 以 `[warn]` 开头。按 grading.md 手工核对：前者应判 A（若 Task 6 Step 5 已把它记进 dispatched，则 merge 时被排除）、中者 C、后者 D。

- [ ] **Step 3: 全量测试**

Run: `bash /Users/bytedance/Desktop/ceilf/ceilf6-skills/slardar-triage/tests/run.sh`
Expected: 全部 pass，退出 0。

- [ ] **Step 4: 行文自查**

Run: `python3 ~/.claude/skills/human-writing/scripts/check_prose.py /Users/bytedance/Desktop/ceilf/ceilf6-skills/slardar-triage/SKILL.md | head -3`
Expected: 翻案句 / 黑话 / 模型路标 / 洞察路标等硬指标全 0；冒号与破折号属结构放行。

- [ ] **Step 5: Commit**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
git add slardar-triage/SKILL.md
git commit -m "feat(slardar-triage): 编排正文与端到端演练"
```

- [ ] **Step 6: 在飞书话题里真实唤醒一次（用户在场）**

在机器人话题里发「扫一下线上告警，只看不派」，确认报告五块齐全、定档与 example-report 一致；再发「看看进度」确认能读到 task_8f582c38 的终态与 MR。
