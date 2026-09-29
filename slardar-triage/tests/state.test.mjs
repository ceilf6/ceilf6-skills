import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadState, saveState, mergeScan, judge, revive, pendingSorted, reject, markDispatched,
  readLedger, ledgerRows, appendLedger, mergeFromScan,
  walk, history,
} from '../scripts/state.mjs';

const STATE_CLI = fileURLToPath(new URL('../scripts/state.mjs', import.meta.url));
const cli = (...args) => JSON.parse(execFileSync(process.execPath, [STATE_CLI, ...args], { encoding: 'utf8' }));
// stdio 全部收口到管道，用法行才不会混进测试输出。
const cliStatus = (...args) => {
  try {
    const stdout = execFileSync(process.execPath, [STATE_CLI, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
};

// member_issue_ids 是这一族当次聚到的 issue，默认跟着 issue_id 走：一个 issue 在一次扫描里只属于一族。
const scanned = (over = {}) => ({ issue_id: 'i1', family_key: 'f1', bid: 'vc_ai', message: 'm', member_issue_ids: [over.issue_id ?? 'i1'], family_users: 200, family_count: 5000, first_seen: 1788000000000, issue_url: 'u1', slardar_url: 's1', ...over });
const empty = () => ({ candidates: {}, dispatched: {} });
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
  assert.equal(state.candidates.i1.verdict, null);
  assert.deepEqual(state.candidates.i1.verdicts, []);
  assert.equal(state.candidates.i1.first_seen_at, '2026-09-10T00:00:00Z');
  ({ state } = mergeScan(state, [scanned({ family_users: 300, issue_url: 'u2', member_issue_ids: ['i1', 'i9'] })], '2026-09-11T00:00:00Z'));
  assert.equal(state.candidates.i1.users, 300);
  assert.equal(state.candidates.i1.issue_url, 'u2');
  assert.deepEqual(state.candidates.i1.member_issue_ids, ['i1', 'i9']);
  assert.equal(state.candidates.i1.refreshed_at, '2026-09-11T00:00:00Z');
  assert.equal(state.candidates.i1.first_seen_at, '2026-09-10T00:00:00Z');
});

test('mergeScan 不删除缺席的候选：分页没扫到不代表告警消失', () => {
  let { state } = mergeScan(empty(), [scanned(), scanned({ issue_id: 'i2', family_key: 'f2' })], 't0');
  judge(state, 'i2', { fixable: false, reason: 'r', at: 't0' });
  ({ state } = mergeScan(state, [], 't1'));
  ({ state } = mergeScan(state, [], 't2'));
  assert.deepEqual(Object.keys(state.candidates).sort(), ['i1', 'i2']);
  assert.equal(state.candidates.i2.verdict.reason, 'r');
  assert.equal('stale_count' in state.candidates.i1, false);
});

test('mergeScan 同族已 dispatched / rejected 的新 issue 不再入池', () => {
  let { state } = mergeScan(empty(), [scanned()], 't0');
  markDispatched(state, 'i1', { task_id: 't', supplement: 'x', at: 't0' });
  ({ state } = mergeScan(state, [scanned({ issue_id: 'i7', family_key: 'f1' })], 't1'));
  assert.equal(state.candidates.i7, undefined);
});

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

test('reject 与 markDispatched 记录决策并改状态，之后不再出现在 pending', () => {
  let { state } = mergeScan(empty(), [scanned()], 't0');
  reject(state, 'i1', '宿主问题', 't1');
  assert.deepEqual(state.candidates.i1.decision, { reason: '宿主问题', at: 't1' });
  assert.deepEqual(state.candidates.i1.verdict, { fixable: false, reason: '宿主问题', by: 'user', at: 't1' });
  assert.deepEqual(pendingSorted(state), []);
  ({ state } = mergeScan(empty(), [scanned()], 't0'));
  markDispatched(state, 'i1', { task_id: 'task_x', supplement: 'native 已确认', at: 't2' });
  assert.equal(state.candidates.i1.status, 'dispatched');
  assert.equal(state.candidates.i1.decision.task_id, 'task_x');
  assert.equal('fix_paths' in state.candidates.i1.decision, false);
  assert.equal(state.dispatched.i1.task_id, 'task_x');
});

test('markDispatched 把 harness 产物记进处置账，保留已有字段', () => {
  const { state } = mergeScan(empty(), [scanned()], 't0');
  state.dispatched.i1 = { meego_url: 'https://meego/1', steps: { meego: 'done' } };
  markDispatched(state, 'i1', { task_id: 'task_x', task_slug: 'avatar-2026-09-21', workspace: '/h/workspaces/tasks/avatar-2026-09-21/byteview-web', at: 't2' });
  assert.deepEqual(state.dispatched.i1, {
    meego_url: 'https://meego/1',
    steps: { meego: 'done' },
    task_id: 'task_x',
    task_slug: 'avatar-2026-09-21',
    workspace: '/h/workspaces/tasks/avatar-2026-09-21/byteview-web',
    dispatched_at: 't2',
  });
});

test('CLI dispatched 缺 --task-id 或 --workspace 报错且不落盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const scanFile = join(dir, 'scan.json');
  writeFileSync(scanFile, JSON.stringify({ scanned_at: T0, candidates: [snap({ issue_id: 'i1', family_key: 'k1' })] }));
  cli('merge', '--dir', dir, '--scan', scanFile);
  const r = cliStatus('dispatched', '--dir', dir, '--issue-id', 'i1', '--task-id', 't');
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /--workspace/);
  assert.equal(loadState(dir).candidates.i1.status, 'pending');
  const r2 = cliStatus('dispatched', '--dir', dir, '--issue-id', 'i1', '--workspace', '/h/ws/i1/byteview-web');
  assert.equal(r2.status, 1);
  assert.match(JSON.parse(r2.stdout).error, /--task-id/);
  assert.equal(loadState(dir).candidates.i1.status, 'pending');
});

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

