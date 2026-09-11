# slardar-triage 呈现优先、派单显式 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 默认唤醒只扫描、判断 web 侧改动可能性并逐条详细呈现；建 Meego / 起 omh / 登记看板只在用户显式「派这条 …，补充：…」后执行。

**Architecture:** `state.mjs` 从「队列」改成「候选池」（candidates.json，pending / dispatched / rejected）；`scan.mjs` 多产出 Issue 详情页 `issue_url`；SKILL.md 重写编排：默认路径零副作用，派单路径复用 dispatch.sh 并把用户补充写进任务书与 Meego 描述。dispatch.sh / board.sh / progress.mjs 机制不动。

**Tech Stack:** Node 24 ESM + node:test、bash 3.2、现有 stub 测试。

## Global Constraints

- 默认唤醒零副作用：不建 Meego、不起 omh、不登记看板；只写 `state/`。
- 派单必须带用户补充；补充为空先问，不猜。
- 可能性四档（高 / 中 / 低 / 排除）只影响排序与展开，不触发动作；同档按 24h 族用户数排序。
- `issue_url` 形态：`https://slardar.bytedance.net/node/web/js/detail?env=online&bid=<bid>&lang=zh&start_time=<窗口起>&end_time=<窗口止>&site_type=web&region=cn&issue_id=<issue_id>&layout=normal&release=<最新事件 release>`；release 未知时省略该参数。
- `state/candidates.json` 条目：`{ issue_id, family_key, bid, message, member_issue_ids, issue_url, slardar_url, likelihood, summary, users, count, first_seen_at, refreshed_at, stale_count, status, decision }`；pending 连续两次缺席移出，dispatched / rejected 不移出。
- 删除 `queue.json`、`skipped.json`、`--max-dispatch`、`--dry-run`。`dispatched.json` 保留给 dispatch.sh / board.sh / progress.mjs。
- 任务书「## 0. 人工确认信息（<日期>）」在「## 1. 线上事实」之前；Meego 描述末尾「【人工确认】」段。
- bash 3.2：`$VAR` 紧邻全角字符必须 `${VAR}`。

---

## 文件结构

```
slardar-triage/
  SKILL.md                         # 重写（Task 3）
  scripts/state.mjs                # 候选池（Task 1）
  scripts/scan.mjs                 # + issue_url（Task 2）
  scripts/progress.mjs             # loadState 契约不变，无改动
  references/likelihood.md         # 原 grading.md 改名重写（Task 3）
  references/task-book-template.md # + 第 0 节（Task 3）
  references/example-report.md     # 按新格式重写（Task 3）
  tests/state.test.mjs             # 重写（Task 1）
  tests/scan.test.mjs              # + issue_url 断言（Task 2）
  state/candidates.json            # Task 4 迁移
```

---

### Task 1: state.mjs 候选池

**Files:**
- Modify: `slardar-triage/scripts/state.mjs`（整文件重写）
- Modify: `slardar-triage/tests/state.test.mjs`（整文件重写）

**Interfaces:**
- Produces：
  - `loadState(dir) → { candidates: Record<issueId, Candidate>, dispatched: Record<issueId, Dispatch> }`；`saveState(dir, state)` 写 `candidates.json` 与 `dispatched.json`。
  - `mergeScan(state, scanned, now) → { state, removed: Candidate[] }`：scanned 为 scan.mjs 的 candidates；池中已有且本次出现的刷新 `users / count / issue_url / slardar_url / member_issue_ids / refreshed_at`、`stale_count=0`；本次出现且池中没有的以 `status:"pending"`、`likelihood:null` 新建；本次未出现的 pending 条目 `stale_count+1`，达到 2 移出并放进 `removed`；dispatched / rejected 不动。同族（family_key 相同）已有 dispatched / rejected 条目的新 issue 不新建。
  - `setJudgment(state, issueId, { likelihood: '高'|'中'|'低'|'排除', summary: string })`。
  - `pendingSorted(state) → Candidate[]`：status=pending，按档位（高 → 中 → 低 → 排除，null 最后）再按 users 降序。
  - `reject(state, issueId, reason, now)`、`markDispatched(state, issueId, { task_id, supplement, at })`。
  - CLI：`node state.mjs pending --dir <state>`（stdout 一行 JSON 数组）、`node state.mjs reject --dir <state> --issue-id <id> --reason <text>`、`node state.mjs judge --dir <state> --issue-id <id> --likelihood <档> --summary <text>`、`node state.mjs dispatched --dir <state> --issue-id <id> --task-id <id> --supplement <text>`。
