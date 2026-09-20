# slardar-triage 单条极简呈现 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `/slardar-triage` 默认只呈现一条最可能在 vc-ai 内修复、且无人在途的告警（现象 + 报错 + 链接），随后一次一问引导用户收敛技术方案；量级与分布不展示但每次扫描全量记台账，派单与修复见效时沉淀飞书。

**Architecture:** 选取的机械部分（低 / 排除规则、在途覆盖、排序）与台账读写全部下沉到 `scripts/state.mjs` 的新子命令，agent 只对短名单逐条读代码验证到第一条通过为止。呈现、引导式收敛、派单门槛是 `SKILL.md` 与 `references/` 的文字约束。`scan.mjs`、`dispatch.sh`、`progress.mjs`、`board.sh` 不动。

**Tech Stack:** Node ≥ 18 ESM（无第三方依赖）、`node:test`、bash。

**Spec:** `docs/superpowers/specs/2026-09-20-slardar-triage-single-pick-design.md`

## Global Constraints

- 所有路径相对仓库根 `/Users/bytedance/Desktop/ceilf/ceilf6-skills`；技能目录 `slardar-triage/`。
- 开工前从 `main` 切分支：`git switch -c feat/slardar-triage-single-pick`。只提交 `slardar-triage/` 下的改动；`docs/superpowers/` 下的 spec / plan **不提交、不推送**。
- `slardar-triage/state/` 在 `.gitignore` 里，是本机运行数据；Task 5 对它的修改不进 git。
- 所有脚本 stdout 只有一行 JSON；失败时 `{ ok: false, error }` 且退出码 1；用法错误退出码 2。
- 代码注释只写长期有效的原因 / 约束 / 不变量，以首次打开文件的读者视角陈述现状，不写「新增了 / 改为 / 不再」这类变更叙事。
- 测试命令：`node --test slardar-triage/tests/state.test.mjs`；全量：`bash slardar-triage/tests/run.sh`。
- 呈现格式固定三行：`现象：` / `报错：` / `Issue：`，不含量级、分布、代码路径、根因、改法。
- 修复见效阈值：`recovery.ratio ≤ 0.2`。
- commit message 末尾带 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

## File Structure

| 文件 | 职责 |
|---|---|
| `slardar-triage/scripts/state.mjs` | 候选池、处置账、台账的唯一读写点。新增导出：`readLedger` `ledgerRows` `appendLedger` `mergeFromScan` `pick` `cover` `setFixPaths` `markMerged` `markSedimented` `flight` `history`；`markDispatched` 增 `fix_paths`。新增子命令：`merge` `pick` `cover` `fix-paths` `merged` `sedimented` `flight` `history` |
| `slardar-triage/tests/state.test.mjs` | 上述全部的单测 |
| `slardar-triage/SKILL.md` | 入口表、主流程、引导式收敛、派单、纪律 |
| `slardar-triage/references/likelihood.md` | 选取规则（脚本预筛 + agent 验证） |
| `slardar-triage/references/example-report.md` | 三行呈现、收敛对话、技术方案回显、无候选一句话的样例 |
| `slardar-triage/references/task-book-template.md` | 第 0 节占位说明 |

---

### Task 1: 台账与 `merge` 子命令

**Files:**
- Modify: `slardar-triage/scripts/state.mjs`
- Test: `slardar-triage/tests/state.test.mjs`

**Interfaces:**
- Consumes: 现有 `loadState(dir)` `saveState(dir, state)` `mergeScan(state, scanned, now)` `pendingSorted(state)`。
- Produces:
  - `readLedger(dir): object[]` —— 读 `<dir>/ledger.jsonl`，文件不存在返回 `[]`。
  - `ledgerRows(state, scanned, now): object[]` —— 每个扫描候选一行：`{ at, bid, issue_id, owner_issue_id, family_key, member_issue_ids, family_count, family_users, distinct_sessions, pid_top, os_top, release_top, host_version_top, source_type_top, status }`，`*_top` 是 `[键, 次数]` 或 `null`。
  - `appendLedger(dir, rows): number` —— 追加，按 `at|issue_id` 去重，返回实际追加行数。
  - `mergeFromScan(dir, scan): { pending: number, removed: number, ledger_appended: number }` —— `scan` 是 `scan.mjs` 的输出对象（用到 `scan.candidates`、`scan.scanned_at`）。
  - CLI：`state.mjs merge --dir <state> --scan <scan.json>`。

- [ ] **Step 1: 写失败测试**

把 `slardar-triage/tests/state.test.mjs` 顶部的 import 两行替换为：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadState, saveState, mergeScan, setJudgment, pendingSorted, reject, markDispatched,
  readLedger, ledgerRows, appendLedger, mergeFromScan,
} from '../scripts/state.mjs';

const STATE_CLI = fileURLToPath(new URL('../scripts/state.mjs', import.meta.url));
const cli = (...args) => JSON.parse(execFileSync(process.execPath, [STATE_CLI, ...args], { encoding: 'utf8' }));
```

在 `const empty = …` 之后加：

```js
const T0 = '2026-09-10T00:00:00.000Z';
const T1 = '2026-09-11T00:00:00.000Z';
const T2 = '2026-09-12T00:00:00.000Z';
const snap = (over = {}) => scanned({
  distinct_sessions: 285,
  detail_error: null,
  pid_dist: { '/webview/ai-layout': 256, '/webview/minutes-ai-layout-pc': 43 },
  os_dist: { Windows: 224, Mac: 76 },
  release_dist: { '7.77.0.21': 299 },
  host_version_dist: { '8.0.3': 116, '7.76.21': 76 },
  source_type_dist: { onunhandledrejection: 300 },
  latest_event: { raw_filename: 'webpack://@byteview-web/vc-ai/./src/services/ai-layout.ts', mapped_path: 'vc-ai/src/services/ai-layout.ts', line: 271, function: 'getMeetingAISummary', page: '/webview/ai-layout', release: '7.77.0.21' },
  ...over,
});
```

在文件末尾追加：

```js
test('ledgerRows 每个扫描候选一行，带分布主项与池内状态；同族未入池的新 issue 记同族候选的状态', () => {
  const { state } = mergeScan(empty(), [snap()], T0);
  markDispatched(state, 'i1', { task_id: 't', supplement: 'x', at: T0 });
  const rows = ledgerRows(state, [snap(), snap({ issue_id: 'i7', member_issue_ids: ['i7'] })], T1);
  assert.deepEqual(rows[0], {
    at: T1,
    bid: 'vc_ai',
    issue_id: 'i1',
    owner_issue_id: 'i1',
    family_key: 'f1',
    member_issue_ids: ['i1'],
    family_count: 5000,
    family_users: 200,
    distinct_sessions: 285,
    pid_top: ['/webview/ai-layout', 256],
    os_top: ['Windows', 224],
    release_top: ['7.77.0.21', 299],
    host_version_top: ['8.0.3', 116],
    source_type_top: ['onunhandledrejection', 300],
    status: 'dispatched',
  });
  assert.equal(rows[1].issue_id, 'i7');
  assert.equal(rows[1].owner_issue_id, 'i1');
  assert.equal(rows[1].status, 'dispatched');
});

test('ledgerRows 对缺分布的候选记 null，对池里找不到归属的记 unknown', () => {
  const rows = ledgerRows(empty(), [scanned()], T0);
  assert.equal(rows[0].pid_top, null);
  assert.equal(rows[0].distinct_sessions, 0);
  assert.equal(rows[0].status, 'unknown');
  assert.equal(rows[0].owner_issue_id, 'i1');
});

test('appendLedger 只追加不改写，同一 at|issue_id 不重复写', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  assert.deepEqual(readLedger(dir), []);
  const { state } = mergeScan(empty(), [snap()], T0);
  assert.equal(appendLedger(dir, ledgerRows(state, [snap()], T0)), 1);
  assert.equal(appendLedger(dir, ledgerRows(state, [snap()], T0)), 0);
  assert.equal(appendLedger(dir, ledgerRows(state, [snap({ family_count: 9 })], T1)), 1);
  assert.deepEqual(readLedger(dir).map((r) => [r.at, r.family_count]), [[T0, 5000], [T1, 9]]);
});