test('readLedger 跳过读不出的坏行，appendLedger 仍照常追加且坏行字节原样留着', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const { state } = mergeScan(empty(), [snap()], T0);
  appendLedger(dir, ledgerRows(state, [snap()], T0));
  const file = join(dir, 'ledger.jsonl');
  const damaged = `${readFileSync(file, 'utf8')}{"at":"${T1}","issue_id":"i1"`;
  writeFileSync(file, damaged);
  assert.deepEqual(readLedger(dir).map((r) => [r.at, r.family_count]), [[T0, 5000]]);
  assert.equal(appendLedger(dir, ledgerRows(state, [snap({ family_count: 9 })], T2)), 1);
  assert.ok(readFileSync(file, 'utf8').startsWith(damaged));
  assert.deepEqual(readLedger(dir).map((r) => [r.at, r.family_count]), [[T0, 5000], [T2, 9]]);
});

test('mergeFromScan 落候选池、台账与 merge-latest.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const out = mergeFromScan(dir, { scanned_at: T0, candidates: [snap(), snap({ issue_id: 'i2', family_key: 'f2' })] });
  assert.deepEqual(out, { pending: 2, ledger_appended: 2 });
  assert.equal(loadState(dir).candidates.i2.status, 'pending');
  assert.equal(readLedger(dir).length, 2);
  const latest = JSON.parse(readFileSync(join(dir, 'scans', 'merge-latest.json'), 'utf8'));
  assert.deepEqual(latest.pending.map((c) => c.issue_id).sort(), ['i1', 'i2']);
});

test('CLI merge 输出一行 JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const scanFile = join(dir, 'scan.json');
  writeFileSync(scanFile, JSON.stringify({ scanned_at: T0, candidates: [snap()] }));
  assert.deepEqual(cli('merge', '--dir', dir, '--scan', scanFile), { ok: true, pending: 1, ledger_appended: 1 });
});

test('ledgerRows 同族池内既有 pending 又有已结案成员时，归属已结案的那条', () => {
  const { state } = mergeScan(empty(), [snap({ issue_id: 'iA' })], T0);
  state.candidates.iB = { ...state.candidates.iA, issue_id: 'iB', status: 'rejected' };
  const rows = ledgerRows(state, [snap({ issue_id: 'iC' })], T1);
  assert.equal(rows[0].owner_issue_id, 'iB');
  assert.equal(rows[0].status, 'rejected');
});