- progress.mjs 只用 `state.dispatched`，契约不变。

- [ ] **Step 1: 重写失败测试**

`slardar-triage/tests/state.test.mjs`：
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState, mergeScan, setJudgment, pendingSorted, reject, markDispatched } from '../scripts/state.mjs';

const scanned = (over = {}) => ({ issue_id: 'i1', family_key: 'f1', bid: 'vc_ai', message: 'm', member_issue_ids: ['i1'], family_users: 200, family_count: 5000, first_seen: 1788000000000, issue_url: 'u1', slardar_url: 's1', ...over });
const empty = () => ({ candidates: {}, dispatched: {} });

test('空目录加载得到空状态，保存后可回读', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  assert.deepEqual(loadState(dir), empty());
  const s = empty();
  s.candidates.i1 = { issue_id: 'i1', status: 'pending' };
  saveState(dir, s);
  assert.equal(loadState(dir).candidates.i1.status, 'pending');
});

test('mergeScan 新候选入池为 pending，已有条目刷新影响数与链接', () => {
  let { state } = mergeScan(empty(), [scanned()], '2026-09-10T00:00:00Z');
  assert.equal(state.candidates.i1.status, 'pending');
  assert.equal(state.candidates.i1.likelihood, null);
  assert.equal(state.candidates.i1.first_seen_at, '2026-09-10T00:00:00Z');
  ({ state } = mergeScan(state, [scanned({ family_users: 300, issue_url: 'u2', member_issue_ids: ['i1', 'i9'] })], '2026-09-11T00:00:00Z'));
  assert.equal(state.candidates.i1.users, 300);
  assert.equal(state.candidates.i1.issue_url, 'u2');
  assert.deepEqual(state.candidates.i1.member_issue_ids, ['i1', 'i9']);
  assert.equal(state.candidates.i1.refreshed_at, '2026-09-11T00:00:00Z');
  assert.equal(state.candidates.i1.first_seen_at, '2026-09-10T00:00:00Z');
});

test('mergeScan 对缺席的 pending 记 stale，连续两次移出；dispatched / rejected 不移出', () => {
  let { state } = mergeScan(empty(), [scanned(), scanned({ issue_id: 'i2', family_key: 'f2' }), scanned({ issue_id: 'i3', family_key: 'f3' })], 't0');
  markDispatched(state, 'i2', { task_id: 't', supplement: 'x', at: 't0' });
  reject(state, 'i3', '不修', 't0');
  let r = mergeScan(state, [], 't1');
  assert.equal(r.state.candidates.i1.stale_count, 1);
  assert.deepEqual(r.removed, []);
  r = mergeScan(r.state, [], 't2');
  assert.equal(r.state.candidates.i1, undefined);
  assert.deepEqual(r.removed.map((c) => c.issue_id), ['i1']);
  assert.equal(r.state.candidates.i2.status, 'dispatched');
  assert.equal(r.state.candidates.i3.status, 'rejected');
});

test('mergeScan 同族已 dispatched / rejected 的新 issue 不再入池', () => {
  let { state } = mergeScan(empty(), [scanned()], 't0');
  markDispatched(state, 'i1', { task_id: 't', supplement: 'x', at: 't0' });
  ({ state } = mergeScan(state, [scanned({ issue_id: 'i7', family_key: 'f1' })], 't1'));
  assert.equal(state.candidates.i7, undefined);
});

