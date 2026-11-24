# monitor-triage 选取核心重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 monitor-triage 的选取从「机械预筛 + 四档 + 永久剔除」改成「按族用户数降序逐条两档判定、第一条能修即停、所有不能修的都进可见的跳过清单、用户可捞回」。

**Architecture:** `scan.mjs` 改为按 `user_descend` 分页拉取；`state.mjs` 删掉 `mechanicalVerdict` / `pick` / `cover` / 四档 / stale 移除，新增 `judge`（两档 + `--same-as`）、`revive`（捞回）、`walk`（纯函数走查）；派单链路、台账与 `history` 不动。文档（SKILL.md、`references/judging.md`、`references/example-report.md`）按新流程重写。

**Tech Stack:** Node.js ESM（`node:test`），bash，`web-monitor-web-cli`。

**Spec:** `docs/superpowers/specs/2026-09-29-monitor-triage-refactor-design.md`

## Global Constraints

- 技能目录：`monitor-triage/`（仓库根为 `/Users/<user>/Desktop/ceilf/ceilf6-skills`）；`~/.claude/skills/monitor-triage` 是指向主工作区的 symlink，所以开发在独立 worktree 进行，合入 main 后才生效。
- 所有脚本 stdout 只有一行 JSON；用法错误退出 2，业务错误输出 `{"ok":false,"error":...}` 并退出 1。
- 派单链路文件不改：`scripts/prepare-dispatch.sh`、`scripts/board.sh`、`scripts/task-model.mjs`、`references/task-book-template.md`、`references/log-forensics.md`；`history()`、`ledgerRows()`、`appendLedger()`、`readLedger()` 逻辑不改。
- 判定只有两档：`fixable: true | false`；`verdict.by` 只有 `agent` / `user`。
- 呈现与文档的中文措辞遵守用户全局规则：注释只写长期有效的约束与原因，不写变更叙事（「不再」「改为」「新增了」等）。
- spec / plan 文档不提交、不推送（用户 CLAUDE.md 第 7 条）。提交时只 `git add` 本计划列出的文件。
- 测试入口：`bash monitor-triage/tests/run.sh`（当前基线 21 个 bash 用例 + node:test 全部通过）。

---

## File Structure

| 文件 | 职责 | 任务 |
|---|---|---|
| `monitor-triage/scripts/scan.mjs` | 按用户数分页拉 web-monitor、取样、合族、按族用户数排序 | 1 |
| `monitor-triage/tests/scan.test.mjs` | scan 单测 | 1 |
| `monitor-triage/scripts/state.mjs` | 候选池 / 判定 / 走查 / 处置账 / 台账 / CLI | 2、3 |
| `monitor-triage/tests/state.test.mjs` | state 单测与 CLI 测 | 2、3 |
| `monitor-triage/references/judging.md` | 判定口径（新建） | 4 |
| `monitor-triage/references/likelihood.md` | 删除 | 4 |
| `monitor-triage/references/example-report.md` | 呈现样例 | 4 |
| `monitor-triage/SKILL.md` | 技能主文档 | 4 |
| `monitor-triage/state/*`（gitignored） | 本机状态迁移 | 5 |

---

### Task 0: 建 worktree

- [ ] **Step 1: 建分支与 worktree**

```bash
cd /Users/<user>/Desktop/ceilf/ceilf6-skills
git worktree add ../ceilf6-skills-web-monitor-walk -b feat/monitor-triage-walk main
cd ../ceilf6-skills-web-monitor-walk
bash monitor-triage/tests/run.sh
```
Expected: 末行 `pass=21 fail=0`，node:test 全部 `ok`，退出码 0。

以下所有路径相对 `/Users/<user>/Desktop/ceilf/ceilf6-skills-web-monitor-walk`。

---

### Task 1: scan 按用户数分页

**Files:**
- Modify: `monitor-triage/scripts/scan.mjs`（`scanBid`、`scan`、CLI 段）
- Test: `monitor-triage/tests/scan.test.mjs`

**Interfaces:**
- Produces: `scan({ bids, hours, page = 1, pageSize = 20, repo, now, runner, textRunner }) → { scanned_at, window, page, page_size, skipped_bids, candidates }`，`candidates` 按 `family_users` 降序。CLI：`scan.mjs --bid ai_summary --hours 24 --page 1 --page-size 20 --repo <repo> --out <file>`，stdout `{"ok":true,"out":...,"page":1,"candidates":N,"skipped_bids":[]}`。`--top` 不再接受。

- [ ] **Step 1: 改测试**

`monitor-triage/tests/scan.test.mjs` 中：

测试「scan 用注入 runner 产出候选并做族合并，某 BID 失败只记 skipped」里把

```js
  const r = await scan({ bids: ['ai_summary', 'vc_client_web'], hours: 24, top: 3, now: 1788853929000, runner, textRunner });
```
改为
```js
  const r = await scan({ bids: ['ai_summary', 'vc_client_web'], hours: 24, pageSize: 3, now: 1788853929000, runner, textRunner });
```
并在该测试末尾（`assert.ok(calls.some((c) => c.includes('--page-size 300')));` 之后）追加：
```js
  assert.ok(calls.some((c) => c.startsWith('js-error list --bid ai_summary') && c.includes('--order-by user_descend --page-num 1 --page-size 3')));
  assert.deepEqual(r.candidates.map((c) => c.family_users), [21740, 11391, 8441]);
  assert.equal(r.page, 1);
  assert.equal(r.page_size, 3);
```

测试「scan 最新事件 detail 报「正在处理」时…」里两处 `top: 1` 都改为 `pageSize: 1`。

文件末尾追加：
```js
test('scan 按页取：--page-num 透传，输出带页码', async () => {
  const calls = [];
  const runner = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'js-error') return { data: { result: [] } };
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const r = await scan({ bids: ['ai_summary'], hours: 24, page: 3, pageSize: 20, now: 1788853929000, runner });
  assert.deepEqual(r.candidates, []);
  assert.equal(r.page, 3);
  assert.equal(r.page_size, 20);
  assert.ok(calls[0].includes('--order-by user_descend --page-num 3 --page-size 20'));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test monitor-triage/tests/scan.test.mjs`
Expected: FAIL（`--order-by user_descend` 断言不满足、`r.page` 为 undefined）。

- [ ] **Step 3: 改实现**

`monitor-triage/scripts/scan.mjs`：

`scanBid` 签名与列表调用改为：
```js
async function scanBid(bid, window, page, pageSize, runner, textRunner) {
  const project = PROJECTS[bid];
  const list = runner(['js-error', 'list', ...commonArgs(bid, window), '--filter', UNRESOLVED_FILTER, '--order-by', 'user_descend', '--page-num', String(page), '--page-size', String(pageSize)]);
```
（函数体其余不变。）

`scan` 改为：
```js
export async function scan({ bids, hours, page = 1, pageSize = 20, repo, now = Date.now(), runner, textRunner }) {
  const end = Math.floor(now / 1000);
  const window = { start: end - hours * 3600, end };
  const bin = resolveBin(resolveRepo(repo));
  const run = runner ?? makeRunner(bin);
  const runText = textRunner ?? (runner ? null : makeTextRunner(bin));
  const skipped = [];
  let all = [];
  for (const bid of bids) {
    if (!PROJECTS[bid]) {
      skipped.push({ bid, reason: '不支持的 BID' });
      continue;
    }
    try {
      all = all.concat(await scanBid(bid, window, page, pageSize, run, runText));
    } catch (error) {
      skipped.push({ bid, reason: String(error.message ?? error).slice(0, 300) });
    }
  }
  // 合族后族用户数可能超过排在它前面的单个 issue，走查顺序以族为准。
  const candidates = mergeFamilies(all).sort((a, b) => b.family_users - a.family_users);
  return { scanned_at: new Date(now).toISOString(), window, page, page_size: pageSize, skipped_bids: skipped, candidates };
}
```