test('CLI merge / walk 缺 --scan 按用法错误退出 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  for (const cmd of ['merge', 'walk']) {
    const { status, stderr } = cliStatus(cmd, '--dir', dir);
    assert.equal(status, 2);
    assert.match(stderr, /用法/);
  }
});

test('CLI 认 issue 的子命令缺 --issue-id 按用法错误退出 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  for (const cmd of ['judge', 'revive', 'reject', 'dispatched', 'history']) {
    const { status, stderr } = cliStatus(cmd, '--dir', dir);
    assert.equal(status, 2, cmd);
    assert.match(stderr, /用法/);
  }
});

test('CLI history 遇到池里没有的 issue 输出 ok:false 并退出 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const { status, stdout } = cliStatus('history', '--dir', dir, '--issue-id', 'nope');
  assert.equal(status, 1);
  const out = JSON.parse(stdout);
  assert.equal(out.ok, false);
  assert.match(out.error, /候选池里没有/);
});

const frame = (over = {}) => ({ raw_filename: 'webpack://@byteview-web/vc-ai/./src/a.ts', mapped_path: 'vc-ai/src/a.ts', line: 10, function: 'fa', page: '/webview/ai-layout', release: '7.77.0.21', ...over });

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
  cli('dispatched', '--dir', dir, '--issue-id', 'i2', '--task-id', 't', '--workspace', '/h/ws/i2/byteview-web');
  assert.equal('fix_paths' in loadState(dir).candidates.i2.decision, false);
  assert.deepEqual(cli('judge', '--dir', dir, '--issue-id', 'i1', '--same-as', 'i2', '--reason', '同缺陷已派单 i2'), { ok: true, issue_id: 'i1', fixable: false, covered_by: 'i2' });
  assert.deepEqual(cli('revive', '--dir', dir, '--issue-id', 'i1'), { ok: true, revived: 'i1' });
  const c = loadState(dir).candidates.i1;
  assert.equal(c.verdict.by, 'user');
  assert.equal(c.covered_by, undefined);
  assert.equal(c.verdicts.length, 3);
});

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
    detail_error: null, mapped_path: 'vc-ai/src/services/ai-layout.ts', line: 271, function: 'getMeetingAISummary', page: '/webview/ai-layout', release: '7.77.0.21',
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

test('history 给出本族与被覆盖族的台账行、处置事件、回落比（改名新族的量加总后再比）', () => {
  const old = snap({ issue_id: 'old', family_key: 'k1', family_count: 1000 });
  const renamed = snap({ issue_id: 'renamed', family_key: 'k2', family_count: 150 });
  const other = snap({ issue_id: 'other', family_key: 'k3', family_count: 77, latest_event: frame() });
  const { state } = mergeScan(empty(), [old, other], T0);
  const ledger = [...ledgerRows(state, [old, other], T0)];
  markDispatched(state, 'old', { task_id: 't', supplement: 'x', at: '2026-09-10T12:00:00.000Z' });
  const merged = mergeScan(state, [{ ...old, family_count: 1200 }, renamed, other], T1).state;
  judge(merged, 'renamed', { sameAs: 'old', reason: '同缺陷已派单 old', at: T1 });
  ledger.push(...ledgerRows(merged, [{ ...old, family_count: 1200 }, renamed, other], T1));
  ledger.push(...ledgerRows(merged, [{ ...renamed, family_count: 90 }, other], T2));

  const h = history(merged, ledger, 'old');
  assert.deepEqual(h.rows.map((r) => [r.at, r.family_count]), [[T0, 1000], [T1, 1200]]);
  assert.deepEqual(h.covered_rows.map((r) => [r.at, r.family_count]), [[T1, 150], [T2, 90]]);
  assert.deepEqual(h.events, [
    { type: 'first_seen', at: T0 },
    { type: 'dispatched', at: '2026-09-10T12:00:00.000Z' },
  ]);
  assert.deepEqual(h.recovery, {
    baseline_count: 1000, baseline_at: T0, latest_at: T2, latest_present: true, latest_count: 90, latest_floor: 77, ratio: 0.09,
  });
});