test('setJudgment 与 pendingSorted 按档位再按用户数排序，null 档位最后', () => {
  let { state } = mergeScan(empty(), [
    scanned({ issue_id: 'a', family_key: 'fa', family_users: 10 }),
    scanned({ issue_id: 'b', family_key: 'fb', family_users: 900 }),
    scanned({ issue_id: 'c', family_key: 'fc', family_users: 500 }),
    scanned({ issue_id: 'd', family_key: 'fd', family_users: 999 }),
  ], 't0');
  setJudgment(state, 'a', { likelihood: '高', summary: 'sa' });
  setJudgment(state, 'b', { likelihood: '中', summary: 'sb' });
  setJudgment(state, 'c', { likelihood: '高', summary: 'sc' });
  assert.deepEqual(pendingSorted(state).map((c) => c.issue_id), ['c', 'a', 'b', 'd']);
  assert.equal(state.candidates.a.summary, 'sa');
});

test('reject 与 markDispatched 记录决策并改状态，之后不再出现在 pending', () => {
  let { state } = mergeScan(empty(), [scanned()], 't0');
  reject(state, 'i1', '宿主问题', 't1');
  assert.deepEqual(state.candidates.i1.decision, { reason: '宿主问题', at: 't1' });
  assert.deepEqual(pendingSorted(state), []);
  ({ state } = mergeScan(empty(), [scanned()], 't0'));
  markDispatched(state, 'i1', { task_id: 'task_x', supplement: 'native 已确认', at: 't2' });
  assert.equal(state.candidates.i1.status, 'dispatched');
  assert.equal(state.candidates.i1.decision.task_id, 'task_x');
  assert.equal(state.dispatched.i1.task_id, 'task_x');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/bytedance/Desktop/ceilf/ceilf6-skills/slardar-triage && node --test tests/state.test.mjs 2>&1 | grep -E "ℹ (pass|fail)"`
Expected: fail ≥ 1（导出名不存在）。

- [ ] **Step 3: 重写 state.mjs**

```js
#!/usr/bin/env node
// 候选池与处置账的唯一读写点。candidates.json 是 agent 呈现给用户、由用户决策的池子；
// dispatched.json 是 dispatch.sh / board.sh / progress.mjs 共用的派单处置账，两者按 issue_id 对齐。
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const FILES = { candidates: 'candidates.json', dispatched: 'dispatched.json' };
// pending 连续两次扫描都不再出现才移出：一次缺席可能只是 Slardar 采样或时间窗边界。
const STALE_REMOVE_AT = 2;
export const LIKELIHOOD_ORDER = ['高', '中', '低', '排除'];

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function loadState(dir) {
  return {
    candidates: readJson(join(dir, FILES.candidates), {}),
    dispatched: readJson(join(dir, FILES.dispatched), {}),
  };
}

export function saveState(dir, state) {
  mkdirSync(dir, { recursive: true });
  for (const [key, file] of Object.entries(FILES)) {
    writeFileSync(join(dir, file), `${JSON.stringify(state[key] ?? {}, null, 2)}\n`);
  }
}

function fromScan(c, now) {
  return {
    issue_id: c.issue_id,
    family_key: c.family_key,
    bid: c.bid,
    message: c.message,
    member_issue_ids: c.member_issue_ids ?? [c.issue_id],
    issue_url: c.issue_url ?? null,
    slardar_url: c.slardar_url ?? null,
    users: c.family_users ?? c.users ?? 0,
    count: c.family_count ?? c.count ?? 0,
    first_seen: c.first_seen ?? null,
    likelihood: null,
    summary: '',
    first_seen_at: now,
    refreshed_at: now,
    stale_count: 0,
    status: 'pending',
    decision: null,
  };
}

export function mergeScan(state, scanned, now) {
  const pool = { ...state.candidates };
  const seen = new Set();
  const settledFamilies = new Set(Object.values(pool).filter((c) => c.status !== 'pending').map((c) => c.family_key));
  for (const c of scanned) {
    seen.add(c.issue_id);
    const cur = pool[c.issue_id];
    if (cur) {
      pool[c.issue_id] = {
        ...cur,
        users: c.family_users ?? c.users ?? cur.users,
        count: c.family_count ?? c.count ?? cur.count,
        issue_url: c.issue_url ?? cur.issue_url,
        slardar_url: c.slardar_url ?? cur.slardar_url,
        member_issue_ids: c.member_issue_ids ?? cur.member_issue_ids,
        refreshed_at: now,
        stale_count: 0,
      };
      continue;
    }
    if (settledFamilies.has(c.family_key)) continue;
    pool[c.issue_id] = fromScan(c, now);
  }
  const removed = [];
  for (const [id, c] of Object.entries(pool)) {
    if (seen.has(id) || c.status !== 'pending') continue;
    const stale = (c.stale_count ?? 0) + 1;
    if (stale >= STALE_REMOVE_AT) {
      removed.push(c);
      delete pool[id];
    } else {
      pool[id] = { ...c, stale_count: stale };
    }
  }
  return { state: { ...state, candidates: pool }, removed };
}

export function setJudgment(state, issueId, { likelihood, summary }) {
  const c = state.candidates[issueId];
  if (!c) throw new Error(`候选池里没有 ${issueId}`);
  if (!LIKELIHOOD_ORDER.includes(likelihood)) throw new Error(`档位只能是 ${LIKELIHOOD_ORDER.join('/')}：${likelihood}`);
  state.candidates[issueId] = { ...c, likelihood, summary: summary ?? '' };
}

export function pendingSorted(state) {
  const rank = (l) => (LIKELIHOOD_ORDER.includes(l) ? LIKELIHOOD_ORDER.indexOf(l) : LIKELIHOOD_ORDER.length);
  return Object.values(state.candidates)
    .filter((c) => c.status === 'pending')
    .sort((a, b) => rank(a.likelihood) - rank(b.likelihood) || (b.users ?? 0) - (a.users ?? 0));
}

export function reject(state, issueId, reason, now) {
  const c = state.candidates[issueId];
  if (!c) throw new Error(`候选池里没有 ${issueId}`);
  state.candidates[issueId] = { ...c, status: 'rejected', decision: { reason, at: now } };
}

export function markDispatched(state, issueId, { task_id, supplement, at }) {
  const c = state.candidates[issueId];
  if (!c) throw new Error(`候选池里没有 ${issueId}`);
  state.candidates[issueId] = { ...c, status: 'dispatched', decision: { task_id, supplement: supplement ?? '', at } };
  state.dispatched[issueId] = { ...(state.dispatched[issueId] ?? {}), task_id };
}

function isMain() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// 技能目录经 symlink 安装，argv[1] 是链接路径而 import.meta.url 是真实路径，须按 realpath 比较。
if (isMain()) {
  const cmd = process.argv[2];
  const dir = arg('--dir');
  if (!dir) {
    process.stderr.write('用法: state.mjs pending|judge|reject|dispatched --dir <state> [--issue-id <id>] [--likelihood <档>] [--summary <text>] [--reason <text>] [--task-id <id>] [--supplement <text>]\n');
    process.exit(2);
  }
  const state = loadState(dir);
  const now = new Date().toISOString();
  try {
    if (cmd === 'pending') {
      process.stdout.write(`${JSON.stringify(pendingSorted(state))}\n`);
    } else if (cmd === 'judge') {
      setJudgment(state, arg('--issue-id'), { likelihood: arg('--likelihood'), summary: arg('--summary') ?? '' });
      saveState(dir, state);
      process.stdout.write(`${JSON.stringify({ ok: true, issue_id: arg('--issue-id'), likelihood: arg('--likelihood') })}\n`);
    } else if (cmd === 'reject') {
      reject(state, arg('--issue-id'), arg('--reason') ?? '', now);
      saveState(dir, state);
      process.stdout.write(`${JSON.stringify({ ok: true, rejected: arg('--issue-id') })}\n`);
    } else if (cmd === 'dispatched') {
      markDispatched(state, arg('--issue-id'), { task_id: arg('--task-id'), supplement: arg('--supplement') ?? '', at: now });
      saveState(dir, state);
      process.stdout.write(`${JSON.stringify({ ok: true, dispatched: arg('--issue-id') })}\n`);
    } else {
      process.stderr.write(`未知子命令: ${cmd}\n`);
      process.exit(2);
    }
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(error.message ?? error) })}\n`);
    process.exit(1);
  }
}
```

- [ ] **Step 4: 运行确认通过，并确认 progress 测试不受影响**

Run: `cd /Users/bytedance/Desktop/ceilf/ceilf6-skills/slardar-triage && node --test tests/state.test.mjs tests/progress.test.mjs 2>&1 | grep -E "ℹ (pass|fail)"`
Expected: pass 9，fail 0。

- [ ] **Step 5: Commit**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
git add slardar-triage/scripts/state.mjs slardar-triage/tests/state.test.mjs
git commit -m "feat(slardar-triage): 队列改为候选池,决策归用户"
```

---

### Task 2: scan.mjs 产出 Issue 详情页链接

**Files:**
- Modify: `slardar-triage/scripts/scan.mjs`
- Modify: `slardar-triage/tests/scan.test.mjs`

**Interfaces:**
- Produces：候选新增 `issue_url`（字符串），形态见 Global Constraints；`latest_event.release` 为空时不带 `release` 参数。

- [ ] **Step 1: 加失败断言**

在 `tests/scan.test.mjs` 第一个 `scan` 测试里、`assert.equal(byId['938f8ba377ac6484ba8918b19f247350'].latest_event.mapped_path, ...)` 之前插入：
```js
  assert.equal(
    byId['938f8ba377ac6484ba8918b19f247350'].issue_url,
    `https://slardar.bytedance.net/node/web/js/detail?env=online&bid=vc_ai&lang=zh&start_time=${1788853929 - 24 * 3600}&end_time=1788853929&site_type=web&region=cn&issue_id=938f8ba377ac6484ba8918b19f247350&layout=normal&release=7.76.0.234`,
  );
```
在第二个 `scan` 测试（detail 全失败的 r2）末尾追加：
```js
  assert.equal(
    r2.candidates[0].issue_url,
    `https://slardar.bytedance.net/node/web/js/detail?env=online&bid=vc_ai&lang=zh&start_time=${1788853929 - 24 * 3600}&end_time=1788853929&site_type=web&region=cn&issue_id=aaaed08b947f7c1730c780ec481b0cee&layout=normal`,
  );
```
（r2 用 top=1，list 首条是 aaaed08b；detail 全失败时 `latest_event.release` 为空串，不带 release。）

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/bytedance/Desktop/ceilf/ceilf6-skills/slardar-triage && node --test tests/scan.test.mjs 2>&1 | grep -E "ℹ (pass|fail)"`
Expected: fail 2。

- [ ] **Step 3: 实现**

在 `scan.mjs` 的 `shareLink` 函数之后加：
```js
// Issue 详情页是用户与 native 同学看上下文的入口；release 参数让页面直接定位到最新事件所在版本。
function issueDetailUrl(bid, window, issueId, release) {
  const params = new URLSearchParams({
    env: 'online', bid, lang: 'zh', start_time: String(window.start), end_time: String(window.end),
    site_type: 'web', region: 'cn', issue_id: issueId, layout: 'normal',
  });
  if (release) params.set('release', release);
  return `https://slardar.bytedance.net/node/web/js/detail?${params.toString()}`;
}
```
在 `scanBid` 里把 `candidates.push({ ... })` 改为先算 `latest`：
```js
    const latest = latestFrame(detail, project.directory);
    candidates.push({
      detail_error,
      issue_id: issue.issue_id,
      ...（其余字段不变）...
      slardar_url: shareLink(bid, window, issue.issue_id, textRunner),
      issue_url: issueDetailUrl(bid, window, issue.issue_id, latest.release),
      latest_event: latest,
    });