CLI 段的 `scan({...})` 调用与输出改为：
```js
  const result = await scan({
    bids: arg('--bid', 'ai_summary').split(',').map((s) => s.trim()).filter(Boolean),
    hours: Number(arg('--hours', '24')),
    page: Number(arg('--page', '1')),
    pageSize: Number(arg('--page-size', '20')),
    repo: arg('--repo'),
  });
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, out: out ?? null, page: result.page, candidates: result.candidates.length, skipped_bids: result.skipped_bids })}\n`);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test monitor-triage/tests/scan.test.mjs`
Expected: 5 个测试全部 `ok`。

- [ ] **Step 5: Commit**

```bash
git add monitor-triage/scripts/scan.mjs monitor-triage/tests/scan.test.mjs
git commit -m "feat(monitor-triage): 扫描按影响用户数分页拉取"
```

---

### Task 2: 状态模型改为两档判定 + 捞回

**Files:**
- Modify: `monitor-triage/scripts/state.mjs`（文件头至 `pick` 结束；`mergeFromScan`；CLI 段）
- Test: `monitor-triage/tests/state.test.mjs`

**Interfaces:**
- Consumes: 无（与 Task 1 独立）。
- Produces（Task 3 使用）：
  - 候选结构：`{ issue_id, family_key, bid, message, member_issue_ids, issue_url, web-monitor_url, users, count, first_seen, first_seen_at, refreshed_at, status: 'pending'|'dispatched'|'rejected', verdict: null | { fixable: boolean, reason: string, by: 'agent'|'user', at: string }, verdicts: Verdict[], decision, covered_by? }`
  - `mergeScan(state, scanned, now) → { state }`（不再返回 `removed`）
  - `judge(state, issueId, { fixable, reason, sameAs, at })`
  - `revive(state, issueId, at)`
  - `reject(state, issueId, reason, now)`（额外追加 user verdict）
  - `pendingSorted(state)`（按 `users` 降序）
  - `markDispatched(state, issueId, { task_id, task_slug, workspace, supplement, at })`
  - CLI：`judge --fixable yes|no --reason <text> [--same-as <id>]` → `{"ok":true,"issue_id":..,"fixable":..,"covered_by":..}`；`revive` → `{"ok":true,"revived":..}`；`merge` → `{"ok":true,"pending":N,"ledger_appended":M}`；`needsScan` 含 `walk`（分支在 Task 3 加）。
- 删除导出：`setJudgment`、`pick`、`cover`、`LIKELIHOOD_ORDER`。

- [ ] **Step 1: 改测试**

`monitor-triage/tests/state.test.mjs`：

1) import 块替换为：
```js
import {
  loadState, saveState, mergeScan, judge, revive, pendingSorted, reject, markDispatched,
  readLedger, ledgerRows, appendLedger, mergeFromScan,
  history,
} from '../scripts/state.mjs';
```

2) 「mergeScan 新候选入池为 pending…」里把 `assert.equal(state.candidates.i1.likelihood, null);` 换成：
```js
  assert.equal(state.candidates.i1.verdict, null);
  assert.deepEqual(state.candidates.i1.verdicts, []);
```

3) 整个删除测试「mergeScan 对缺席的 pending 记 stale，连续两次移出；dispatched / rejected 不移出」，原位置写入：
```js
test('mergeScan 不删除缺席的候选：分页没扫到不代表告警消失', () => {
  let { state } = mergeScan(empty(), [scanned(), scanned({ issue_id: 'i2', family_key: 'f2' })], 't0');
  judge(state, 'i2', { fixable: false, reason: 'r', at: 't0' });
  ({ state } = mergeScan(state, [], 't1'));
  ({ state } = mergeScan(state, [], 't2'));
  assert.deepEqual(Object.keys(state.candidates).sort(), ['i1', 'i2']);
  assert.equal(state.candidates.i2.verdict.reason, 'r');
  assert.equal('stale_count' in state.candidates.i1, false);
});
```

4) 整个删除测试「setJudgment 与 pendingSorted 按档位再按用户数排序，null 档位最后」，原位置写入：
```js
test('pendingSorted 只含 pending，按用户数降序', () => {
  const { state } = mergeScan(empty(), [
    scanned({ issue_id: 'a', family_key: 'fa', family_users: 10 }),
    scanned({ issue_id: 'b', family_key: 'fb', family_users: 900 }),
    scanned({ issue_id: 'c', family_key: 'fc', family_users: 500 }),
  ], 't0');
  reject(state, 'b', '不修', 't1');
  assert.deepEqual(pendingSorted(state).map((c) => c.issue_id), ['c', 'a']);
});

test('judge 写 agent 判定并追加 verdicts 历史', () => {
  const { state } = mergeScan(empty(), [scanned()], T0);
  judge(state, 'i1', { fixable: false, reason: '调用点在宿主内置脚本', at: T0 });
  judge(state, 'i1', { fixable: true, reason: '调用方可加能力探测', at: T1 });
  assert.deepEqual(state.candidates.i1.verdict, { fixable: true, reason: '调用方可加能力探测', by: 'agent', at: T1 });
  assert.deepEqual(state.candidates.i1.verdicts.map((v) => v.fixable), [false, true]);
});

test('judge 拒绝：缺理由、fixable 非布尔、池里没有、非 pending、已被用户捞回', () => {
  const { state } = mergeScan(empty(), [scanned(), scanned({ issue_id: 'i2', family_key: 'f2' })], T0);
  assert.throws(() => judge(state, 'i1', { fixable: true, reason: '', at: T0 }), /--reason/);
  assert.throws(() => judge(state, 'i1', { fixable: undefined, reason: 'r', at: T0 }), /yes \/ no/);
  assert.throws(() => judge(state, 'nope', { fixable: true, reason: 'r', at: T0 }), /候选池里没有/);
  reject(state, 'i2', '不修', T0);
  assert.throws(() => judge(state, 'i2', { fixable: true, reason: 'r', at: T0 }), /不是 pending 候选/);
  revive(state, 'i1', T0);
  assert.throws(() => judge(state, 'i1', { fixable: false, reason: 'r', at: T1 }), /已由用户捞回/);
});

test('judge --same-as 写 covered_by 并判不能修，目标须是已派单且不能是自己', () => {
  const { state } = mergeScan(empty(), [scanned({ issue_id: 'old', family_key: 'k1' }), scanned({ issue_id: 'shared', family_key: 'k2' })], T0);
  assert.throws(() => judge(state, 'shared', { sameAs: 'old', reason: '同缺陷', at: T0 }), /不是已派单候选/);
  markDispatched(state, 'old', { task_id: 't', supplement: 'x', at: T0 });
  assert.throws(() => judge(state, 'shared', { sameAs: 'shared', reason: '同缺陷', at: T0 }), /不能归属到自己/);
  judge(state, 'shared', { sameAs: 'old', reason: '同缺陷已派单 old', at: T1 });
  assert.equal(state.candidates.shared.covered_by, 'old');
  assert.deepEqual(state.candidates.shared.verdict, { fixable: false, reason: '同缺陷已派单 old', by: 'agent', at: T1 });
});

test('revive 写用户判定、清掉 covered_by，已拒的恢复为 pending，已派单的拒绝', () => {
  const { state } = mergeScan(empty(), [
    scanned({ issue_id: 'old', family_key: 'k1' }),
    scanned({ issue_id: 'a', family_key: 'k2' }),
    scanned({ issue_id: 'b', family_key: 'k3' }),
  ], T0);
  markDispatched(state, 'old', { task_id: 't', supplement: 'x', at: T0 });
  judge(state, 'a', { sameAs: 'old', reason: '同缺陷', at: T0 });
  revive(state, 'a', T1);
  assert.equal(state.candidates.a.covered_by, undefined);
  assert.deepEqual(state.candidates.a.verdict, { fixable: true, reason: '捞回', by: 'user', at: T1 });
  assert.equal(state.candidates.a.verdicts.length, 2);
  reject(state, 'b', '不修', T0);
  revive(state, 'b', T1);
  assert.equal(state.candidates.b.status, 'pending');
  assert.equal(state.candidates.b.decision, null);
  assert.deepEqual(state.candidates.b.verdicts.map((v) => [v.by, v.fixable, v.reason]), [['user', false, '不修'], ['user', true, '捞回']]);
  assert.throws(() => revive(state, 'old', T1), /已派单/);
  assert.throws(() => revive(state, 'nope', T1), /候选池里没有/);
});
```

5) 「reject 与 markDispatched 记录决策并改状态…」里 `assert.deepEqual(state.candidates.i1.decision, { reason: '宿主问题', at: 't1' });` 之后追加：
```js
  assert.deepEqual(state.candidates.i1.verdict, { fixable: false, reason: '宿主问题', by: 'user', at: 't1' });