test('history：台账晚于派单的旧单以最早一行为基线；族在最新扫描里缺席按那次扫描的最小次数估上界；没有台账时 ratio 为 null', () => {
  const c = snap({ family_count: 400 });
  const { state } = mergeScan(empty(), [c], T0);
  markDispatched(state, 'i1', { task_id: 't', supplement: 'x', at: '2026-09-01T00:00:00.000Z' });
  assert.deepEqual(history(state, [], 'i1').recovery, {
    baseline_count: null, baseline_at: null, latest_at: null, latest_present: false, latest_count: 0, latest_floor: null, ratio: null,
  });
  const other = snap({ issue_id: 'o', family_key: 'ko', family_count: 800 });
  const ledger = [...ledgerRows(state, [c], T1), ...ledgerRows(state, [other], T2)];
  assert.deepEqual(history(state, ledger, 'i1').recovery, {
    baseline_count: 400, baseline_at: T1, latest_at: T2, latest_present: false, latest_count: 0, latest_floor: 800, ratio: 2,
  });
  // 派单早于台账第一行的旧单，first_seen 反而晚于 dispatched，事件仍按时间升序。
  assert.deepEqual(history(state, ledger, 'i1').events, [
    { type: 'dispatched', at: '2026-09-01T00:00:00.000Z' },
    { type: 'first_seen', at: T0 },
  ]);
  assert.throws(() => history(state, ledger, 'nope'), /候选池里没有/);
});

test('history 按 issue 身份认台账行：族名改过那次的旧行仍算这条单的，并作为基线', () => {
  const { state } = mergeScan(empty(), [snap({ family_count: 400 })], T0);
  // 池里的 family_key 冻在首见那次，台账行记的是各自扫描当时算出的 key，报错文案一改两者就对不上。
  const early = ledgerRows(state, [snap({ family_key: 'f0', family_count: 900 })], T0);
  markDispatched(state, 'i1', { task_id: 't', supplement: 'x', at: '2026-09-10T12:00:00.000Z' });
  const later = ledgerRows(state, [snap({ family_count: 400 })], T1);
  const ledger = [...early, ...later];
  const h = history(state, ledger, 'i1');
  assert.deepEqual(h.rows.map((r) => [r.at, r.family_key, r.family_count]), [[T0, 'f0', 900], [T1, 'f1', 400]]);
  assert.equal(h.recovery.baseline_count, 900);
  assert.equal(h.recovery.baseline_at, T0);
  assert.equal(h.recovery.ratio, 400 / 900);
  // 被覆盖候选与本族指向同一族时，行只算本族的一份。
  state.candidates.i2 = { ...state.candidates.i1, issue_id: 'i2', member_issue_ids: ['i2'], status: 'pending', decision: null, covered_by: 'i1' };
  assert.deepEqual(history(state, ledger, 'i1').covered_rows, []);
});

test('history 对没派单的候选不给基线，ratio 为 null', () => {
  const { state } = mergeScan(empty(), [snap({ family_count: 400 })], T0);
  const ledger = ledgerRows(state, [snap({ family_count: 400 })], T1);
  const pending = history(state, ledger, 'i1').recovery;
  assert.deepEqual(pending, {
    baseline_count: null, baseline_at: null, latest_at: T1, latest_present: true, latest_count: 400, latest_floor: 400, ratio: null,
  });
  reject(state, 'i1', '宿主问题', T2);
  assert.equal(history(state, ledger, 'i1').recovery.ratio, null);
});

test('history 记录派单与拒绝事件；CLI history 输出一行 JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const scanFile = join(dir, 'scan.json');
  writeFileSync(scanFile, JSON.stringify({ scanned_at: T0, candidates: [snap(), snap({ issue_id: 'i2', family_key: 'f2' })] }));
  cli('merge', '--dir', dir, '--scan', scanFile);
  cli('reject', '--dir', dir, '--issue-id', 'i2', '--reason', '宿主问题');
  cli('dispatched', '--dir', dir, '--issue-id', 'i1', '--task-id', 't', '--workspace', '/h/ws/i1/byteview-web');
  const h = cli('history', '--dir', dir, '--issue-id', 'i1');
  assert.equal(h.ok, true);
  assert.deepEqual(h.events.map((e) => e.type), ['first_seen', 'dispatched']);
  assert.equal(h.rows.length, 1);
  assert.deepEqual(cli('history', '--dir', dir, '--issue-id', 'i2').events.map((e) => e.type), ['first_seen', 'rejected']);
});