```

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/bytedance/Desktop/ceilf/ceilf6-skills/slardar-triage && node --test tests/scan.test.mjs 2>&1 | grep -E "ℹ (pass|fail)"`
Expected: pass 4，fail 0。

- [ ] **Step 5: Commit**

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
git add slardar-triage/scripts/scan.mjs slardar-triage/tests/scan.test.mjs
git commit -m "feat(slardar-triage): 扫描产出 Slardar Issue 详情页链接"
```

---

### Task 3: 参考文档与 SKILL.md 重写

**Files:**
- Rename: `slardar-triage/references/grading.md` → `slardar-triage/references/likelihood.md`（重写）
- Modify: `slardar-triage/references/task-book-template.md`（加第 0 节）
- Modify: `slardar-triage/references/example-report.md`（重写）
- Modify: `slardar-triage/SKILL.md`（重写）

- [ ] **Step 1: likelihood.md**

```markdown
# web 侧改动可能性

四档只决定排序与是否展开详细信息，不触发任何动作。每档的判据要在报告里给出证据原文。

- **高**：`latest_event.mapped_path` 落在 `vc-ai/`、`vc-web/`、`vc-pages/`、`packages/` 源码（不是 `[native code]`、`blob:`、CDN URL、node_modules），且在 `<repo>` 的 `origin/master` 读到对应文件（`git show origin/master:<path>`，帧位置已重构时用 `git log --follow` / `git grep` 找等价位置）并能写出「文件:行 + 一句话缺陷描述」。
- **中**：帧在我们仓源码，但读完代码写不出单一缺陷点位（共享 throw、跨 await 丢失调用者且候选调用链多于一条）。报告里列候选调用链。
- **低**：任一成立——message 含服务端错误码（`code: \d{6}`、`larkErrorCode`）、`invalid user`、`APINotProvided`；`pid_dist` 全部以 `/webview/doubao-` 开头；`latest_event.raw_filename` 为 `[native code]`。
- **排除**：任一成立——message 以 `[warn]` 开头；`git log -S'<关键片段>' origin/master --oneline` 查到修复提交且线上 `release_dist` 主版本早于该提交进入的 builds 分支版本。
- 拿不准归中。同档内按 24h 族用户数降序。