```
同一测试末尾追加：
```js
  assert.equal('fix_paths' in state.candidates.i1.decision, false);
```

6) 「mergeFromScan 落候选池、台账与 merge-latest.json」里：
```js
  assert.deepEqual(out, { pending: 2, removed: 0, ledger_appended: 2 });
```
改为
```js
  assert.deepEqual(out, { pending: 2, ledger_appended: 2 });
```
并删除该测试里的 `assert.deepEqual(latest.removed, []);` 一行。

7) 「CLI merge 输出一行 JSON」里期望改为 `{ ok: true, pending: 1, ledger_appended: 1 }`。

8) 「CLI merge / pick 缺 --scan 按用法错误退出 2」整体替换为：
```js
test('CLI merge / walk 缺 --scan 按用法错误退出 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  for (const cmd of ['merge', 'walk']) {
    const { status, stderr } = cliStatus(cmd, '--dir', dir);
    assert.equal(status, 2);
    assert.match(stderr, /用法/);
  }
});
```

9) 「CLI 认 issue 的子命令缺 --issue-id、cover 缺 --by 都按用法错误退出 2」整体替换为：
```js
test('CLI 认 issue 的子命令缺 --issue-id 按用法错误退出 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  for (const cmd of ['judge', 'revive', 'reject', 'dispatched', 'history']) {
    const { status, stderr } = cliStatus(cmd, '--dir', dir);
    assert.equal(status, 2, cmd);
    assert.match(stderr, /用法/);
  }
});
```

10) 删除以下 10 个测试（整段）：
- 「pick 按机械规则剔除并写入档位：warn、服务端错误码、豆包页面、native code、帧不在仓内」
- 「pick 短名单按族用户数降序，Sourcemap 没取到的排末尾，带帧信息；--skip 与已判低 / 排除的不进短名单」
- 「pick 短名单的 message 取本次扫描快照，不取池里冻在首见那次的文案」
- 「pick 不拿机械规则覆盖已判高 / 中的候选」
- 「pick 只看本次扫描到的 pending 候选」
- 「已派单覆盖：帧命中已派单的 fix_paths 进 covered 并写 covered_by，不再随合入与否变化」
- 「cover 手工建立归属：帧在共享 throw 点、fix_paths 匹配不到时同样进 covered」
- 「cover 拒绝自己归属自己，也拒绝已结案的候选」
- 「CLI pick / dispatched --fix-paths / cover 落盘并输出一行 JSON」

（`const frame = ...` 定义保留，history 测试在用。）在原位置写入：
```js
test('CLI judge / revive 落盘并输出一行 JSON；judge 缺 --reason 报错不落盘；dispatched 不记 fix_paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const scanFile = join(dir, 'scan.json');
  writeFileSync(scanFile, JSON.stringify({ scanned_at: T0, candidates: [snap(), snap({ issue_id: 'i2', family_key: 'f2' })] }));
  cli('merge', '--dir', dir, '--scan', scanFile);
  const r = cliStatus('judge', '--dir', dir, '--issue-id', 'i1', '--fixable', 'no');
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /--reason/);
  assert.equal(loadState(dir).candidates.i1.verdict, null);
  assert.deepEqual(cli('judge', '--dir', dir, '--issue-id', 'i1', '--fixable', 'no', '--reason', '宿主内置脚本'), { ok: true, issue_id: 'i1', fixable: false, covered_by: null });
  cli('dispatched', '--dir', dir, '--issue-id', 'i2', '--task-id', 't', '--workspace', '/h/ws/i2/biz-vc-web');
  assert.equal('fix_paths' in loadState(dir).candidates.i2.decision, false);
  assert.deepEqual(cli('judge', '--dir', dir, '--issue-id', 'i1', '--same-as', 'i2', '--reason', '同缺陷已派单 i2'), { ok: true, issue_id: 'i1', fixable: false, covered_by: 'i2' });
  assert.deepEqual(cli('revive', '--dir', dir, '--issue-id', 'i1'), { ok: true, revived: 'i1' });
  const c = loadState(dir).candidates.i1;
  assert.equal(c.verdict.by, 'user');
  assert.equal(c.covered_by, undefined);
  assert.equal(c.verdicts.length, 3);
});
```

11) 「history 给出本族与被覆盖族的台账行、处置事件、回落比…」中：
```js
  markDispatched(state, 'old', { task_id: 't', supplement: 'x', fix_paths: ['ai-summary/src/services/summary-layout.ts'], at: '2026-09-10T12:00:00.000Z' });
  const merged = mergeScan(state, [{ ...old, family_count: 1200 }, renamed, other], T1).state;
  pick(merged, [old, renamed, other]);
```
替换为
```js
  markDispatched(state, 'old', { task_id: 't', supplement: 'x', at: '2026-09-10T12:00:00.000Z' });
  const merged = mergeScan(state, [{ ...old, family_count: 1200 }, renamed, other], T1).state;
  judge(merged, 'renamed', { sameAs: 'old', reason: '同缺陷已派单 old', at: T1 });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test monitor-triage/tests/state.test.mjs`
Expected: FAIL（`judge` / `revive` 不是导出成员，模块加载报 SyntaxError）。

- [ ] **Step 3: 改实现**

`monitor-triage/scripts/state.mjs`：把从第 1 行起到 `pick` 函数结束（原 `return { shortlist, covered, filtered, dispatched: handled.length };\n}`）为止的全部内容替换为：

```js
#!/usr/bin/env node
// 候选池、处置账与台账的唯一读写点。candidates.json 是走查与判定的池子；
// dispatched.json 是 prepare-dispatch.sh / board.sh 共用的派单处置账，两份文件按 issue_id 对齐；
// ledger.jsonl 是每次扫描每族一行的量级台账。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const FILES = { candidates: 'candidates.json', dispatched: 'dispatched.json' };
// 候选池里的 count / users 会被后续扫描覆盖，事后要取「修复前 → 修复后」量级只能靠这份只追加的台账。
const LEDGER = 'ledger.jsonl';

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
    web-monitor_url: c.web-monitor_url ?? null,
    users: c.family_users ?? c.users ?? 0,
    count: c.family_count ?? c.count ?? 0,
    first_seen: c.first_seen ?? null,
    first_seen_at: now,
    refreshed_at: now,
    status: 'pending',
    verdict: null,
    verdicts: [],
    decision: null,
  };
}

// 扫描是分页的，某页没扫到不代表告警消失；判定与捞回都挂在候选上，缺席的候选一律保留。
export function mergeScan(state, scanned, now) {
  const pool = { ...state.candidates };
  const settledFamilies = new Set(Object.values(pool).filter((c) => c.status !== 'pending').map((c) => c.family_key));
  for (const c of scanned) {
    const cur = pool[c.issue_id];
    if (cur) {
      pool[c.issue_id] = {
        ...cur,
        users: c.family_users ?? c.users ?? cur.users,
        count: c.family_count ?? c.count ?? cur.count,
        issue_url: c.issue_url ?? cur.issue_url,
        web-monitor_url: c.web-monitor_url ?? cur.web-monitor_url,
        member_issue_ids: c.member_issue_ids ?? cur.member_issue_ids,
        refreshed_at: now,
      };
      continue;
    }
    if (settledFamilies.has(c.family_key)) continue;
    pool[c.issue_id] = fromScan(c, now);
  }
  return { state: { ...state, candidates: pool } };
}