test('mergeFromScan 落候选池、台账与 merge-latest.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const out = mergeFromScan(dir, { scanned_at: T0, candidates: [snap(), snap({ issue_id: 'i2', family_key: 'f2' })] });
  assert.deepEqual(out, { pending: 2, removed: 0, ledger_appended: 2 });
  assert.equal(loadState(dir).candidates.i2.status, 'pending');
  assert.equal(readLedger(dir).length, 2);
  const latest = JSON.parse(readFileSync(join(dir, 'scans', 'merge-latest.json'), 'utf8'));
  assert.deepEqual(latest.pending.map((c) => c.issue_id).sort(), ['i1', 'i2']);
  assert.deepEqual(latest.removed, []);
});

test('CLI merge 输出一行 JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const scanFile = join(dir, 'scan.json');
  writeFileSync(scanFile, JSON.stringify({ scanned_at: T0, candidates: [snap()] }));
  assert.deepEqual(cli('merge', '--dir', dir, '--scan', scanFile), { ok: true, pending: 1, removed: 0, ledger_appended: 1 });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test slardar-triage/tests/state.test.mjs`
Expected: FAIL，报 `The requested module '../scripts/state.mjs' does not provide an export named 'appendLedger'`（或同类导出缺失）。

- [ ] **Step 3: 实现**

`slardar-triage/scripts/state.mjs`：

把 fs 的 import 行改为：

```js
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
```

把文件头两行注释改为：

```js
// 候选池、处置账与台账的唯一读写点。candidates.json 是 agent 从中选取、由用户决策的池子；
// dispatched.json 是 dispatch.sh / board.sh / progress.mjs 共用的派单处置账，两者按 issue_id 对齐；
// ledger.jsonl 是每次扫描每族一行的量级台账。
```

在 `const STALE_REMOVE_AT = 2;` 之后加：

```js
// 候选池里的 count / users 会被后续扫描覆盖，事后要取「修复前 → 修复后」量级只能靠这份只追加的台账。
const LEDGER = 'ledger.jsonl';
```

在 `markDispatched` 之后、`function isMain()` 之前加：

```js
function topOf(dist) {
  const entry = Object.entries(dist ?? {}).sort((a, b) => b[1] - a[1])[0];
  return entry ? [entry[0], entry[1]] : null;
}

export function readLedger(dir) {
  const file = join(dir, LEDGER);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

// 同族已结案的新 issue 不入池（见 mergeScan），它的量级记在同族候选名下，status 取那条候选的。
export function ledgerRows(state, scanned, now) {
  const pool = Object.values(state.candidates);
  return scanned.map((c) => {
    const owner = state.candidates[c.issue_id] ?? pool.find((p) => p.family_key === c.family_key);
    return {
      at: now,
      bid: c.bid,
      issue_id: c.issue_id,
      owner_issue_id: owner?.issue_id ?? c.issue_id,
      family_key: c.family_key,
      member_issue_ids: c.member_issue_ids ?? [c.issue_id],
      family_count: c.family_count ?? c.count ?? 0,
      family_users: c.family_users ?? c.users ?? 0,
      distinct_sessions: c.distinct_sessions ?? 0,
      pid_top: topOf(c.pid_dist),
      os_top: topOf(c.os_dist),
      release_top: topOf(c.release_dist),
      host_version_top: topOf(c.host_version_dist),
      source_type_top: topOf(c.source_type_dist),
      status: owner?.status ?? 'unknown',
    };
  });
}

export function appendLedger(dir, rows) {
  const have = new Set(readLedger(dir).map((r) => `${r.at}|${r.issue_id}`));
  const fresh = rows.filter((r) => !have.has(`${r.at}|${r.issue_id}`));
  if (fresh.length) {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, LEDGER), fresh.map((r) => `${JSON.stringify(r)}\n`).join(''));
  }
  return fresh.length;
}