高、中两档展开详细信息（栏目见 SKILL.md 第 4 步）；低、排除各一行。
```
`git mv references/grading.md references/likelihood.md` 后写入。

- [ ] **Step 2: task-book-template.md 加第 0 节**

在 `# 修复 {{标题:一句话}}` 之后、`## 1. 线上事实` 之前插入：
```markdown
## 0. 人工确认信息({{date}})

{{用户在「派这条」指令里给的补充,原样收录:native 侧同学的结论、leader 对 web 侧是否动手的口径、范围边界}}

以上是本任务的范围边界,与第 4 节修法冲突时以本节为准。
```

- [ ] **Step 3: example-report.md 重写**

```markdown
# 样例报告（2026-09-08 vc_ai 批次，按呈现优先格式）

【候选清单】

高｜vc_ai｜common.getAvatarBase64_<n> timeout after 60s（族含 938f8ba3…）
  Issue：https://slardar.bytedance.net/node/web/js/detail?env=online&bid=vc_ai&lang=zh&start_time=1788767529&end_time=1788853929&site_type=web&region=cn&issue_id=938f8ba377ac6484ba8918b19f247350&layout=normal&release=7.76.0.234
  状态 unassigned；首次出现 2026-08-04
  24h 45452 次 / 21740 用户 / 抽样 269 session
  分布：页面 minutes-ai-layout-mobile 256、doubao-ai-layout-mobile 23、ai-layout-mobile 11、end-summary-mobile 10；系统 iOS 300/300；release 7.76.0.234 277、1.0.0.360 23；宿主版本 unknown 300；source_type unhandledrejection 299、manual 1
  最新帧：vc-ai/src/utils/native.ts:196（页面 minutes-ai-layout-mobile，release 7.76.0.234 → ee/lark/vc_ai builds/beta/7.76.0 c1a21610）
  master 点位：vc-ai/src/services/transport-layer/mobile/chatter.ts:45 —— getAvatarUrl 直接 await 桥调用，无 catch、无缓存；services/chatter.ts:34 FetchQueue 头像链无 catch，拒绝逃逸为 unhandledrejection
  根因假设：
    web 侧可独立解释：拒绝未捕获、无缓存导致同一 session 165+ 次请求、60s 超时过长
    依赖 native：iOS 宿主对 common.getAvatarBase64 完全不回调，原因未知
  要向 native 确认：
    1. iOS 端 common.getAvatarBase64 在什么条件下不回调（avatarKey 无效？用户不可见？bridge 未注册？）
    2. 不回调的宿主版本范围，是否集中在某个 Lark 版本
    3. native 侧是否有修复计划；若有，web 侧是否只需兜底
  若在 web 侧动手：mobile/chatter.ts 与 doubao-chatter.ts 加缓存与兜底、mobile-bridge.ts 给该请求设短超时、services/chatter.ts 与 minutes-end-summary-mobile.tsx 补 catch；不动 native 协议
  不确定点：master 上超时文案已改为 `[native-api] … timed out after 60000ms`，7.77 起 Slardar 会以新文案聚合

低｜vc_ai｜业务错误 code 220301 invalid user（族含 aaaed08b…、b1071995…）｜服务端错误码；页面 100% doubao-ai-layout-mobile｜Issue：https://slardar.bytedance.net/node/web/js/detail?…issue_id=aaaed08b947f7c1730c780ec481b0cee…
低｜vc_ai｜APINotProvided（族含 9491f36c…、24097171…）｜宿主未注入 API；帧在 React 渲染入口 / [native code]｜Issue：…
排除｜vc_ai｜[warn] FishBoneError: fishBone out of screen｜warn 级上报｜Issue：…

【已派单进展】
（无）

【已拒绝 / 自动移出】
（无）

【本次未扫】
vc_web、vc_pages：Slardar 账号缺 kani 角色（role_bid_vc_web / role_bid_vc_pages），申请链接见扫描输出

【下一步】
确认后回复「派这条 938f8ba3，补充：<native 结论 / leader 口径>」；不修回复「这条不修 938f8ba3，原因：…」
```