// verdict 是当前结论，verdicts 是只追加的完整决策史（agent 判定、用户拒绝与捞回）。
function withVerdict(c, verdict) {
  return { ...c, verdict, verdicts: [...(c.verdicts ?? []), verdict] };
}

// agent 的判定是可被用户推翻的缓存；用户捞回过的条目 agent 不得改判。
export function judge(state, issueId, { fixable, reason, sameAs, at }) {
  const c = state.candidates[issueId];
  if (!c) throw new Error(`候选池里没有 ${issueId}`);
  if (c.status !== 'pending') throw new Error(`${issueId} 不是 pending 候选`);
  if (c.verdict?.by === 'user') throw new Error(`${issueId} 已由用户捞回，agent 不能改判`);
  if (!reason) throw new Error('判定必须带 --reason');
  if (sameAs) {
    if (sameAs === issueId) throw new Error(`${issueId} 不能归属到自己`);
    if (state.candidates[sameAs]?.status !== 'dispatched') throw new Error(`${sameAs} 不是已派单候选`);
    state.candidates[issueId] = withVerdict({ ...c, covered_by: sameAs }, { fixable: false, reason, by: 'agent', at });
    return;
  }
  if (typeof fixable !== 'boolean') throw new Error('--fixable 只能是 yes / no');
  state.candidates[issueId] = withVerdict(c, { fixable, reason, by: 'agent', at });
}

// 捞回覆盖 agent 的结论与用户自己之前的拒绝。已派单的续作归 harness 任务链，dispatched.json 的续做记录不能在这里重开。
export function revive(state, issueId, at) {
  const c = state.candidates[issueId];
  if (!c) throw new Error(`候选池里没有 ${issueId}`);
  if (c.status === 'dispatched') throw new Error(`${issueId} 已派单，不能捞回`);
  const { covered_by: _coveredBy, ...rest } = c;
  const reopened = c.status === 'rejected' ? { ...rest, status: 'pending', decision: null } : rest;
  state.candidates[issueId] = withVerdict(reopened, { fixable: true, reason: '捞回', by: 'user', at });
}

export function pendingSorted(state) {
  return Object.values(state.candidates)
    .filter((c) => c.status === 'pending')
    .sort((a, b) => (b.users ?? 0) - (a.users ?? 0));
}

export function reject(state, issueId, reason, now) {
  const c = state.candidates[issueId];
  if (!c) throw new Error(`候选池里没有 ${issueId}`);
  state.candidates[issueId] = withVerdict(
    { ...c, status: 'rejected', decision: { reason, at: now } },
    { fixable: false, reason, by: 'user', at: now },
  );
}

export function markDispatched(state, issueId, { task_id, task_slug, workspace, supplement, at }) {
  const c = state.candidates[issueId];
  if (!c) throw new Error(`候选池里没有 ${issueId}`);
  state.candidates[issueId] = { ...c, status: 'dispatched', decision: { task_id, supplement: supplement ?? '', at } };
  state.dispatched[issueId] = {
    ...(state.dispatched[issueId] ?? {}),
    task_id,
    ...(task_slug ? { task_slug } : {}),
    ...(workspace ? { workspace } : {}),
    dispatched_at: at,
  };
}
```

`mergeFromScan` 整体替换为：
```js
export function mergeFromScan(dir, scan) {
  const { state } = mergeScan(loadState(dir), scan.candidates, scan.scanned_at);
  saveState(dir, state);
  const appended = appendLedger(dir, ledgerRows(state, scan.candidates, scan.scanned_at));
  const pending = pendingSorted(state);
  mkdirSync(join(dir, 'scans'), { recursive: true });
  writeFileSync(join(dir, 'scans', 'merge-latest.json'), `${JSON.stringify({ pending }, null, 2)}\n`);
  return { pending: pending.length, ledger_appended: appended };
}
```

CLI 段：从 `const NEEDS_ISSUE_ID` 起到文件末尾整体替换为：
```js
const NEEDS_ISSUE_ID = new Set(['judge', 'revive', 'reject', 'dispatched', 'history']);

const USAGE = '用法: state.mjs merge|walk|pending|judge|revive|reject|dispatched|history --dir <state> [--scan <scan.json>] [--skip <id,id>] [--issue-id <id>] [--fixable yes|no] [--reason <text>] [--same-as <id>] [--task-id <id>] [--task-slug <slug>] [--workspace <abs>] [--supplement <text>]\n';

function usageExit() {
  process.stderr.write(USAGE);
  process.exit(2);
}

function fixableArg() {
  const v = arg('--fixable');
  if (v === 'yes') return true;
  if (v === 'no') return false;
  return undefined;
}