export function mergeFromScan(dir, scan) {
  const { state, removed } = mergeScan(loadState(dir), scan.candidates, scan.scanned_at);
  saveState(dir, state);
  const appended = appendLedger(dir, ledgerRows(state, scan.candidates, scan.scanned_at));
  const pending = pendingSorted(state);
  mkdirSync(join(dir, 'scans'), { recursive: true });
  writeFileSync(join(dir, 'scans', 'merge-latest.json'), `${JSON.stringify({ pending, removed }, null, 2)}\n`);
  return { pending: pending.length, removed: removed.length, ledger_appended: appended };
}
```

CLI 部分：在 `if (cmd === 'pending') {` 这个分支**之前**插入 `merge` 分支（把原来的 `if` 改成 `else if`）：

```js
    if (cmd === 'merge') {
      const scan = JSON.parse(readFileSync(arg('--scan'), 'utf8'));
      process.stdout.write(`${JSON.stringify({ ok: true, ...mergeFromScan(dir, scan) })}\n`);
    } else if (cmd === 'pending') {
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test slardar-triage/tests/state.test.mjs`
Expected: 全部 PASS（原有 6 条 + 新增 5 条）。

- [ ] **Step 5: Commit**

```bash
git add slardar-triage/scripts/state.mjs slardar-triage/tests/state.test.mjs
git commit -m "feat(slardar-triage): 每次扫描每族记台账，合并候选池收口为 merge 子命令

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: 预筛 `pick` 与在途覆盖

**Files:**
- Modify: `slardar-triage/scripts/state.mjs`
- Test: `slardar-triage/tests/state.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `snap()` 测试夹具、`cli()` 助手；现有 `markDispatched`。
- Produces:
  - `markDispatched(state, issueId, { task_id, supplement, fix_paths, at })` —— `decision.fix_paths: string[]`（缺省 `[]`）。
  - `setFixPaths(state, issueId, paths: string[])`、`markMerged(state, issueId, at)`、`markSedimented(state, issueId, at)` —— 目标必须是 status=dispatched 的候选，否则 throw。分别写 `decision.fix_paths` / `decision.merged_at` / `decision.sedimented_at`。
  - `cover(state, issueId, byIssueId)` —— 写 `candidates[issueId].covered_by`；`byIssueId` 必须是 status=dispatched 的候选。
  - `flight(state): { in_flight: Brief[], awaiting_recovery: Brief[] }`，`Brief = { issue_id, message, task_id, mr_id, meego_url }`。`in_flight` = 已派单未合入；`awaiting_recovery` = 已合入未收尾沉淀。
  - `pick(state, scanned, { skip?: string[] }): { shortlist: Short[], covered: { issue_id, covered_by }[], filtered: { issue_id, likelihood, summary }[], in_flight: number }`。会就地写入 `state.candidates` 的 `likelihood` / `summary` / `covered_by`，调用方负责 `saveState`。`Short = { issue_id, message, issue_url, users, count, likelihood, detail_error, mapped_path, line, function, page, release }`。
  - CLI：`pick --dir --scan [--skip a,b]`、`cover --dir --issue-id --by`、`fix-paths --dir --issue-id --paths a,b`、`merged --dir --issue-id [--at]`、`sedimented --dir --issue-id`、`flight --dir`、`dispatched … [--fix-paths a,b]`。

- [ ] **Step 1: 写失败测试**

`slardar-triage/tests/state.test.mjs` 的 import 列表里追加 `pick, cover, setFixPaths, markMerged, markSedimented, flight`：

```js
import {
  loadState, saveState, mergeScan, setJudgment, pendingSorted, reject, markDispatched,
  readLedger, ledgerRows, appendLedger, mergeFromScan,
  pick, cover, setFixPaths, markMerged, markSedimented, flight,
} from '../scripts/state.mjs';
```

文件末尾追加：

```js
const frame = (over = {}) => ({ raw_filename: 'webpack://@byteview-web/vc-ai/./src/a.ts', mapped_path: 'vc-ai/src/a.ts', line: 10, function: 'fa', page: '/webview/ai-layout', release: '7.77.0.21', ...over });

test('pick 按机械规则剔除并写入档位：warn、服务端错误码、豆包页面、native code、帧不在仓内', () => {
  const scan = [
    snap({ issue_id: 'warn', family_key: 'k1', message: '[warn] FishBoneError: out of screen' }),
    snap({ issue_id: 'code', family_key: 'k2', message: '业务错误，ErrorInfo: code: 220301,larkErrorCode: 220301' }),
    snap({ issue_id: 'user', family_key: 'k3', message: 'invalid user' }),
    snap({ issue_id: 'api', family_key: 'k4', message: 'APINotProvided' }),
    snap({ issue_id: 'doubao', family_key: 'k5', pid_dist: { '/webview/doubao-ai-layout-mobile': 300 } }),
    snap({ issue_id: 'native', family_key: 'k6', latest_event: frame({ raw_filename: '[native code]', mapped_path: null }) }),
    snap({ issue_id: 'blob', family_key: 'k7', latest_event: frame({ raw_filename: 'blob:https://vc.feishu.cn/x', mapped_path: null }) }),
    snap({ issue_id: 'ok', family_key: 'k8' }),
  ];
  const { state } = mergeScan(empty(), scan, T0);
  const out = pick(state, scan);
  assert.deepEqual(out.shortlist.map((c) => c.issue_id), ['ok']);
  assert.deepEqual(Object.fromEntries(out.filtered.map((f) => [f.issue_id, f.likelihood])), {
    warn: '排除', code: '低', user: '低', api: '低', doubao: '低', native: '低', blob: '低',
  });
  assert.equal(state.candidates.warn.likelihood, '排除');
  assert.equal(state.candidates.warn.summary, 'warn 级上报');
  assert.equal(state.candidates.blob.summary, '最新帧不在 vc-ai / packages 源码');
  assert.equal(state.candidates.ok.likelihood, null);
});

test('pick 短名单按族用户数降序，Sourcemap 没取到的排末尾，带帧信息；--skip 与已判低 / 排除的不进短名单', () => {
  const scan = [
    snap({ issue_id: 'small', family_key: 'k1', family_users: 10 }),
    snap({ issue_id: 'nomap', family_key: 'k2', family_users: 9999, detail_error: 'sourcemap 404', latest_event: frame({ mapped_path: null }) }),
    snap({ issue_id: 'big', family_key: 'k3', family_users: 500, latest_event: frame({ mapped_path: 'packages/vc-web-utils/x.ts', line: 29, function: 'fx' }) }),
    snap({ issue_id: 'shown', family_key: 'k4', family_users: 800 }),
    snap({ issue_id: 'fixed', family_key: 'k5', family_users: 900 }),
  ];
  const { state } = mergeScan(empty(), scan, T0);
  setJudgment(state, 'fixed', { likelihood: '排除', summary: 'master 已修复' });
  const out = pick(state, scan, { skip: ['shown'] });
  assert.deepEqual(out.shortlist.map((c) => c.issue_id), ['big', 'small', 'nomap']);
  assert.deepEqual(out.shortlist[0], {
    issue_id: 'big', message: 'm', issue_url: 'u1', users: 500, count: 5000, likelihood: null, detail_error: null,
    mapped_path: 'packages/vc-web-utils/x.ts', line: 29, function: 'fx', page: '/webview/ai-layout', release: '7.77.0.21',
  });
  assert.deepEqual(out.filtered.map((f) => f.issue_id), ['fixed']);
});

test('pick 只看本次扫描到的 pending 候选', () => {
  const { state } = mergeScan(empty(), [snap(), snap({ issue_id: 'gone', family_key: 'k9' })], T0);
  assert.deepEqual(pick(state, [snap()]).shortlist.map((c) => c.issue_id), ['i1']);
});

test('在途覆盖：帧命中未合入单的 fix_paths 进 covered 并写 covered_by；该单合入后回到短名单', () => {
  const scan = [snap({ issue_id: 'old', family_key: 'k1' }), snap({ issue_id: 'renamed', family_key: 'k2' })];
  const { state } = mergeScan(empty(), scan, T0);
  markDispatched(state, 'old', { task_id: 't', supplement: 'x', fix_paths: ['vc-ai/src/services/ai-layout.ts'], at: T0 });
  let out = pick(state, scan);
  assert.deepEqual(out.shortlist, []);
  assert.deepEqual(out.covered, [{ issue_id: 'renamed', covered_by: 'old' }]);
  assert.equal(out.in_flight, 1);
  assert.equal(state.candidates.renamed.covered_by, 'old');
  assert.equal(state.candidates.renamed.status, 'pending');
  markMerged(state, 'old', T1);
  out = pick(state, scan);
  assert.deepEqual(out.shortlist.map((c) => c.issue_id), ['renamed']);
  assert.deepEqual(out.covered, []);
  assert.equal(out.in_flight, 0);
});

test('cover 手工建立归属：帧在共享 throw 点、fix_paths 匹配不到时同样进 covered', () => {
  const scan = [snap({ issue_id: 'old', family_key: 'k1' }), snap({ issue_id: 'shared', family_key: 'k2', latest_event: frame({ mapped_path: 'vc-ai/src/utils/native-api/mobile-native-client.ts' }) })];
  const { state } = mergeScan(empty(), scan, T0);
  assert.throws(() => cover(state, 'shared', 'old'), /不是已派单候选/);
  markDispatched(state, 'old', { task_id: 't', supplement: 'x', at: T0 });
  assert.deepEqual(state.candidates.old.decision.fix_paths, []);
  assert.deepEqual(pick(state, scan).shortlist.map((c) => c.issue_id), ['shared']);
  cover(state, 'shared', 'old');
  assert.deepEqual(pick(state, scan).covered, [{ issue_id: 'shared', covered_by: 'old' }]);
});

test('setFixPaths / markMerged / markSedimented 只接受已派单候选；flight 分出在途与待收尾', () => {
  const { state } = mergeScan(empty(), [snap(), snap({ issue_id: 'i2', family_key: 'f2', message: 'm2' })], T0);
  assert.throws(() => setFixPaths(state, 'i1', ['a']), /不是已派单候选/);
  assert.throws(() => markMerged(state, 'nope', T1), /不是已派单候选/);
  markDispatched(state, 'i1', { task_id: 't1', supplement: 'x', at: T0 });
  markDispatched(state, 'i2', { task_id: 't2', supplement: 'x', at: T0 });
  state.dispatched.i1.mr_id = '8408387';
  state.dispatched.i1.meego_url = 'https://meego/1';
  setFixPaths(state, 'i1', ['vc-ai/src/a.ts']);
  assert.deepEqual(state.candidates.i1.decision.fix_paths, ['vc-ai/src/a.ts']);
  assert.deepEqual(flight(state), {
    in_flight: [
      { issue_id: 'i1', message: 'm', task_id: 't1', mr_id: '8408387', meego_url: 'https://meego/1' },
      { issue_id: 'i2', message: 'm2', task_id: 't2', mr_id: null, meego_url: null },
    ],
    awaiting_recovery: [],
  });
  markMerged(state, 'i1', T1);
  assert.deepEqual(flight(state).in_flight.map((c) => c.issue_id), ['i2']);
  assert.deepEqual(flight(state).awaiting_recovery.map((c) => c.issue_id), ['i1']);
  markSedimented(state, 'i1', T2);
  assert.equal(state.candidates.i1.decision.sedimented_at, T2);
  assert.deepEqual(flight(state).awaiting_recovery, []);
});

test('CLI pick / dispatched --fix-paths / cover / flight 落盘并输出一行 JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const scanFile = join(dir, 'scan.json');
  const scan = { scanned_at: T0, candidates: [snap({ issue_id: 'old', family_key: 'k1' }), snap({ issue_id: 'new', family_key: 'k2', latest_event: frame() })] };
  writeFileSync(scanFile, JSON.stringify(scan));
  cli('merge', '--dir', dir, '--scan', scanFile);
  assert.deepEqual(cli('dispatched', '--dir', dir, '--issue-id', 'old', '--task-id', 't', '--supplement', 's', '--fix-paths', 'vc-ai/src/x.ts, vc-ai/src/y.ts'), { ok: true, dispatched: 'old' });
  assert.deepEqual(loadState(dir).candidates.old.decision.fix_paths, ['vc-ai/src/x.ts', 'vc-ai/src/y.ts']);
  assert.deepEqual(cli('pick', '--dir', dir, '--scan', scanFile).shortlist.map((c) => c.issue_id), ['new']);
  assert.deepEqual(cli('pick', '--dir', dir, '--scan', scanFile, '--skip', 'new').shortlist, []);
  assert.deepEqual(cli('cover', '--dir', dir, '--issue-id', 'new', '--by', 'old'), { ok: true, issue_id: 'new', covered_by: 'old' });
  const out = cli('pick', '--dir', dir, '--scan', scanFile);
  assert.equal(out.ok, true);
  assert.deepEqual(out.covered, [{ issue_id: 'new', covered_by: 'old' }]);
  assert.equal(cli('flight', '--dir', dir).in_flight.length, 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test slardar-triage/tests/state.test.mjs`
Expected: FAIL，报 `does not provide an export named 'cover'`（或同类导出缺失）。

- [ ] **Step 3: 实现**

`slardar-triage/scripts/state.mjs`：

在 `const LEDGER = …` 之后加：

```js
const LOW_MESSAGE = /code: \d{6}|larkErrorCode|invalid user|APINotProvided/;
const OUR_SOURCE = /^(vc-ai|packages)\//;
```

把 `markDispatched` 整个替换为：

```js
export function markDispatched(state, issueId, { task_id, supplement, fix_paths, at }) {
  const c = state.candidates[issueId];
  if (!c) throw new Error(`候选池里没有 ${issueId}`);
  state.candidates[issueId] = { ...c, status: 'dispatched', decision: { task_id, supplement: supplement ?? '', fix_paths: fix_paths ?? [], at } };
  state.dispatched[issueId] = { ...(state.dispatched[issueId] ?? {}), task_id };
}

function patchDecision(state, issueId, patch) {
  const c = state.candidates[issueId];
  if (c?.status !== 'dispatched') throw new Error(`${issueId} 不是已派单候选`);
  state.candidates[issueId] = { ...c, decision: { ...c.decision, ...patch } };
}

export function setFixPaths(state, issueId, paths) {
  patchDecision(state, issueId, { fix_paths: paths });
}

export function markMerged(state, issueId, at) {
  patchDecision(state, issueId, { merged_at: at });
}

export function markSedimented(state, issueId, at) {
  patchDecision(state, issueId, { sedimented_at: at });
}

// covered_by 只是归属链接，候选仍是 pending；是否因此被剔除由 pick 按归属的单是否仍未合入现算。
export function cover(state, issueId, byIssueId) {
  const c = state.candidates[issueId];
  if (!c) throw new Error(`候选池里没有 ${issueId}`);
  if (state.candidates[byIssueId]?.status !== 'dispatched') throw new Error(`${byIssueId} 不是已派单候选`);
  state.candidates[issueId] = { ...c, covered_by: byIssueId };
}

const isInFlight = (c) => c.status === 'dispatched' && !c.decision?.merged_at;

export function flight(state) {
  const brief = (c) => ({
    issue_id: c.issue_id,
    message: c.message,
    task_id: c.decision?.task_id ?? null,
    mr_id: state.dispatched[c.issue_id]?.mr_id ?? null,
    meego_url: state.dispatched[c.issue_id]?.meego_url ?? null,
  });
  const dispatched = Object.values(state.candidates).filter((c) => c.status === 'dispatched');
  return {
    in_flight: dispatched.filter(isInFlight).map(brief),
    awaiting_recovery: dispatched.filter((c) => c.decision?.merged_at && !c.decision?.sedimented_at).map(brief),
  };
}

function mechanicalVerdict(snapshot) {
  const message = snapshot.message ?? '';
  if (message.startsWith('[warn]')) return { likelihood: '排除', summary: 'warn 级上报' };
  if (LOW_MESSAGE.test(message)) return { likelihood: '低', summary: 'message 含服务端错误码 / invalid user / APINotProvided' };
  const pages = Object.keys(snapshot.pid_dist ?? {});
  if (pages.length && pages.every((p) => p.startsWith('/webview/doubao-'))) return { likelihood: '低', summary: '页面全部在豆包宿主' };
  if (snapshot.latest_event?.raw_filename === '[native code]') return { likelihood: '低', summary: '最新帧在 [native code]' };
  // Sourcemap 没取到时 mapped_path 为空不代表帧不在仓内，留给 agent 判断。
  if (!snapshot.detail_error && !OUR_SOURCE.test(snapshot.latest_event?.mapped_path ?? '')) return { likelihood: '低', summary: '最新帧不在 vc-ai / packages 源码' };
  return null;
}

// 帧与分布只在扫描快照里，候选池不存，所以预筛要两者一起看。
export function pick(state, scanned, { skip = [] } = {}) {
  const snapshots = new Map(scanned.map((c) => [c.issue_id, c]));
  const inFlight = Object.values(state.candidates).filter(isInFlight);
  const shortlist = [];
  const covered = [];
  const filtered = [];
  for (const cand of Object.values(state.candidates)) {
    const snapshot = snapshots.get(cand.issue_id);
    if (cand.status !== 'pending' || !snapshot) continue;
    const id = cand.issue_id;
    if (cand.likelihood === '低' || cand.likelihood === '排除') {
      filtered.push({ issue_id: id, likelihood: cand.likelihood, summary: cand.summary });
      continue;
    }
    const verdict = mechanicalVerdict(snapshot);
    if (verdict) {
      state.candidates[id] = { ...cand, ...verdict };
      filtered.push({ issue_id: id, ...verdict });
      continue;
    }
    const path = snapshot.latest_event?.mapped_path;
    const owner = inFlight.find((d) => d.issue_id === cand.covered_by)
      ?? inFlight.find((d) => path && (d.decision.fix_paths ?? []).includes(path));
    if (owner) {
      state.candidates[id] = { ...cand, covered_by: owner.issue_id };
      covered.push({ issue_id: id, covered_by: owner.issue_id });
      continue;
    }
    if (skip.includes(id)) continue;
    shortlist.push({
      issue_id: id,
      message: cand.message,
      issue_url: cand.issue_url,
      users: cand.users,
      count: cand.count,
      likelihood: cand.likelihood,
      detail_error: snapshot.detail_error ?? null,
      mapped_path: path ?? null,
      line: snapshot.latest_event?.line ?? null,
      function: snapshot.latest_event?.function ?? null,
      page: snapshot.latest_event?.page ?? null,
      release: snapshot.latest_event?.release ?? null,
    });
  }
  shortlist.sort((a, b) => Boolean(a.detail_error) - Boolean(b.detail_error) || (b.users ?? 0) - (a.users ?? 0));
  return { shortlist, covered, filtered, in_flight: inFlight.length };
}
```

CLI 部分：在 `function arg(name) {…}` 之后加：

```js
function listArg(name) {
  return (arg(name) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}
```

把用法行替换为：

```js
    process.stderr.write('用法: state.mjs merge|pick|pending|judge|reject|dispatched|cover|fix-paths|merged|sedimented|flight|history --dir <state> [--scan <scan.json>] [--skip <id,id>] [--issue-id <id>] [--by <id>] [--likelihood <档>] [--summary <text>] [--reason <text>] [--task-id <id>] [--supplement <text>] [--fix-paths <a,b>] [--paths <a,b>] [--at <iso>]\n');
```

把 `dispatched` 分支里的 `markDispatched(...)` 调用替换为：

```js
      markDispatched(state, arg('--issue-id'), { task_id: arg('--task-id'), supplement: arg('--supplement') ?? '', fix_paths: listArg('--fix-paths'), at: now });
```

在 `dispatched` 分支之后、`else {` 未知子命令之前，加：

```js
    } else if (cmd === 'pick') {
      const scan = JSON.parse(readFileSync(arg('--scan'), 'utf8'));
      const out = pick(state, scan.candidates, { skip: listArg('--skip') });
      saveState(dir, state);
      process.stdout.write(`${JSON.stringify({ ok: true, ...out })}\n`);
    } else if (cmd === 'cover') {
      cover(state, arg('--issue-id'), arg('--by'));
      saveState(dir, state);
      process.stdout.write(`${JSON.stringify({ ok: true, issue_id: arg('--issue-id'), covered_by: arg('--by') })}\n`);
    } else if (cmd === 'fix-paths') {
      setFixPaths(state, arg('--issue-id'), listArg('--paths'));
      saveState(dir, state);
      process.stdout.write(`${JSON.stringify({ ok: true, issue_id: arg('--issue-id'), fix_paths: listArg('--paths') })}\n`);
    } else if (cmd === 'merged') {
      markMerged(state, arg('--issue-id'), arg('--at') ?? now);
      saveState(dir, state);
      process.stdout.write(`${JSON.stringify({ ok: true, merged: arg('--issue-id') })}\n`);
    } else if (cmd === 'sedimented') {
      markSedimented(state, arg('--issue-id'), now);
      saveState(dir, state);
      process.stdout.write(`${JSON.stringify({ ok: true, sedimented: arg('--issue-id') })}\n`);
    } else if (cmd === 'flight') {
      process.stdout.write(`${JSON.stringify({ ok: true, ...flight(state) })}\n`);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test slardar-triage/tests/state.test.mjs`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add slardar-triage/scripts/state.mjs slardar-triage/tests/state.test.mjs
git commit -m "feat(slardar-triage): pick 预筛短名单，在途单按 fix_paths 与 covered_by 覆盖改名新族

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: 时间线 `history` 与回落比

**Files:**
- Modify: `slardar-triage/scripts/state.mjs`
- Test: `slardar-triage/tests/state.test.mjs`

**Interfaces:**
- Consumes: Task 1 `readLedger` `ledgerRows`；Task 2 `markDispatched` `markMerged` `markSedimented` `cover`。
- Produces:
  - `history(state, ledger, issueId): { issue_id, family_key, rows, covered_rows, events, recovery }`。`events: { type, at }[]`，`type ∈ first_seen | dispatched | rejected | merged | sedimented`。`recovery: { baseline_count: number|null, latest_at: string|null, latest_count: number, ratio: number|null }`。
  - CLI：`history --dir <state> --issue-id <id>`。

- [ ] **Step 1: 写失败测试**

import 列表追加 `history`。文件末尾追加：

```js
test('history 给出本族与被覆盖族的台账行、处置事件、回落比（改名新族的量加总后再比）', () => {
  const old = snap({ issue_id: 'old', family_key: 'k1', family_count: 1000 });
  const renamed = snap({ issue_id: 'renamed', family_key: 'k2', family_count: 150 });
  const other = snap({ issue_id: 'other', family_key: 'k3', family_count: 77, latest_event: frame() });
  const { state } = mergeScan(empty(), [old, other], T0);
  const ledger = [...ledgerRows(state, [old, other], T0)];
  markDispatched(state, 'old', { task_id: 't', supplement: 'x', fix_paths: ['vc-ai/src/services/ai-layout.ts'], at: '2026-09-10T12:00:00.000Z' });
  const merged = mergeScan(state, [{ ...old, family_count: 1200 }, renamed, other], T1).state;
  pick(merged, [old, renamed, other]);
  ledger.push(...ledgerRows(merged, [{ ...old, family_count: 1200 }, renamed, other], T1));
  markMerged(merged, 'old', '2026-09-11T12:00:00.000Z');
  ledger.push(...ledgerRows(merged, [{ ...renamed, family_count: 90 }, other], T2));

  const h = history(merged, ledger, 'old');
  assert.deepEqual(h.rows.map((r) => [r.at, r.family_count]), [[T0, 1000], [T1, 1200]]);
  assert.deepEqual(h.covered_rows.map((r) => [r.at, r.family_count]), [[T1, 150], [T2, 90]]);
  assert.deepEqual(h.events, [
    { type: 'first_seen', at: T0 },
    { type: 'dispatched', at: '2026-09-10T12:00:00.000Z' },
    { type: 'merged', at: '2026-09-11T12:00:00.000Z' },
  ]);
  assert.deepEqual(h.recovery, { baseline_count: 1000, latest_at: T2, latest_count: 90, ratio: 0.09 });
});

test('history：台账晚于派单的旧单以最早一行为基线；族在最新扫描里缺席记 0；没有台账时 ratio 为 null', () => {
  const c = snap({ family_count: 400 });
  const { state } = mergeScan(empty(), [c], T0);
  markDispatched(state, 'i1', { task_id: 't', supplement: 'x', at: '2026-09-01T00:00:00.000Z' });
  assert.deepEqual(history(state, [], 'i1').recovery, { baseline_count: null, latest_at: null, latest_count: 0, ratio: null });
  const other = snap({ issue_id: 'o', family_key: 'ko' });
  const ledger = [...ledgerRows(state, [c], T1), ...ledgerRows(state, [other], T2)];
  assert.deepEqual(history(state, ledger, 'i1').recovery, { baseline_count: 400, latest_at: T2, latest_count: 0, ratio: 0 });
  assert.throws(() => history(state, ledger, 'nope'), /候选池里没有/);
});

test('history 记录拒绝与收尾沉淀事件；CLI history 输出一行 JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const scanFile = join(dir, 'scan.json');
  writeFileSync(scanFile, JSON.stringify({ scanned_at: T0, candidates: [snap(), snap({ issue_id: 'i2', family_key: 'f2' })] }));
  cli('merge', '--dir', dir, '--scan', scanFile);
  cli('reject', '--dir', dir, '--issue-id', 'i2', '--reason', '宿主问题');
  cli('dispatched', '--dir', dir, '--issue-id', 'i1', '--task-id', 't');
  cli('merged', '--dir', dir, '--issue-id', 'i1', '--at', T1);
  cli('sedimented', '--dir', dir, '--issue-id', 'i1');
  const h = cli('history', '--dir', dir, '--issue-id', 'i1');
  assert.equal(h.ok, true);
  assert.deepEqual(h.events.map((e) => e.type), ['first_seen', 'dispatched', 'merged', 'sedimented']);
  assert.equal(h.rows.length, 1);
  assert.deepEqual(cli('history', '--dir', dir, '--issue-id', 'i2').events.map((e) => e.type), ['first_seen', 'rejected']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test slardar-triage/tests/state.test.mjs`
Expected: FAIL，报 `does not provide an export named 'history'`。

- [ ] **Step 3: 实现**

`slardar-triage/scripts/state.mjs`，在 `mergeFromScan` 之后加：

```js
// 回落比拿「派单前最近一次的族次数」对「台账最新一次扫描里本族 + 被覆盖族的次数之和」：
// 报错文案改名会让原族消失、量转到新族，只看原族会把改名误判成修好了。
export function history(state, ledger, issueId) {
  const c = state.candidates[issueId];
  if (!c) throw new Error(`候选池里没有 ${issueId}`);
  const byAt = (a, b) => Date.parse(a.at) - Date.parse(b.at);
  const coveredFamilies = new Set(Object.values(state.candidates).filter((x) => x.covered_by === issueId).map((x) => x.family_key));
  const rows = ledger.filter((r) => r.family_key === c.family_key).sort(byAt);
  const coveredRows = ledger.filter((r) => coveredFamilies.has(r.family_key)).sort(byAt);

  const events = [{ type: 'first_seen', at: c.first_seen_at }];
  if (c.decision?.at) events.push({ type: c.status, at: c.decision.at });
  if (c.decision?.merged_at) events.push({ type: 'merged', at: c.decision.merged_at });
  if (c.decision?.sedimented_at) events.push({ type: 'sedimented', at: c.decision.sedimented_at });

  const decidedAt = Date.parse(c.decision?.at ?? '');
  const baseline = rows.filter((r) => Date.parse(r.at) <= decidedAt).at(-1) ?? rows[0] ?? null;
  const latestAt = ledger.reduce((max, r) => (max === null || Date.parse(r.at) > Date.parse(max) ? r.at : max), null);
  const latestByFamily = new Map();
  for (const r of [...rows, ...coveredRows]) {
    if (r.at === latestAt) latestByFamily.set(r.family_key, Math.max(latestByFamily.get(r.family_key) ?? 0, r.family_count));
  }
  const latestCount = [...latestByFamily.values()].reduce((sum, n) => sum + n, 0);
  const baselineCount = baseline?.family_count ?? null;
  return {
    issue_id: issueId,
    family_key: c.family_key,
    rows,
    covered_rows: coveredRows,
    events,
    recovery: { baseline_count: baselineCount, latest_at: latestAt, latest_count: latestCount, ratio: baselineCount ? latestCount / baselineCount : null },
  };
}
```

CLI：在 `flight` 分支之后加：

```js
    } else if (cmd === 'history') {
      process.stdout.write(`${JSON.stringify({ ok: true, ...history(state, readLedger(dir), arg('--issue-id')) })}\n`);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bash slardar-triage/tests/run.sh`
Expected: 全部 PASS（含 `scan.test.mjs`、`progress.test.mjs`、`test-dispatch.sh`，它们不受本次改动影响）。

- [ ] **Step 5: Commit**

```bash
git add slardar-triage/scripts/state.mjs slardar-triage/tests/state.test.mjs
git commit -m "feat(slardar-triage): history 输出告警量级时间线与回落比

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: SKILL.md 与 references 改写

**Files:**
- Modify: `slardar-triage/SKILL.md`（整文件替换）
- Modify: `slardar-triage/references/likelihood.md`（整文件替换）
- Modify: `slardar-triage/references/example-report.md`（整文件替换）
- Modify: `slardar-triage/references/task-book-template.md:7`

**Interfaces:**
- Consumes: Task 1–3 的全部子命令名与参数（`merge` `pick` `cover` `fix-paths` `merged` `sedimented` `flight` `history` `dispatched --fix-paths`）。
- Produces: 无代码接口。

- [ ] **Step 1: 整文件替换 `slardar-triage/SKILL.md`**

````markdown
---
name: slardar-triage
description: 扫描 Slardar 近 24h 线上 JS 错误（只看 vc_ai，即 vc-ai 方向），挑出一条最可能在 vc-ai 内通过代码修复、且无人在途处理的告警，只呈现现象、报错与 Issue 链接，随后一次一问引导用户收敛技术方案；用户说「派这条」才建 Meego、经 traecli 起 omh、登记看板。量级与分布不展示但每次扫描记台账。当用户说「扫一下线上告警」「看看 Slardar」「挑一个告警看看」「换一条」「派这条」「这条不修」「看看进度」时使用。
---

# slardar-triage

技能目录 `<skill>` = 本文件所在目录；状态目录 `<state>` = `<skill>/state`；byteview-web 仓 `<repo>` = 当前 cwd 的 `../byteview-web`（`--repo` 可改）。所有脚本 stdout 只有一行 JSON。

**默认唤醒不建 Meego、不起 omh、不登记看板**，只写 `<state>/`；唯一的外发动作是已派单修复见效时的一次飞书沉淀（主流程第 4 步）。agent 读代码得出的判断只用来选取和安排提问顺序；技术方案由用户在对话里逐项拍板。

## 入口

| 用户意图 | 动作 |
|---|---|
| 默认（「扫一下线上告警」「看看 Slardar」「挑一个告警看看」） | 主流程第 1–6 步，随后进入「引导式收敛」 |
| 「换一条」 | 用同一份 scan 重跑第 5 步，`--skip` 带上本会话已呈现过的 issue；当前这条保持 pending |
| 「说说你的判断」 | 直接给出对当前这条的初步判断（点位、根因、改法），之后回到一次一问 |
| 「派这条」 | 「派单」一节 |
| 「这条不修 <摘要或 issue_id>，原因：<文本>」 | `node <skill>/scripts/state.mjs reject --dir <state> --issue-id <id> --reason "<原话>"`，回话题确认 |
| 「看看进度」 | `node <skill>/scripts/progress.mjs --state <state>`，回话题：Issue 一句话、Meego、Task、阶段、MR 链接与是否合入 |

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
`skipped_bids` 非空说明 vc_ai 本身没扫成：回话题说明原因并停在这一步。

### 3. 合并候选池并记台账

```bash
node <skill>/scripts/state.mjs merge --dir <state> --scan <scan.json>
```
每次扫描的每个族都会在 `<state>/ledger.jsonl` 留一行（次数、用户、session、各分布主项、状态）。这些数字不出现在呈现里。

### 4. 已派单收尾检查

```bash
node <skill>/scripts/state.mjs flight --dir <state>
```
- `in_flight` 里有 `mr_id` 的，经 bytedcli-bits-mr skill 查 MR 状态；已合入的执行 `node <skill>/scripts/state.mjs merged --dir <state> --issue-id <id> --at <合入时间 ISO>`，然后重跑 `flight`。
- `awaiting_recovery` 里每条执行 `node <skill>/scripts/state.mjs history --dir <state> --issue-id <id>`；`recovery.ratio` ≤ 0.2 时经 lark-sediment skill 沉淀「现象、修复前量级（`baseline_count` 及那一行的用户 / 分布主项）→ 当前量级（`latest_count`）、MR 链接、合入时间」，成功后 `node <skill>/scripts/state.mjs sedimented --dir <state> --issue-id <id>`。`ratio` 为 null 或大于 0.2 的不动。

### 5. 预筛与验证

```bash
node <skill>/scripts/state.mjs pick --dir <state> --scan <scan.json> [--skip <id,id>]
```
按 `<skill>/references/likelihood.md` 对 `shortlist` 从头逐条读代码验证，**第一条判「高」就停**。读代码：`git -C <repo> show origin/master:<mapped_path> | sed -n '<line-30>,<line+30>p'`，位置已变时 `git -C <repo> log --oneline -5 origin/master -- <mapped_path>`、`git -C <repo> grep -n '<函数名>' origin/master -- <project_dir>`。线上 release 对应 commit：`bytedcli --json scm repo version list <scm_repo> --type online --version <release> --page-size 10` 取 `data.versions[].base_commit_hash`（vc_ai 同时试 `ee/lark/vc_ai` 与 `ee/lark/vc_ai_doubao`，type 再试 test）。

每条验证的结局落档：
```bash
node <skill>/scripts/state.mjs judge --dir <state> --issue-id <id> --likelihood <高|中|排除> --summary "<点位与一句话缺陷描述，或归档原因>"
node <skill>/scripts/state.mjs cover --dir <state> --issue-id <id> --by <在途单 issue_id>
```
`--summary` 只存档，不出现在呈现里。

### 6. 呈现

`botmux send` 一条消息，格式见 `<skill>/references/example-report.md`：

```
【Slardar · vc_ai 近 24h】
现象：<一句人话：哪个端、哪个页面、用户侧或运行时发生了什么>
报错：<原始 message>
Issue：<issue_url>

<第一个引导问题>
```
「现象」只写可观察事实。不写代码路径、函数名、根因、改法、次数、用户数、分布，也不附已派单进展、已拒绝、低 / 排除清单。

短名单为空或验证后一条可呈现的都没有：只回「没有新的可修告警，在途 N 条」（N = `pick` 输出的 `covered` 条数 + `in_flight`）。

## 引导式收敛

每轮只做一件事：**贴一个事实原文，提一个待用户决定的问题**。

- 事实来源：堆栈、`git show` 代码片段、`<scan.json>` 里这条的分布与量级、`git log`、线上 release 对应 commit。贴原文，不转述成结论。
- 收敛清单（顺序可依对话调整，逐项由用户拍板）：
  1. 复现条件：哪个端、页面、操作或时序下触发
  2. 缺陷点位：文件:行
  3. 根因归属：web 侧可独立解释 / 依赖 native 或服务端。判为依赖时问用户是否已向对方确认及结论，不强制
  4. 改动范围：文件级，并明确不动什么
  5. 验收方式：首条红灯测试如何复现
- 初步判断可以用来决定先问什么、先贴哪段证据，不抢先说结论。用户的说法与代码或数据不一致时，贴出不一致的原文再问。

清单走完后回显，然后停下等用户说「派这条」或继续修改：

```
【技术方案】<issue 短 id>
复现条件：…
缺陷点位：…
根因：…（native / 服务端确认情况：…）
改动范围：…
验收：…
```

## 派单（只在用户显式指令后）

1. 本会话没有回显过【技术方案】：不派，回话题说明要先走收敛对话。「补充」= 回显的技术方案原文（含用户之后的修改）。
2. 核对：`node <skill>/scripts/state.mjs pending --dir <state>` 里存在该 issue 且 status=pending；否则回话题说明（已派 / 已拒 / 不在池中）。
3. 派单前校验：`bytedcli --json meego user search --project-key 5e96d7bff4e7c525510f9156 --user-keys '["wangjinghong.ceilf6"]'`、`command -v traecli omh-cli orchestrator`，缺则停。
4. 写任务书：按 `<skill>/references/task-book-template.md`，第 0 节原样收录技术方案；第 1 节的量级与分布取自 `<scan.json>`；第 2 节线上代码用主流程第 5 步查到的 commit；第 3、4 节按方案的缺陷点位、根因、改动范围写；第 5 节首条 AC 写方案的验收方式（复现步骤、改动前实际表现、期望表现）。`{{meego_url}}` 保留占位。
5. 写 Meego 描述文件：现象 / 根因 / 修法 / Slardar 链接（`issue_url`，用 `[]` 包裹），末尾「【人工确认】<技术方案原文>」。
6. 派发（在本会话 cwd 下执行，不要先 `cd` 进工作区）：
```bash
bash <skill>/scripts/dispatch.sh --state <state> --issue-id <id> --slug <kebab-摘要>-$(date +%F) --task-book <任务书路径> --meego-desc <描述文件> --meego-name "<Meego 标题>" --os <os_dist 主项> --release <release_dist 主项> --repo <repo> --slardar-url "<issue_url>"
```
退出 3：有在跑的单，附其进展；退出 4：runtime 不符已 cancel，不重试；退出 1：写停在哪一步，下次「派这条」会续派。输出的 `board` 字段是看板登记结果，失败写原因。
7. 成功后（`--fix-paths` 取方案「改动范围」里的仓内路径，逗号分隔，不含测试文件）：
```bash
node <skill>/scripts/state.mjs dispatched --dir <state> --issue-id <id> --task-id <task_id> --supplement "<技术方案原文>" --fix-paths <a,b>
```
8. 经 lark-sediment skill 沉淀：现象、派单时量级（`history` 最后一行 `rows` 的次数 / 用户 / 分布主项）、技术方案、Meego 链接、Task ID。
9. 回话题：Issue 一句话、Meego 链接、Task ID、工作区、看板登记结果、预计约 3 小时、叫停命令 `orchestrator task-cancel --task-id <id>`。

## 纪律

- 任何情况下不自动派单，包括短名单只有一条、用户上次说过「以后都派」——每次都要本会话的技术方案与显式「派这条」。
- 选取不看 users / count，它们只决定短名单里的验证顺序；拿不准归中。
- 呈现与收敛对话里，结论由用户说出或在用户要求「说说你的判断」后给出。
- 写答辩或复盘材料要某条告警的量级时间线：`node <skill>/scripts/state.mjs history --dir <state> --issue-id <id>`。
- omh 永远经 `traecli exec` 起（dispatch.sh 内置）。
- 看板登记的是调用本技能的 claude 线程；meta 带 meego_id / meego_type=issue / meego_url / slardar_url，`progress.mjs` 发现 MR 后回填 mr_id。补登记：`bash <skill>/scripts/board.sh --state <state> --issue-id <id> [--mr-id] [--session-id] [--slardar-url]`。
- 停摆恢复：phase=failed 且死于 code-review → `bash <skill>/scripts/resume-traex.sh <workspace> <task_id> impl`；其他节点省略第三个参数；执行后在回复里写动作与理由。
````

- [ ] **Step 2: 整文件替换 `slardar-triage/references/likelihood.md`**

```markdown
# 选取规则

目标是选出一条：最新帧在 vc-ai / packages 源码、在 `origin/master` 上能定位到单一缺陷点位、且没有在途单覆盖。规则只决定选哪条，不触发任何动作。

## 脚本预筛（`state.mjs pick`）

从 status=pending 且本次扫描到的候选里依次剔除，前三类同时写入档位与原因：

- **排除**：message 以 `[warn]` 开头。
- **低**：message 含服务端错误码（`code: \d{6}`、`larkErrorCode`）、`invalid user`、`APINotProvided`；`pid_dist` 全部以 `/webview/doubao-` 开头；`latest_event.raw_filename` 为 `[native code]`。
- **低**：`latest_event.mapped_path` 不在 `vc-ai/`、`packages/` 下（`blob:`、CDN URL、node_modules）。`detail_error` 非空（Sourcemap 没取到）的不剔除，排到短名单末尾。
- **在途覆盖**（进 `covered`，状态仍是 pending）：候选的 `covered_by` 指向一条已派单未合入的候选；或最新帧 `mapped_path` 落在这类候选的 `fix_paths` 里。那张单合入后候选自动回到短名单。

之前已判低 / 排除的候选不再进短名单。短名单按 24h 族用户数降序。

## agent 逐条验证

从短名单头部开始读 `origin/master` 上的代码，每条落一种结局：

- **高**：能写出「文件:行 + 一句话缺陷描述」。`judge` 后停止验证，呈现这一条。
- **在途覆盖**：读下来是某条在途单的同一缺陷（调用链汇到那张单的改动范围；典型是超时类错误，最新帧落在共享的 throw 点，`fix_paths` 匹配不到）。`cover --by <在途单>`，看下一条。
- **排除**：`git -C <repo> log -S'<关键片段>' origin/master --oneline` 查到修复提交，且线上 `release_dist` 主版本早于该提交进入的 builds 分支版本。`judge` 后看下一条。
- **中**：帧在我们仓源码，但读完写不出单一缺陷点位（共享 throw、跨 await 丢失调用者且候选调用链多于一条）。`judge` 后记下，看下一条。

拿不准归中。整份短名单没有高时，呈现第一条中；一条可呈现的都没有时只回「没有新的可修告警，在途 N 条」。
```

- [ ] **Step 3: 整文件替换 `slardar-triage/references/example-report.md`**

```markdown
# 样例（呈现 → 收敛对话 → 技术方案）

## 呈现

【Slardar · vc_ai 近 24h】
现象：PC 端会中 AI 视图（ai-layout）拉取会议 AI 总结时等了 10 秒没有结果，错误以 unhandledrejection 上报
报错：[native-api] command=94003 timed out after 10000ms
Issue：https://slardar.bytedance.net/node/web/js/detail?env=online&bid=vc_ai&lang=zh&start_time=1789637699&end_time=1789724099&site_type=web&region=cn&layout=normal&issue_id=f49170ba664fefd93aede453eb5dc3ba&release=7.77.0.21

先定复现条件。抽样 300 条里页面是 ai-layout 256、minutes-ai-layout-pc 43，系统 Windows 224、Mac 76。你想先按哪个场景看：会中 AI 视图，还是妙记 PC？

## 收敛对话（每轮一个事实 + 一个问题）

用户：先看会中。

agent：这条的最新帧在 `vc-ai/src/services/ai-layout.ts:271`，master 上这一段是：

    async getFishBoneData() {
      this.loading = true;
      try {
        const res = await getMeetingAISummary(...);
        ...
      } finally {
        this.loading = false;
      }
    }

缺陷点位你想定在这个函数，还是往上看它的调用方？

用户：调用方怎么调的？

agent：两处，`git grep -n getFishBoneData origin/master -- vc-ai`：

    vc-ai/src/stores/ai-layout.ts:88:    when(() => this.ready, () => this.getFishBoneData());
    vc-ai/src/stores/ai-layout.ts:142:   getFishBoneDataDebounced = debounce(() => this.getFishBoneData(), 300);

两处都没有接返回的 Promise。点位定在哪？

（……按清单继续：根因归属、改动范围、验收方式）

## 技术方案回显

【技术方案】f49170ba
复现条件：PC 会中打开 AI 视图，宿主 command 94003 在 10s 内不回包
缺陷点位：vc-ai/src/services/ai-layout.ts:266-280 getFishBoneData
根因：超时 reject 没有被接住，逃逸为 unhandledrejection（native / 服务端确认情况：94003 不回包的原因未向 native 确认，本单只处理 web 侧未捕获）
改动范围：vc-ai/src/services/ai-layout.ts 加 catch 并走既有错误上报；不动 native 协议、不改超时时长
验收：mock getMeetingAISummary 返回 rejected Promise，改动前测试进程收到 unhandledRejection，改动后不再收到且 loading 复位

确认后回复「派这条」；要改哪一项直接说。

## 没有可呈现的候选

没有新的可修告警，在途 3 条。
```

- [ ] **Step 4: 改 `slardar-triage/references/task-book-template.md` 第 0 节占位**

把这一行：

```
{{用户在「派这条」指令里给的补充,原样收录:native 侧同学的结论、leader 对 web 侧是否动手的口径、范围边界}}
```

替换为：

```
{{收敛对话回显的【技术方案】原文(含用户之后的修改),原样收录:复现条件、缺陷点位、根因与 native / 服务端确认情况、改动范围、验收}}
```

- [ ] **Step 5: 自查文档与脚本一致**

Run:
```bash
grep -o 'state.mjs [a-z-]*' slardar-triage/SKILL.md slardar-triage/references/likelihood.md | awk '{print $2}' | sort -u
```
Expected（每个都是 Task 1–3 实现过或原有的子命令）：
```
cover
dispatched
flight
history
judge
merge
merged
pending
pick
reject
sedimented
```

Run: `grep -n "补充：\|五块\|根因假设" slardar-triage/SKILL.md slardar-triage/references/*.md`
Expected: 无输出。

Run: `bash slardar-triage/tests/run.sh`
Expected: 全部 PASS（`test-dispatch.sh` 用到任务书模板，确认没被第 4 步改坏）。

- [ ] **Step 6: Commit**

```bash
git add slardar-triage/SKILL.md slardar-triage/references/likelihood.md slardar-triage/references/example-report.md slardar-triage/references/task-book-template.md
git commit -m "feat(slardar-triage): 默认只呈现一条告警的现象，技术方案经一次一问收敛后显式派单

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: 本机 state 一次性回填与冒烟（不进 git）

旧派单没有 `fix_paths`，改名新族也没有 `covered_by`。不回填的话，下一次唤醒选出来的就是 `f49170ba`（鱼骨图那张单已覆盖）。

**Files:**
- Modify（本机，不提交）: `slardar-triage/state/candidates.json`

**Interfaces:**
- Consumes: Task 1 的 `ledgerRows` `appendLedger`；Task 2 的 `fix-paths` `cover` `pick`；Task 3 的 `history`。

- [ ] **Step 1: 备份**

```bash
cp slardar-triage/state/candidates.json slardar-triage/state/candidates.json.bak-20260920
```

- [ ] **Step 2: 对账已派单**

```bash
node -e '
const fs=require("fs");const d="slardar-triage/state/";
const c=JSON.parse(fs.readFileSync(d+"candidates.json","utf8"));const p=JSON.parse(fs.readFileSync(d+"dispatched.json","utf8"));
for (const [id,v] of Object.entries(p)) console.log(id.slice(0,8), c[id]?.status ?? "不在候选池", v.workspace);'
```
Expected: `938f8ba3` 与 `b1071995` 为 `dispatched`；`8567d6e7`（canStartVideo，MR 8412955）显示「不在候选池」。后者是既有的数据不一致：**停下来告诉用户**，由用户决定是否补一条候选记录，不要自行编造候选字段。

- [ ] **Step 3: 回填 `fix_paths`**

对 Step 2 里状态为 `dispatched` 的每条，先看工作区当前分支与修复分支：

```bash
git -C <workspace> branch --show-current
git -C <workspace> branch --list 'fix/*' 'bugfix/*'
```
用修复分支（不是 `omh-base/*`）取改动的非测试源码路径：

```bash
git -C <workspace> diff --name-only origin/master...<修复分支> | grep -v '\.test\.\|\.stories\.\|__tests__'
```
把输出用逗号拼起来写入：

```bash
node slardar-triage/scripts/state.mjs fix-paths --dir slardar-triage/state --issue-id <完整 issue_id> --paths <a,b,c>
```
Expected: `{"ok":true,"issue_id":"…","fix_paths":[…]}`；`b1071995…` 的 `fix_paths` 应包含 `vc-ai/src/services/ai-layout.ts`。diff 为空或分支找不到时停下来告诉用户。

- [ ] **Step 4: 建立头像超时改名新族的归属**

`a5300cba…`（`[native-api] common.getAvatarBase64 timed out after 60000ms`）的最新帧在共享 throw 点 `mobile-native-client.ts:117`，`fix_paths` 匹配不到，手工归到 `938f8ba3…`：

```bash
node slardar-triage/scripts/state.mjs cover --dir slardar-triage/state --issue-id a5300cba49f27168bf68fedb86457cde --by 938f8ba377ac6484ba8918b19f247350
```
Expected: `{"ok":true,"issue_id":"a5300cba49f27168bf68fedb86457cde","covered_by":"938f8ba377ac6484ba8918b19f247350"}`

- [ ] **Step 5: 用历史扫描快照回填台账**

不要对旧快照跑 `merge`：`mergeScan` 会给这份快照里缺席的 pending 候选记 stale，重放旧快照会把它们误移出候选池。只追加台账行：

```bash
node -e '
import("./slardar-triage/scripts/state.mjs").then(async (m) => {
  const fs = await import("node:fs");
  const dir = "slardar-triage/state";
  const state = m.loadState(dir);
  for (const f of process.argv.slice(1)) {
    const scan = JSON.parse(fs.readFileSync(f, "utf8"));
    console.log(f, m.appendLedger(dir, m.ledgerRows(state, scan.candidates, scan.scanned_at)));
  }
})' slardar-triage/state/scans/scan-20260909T032316Z.json slardar-triage/state/scans/scan-20260910T045747Z.json slardar-triage/state/scans/scan-20260918T093459Z.json
wc -l slardar-triage/state/ledger.jsonl
```
Expected: 三个文件分别追加 8、26、8 行，`ledger.jsonl` 共 42 行。回填行的 `status` 是候选**现在**的状态而不是扫描当时的，量级数字是当时的。（`e2e.json`、`smoke.json`、`scan-e2e-*.json` 是测试产物，不回填。）

- [ ] **Step 6: 冒烟**

```bash
node slardar-triage/scripts/state.mjs pick --dir slardar-triage/state --scan slardar-triage/state/scans/scan-20260918T093459Z.json
node slardar-triage/scripts/state.mjs history --dir slardar-triage/state --issue-id b1071995655bbebf583ae422aa64c7ae
```
Expected:
- `pick`：`covered` 含 `f49170ba…→b1071995…` 与 `a5300cba…→938f8ba3…`；`shortlist` 里没有这两条，也没有 `[warn]`、`invalid user`、`APINotProvided`、豆包页面的候选；`in_flight` 为 2。
- `history`：`rows` 有 09-09 / 09-10 的鱼骨图族量级；`covered_rows` 里有 `f49170ba…` 所在族 09-18 的一行；`recovery.latest_count` 大于 0。

把 `pick` 的 `shortlist` 原样贴给用户看一眼，确认选取范围符合预期。

- [ ] **Step 7: 收尾**

```bash
git status --short
```
Expected: 无输出（`state/` 被忽略，Task 1–4 已各自提交）。分支 `feat/slardar-triage-single-pick` 留给用户决定如何合入 `main`（合入前把 Task 1–4 的提交 squash 成一条）。