- [ ] **Step 4: SKILL.md 重写**

```markdown
---
name: slardar-triage
description: 扫描 Slardar 近 24h 线上 JS 错误（vc_ai/vc_web/vc_pages），按 web 侧改动可能性排序并逐条详细呈现（Issue 链接、分布、代码点位、根因假设、要向 native 确认的问题），决策交给用户；只有用户说「派这条 <issue>，补充：<敲定的细节>」才建 Meego、经 traecli 起 omh、登记看板。当用户说「扫一下线上告警」「看看 Slardar」「挑一个告警看看」「派这条」「这条不修」「看看进度」时使用。
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

参数：`--bid`（默认 `vc_ai,vc_web,vc_pages`）、`--hours`（24）、`--top`（10）。

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
`skipped_bids` 非空写进报告第 4 块；候选 `detail_error` 非空说明 Sourcemap 没取到，档位按中处理并把原因写进详细信息的「不确定点」。

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

`botmux send` 一条消息，按 `<skill>/references/example-report.md` 的五块：候选清单；已派单进展（`progress.mjs`）；已拒绝 / 自动移出；本次未扫的 BID；下一步一行。

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
```

- [ ] **Step 5: 行文自查与提交**

Run: `python3 ~/.claude/skills/human-writing/scripts/check_prose.py /Users/bytedance/Desktop/ceilf/ceilf6-skills/slardar-triage/SKILL.md | sed -n 2p`
Expected: 硬指标全 0。

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
git add slardar-triage/SKILL.md slardar-triage/references
git commit -m "docs(slardar-triage): 编排改为呈现优先、派单显式"
```

---

### Task 4: 状态迁移与端到端演练

**Files:**
- Modify（本机，不进仓库）: `~/.claude/skills/slardar-triage/state/candidates.json`、删除 `queue.json`、`skipped.json`

- [ ] **Step 1: 迁移已派两单进候选池**

```bash
S=~/.claude/skills/slardar-triage/state
node -e '
import("'$HOME'/.claude/skills/slardar-triage/scripts/state.mjs").then((m) => {
  const s = m.loadState(process.argv[1]);
  const seed = [
    { issue_id: "938f8ba377ac6484ba8918b19f247350", family_key: "common.getAvatarBase64 timeout after 60s", bid: "vc_ai", message: "common.getAvatarBase64_<n> timeout after 60s", member_issue_ids: ["938f8ba377ac6484ba8918b19f247350"], family_users: 0, family_count: 0 },
    { issue_id: "b1071995655bbebf583ae422aa64c7ae", family_key: "[InvokeServierPBFast error]: logId=<id>, invalid user", bid: "vc_ai", message: "[InvokeServierPBFast error]: logId=<id>, invalid user", member_issue_ids: ["b1071995655bbebf583ae422aa64c7ae"], family_users: 0, family_count: 0 },
  ];
  const { state } = m.mergeScan(s, seed, "2026-09-08T08:51:03Z");
  m.setJudgment(state, seed[0].issue_id, { likelihood: "高", summary: "移动端头像拉取无 catch 无缓存,60s 超时未捕获" });
  m.setJudgment(state, seed[1].issue_id, { likelihood: "高", summary: "AI 布局鱼骨图拉取失败未捕获" });
  m.markDispatched(state, seed[0].issue_id, { task_id: "task_20260908T085103Z_8f582c38", supplement: "(迁移前派单,无人工确认信息)", at: "2026-09-08T08:51:03Z" });
  m.markDispatched(state, seed[1].issue_id, { task_id: "task_20260909T033115Z_2e93a1b9", supplement: "(迁移前派单,无人工确认信息)", at: "2026-09-09T03:31:19Z" });
  m.saveState(process.argv[1], state);
  console.log(JSON.stringify(Object.fromEntries(Object.entries(state.candidates).map(([k, v]) => [k.slice(0, 8), v.status]))));
})' "$S"
rm -f "$S/queue.json" "$S/skipped.json"
```
Expected: `{"938f8ba3":"dispatched","b1071995":"dispatched"}`；`dispatched.json` 原有字段保留（markDispatched 只合并 task_id）。

- [ ] **Step 2: 真实扫描 + 合并**

在 `/Users/bytedance/Desktop/workspace/byteview-web-harness` 下跑 SKILL.md 第 2、3 步，Expected：`merge-latest.json` 的 `pending` 不含上述两个 issue（同族也不含 aaaed08b 之外的 b1071995 族成员），其余候选 `likelihood` 为 null、`issue_url` 以 `https://slardar.bytedance.net/node/web/js/detail?` 开头且含 `issue_id=`。

- [ ] **Step 3: 全量测试**

Run: `bash /Users/bytedance/Desktop/ceilf/ceilf6-skills/slardar-triage/tests/run.sh 2>&1 | grep -E "ℹ (pass|fail)|pass="`
Expected: 全 pass。

- [ ] **Step 4: 旧 spec 加取代说明**

在 `docs/superpowers/specs/2026-09-08-slardar-triage-design.md` 第 4 行 `状态：待用户评审` 改为 `状态：第 4、6、7、8、9 节的自动派发已被 2026-09-11-slardar-triage-report-first-design.md 取代`。

```bash
cd /Users/bytedance/Desktop/ceilf/ceilf6-skills
git add docs/superpowers/specs/2026-09-08-slardar-triage-design.md
git commit -m "docs(slardar-triage): 旧 spec 标记被取代"
```