// 技能目录经 symlink 安装，argv[1] 是链接路径而 import.meta.url 是真实路径，须按 realpath 比较。
if (isMain()) {
  const cmd = process.argv[2];
  const dir = arg('--dir');
  const needsScan = cmd === 'merge' || cmd === 'walk';
  const needsIssue = NEEDS_ISSUE_ID.has(cmd);
  if (!dir || (needsScan && !arg('--scan')) || (needsIssue && !arg('--issue-id'))) usageExit();
  const state = loadState(dir);
  const now = new Date().toISOString();
  const id = arg('--issue-id');
  try {
    if (cmd === 'merge') {
      const scan = JSON.parse(readFileSync(arg('--scan'), 'utf8'));
      process.stdout.write(`${JSON.stringify({ ok: true, ...mergeFromScan(dir, scan) })}\n`);
    } else if (cmd === 'pending') {
      process.stdout.write(`${JSON.stringify(pendingSorted(state))}\n`);
    } else if (cmd === 'judge') {
      judge(state, id, { fixable: fixableArg(), reason: arg('--reason'), sameAs: arg('--same-as'), at: now });
      saveState(dir, state);
      const c = state.candidates[id];
      process.stdout.write(`${JSON.stringify({ ok: true, issue_id: id, fixable: c.verdict.fixable, covered_by: c.covered_by ?? null })}\n`);
    } else if (cmd === 'revive') {
      revive(state, id, now);
      saveState(dir, state);
      process.stdout.write(`${JSON.stringify({ ok: true, revived: id })}\n`);
    } else if (cmd === 'reject') {
      reject(state, id, arg('--reason') ?? '', now);
      saveState(dir, state);
      process.stdout.write(`${JSON.stringify({ ok: true, rejected: id })}\n`);
    } else if (cmd === 'dispatched') {
      // 在途检查与 board.sh 都按 task_id + workspace 定位 omh Task，缺一条这单就查不到。
      for (const k of ['--task-id', '--workspace']) if (!arg(k)) throw new Error(`缺 ${k}`);
      markDispatched(state, id, { task_id: arg('--task-id'), task_slug: arg('--task-slug'), workspace: arg('--workspace'), supplement: arg('--supplement') ?? '', at: now });
      saveState(dir, state);
      process.stdout.write(`${JSON.stringify({ ok: true, dispatched: id })}\n`);
    } else if (cmd === 'history') {
      process.stdout.write(`${JSON.stringify({ ok: true, ...history(state, readLedger(dir), id) })}\n`);
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
（`isMain`、`arg`、`listArg` 三个辅助函数保留原样；`listArg` 在 Task 3 的 `walk --skip` 使用。）

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test monitor-triage/tests/state.test.mjs && bash monitor-triage/tests/run.sh`
Expected: state 全部 `ok`；run.sh 末行 `pass=21 fail=0`，退出码 0。

- [ ] **Step 5: 确认旧概念已清干净**

Run: `grep -nE "likelihood|mechanicalVerdict|pick\(|cover\(|fix_paths|stale|LOW_MESSAGE|OUR_SOURCE" monitor-triage/scripts/state.mjs`
Expected: 无输出。

- [ ] **Step 6: Commit**

```bash
git add monitor-triage/scripts/state.mjs monitor-triage/tests/state.test.mjs
git commit -m "feat(monitor-triage): 判定收成能修 / 不能修两档，支持捞回"
```

---

### Task 3: walk 走查

**Files:**
- Modify: `monitor-triage/scripts/state.mjs`（在 `markDispatched` 之后加 `resolveOwner` / `classify` / `walk`；CLI 加 `walk` 分支）
- Test: `monitor-triage/tests/state.test.mjs`

**Interfaces:**
- Consumes: Task 2 的候选结构、`judge` / `revive` / `reject` / `markDispatched`。
- Produces: `walk(state, scanned, { skip = [] } = {}) → { items, todo, exhausted }`，
  - `items[]`: `{ issue_id, users, count, message, issue_url, class: 'fixable'|'skip'|'unjudged', source: 'dispatched'|'rejected'|'agent'|'user'|'session'|null, reason, at, detail_error, mapped_path, line, function, page, release }`
  - `todo[]`: `{ issue_id, users, message, issue_url, at }`
  - CLI：`state.mjs walk --dir <state> --scan <scan.json> [--skip <id,id>]` → `{"ok":true,"items":[...],"todo":[...],"exhausted":bool}`，不写盘。

- [ ] **Step 1: 写失败测试**

`monitor-triage/tests/state.test.mjs`：import 块加入 `walk`：
```js
import {
  loadState, saveState, mergeScan, judge, revive, pendingSorted, reject, markDispatched,
  readLedger, ledgerRows, appendLedger, mergeFromScan,
  walk, history,
} from '../scripts/state.mjs';
```

在「CLI judge / revive 落盘…」测试之后追加：
```js
test('walk 按族用户数降序归类：已派单 / 同缺陷 > 已拒 > 用户捞回 > agent 能修 > agent 不能修 > 待判', () => {
  const scan = [
    snap({ issue_id: 'disp', family_key: 'k1', family_users: 900 }),
    snap({ issue_id: 'cov', family_key: 'k2', family_users: 800 }),
    snap({ issue_id: 'rej', family_key: 'k3', family_users: 700 }),
    snap({ issue_id: 'no', family_key: 'k4', family_users: 600 }),
    snap({ issue_id: 'rev', family_key: 'k5', family_users: 500 }),
    snap({ issue_id: 'yes', family_key: 'k6', family_users: 400 }),
    snap({ issue_id: 'new', family_key: 'k7', family_users: 300 }),
  ];
  const { state } = mergeScan(empty(), scan, T0);
  markDispatched(state, 'disp', { task_id: 't', supplement: 'x', at: T0 });
  judge(state, 'cov', { sameAs: 'disp', reason: '同缺陷已派单 disp', at: T1 });
  judge(state, 'rej', { fixable: true, reason: '调用方可 catch', at: T0 });
  reject(state, 'rej', '只是加日志，没必要', T1);
  judge(state, 'no', { fixable: false, reason: '调用点在宿主内置脚本', at: T1 });
  judge(state, 'rev', { fixable: false, reason: '宿主未注入 API', at: T1 });
  revive(state, 'rev', T2);
  judge(state, 'yes', { fixable: true, reason: '调用方可加 catch', at: T1 });
  const out = walk(state, [...scan].reverse());
  assert.deepEqual(out.items.map((i) => [i.issue_id, i.class, i.source]), [
    ['disp', 'skip', 'dispatched'],
    ['cov', 'skip', 'dispatched'],
    ['rej', 'skip', 'rejected'],
    ['no', 'skip', 'agent'],
    ['rev', 'fixable', 'user'],
    ['yes', 'fixable', 'agent'],
    ['new', 'unjudged', null],
  ]);
  assert.equal(out.items[0].at, T0);
  assert.equal(out.items[1].reason, '同缺陷已派单 disp');
  assert.equal(out.items[2].reason, '只是加日志，没必要');
  assert.equal(out.items[3].reason, '调用点在宿主内置脚本');
  assert.equal(out.items[3].at, T1);
  assert.deepEqual(out.todo, [{ issue_id: 'rev', users: 500, message: 'm', issue_url: 'u1', at: T2 }]);
  assert.equal(out.exhausted, false);
});

test('walk 的 message 与帧信息取本次扫描快照；--skip 只把非 skip 项记为 session 且不落盘', () => {
  const scan = [
    snap({ message: '[native-api] command=94003 timed out after 10000ms', family_users: 50 }),
    snap({ issue_id: 'i2', family_key: 'f2', family_users: 40 }),
  ];
  const { state } = mergeScan(empty(), scan, T0);
  state.candidates.i1.message = '[native-api] command=94003 timed out after 3000ms';
  reject(state, 'i2', '不修', T0);
  const out = walk(state, scan, { skip: ['i1', 'i2'] });
  assert.deepEqual(out.items[0], {
    issue_id: 'i1', users: 50, count: 5000, message: '[native-api] command=94003 timed out after 10000ms', issue_url: 'u1',
    class: 'skip', source: 'session', reason: '', at: null,
    detail_error: null, mapped_path: 'ai-summary/src/services/summary-layout.ts', line: 271, function: 'getMeetingAISummary', page: '/webview/summary-layout', release: '7.77.0.21',
  });
  assert.equal(out.items[1].source, 'rejected');
  assert.equal(out.exhausted, true);
  assert.equal(state.candidates.i1.verdict, null);
});

test('walk 让同族换了 issue_id 的扫描项沿用已派单那条的状态', () => {
  const { state } = mergeScan(empty(), [snap({ issue_id: 'old', family_key: 'k1' })], T0);
  markDispatched(state, 'old', { task_id: 't', supplement: 'x', at: T0 });
  const later = [snap({ issue_id: 'fresh', family_key: 'k1', member_issue_ids: ['fresh'] })];
  const merged = mergeScan(state, later, T1).state;
  assert.equal(merged.candidates.fresh, undefined);
  assert.deepEqual(walk(merged, later).items.map((i) => [i.issue_id, i.class, i.source]), [['old', 'skip', 'dispatched']]);
});

test('walk 跨页同族：后一页的成员沿用前一页已判定那条的结论', () => {
  const page1 = [snap({ issue_id: 'a', family_key: 'APINotProvided', family_users: 900 })];
  let { state } = mergeScan(empty(), page1, T0);
  judge(state, 'a', { fixable: false, reason: '调用点在宿主内置脚本', at: T0 });
  const page2 = [snap({ issue_id: 'b', family_key: 'APINotProvided', member_issue_ids: ['b'], family_users: 90 })];
  ({ state } = mergeScan(state, page2, T1));
  assert.equal(state.candidates.b.verdict, null);
  assert.deepEqual(walk(state, page2).items.map((i) => [i.issue_id, i.class, i.reason]), [['a', 'skip', '调用点在宿主内置脚本']]);
});

test('CLI walk 输出一行 JSON 且不改池子', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const scanFile = join(dir, 'scan.json');
  writeFileSync(scanFile, JSON.stringify({ scanned_at: T0, candidates: [snap(), snap({ issue_id: 'i2', family_key: 'f2', family_users: 100 })] }));
  cli('merge', '--dir', dir, '--scan', scanFile);
  cli('judge', '--dir', dir, '--issue-id', 'i1', '--fixable', 'no', '--reason', '宿主内置脚本');
  const before = readFileSync(join(dir, 'candidates.json'), 'utf8');
  const out = cli('walk', '--dir', dir, '--scan', scanFile, '--skip', 'i2');
  assert.equal(out.ok, true);
  assert.deepEqual(out.items.map((i) => [i.issue_id, i.class, i.source]), [['i1', 'skip', 'agent'], ['i2', 'skip', 'session']]);
  assert.deepEqual(out.todo, []);
  assert.equal(out.exhausted, true);
  assert.equal(readFileSync(join(dir, 'candidates.json'), 'utf8'), before);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test monitor-triage/tests/state.test.mjs`
Expected: FAIL（`walk` 不是导出成员）。

- [ ] **Step 3: 实现 walk**

`monitor-triage/scripts/state.mjs`，在 `markDispatched` 函数之后插入：
```js
// 同一缺陷可能以不同 issue_id 出现在不同扫描或不同页。结案的同族优先（派单、拒绝对整族生效），
// 其次是已有判定的那条（跨页不重读代码），都没有才落到自己。
export function resolveOwner(state, scannedItem) {
  const self = state.candidates[scannedItem.issue_id];
  const related = Object.values(state.candidates).filter((p) => p.issue_id === scannedItem.issue_id
    || (p.member_issue_ids ?? []).includes(scannedItem.issue_id)
    || p.family_key === scannedItem.family_key);
  return related.find((p) => p.status === 'dispatched')
    ?? related.find((p) => p.status === 'rejected')
    ?? [self, ...related].find((p) => p?.verdict)
    ?? self
    ?? related[0]
    ?? null;
}

const UNJUDGED = { class: 'unjudged', source: null, reason: '', at: null };

function classify(state, owner) {
  if (!owner) return UNJUDGED;
  if (owner.status === 'dispatched') return { class: 'skip', source: 'dispatched', reason: '', at: owner.decision?.at ?? null };
  if (owner.covered_by && state.candidates[owner.covered_by]?.status === 'dispatched') {
    return { class: 'skip', source: 'dispatched', reason: owner.verdict?.reason ?? '', at: owner.verdict?.at ?? null };
  }
  if (owner.status === 'rejected') return { class: 'skip', source: 'rejected', reason: owner.decision?.reason ?? '', at: owner.decision?.at ?? null };
  const v = owner.verdict;
  if (!v) return UNJUDGED;
  return { class: v.fixable ? 'fixable' : 'skip', source: v.by, reason: v.reason, at: v.at };
}

// 纯函数：按族用户数降序给出每条的归类。agent 遇到 unjudged 判定落档后重跑，直到第一条非 skip 的是 fixable；
// 排在它前面的 skip 项就是呈现给用户的跳过清单，不存在不可见的剔除。
export function walk(state, scanned, { skip = [] } = {}) {
  const usersOf = (c) => c.family_users ?? c.users ?? 0;
  const seen = new Set();
  const items = [];
  for (const c of [...scanned].sort((a, b) => usersOf(b) - usersOf(a))) {
    const owner = resolveOwner(state, c);
    const id = owner?.issue_id ?? c.issue_id;
    if (seen.has(id)) continue;
    seen.add(id);
    const verdict = classify(state, owner);
    const e = c.latest_event ?? {};
    items.push({
      issue_id: id,
      users: usersOf(c),
      count: c.family_count ?? c.count ?? 0,
      // 池里的 message 冻在首见那次，可能还带着早已换掉的 logId 之类易变量；呈现要用本次扫描的原文。
      message: c.message ?? owner?.message ?? '',
      issue_url: c.issue_url ?? owner?.issue_url ?? null,
      ...(verdict.class !== 'skip' && skip.includes(id) ? { class: 'skip', source: 'session', reason: '', at: null } : verdict),
      detail_error: c.detail_error ?? null,
      mapped_path: e.mapped_path ?? null,
      line: e.line ?? null,
      function: e.function ?? null,
      page: e.page ?? null,
      release: e.release ?? null,
    });
  }
  const todo = Object.values(state.candidates)
    .filter((p) => p.status === 'pending' && p.verdict?.by === 'user' && p.verdict.fixable)
    .sort((a, b) => (b.users ?? 0) - (a.users ?? 0))
    .map((p) => ({ issue_id: p.issue_id, users: p.users ?? 0, message: p.message, issue_url: p.issue_url, at: p.verdict.at }));
  return { items, todo, exhausted: !items.some((i) => i.class !== 'skip') };
}
```

CLI 段，在 `} else if (cmd === 'history') {` 之前插入：
```js
    } else if (cmd === 'walk') {
      const scan = JSON.parse(readFileSync(arg('--scan'), 'utf8'));
      process.stdout.write(`${JSON.stringify({ ok: true, ...walk(state, scan.candidates, { skip: listArg('--skip') }) })}\n`);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bash monitor-triage/tests/run.sh`
Expected: node:test 全部 `ok`；末行 `pass=21 fail=0`；退出码 0。

- [ ] **Step 5: Commit**

```bash
git add monitor-triage/scripts/state.mjs monitor-triage/tests/state.test.mjs
git commit -m "feat(monitor-triage): walk 按用户数走查并给出可见的跳过清单"
```

---

### Task 4: 文档改到新流程

**Files:**
- Create: `monitor-triage/references/judging.md`
- Delete: `monitor-triage/references/likelihood.md`
- Modify: `monitor-triage/references/example-report.md`（整体重写）
- Modify: `monitor-triage/SKILL.md`（frontmatter、开头说明、入口、主流程 2–5、引导式收敛、派单第 11 步、纪律）

**Interfaces:**
- Consumes: Task 1 的 `scan.mjs --page/--page-size`；Task 2/3 的 `state.mjs walk|judge|revive|reject|pending`。

- [ ] **Step 1: 新建 `monitor-triage/references/judging.md`**

````markdown
# 判定口径

每条告警只落一个结论：ai-summary 能修 / 不能修。判定只在 `walk` 给出 `unjudged` 时做，落档后作为缓存复用，并总以跳过清单的形式呈现给用户，由用户兜底。

## 能修

`ai-summary/` 或 `packages/` 内存在某处改动，能减少这条上报或改善用户侧表现。下列任一都算，不要求单一缺陷点位：

- 修缺陷（空值、竞态、读写 key 不一致等）
- 在调用点 catch，走既有错误处理，不再逃逸为 unhandledrejection
- 失败降级（兜底 UI、重试、跳过非关键数据）
- 能力探测：宿主未提供 API 时不调用或走替代路径
- 去掉无效或重复调用
- 校正上报级别：预期内的失败不按 error 上报

```bash
node <skill>/scripts/state.mjs judge --dir <state> --issue-id <id> --fixable yes --reason "<点位与改法一句话>"
```

## 判不能修之前

1. 沿**完整堆栈**找出 ai-summary 调用点，不只看最新帧。最新帧在宿主、CDN、`[native code]` 时，往上找第一个 `ai-summary/` 或 `packages/` 帧；整条栈都没有，再取同 issue 的其他事件看。
2. 对上面每种手段说明为什么不成立。
3. 理由写一句话、点名责任层：
   - `master 已修（<commit>），线上 <release> 未带上`：`git -C <repo> log -S'<关键片段>' origin/master --oneline` 查到提交，且线上 `release_dist` 主版本早于该提交进入的 builds 分支版本。
   - `同缺陷已派单 <issue_id>`：调用链汇到那张单的改动范围（典型是超时类错误落在共享 throw 点），用 `--same-as`。
   - `调用点在宿主内置脚本，ai-summary 无调用点`。

```bash
node <skill>/scripts/state.mjs judge --dir <state> --issue-id <id> --fixable no --reason "<责任层一句话>"
node <skill>/scripts/state.mjs judge --dir <state> --issue-id <id> --same-as <已派单 issue_id> --reason "同缺陷已派单 <issue_id>：<一句话>"
```

只描述现象来源的理由不合格：「宿主问题」「服务端错误码」「warn 级日志」「页面在豆包」。服务端返回错误码时 ai-summary 仍可能该 catch 或降级；豆包移动端是 ai-summary 的正式入口。

## 拿不准

判能修。是否**值得**修（例如主要改动只是加日志）由用户在引导式收敛里决定，agent 不代为拦截：假阳性有用户在收敛中拦，假阴性只能靠用户读跳过清单兜底。

## 用户决定优先

用户捞回（`verdict.by=user`）的条目 agent 不改判，`judge` 会拒绝；用户拒过的条目只能由用户捞回。
````

- [ ] **Step 2: 删除旧口径文件**

```bash
git rm monitor-triage/references/likelihood.md
```

- [ ] **Step 3: 重写 `monitor-triage/references/example-report.md`**

整体替换为：
````markdown
# 样例（呈现 → 收敛对话 → 技术方案）

## 呈现

【web-monitor · ai_summary 近 24h】
现象：PC 端会中 AI 视图（summary-layout）拉取会议 AI 总结时等了 10 秒没有结果，错误以 unhandledrejection 上报
报错：[native-api] command=94003 timed out after 10000ms
Issue：<internal-url>

待处理（你捞回过、还没派也没拒）：
- common.getAvatarBase64 timeout after 60s（2.1k 用户）— 捞回 09-27
排在它前面、判为不能修的：
1. APINotProvided（71k 用户）— agent 09-29：调用点在宿主内置脚本，ai-summary 无调用点
2. [warn] FishBoneError: fishBone out of screen（29k 用户）— 你拒过 09-29：只是加日志，没必要
3. [InvokeServierPBFast error]: logId=…（13k 用户）— 已派单 09-28
要捞回哪条直接说「捞回 2」。

先定复现条件。这条既出现在会中 AI 视图（summary-layout），也出现在妙记 PC（minutes-summary-layout-pc）。你想先按哪个场景看？

## 捞回

用户：捞回 1

agent（`revive` 后切到这条，第一问围绕「ai-summary 能怎么缓解」）：

【web-monitor · ai_summary 近 24h】（你捞回的）
现象：豆包移动端 AI 视图调用宿主接口时，宿主未提供该接口
报错：APINotProvided
Issue：<internal-url>

调用点在 `packages/vc-client-web-utils/gateway/request.ts`，master 上这一段是：

    <git show 贴出的原文>

你倾向在调用前做能力探测、在调用点 catch 后降级，还是去掉这次调用？

## 收敛对话（每轮一个事实 + 一个问题）

用户：先看会中。

agent：这条的最新帧在 `ai-summary/src/services/summary-layout.ts:271`，master 上这一段是：

    async getFishBoneData() {
      this.loading = true;
      try {
        const res = await getMeetingAISummary(...);
        ...
      } finally {
        this.loading = false;
      }
    }

报错原文里的超时是 10000ms。复现条件就定成「会中打开 AI 视图、宿主 command 94003 在 10s 内不回包」，还是你见过别的触发路径？

（……按清单继续：缺陷点位、根因归属、改动范围、验收方式）

## 技术方案回显

【技术方案】f49170ba
复现条件：PC 会中打开 AI 视图，宿主 command 94003 在 10s 内不回包
缺陷点位：ai-summary/src/services/summary-layout.ts:266-280 getFishBoneData
根因：超时 reject 没有被接住，逃逸为 unhandledrejection（native / 服务端确认情况：94003 不回包的原因未向 native 确认，本单只处理 web 侧未捕获）
改动范围：ai-summary/src/services/summary-layout.ts 加 catch 并走既有错误上报；不动 native 协议、不改超时时长
验收：mock getMeetingAISummary 返回 rejected Promise，改动前测试进程收到 unhandledRejection，改动后不再收到且 loading 复位

确认后回复「派这条」；要改哪一项直接说。

## 前 100 条没有能修的

翻到第 5 页仍没有 `fixable` 时发，照样附清单：

前 100 条没有判为能修的。
待处理（你捞回过、还没派也没拒）：
- …
排在前面、判为不能修的：
1. …
要捞回哪条直接说「捞回 N」。
````

- [ ] **Step 4: 改 SKILL.md frontmatter 与开头**

`monitor-triage/SKILL.md` 第 3 行 `description:` 整行替换为：
```
description: 扫描 web-monitor 近 24h 线上 JS 错误（只看 ai_summary，即 ai-summary 方向），按影响用户数从高到低逐条判定 ai-summary 能否修，呈现第一条能修的告警（现象、报错、Issue 链接），并附上排在它前面、判为不能修的全部条目与理由供用户捞回；随后一次一问引导用户收敛技术方案；用户说「派这条」才建 ticket-platform、转交 biz-vc-web-harness 任务链修复（omh 固定跑 opus）、登记看板。判定、拒绝与派单都持久化并在跳过清单里可见，每次扫描记台账。当用户说「扫一下线上告警」「看看 web-monitor」「挑一个告警看看」「换一条」「捞回 N」「派这条」「这条不修」时使用。
```

以 `**本技能只管「适合修且还没派过单」的告警。**` 开头的那一段整段替换为：
```
**本技能只管「ai-summary 能修且还没派过单」的告警，任何判定都不静默丢弃。** 按影响用户数降序逐条走查，第一条能修即停；排在它前面的每一条（agent 判不能修、用户拒过、已派单）都带理由出现在跳过清单里，用户一句「捞回 N」即可推翻。派出去的单不再跟踪去向：不查 omh 阶段、不查 MR 是否合入、不看修复是否见效。
```

- [ ] **Step 5: 改 SKILL.md 入口与参数**

「## 入口」下的表格与「参数：」一行整体替换为：
```
| 用户意图 | 动作 |
|---|---|
| 默认（「扫一下线上告警」「看看 web-monitor」「挑一个告警看看」） | 主流程第 1–5 步，随后进入「引导式收敛」 |
| 「换一条」 | 用同一份 scan 重跑第 4 步的 `walk`，`--skip` 带上本会话已呈现过的 issue；当前这条不落档 |
| 「捞回 N」 | 按上次呈现的跳过清单编号（或待处理清单里的条目）取 issue_id，`node <skill>/scripts/state.mjs revive --dir <state> --issue-id <id>`，切到这条按第 5 步格式呈现（标题加「（你捞回的）」，不再附清单），随后进入「引导式收敛」 |
| 「说说你的判断」 | 直接给出对当前这条的初步判断（点位、根因、改法），之后回到一次一问 |
| 「派这条」 | 「派单」一节 |
| 「这条不修 <摘要或 issue_id>，原因：<文本>」 | `node <skill>/scripts/state.mjs reject --dir <state> --issue-id <id> --reason "<原话>"`，回话题确认 |

参数：`--bid`（默认 `ai_summary`；本技能只看 ai-summary 方向，不加 vc_client_web / vc_pages）、`--hours`（24）、`--page-size`（20，按影响用户数一页的条数；最多翻到第 5 页）。
```

- [ ] **Step 6: 改 SKILL.md 主流程第 2–5 步**

从 `### 2. 扫描` 起，到 `## 引导式收敛` 之前为止，整体替换为：
````markdown
### 2. 扫描

```bash
node <skill>/scripts/scan.mjs --bid <bids> --hours <hours> --page <N> --page-size 20 --repo <repo> --out <state>/scans/scan-$(date -u +%Y%m%dT%H%M%SZ)-p<N>.json
```
首轮 `N=1`。按影响用户数（`user_descend`）取一页，同 message 的 issue 合成一族，族按族用户数降序。`skipped_bids` 非空说明 ai_summary 本身没扫成：回话题说明原因并停在这一步。

### 3. 合并候选池并记台账

```bash
node <skill>/scripts/state.mjs merge --dir <state> --scan <scan.json>
```
候选池只增不删：没扫到的页里的候选及其判定都保留。每次扫描的每个族在 `<state>/ledger.jsonl` 留一行（次数、用户、session、各分布主项、状态）。

### 4. 走查与判定

```bash
node <skill>/scripts/state.mjs walk --dir <state> --scan <scan.json> [--skip <id,id>]
```
`items` 按族用户数降序，每条带 `class`：
- `skip`：`source` 为 `dispatched`（已派单或同缺陷已派单）/ `rejected`（用户拒过）/ `agent`（agent 判不能修）/ `session`（本会话看过），带 `reason`、`at`
- `fixable`：`source` 为 `user`（用户捞回）或 `agent`
- `unjudged`：还没判过

从头往下看：第一条非 `skip` 的是 `fixable` 就停，进第 5 步；是 `unjudged` 就按 `<skill>/references/judging.md` 读代码判定、`judge` 落档，然后重跑 `walk`。`items[].issue_id` 就是 `judge` / `revive` 要用的池内键。

读代码：`git -C <repo> show origin/master:<mapped_path> | sed -n '<line-30>,<line+30>p'`，位置已变时 `git -C <repo> log --oneline -5 origin/master -- <mapped_path>`、`git -C <repo> grep -n '<函数名>' origin/master -- <project_dir>`。完整堆栈：`<repo>/node_modules/.bin/web-monitor-web-cli --raw log detail --bid ai_summary --env online --site-type web --start-time <window.start> --end-time <window.end> --ev-type js_error --dh-key <dh_key>`（`dh_key` 取 `log query --filter issue_id` 的样本）。线上 release 对应 commit：`internal-cli --json pkg-platform repo version list <pkg-platform_repo> --type online --version <release> --page-size 10` 取 `data.versions[].base_commit_hash`（ai_summary 同时试 `ee/lark/ai_summary` 与 `ee/lark/ai_summary_doubao`，type 再试 test）。

读 web 代码判不出责任方时（超时、无响应、数据与预期不符），按 `<skill>/references/log-forensics.md` 往下查：web-monitor 事件级 context → 网关与业务 PSM 日志 → Logifier 端侧日志。那份文档同时写了和其他 bot 要结论时的纪律。

`exhausted: true`（本页全是 `skip`）：`N+1` 从第 2 步重跑，最多到 `N=5`（前 100 条）。跨页时把各页 `walk` 的 `skip` 项按页序累积，作为第 5 步的跳过清单。

### 5. 呈现

`botmux send` 一条消息，格式见 `<skill>/references/example-report.md`：

```
【web-monitor · ai_summary 近 24h】
现象：<一句人话：哪个端、哪个页面、用户侧或运行时发生了什么>
报错：<原始 message>
Issue：<issue_url>

待处理（你捞回过、还没派也没拒）：
- <message 摘要>（<users> 用户）— 捞回 <MM-DD>
排在它前面、判为不能修的：
1. <message 摘要>（<users> 用户）— <来源> <MM-DD>：<理由>
要捞回哪条直接说「捞回 2」。

<第一个引导问题>
```
- 当前条 `source=user` 时标题后加「（你捞回的）」。
- 待处理 = `walk.todo` 去掉当前这条；为空省略该节。
- 跳过清单 = 当前这条之前的全部 `skip` 项（跨页累积），全部列出、不折叠，从 1 编号，「捞回 N」按这个编号。来源措辞：`agent` → `agent`，`rejected` → `你拒过`，`dispatched` → `已派单`，`session` → `本会话看过`（不带理由）。为空省略该节。
- 「现象」只写可观察事实，不写代码路径、函数名、根因、改法。
- 翻到第 5 页仍没有 `fixable`：回「前 100 条没有判为能修的」，照样附跳过清单与待处理清单。这句不带「新」字：候选池不看告警首次出现的时间。
````

- [ ] **Step 7: 改 SKILL.md 引导式收敛与派单第 11 步**

「## 引导式收敛」下 `- 初步判断可以用来决定先问什么…` 那一条之后追加一条：
```
- 当前条是捞回项时，第一问围绕「ai-summary 能怎么缓解」：贴 ai-summary 调用点的代码原文，问用户倾向能力探测、catch 后降级、还是去掉这次调用。
```

「## 派单」第 11 步：
- 句子 `；`--fix-paths` 取方案「改动范围」里的仓内路径，逗号分隔，不含测试文件：` 替换为 `：`
- 代码块里 `--supplement "<技术方案原文>" --fix-paths <a,b>` 替换为 `--supplement "<技术方案原文>"`

- [ ] **Step 8: 改 SKILL.md 纪律**

「## 纪律」中：
- 删除 `- 选取不看 users / count，它们只决定短名单里的验证顺序；拿不准归中。`，原位置写入：
```
- 走查顺序只看族用户数；判定只有能修 / 不能修两档，拿不准判能修（见 `references/judging.md`）。
- 用户的拒绝与捞回优先于任何 agent 判定；agent 不改判捞回项。
```
- `- 呈现与收敛对话里，结论由用户说出或在用户要求「说说你的判断」后给出。` 保留。

- [ ] **Step 9: 检查文档里旧概念已清干净**

Run: `grep -nE "短名单|shortlist|--top|likelihood|高 / 中|判「高」|fix-paths|fix_paths|cover |pick|没有可修告警|不附" monitor-triage/SKILL.md monitor-triage/references/*.md`
Expected: 无输出。

Run: `bash monitor-triage/tests/run.sh`
Expected: 全部通过，退出码 0。

- [ ] **Step 10: Commit**

```bash
git add monitor-triage/SKILL.md monitor-triage/references/judging.md monitor-triage/references/example-report.md
git commit -m "docs(monitor-triage): 流程与口径改为按用户数走查、两档判定、跳过清单可捞回"
```
（`likelihood.md` 的删除已由 Step 2 的 `git rm` 暂存，随本次提交。）

---

### Task 5: 合入 main、迁移本机状态、冒烟

**Files:**
- 本机：`monitor-triage/state/candidates.json`、`monitor-triage/state/dispatched.json`（gitignored）

- [ ] **Step 1: squash 成一个提交并快进 main**

按用户规则，合入 main 前把过程提交收成一个：
```bash
cd /Users/<user>/Desktop/ceilf/ceilf6-skills-web-monitor-walk
git reset --soft main
git commit -m "$(cat <<'EOF'
feat(monitor-triage): 按影响用户数走查，不能修的判定全部进可见的跳过清单

- 扫描按 user_descend 分页，族按族用户数排序
- 判定收成能修 / 不能修两档，宽口径；删除机械预筛、四档与永久剔除
- walk 走查第一条能修即停，排在前面的全部带理由呈现，用户可「捞回 N」
- 候选池只增不删；reject / revive 记入 verdicts 决策史

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
cd /Users/<user>/Desktop/ceilf/ceilf6-skills
git merge --ff-only feat/monitor-triage-walk
git push origin main
git worktree remove ../ceilf6-skills-web-monitor-walk
git branch -d feat/monitor-triage-walk
```
Expected: `git log --oneline -1` 为上面这条；push 成功。主工作区里 `report-writer-work/` 的未提交改动保持原样（`git status --short` 仍只列那 4 个文件）。

- [ ] **Step 2: 归档并清空本机状态**

```bash
cd /Users/<user>/Desktop/ceilf/ceilf6-skills/monitor-triage/state
mv candidates.json candidates.json.bak-2026-09-29
mv dispatched.json dispatched.json.bak-2026-09-29
ls
```
Expected: `ledger.jsonl`、`board/`（若存在）、`scans/`、两个 `.bak-2026-09-29` 与旧的 `candidates.json.bak-20260920` 都在，没有 `candidates.json` / `dispatched.json`。

- [ ] **Step 3: 真实冒烟（只读 web-monitor，写本机 state）**

```bash
cd /Users/<user>/Desktop/ceilf/ceilf6-skills
S=monitor-triage
OUT=$S/state/scans/scan-smoke-p1.json
node $S/scripts/scan.mjs --bid ai_summary --hours 24 --page 1 --page-size 20 --repo /Users/<user>/Desktop/workspace/biz-vc-web --out $OUT
node $S/scripts/state.mjs merge --dir $S/state --scan $OUT
node $S/scripts/state.mjs walk --dir $S/state --scan $OUT | python3 -c "
import json,sys;d=json.load(sys.stdin)
for i in d['items'][:8]: print(i['users'], i['class'], i['source'], i['issue_id'][:8], i['message'][:50])
print('todo', len(d['todo']), 'exhausted', d['exhausted'])"
```
Expected: scan 输出 `"ok":true,"page":1`，`skipped_bids` 为空；merge 输出 `ledger_appended` > 0；walk 前几条按用户数降序、全部 `unjudged`（空池首跑），第一条为 `APINotProvided`，`todo 0 exhausted False`。

- [ ] **Step 4: 回报**

向用户报告：合入的 commit、测试结果、冒烟输出前 8 行、state 已归档的文件名；提示下次 `/monitor-triage` 会从空池按用户数从头判定，已派的 3 条可能再次出现。
