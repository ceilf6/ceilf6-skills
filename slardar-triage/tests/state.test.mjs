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
  pick, cover, setFixPaths, markMerged, markSedimented, flight, history,
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

test('ledgerRows 同族池内既有 pending 又有已结案成员时，归属已结案的那条', () => {
  const { state } = mergeScan(empty(), [snap({ issue_id: 'iA' })], T0);
  state.candidates.iB = { ...state.candidates.iA, issue_id: 'iB', status: 'rejected' };
  const rows = ledgerRows(state, [snap({ issue_id: 'iC' })], T1);
  assert.equal(rows[0].owner_issue_id, 'iB');
  assert.equal(rows[0].status, 'rejected');
});

test('CLI merge / pick 缺 --scan 按用法错误退出 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  for (const cmd of ['merge', 'pick']) {
    const { status, stderr } = cliStatus(cmd, '--dir', dir);
    assert.equal(status, 2);
    assert.match(stderr, /用法/);
  }
});

test('CLI 认 issue 的子命令缺 --issue-id、cover 缺 --by 都按用法错误退出 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  for (const cmd of ['judge', 'reject', 'dispatched', 'cover', 'fix-paths', 'merged', 'sedimented', 'history']) {
    const { status, stderr } = cliStatus(cmd, '--dir', dir);
    assert.equal(status, 2, cmd);
    assert.match(stderr, /用法/);
  }
  const { status, stderr } = cliStatus('cover', '--dir', dir, '--issue-id', 'i1');
  assert.equal(status, 2);
  assert.match(stderr, /用法/);
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

test('pick 短名单的 message 取本次扫描快照，不取池里冻在首见那次的文案', () => {
  const scan = [snap({ message: '[native-api] command=94003 timed out after 10000ms' })];
  const { state } = mergeScan(empty(), scan, T0);
  state.candidates.i1.message = '[native-api] command=94003 timed out after 3000ms';
  assert.equal(pick(state, scan).shortlist[0].message, '[native-api] command=94003 timed out after 10000ms');
});

test('pick 不拿机械规则覆盖已判高 / 中的候选', () => {
  const scan = [snap({ issue_id: 'judged', family_key: 'k1', latest_event: frame({ raw_filename: '[native code]', mapped_path: null }) })];
  const { state } = mergeScan(empty(), scan, T0);
  setJudgment(state, 'judged', { likelihood: '中', summary: '疑似 native 未返回' });
  const out = pick(state, scan);
  assert.deepEqual(out.shortlist.map((c) => c.issue_id), ['judged']);
  assert.deepEqual(out.filtered, []);
  assert.equal(state.candidates.judged.likelihood, '中');
  assert.equal(state.candidates.judged.summary, '疑似 native 未返回');
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

test('cover 拒绝自己归属自己，也拒绝已结案的候选', () => {
  const scan = [snap({ issue_id: 'old', family_key: 'k1' }), snap({ issue_id: 'done', family_key: 'k2' })];
  const { state } = mergeScan(empty(), scan, T0);
  markDispatched(state, 'old', { task_id: 't', supplement: 'x', at: T0 });
  assert.throws(() => cover(state, 'old', 'old'), /不能归属到自己/);
  reject(state, 'done', '宿主问题', T0);
  assert.throws(() => cover(state, 'done', 'old'), /不是 pending 候选/);
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

test('history 记录拒绝与收尾沉淀事件；CLI history 输出一行 JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const scanFile = join(dir, 'scan.json');
  writeFileSync(scanFile, JSON.stringify({ scanned_at: T0, candidates: [snap(), snap({ issue_id: 'i2', family_key: 'f2' })] }));
  cli('merge', '--dir', dir, '--scan', scanFile);
  cli('reject', '--dir', dir, '--issue-id', 'i2', '--reason', '宿主问题');
  cli('dispatched', '--dir', dir, '--issue-id', 'i1', '--task-id', 't');
  // 派单 / 收尾沉淀的时刻由脚本取当下，合入时刻夹在两者之间，事件才是真实的先后。
  cli('merged', '--dir', dir, '--issue-id', 'i1', '--at', new Date().toISOString());
  cli('sedimented', '--dir', dir, '--issue-id', 'i1');
  const h = cli('history', '--dir', dir, '--issue-id', 'i1');
  assert.equal(h.ok, true);
  assert.deepEqual(h.events.map((e) => e.type), ['first_seen', 'dispatched', 'merged', 'sedimented']);
  assert.equal(h.rows.length, 1);
  assert.deepEqual(cli('history', '--dir', dir, '--issue-id', 'i2').events.map((e) => e.type), ['first_seen', 'rejected']);
});
