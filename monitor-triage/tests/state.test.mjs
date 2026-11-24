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

const scanned = (over = {}) => ({ issue_id: 'i1', bid: 'ai_summary', message: 'm', users: 200, count: 5000, first_seen: 1788000000000, issue_url: 'u1', web-monitor_url: 's1', ...over });
const larkMessage = (over = {}) => ({
  issue_id: 'lark:om_1',
  origin: 'lark',
  origin_id: 'om_1',
  chat_id: '<chat_id>',
  message: "TypeError: Cannot read properties of undefined (reading 'map')",
  sender: 'VC Alert Bot',
  created_at: '2026-11-05T08:00:00.000Z',
  users: 0,
  count: 0,
  ...over,
});
const empty = () => ({ candidates: {}, dispatched: {} });
const T0 = '2026-09-10T00:00:00.000Z';
const T1 = '2026-09-11T00:00:00.000Z';
const T2 = '2026-09-12T00:00:00.000Z';
const snap = (over = {}) => scanned({
  distinct_sessions: 285,
  detail_error: null,
  pid_dist: { '/webview/summary-layout': 256, '/webview/minutes-summary-layout-pc': 43 },
  os_dist: { Windows: 224, Mac: 76 },
  release_dist: { '7.77.0.21': 299 },
  host_version_dist: { '8.0.3': 116, '7.76.21': 76 },
  source_type_dist: { onunhandledrejection: 300 },
  latest_event: { raw_filename: 'webpack://@biz-vc-web/ai-summary/./src/services/summary-layout.ts', mapped_path: 'ai-summary/src/services/summary-layout.ts', line: 271, function: 'getMeetingAISummary', page: '/webview/summary-layout', release: '7.77.0.21' },
  ...over,
});

test('Lark 候选保留来源证据，walk 的 source 仍表示判定来源', () => {
  const { state } = mergeScan(empty(), [larkMessage()], T0);
  assert.deepEqual(
    {
      origin: state.candidates['lark:om_1'].origin,
      origin_id: state.candidates['lark:om_1'].origin_id,
      chat_id: state.candidates['lark:om_1'].chat_id,
      sender: state.candidates['lark:om_1'].sender,
      created_at: state.candidates['lark:om_1'].created_at,
    },
    {
      origin: 'lark',
      origin_id: 'om_1',
      chat_id: '<chat_id>',
      sender: 'VC Alert Bot',
      created_at: '2026-11-05T08:00:00.000Z',
    },
  );

  judge(state, 'lark:om_1', { fixable: false, reason: '用户侧表现正常', at: T1 });
  const item = walk(state, [larkMessage()]).items[0];
  assert.equal(item.origin, 'lark');
  assert.equal(item.origin_id, 'om_1');
  assert.equal(item.source, 'agent');
  assert.equal(item.class, 'skip');
});

test('Lark 候选复用用户决定优先规则和 verdicts 历史', () => {
  const { state } = mergeScan(empty(), [larkMessage()], T0);
  judge(state, 'lark:om_1', { fixable: false, reason: '缺少用户侧影响证据', at: T0 });
  revive(state, 'lark:om_1', T1);
  assert.throws(
    () => judge(state, 'lark:om_1', { fixable: false, reason: '再次否定', at: T2 }),
    /已由用户捞回/,
  );
  assert.deepEqual(
    state.candidates['lark:om_1'].verdicts.map((v) => [v.by, v.fixable]),
    [['agent', false], ['user', true]],
  );
});

test('ledgerRows 只记录 web-monitor 候选，不把 Lark 消息当量级样本', () => {
  const { state } = mergeScan(empty(), [snap(), larkMessage()], T0);
  const rows = ledgerRows(state, [snap(), larkMessage()], T1);
  assert.deepEqual(rows.map((row) => row.issue_id), ['i1']);
});

test('Lark 重复 merge 更新证据、保留缺省字段及用户决定', () => {
  for (const decision of ['revived', 'rejected', 'dispatched']) {
    let { state } = mergeScan(empty(), [larkMessage()], T0);
    judge(state, 'lark:om_1', { fixable: false, reason: '待确认影响', at: T0 });
    if (decision === 'revived') revive(state, 'lark:om_1', T1);
    if (decision === 'rejected') reject(state, 'lark:om_1', '用户不修', T1);
    if (decision === 'dispatched') {
      markDispatched(state, 'lark:om_1', { task_id: 'task_lark', supplement: '已确认', at: T1 });
    }
    const before = structuredClone(state.candidates['lark:om_1']);
    const dispatched = structuredClone(state.dispatched);
    const evidence = {
      chat_id: 'oc_updated',
      sender: 'VC Alert Bot Updated',
      created_at: '2026-11-05T09:00:00.000Z',
    };
    ({ state } = mergeScan(state, [larkMessage(evidence)], T2));
    const expected = { ...before, ...evidence, refreshed_at: T2 };
    assert.deepEqual(state.candidates['lark:om_1'], expected, decision);
    for (const missing of [undefined, null]) {
      ({ state } = mergeScan(state, [larkMessage({
        origin: missing, origin_id: missing,
        chat_id: missing, sender: missing, created_at: missing,
      })], T2));
      assert.deepEqual(state.candidates['lark:om_1'], expected, `${decision}: ${missing}`);
    }
    assert.deepEqual(state.dispatched, dispatched, decision);
  }
});

test('历史 web-monitor 重复 merge 补齐默认来源并保留判定', () => {
  const verdict = { fixable: false, reason: '历史已判', by: 'agent', at: T0 };
  const legacy = {
    issue_id: 'i1', bid: 'ai_summary', message: 'm', users: 200, count: 5000,
    status: 'pending', verdict, verdicts: [verdict], decision: null,
    first_seen_at: T0, refreshed_at: T0,
  };
  let state = { candidates: { i1: legacy }, dispatched: {} };
  for (const at of [T1, T2]) {
    ({ state } = mergeScan(state, [scanned()], at));
    assert.deepEqual(state.candidates.i1, {
      ...legacy, origin: 'web-monitor', origin_id: 'i1',
      chat_id: null, sender: null, created_at: null,
      issue_url: 'u1', web-monitor_url: 's1', refreshed_at: at,
    });
  }
});

test('walk 与 ledgerRows 从 owner 回退来源，历史 web-monitor 仍记录量级', () => {
  const { state } = mergeScan(empty(), [larkMessage()], T0);
  state.candidates.i1 = { issue_id: 'i1', bid: 'ai_summary', message: 'm', status: 'pending' };
  const larkSnapshot = { issue_id: 'lark:om_1', message: larkMessage().message };
  const item = walk(state, [larkSnapshot]).items[0];
  assert.equal(item.origin, 'lark');
  assert.equal(item.origin_id, 'om_1');
  assert.equal(item.chat_id, '<chat_id>');
  assert.equal(item.sender, 'VC Alert Bot');
  assert.equal(item.created_at, '2026-11-05T08:00:00.000Z');
  assert.equal(item.source, null);
  assert.deepEqual(ledgerRows(state, [larkSnapshot], T1), []);
  const web-monitorSnapshot = { issue_id: 'i1', message: 'm', count: 7, users: 3 };
  const legacyItem = walk(state, [web-monitorSnapshot]).items[0];
  assert.equal(legacyItem.origin, 'web-monitor');
  assert.equal(legacyItem.origin_id, 'i1');
  const rows = ledgerRows(state, [larkSnapshot, web-monitorSnapshot], T1);
  assert.deepEqual(rows.map((row) => [row.issue_id, row.count, row.users, row.status]), [
    ['i1', 7, 3, 'pending'],
  ]);
  assert.equal('origin' in state.candidates.i1, false);
});

for (const [category, message] of [
  ['network', 'TypeError: Failed to fetch'],
  ['host', 'ChunkLoadError: Loading chunk 123 failed'],
]) {
  test(`环境桶来源：显式 Lark ${category} 候选进入逐条判定`, () => {
    const candidate = larkMessage({ message });
    const { state } = mergeScan(empty(), [candidate], T0);
    const before = walk(state, [candidate]);
    assert.deepEqual(before.items.map((item) => [item.category, item.class, item.source]), [
      [category, 'unjudged', null],
    ]);
    assert.deepEqual(before.buckets, {});
    assert.equal(before.exhausted, false);
    for (const fixable of [true, false]) {
      judge(state, candidate.issue_id, { fixable, reason: '逐条检查影响', at: T1 });
      const item = walk(state, [candidate]).items[0];
      assert.deepEqual([item.class, item.source, item.reason], [
        fixable ? 'fixable' : 'skip', 'agent', '逐条检查影响',
      ]);
    }
  });

  test(`环境桶来源：owner 回退 Lark ${category} 候选进入逐条判定`, () => {
    const { state } = mergeScan(empty(), [larkMessage({ message })], T0);
    const snapshot = { issue_id: 'lark:om_1', message };
    const before = walk(state, [snapshot]);
    assert.deepEqual(before.items.map((item) => [item.origin, item.category, item.class, item.source]), [
      ['lark', category, 'unjudged', null],
    ]);
    assert.deepEqual(before.buckets, {});
    assert.equal(before.exhausted, false);
  });

  test(`环境桶来源：web-monitor ${category} 候选维持整桶跳过`, () => {
    for (const origin of [undefined, 'web-monitor']) {
      const candidate = scanned({ message, origin });
      const { state } = mergeScan(empty(), [candidate], T0);
      const item = walk(state, [candidate]).items[0];
      assert.deepEqual([item.origin, item.category, item.class, item.source], [
        'web-monitor', category, 'skip', 'bucket',
      ]);
    }
  });
}

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
  ({ state } = mergeScan(state, [scanned({ users: 300, issue_url: 'u2' })], '2026-09-11T00:00:00Z'));
  assert.equal(state.candidates.i1.users, 300);
  assert.equal(state.candidates.i1.issue_url, 'u2');
  assert.equal(state.candidates.i1.refreshed_at, '2026-09-11T00:00:00Z');
  assert.equal(state.candidates.i1.first_seen_at, '2026-09-10T00:00:00Z');
});

test('mergeScan 不删除缺席的候选：分页没扫到不代表告警消失', () => {
  let { state } = mergeScan(empty(), [scanned(), scanned({ issue_id: 'i2' })], 't0');
  judge(state, 'i2', { fixable: false, reason: 'r', at: 't0' });
  ({ state } = mergeScan(state, [], 't1'));
  ({ state } = mergeScan(state, [], 't2'));
  assert.deepEqual(Object.keys(state.candidates).sort(), ['i1', 'i2']);
  assert.equal(state.candidates.i2.verdict.reason, 'r');
  assert.equal('stale_count' in state.candidates.i1, false);
});

test('mergeScan 以 issue 为单位：文案与已派单相同的新 issue 也作为独立候选入池', () => {
  let { state } = mergeScan(empty(), [scanned()], 't0');
  markDispatched(state, 'i1', { task_id: 't', supplement: 'x', at: 't0' });
  ({ state } = mergeScan(state, [scanned({ issue_id: 'i7' })], 't1'));
  assert.equal(state.candidates.i7.status, 'pending');
  assert.equal(state.candidates.i7.verdict, null);
});

test('pendingSorted 只含 pending，按用户数降序', () => {
  const { state } = mergeScan(empty(), [
    scanned({ issue_id: 'a', users: 10 }),
    scanned({ issue_id: 'b', users: 900 }),
    scanned({ issue_id: 'c', users: 500 }),
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
  const { state } = mergeScan(empty(), [scanned(), scanned({ issue_id: 'i2' })], T0);
  assert.throws(() => judge(state, 'i1', { fixable: true, reason: '', at: T0 }), /--reason/);
  assert.throws(() => judge(state, 'i1', { fixable: undefined, reason: 'r', at: T0 }), /yes \/ no/);
  assert.throws(() => judge(state, 'nope', { fixable: true, reason: 'r', at: T0 }), /候选池里没有/);
  reject(state, 'i2', '不修', T0);
  assert.throws(() => judge(state, 'i2', { fixable: true, reason: 'r', at: T0 }), /不是 pending 候选/);
  revive(state, 'i1', T0);
  assert.throws(() => judge(state, 'i1', { fixable: false, reason: 'r', at: T1 }), /已由用户捞回/);
});

test('CLI rejudge 只清空 pending 候选的 agent 缓存结论，保留判定历史和用户拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const scanFile = join(dir, 'scan.json');
  writeFileSync(scanFile, JSON.stringify({ scanned_at: T0, candidates: [snap(), snap({ issue_id: 'i2' })] }));
  cli('merge', '--dir', dir, '--scan', scanFile);
  cli('judge', '--dir', dir, '--issue-id', 'i1', '--fixable', 'no', '--reason', '仅低版本出现');
  cli('reject', '--dir', dir, '--issue-id', 'i2', '--reason', '用户不修');

  const reopened = cliStatus('rejudge', '--dir', dir, '--issue-id', 'i1');
  assert.equal(reopened.status, 0);
  assert.deepEqual(JSON.parse(reopened.stdout), { ok: true, rejudge: 'i1' });
  const state = loadState(dir);
  assert.equal(state.candidates.i1.verdict, null);
  assert.equal(state.candidates.i1.verdicts.length, 1);
  assert.deepEqual(walk(state, [snap()]).items.map((item) => [item.issue_id, item.class, item.source]), [['i1', 'unjudged', null]]);

  const rejected = cliStatus('rejudge', '--dir', dir, '--issue-id', 'i2');
  assert.equal(rejected.status, 1);
  assert.match(JSON.parse(rejected.stdout).error, /用户判定/);
  assert.equal(loadState(dir).candidates.i2.status, 'rejected');
});

test('judge --same-as 写 covered_by 并判不能修，目标须是已派单且不能是自己', () => {
  const { state } = mergeScan(empty(), [scanned({ issue_id: 'old' }), scanned({ issue_id: 'shared' })], T0);
  assert.throws(() => judge(state, 'shared', { sameAs: 'old', reason: '同缺陷', at: T0 }), /不是已派单候选/);
  markDispatched(state, 'old', { task_id: 't', supplement: 'x', at: T0 });
  assert.throws(() => judge(state, 'shared', { sameAs: 'shared', reason: '同缺陷', at: T0 }), /不能归属到自己/);
  judge(state, 'shared', { sameAs: 'old', reason: '同缺陷已派单 old', at: T1 });
  assert.equal(state.candidates.shared.covered_by, 'old');
  assert.deepEqual(state.candidates.shared.verdict, { fixable: false, reason: '同缺陷已派单 old', by: 'agent', at: T1 });
});

test('revive 写用户判定、清掉 covered_by，已拒的恢复为 pending，已派单的拒绝', () => {
  const { state } = mergeScan(empty(), [
    scanned({ issue_id: 'old' }),
    scanned({ issue_id: 'a' }),
    scanned({ issue_id: 'b' }),
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
  state.dispatched.i1 = { ticket-platform_url: 'https://ticket-platform/1', steps: { ticket-platform: 'done' } };
  markDispatched(state, 'i1', { task_id: 'task_x', task_slug: 'avatar-2026-09-21', workspace: '/h/workspaces/tasks/avatar-2026-09-21/biz-vc-web', at: 't2' });
  assert.deepEqual(state.dispatched.i1, {
    ticket-platform_url: 'https://ticket-platform/1',
    steps: { ticket-platform: 'done' },
    task_id: 'task_x',
    task_slug: 'avatar-2026-09-21',
    workspace: '/h/workspaces/tasks/avatar-2026-09-21/biz-vc-web',
    dispatched_at: 't2',
  });
});

test('CLI dispatched 缺 --task-id 或 --workspace 报错且不落盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const scanFile = join(dir, 'scan.json');
  writeFileSync(scanFile, JSON.stringify({ scanned_at: T0, candidates: [snap({ issue_id: 'i1' })] }));
  cli('merge', '--dir', dir, '--scan', scanFile);
  const r = cliStatus('dispatched', '--dir', dir, '--issue-id', 'i1', '--task-id', 't');
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /--workspace/);
  assert.equal(loadState(dir).candidates.i1.status, 'pending');
  const r2 = cliStatus('dispatched', '--dir', dir, '--issue-id', 'i1', '--workspace', '/h/ws/i1/biz-vc-web');
  assert.equal(r2.status, 1);
  assert.match(JSON.parse(r2.stdout).error, /--task-id/);
  assert.equal(loadState(dir).candidates.i1.status, 'pending');
});

test('ledgerRows 每个扫描候选一行，带分布主项与池内状态；池里没有的记 unknown，不借用同文案候选的状态', () => {
  const { state } = mergeScan(empty(), [snap()], T0);
  markDispatched(state, 'i1', { task_id: 't', supplement: 'x', at: T0 });
  const rows = ledgerRows(state, [snap(), snap({ issue_id: 'i7' })], T1);
  assert.deepEqual(rows[0], {
    at: T1,
    bid: 'ai_summary',
    issue_id: 'i1',
    window_hours: 24,
    count: 5000,
    users: 200,
    distinct_sessions: 285,
    pid_top: ['/webview/summary-layout', 256],
    os_top: ['Windows', 224],
    release_top: ['7.77.0.21', 299],
    host_version_top: ['8.0.3', 116],
    source_type_top: ['onunhandledrejection', 300],
    status: 'dispatched',
  });
  assert.equal(rows[1].issue_id, 'i7');
  assert.equal(rows[1].status, 'unknown');
});

test('ledgerRows 对缺分布的候选记 null，对池里找不到归属的记 unknown', () => {
  const rows = ledgerRows(empty(), [scanned()], T0);
  assert.equal(rows[0].pid_top, null);
  assert.equal(rows[0].distinct_sessions, 0);
  assert.equal(rows[0].status, 'unknown');
});

test('appendLedger 只追加不改写，同一 at|issue_id 不重复写', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  assert.deepEqual(readLedger(dir), []);
  const { state } = mergeScan(empty(), [snap()], T0);
  assert.equal(appendLedger(dir, ledgerRows(state, [snap()], T0)), 1);
  assert.equal(appendLedger(dir, ledgerRows(state, [snap()], T0)), 0);
  assert.equal(appendLedger(dir, ledgerRows(state, [snap({ count: 9 })], T1)), 1);
  assert.deepEqual(readLedger(dir).map((r) => [r.at, r.count]), [[T0, 5000], [T1, 9]]);
});

test('readLedger 跳过读不出的坏行，appendLedger 仍照常追加且坏行字节原样留着', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const { state } = mergeScan(empty(), [snap()], T0);
  appendLedger(dir, ledgerRows(state, [snap()], T0));
  const file = join(dir, 'ledger.jsonl');
  const damaged = `${readFileSync(file, 'utf8')}{"at":"${T1}","issue_id":"i1"`;
  writeFileSync(file, damaged);
  assert.deepEqual(readLedger(dir).map((r) => [r.at, r.count]), [[T0, 5000]]);
  assert.equal(appendLedger(dir, ledgerRows(state, [snap({ count: 9 })], T2)), 1);
  assert.ok(readFileSync(file, 'utf8').startsWith(damaged));
  assert.deepEqual(readLedger(dir).map((r) => [r.at, r.count]), [[T0, 5000], [T2, 9]]);
});

test('mergeFromScan 落候选池、台账与 merge-latest.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const out = mergeFromScan(dir, { scanned_at: T0, candidates: [snap(), snap({ issue_id: 'i2' })] });
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
  for (const cmd of ['judge', 'rejudge', 'revive', 'reject', 'dispatched', 'history']) {
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

const frame = (over = {}) => ({ raw_filename: 'webpack://@biz-vc-web/ai-summary/./src/a.ts', mapped_path: 'ai-summary/src/a.ts', line: 10, function: 'fa', page: '/webview/summary-layout', release: '7.77.0.21', ...over });

test('CLI judge / revive 落盘并输出一行 JSON；judge 缺 --reason 报错不落盘；dispatched 不记 fix_paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const scanFile = join(dir, 'scan.json');
  writeFileSync(scanFile, JSON.stringify({ scanned_at: T0, candidates: [snap(), snap({ issue_id: 'i2' })] }));
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

test('walk 按用户数降序归类：已派单 / 同缺陷 > 已拒 > 用户捞回 > agent 能修 > agent 不能修 > 待判', () => {
  const scan = [
    snap({ issue_id: 'disp', users: 900 }),
    snap({ issue_id: 'cov', users: 800 }),
    snap({ issue_id: 'rej', users: 700 }),
    snap({ issue_id: 'no', users: 600 }),
    snap({ issue_id: 'rev', users: 500 }),
    snap({ issue_id: 'yes', users: 400 }),
    snap({ issue_id: 'new', users: 300 }),
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
    snap({ message: '[warn] ErrorBoundary: n.map is not a function', users: 50 }),
    snap({ issue_id: 'i2', users: 40 }),
  ];
  const { state } = mergeScan(empty(), scan, T0);
  state.candidates.i1.message = '[warn] ErrorBoundary: o.map is not a function';
  reject(state, 'i2', '不修', T0);
  const out = walk(state, scan, { skip: ['i1', 'i2'] });
  assert.deepEqual(out.items[0], {
    origin: 'web-monitor',
    origin_id: 'i1',
    chat_id: null,
    sender: null,
    created_at: null,
    issue_id: 'i1', users: 50, count: 5000, message: '[warn] ErrorBoundary: n.map is not a function', message_core: '[warn] ErrorBoundary: n.map is not a function', bid: 'ai_summary', repo: null, issue_url: 'u1',
    class: 'skip', source: 'session', reason: '', at: null,
    is_new: false, new_family: false, baseline_first_seen: null,
    category: 'business', family_key: '[warn] ErrorBoundary: *.map is not a function', family_users: 50, family_count: 5000, family_size: 1,
    detail_error: null, mapped_path: 'ai-summary/src/services/summary-layout.ts', line: 271, function: 'getMeetingAISummary', page: '/webview/summary-layout', release: '7.77.0.21',
    sourcemap_missing: false, chunk_files: [],
  });
  assert.equal(out.items[1].source, 'rejected');
  assert.equal(out.exhausted, true);
  assert.deepEqual(out.buckets, {});
  assert.equal(state.candidates.i1.verdict, null);
});

test('walk 整桶跳过：环境桶里未判过的条目记 skip/bucket 且不落盘；用户捞回、agent 判定与派单不受桶影响', () => {
  const scan = [
    snap({ issue_id: 'api', message: 'APINotProvided', users: 900 }),
    snap({ issue_id: 'net', message: '[warn] CommonError: Failed to fetch', users: 800 }),
    snap({ issue_id: 'srv', message: '[InvokeServierPBFast error]: logId=1, rate limit', users: 700 }),
    snap({ issue_id: 'rev', message: '[native-api] common.getAvatarBase64 timed out after 60000ms', users: 600 }),
    snap({ issue_id: 'yes', message: '[native-api] command=2312 timed out after 10000ms', users: 500 }),
    snap({ issue_id: 'disp', message: '[native-api] command=94003 timed out after 10000ms', users: 400 }),
    snap({ issue_id: 'biz', message: "[warn] CommonError: Cannot read properties of undefined (reading 'length')", users: 300 }),
  ];
  const { state } = mergeScan(empty(), scan, T0);
  revive(state, 'rev', T1);
  judge(state, 'yes', { fixable: true, reason: '调用方可加 catch', at: T1 });
  markDispatched(state, 'disp', { task_id: 't', supplement: 'x', at: T1 });
  const before = JSON.stringify(state);
  const out = walk(state, scan, { skip: ['api'] });
  assert.deepEqual(out.items.map((i) => [i.issue_id, i.class, i.source, i.reason]), [
    ['api', 'skip', 'bucket', '宿主与 Native 桥'],
    ['net', 'skip', 'bucket', '网络'],
    ['srv', 'skip', 'bucket', '服务端错误码'],
    ['rev', 'fixable', 'user', '捞回'],
    ['yes', 'fixable', 'agent', '调用方可加 catch'],
    ['disp', 'skip', 'dispatched', ''],
    ['biz', 'unjudged', null, ''],
  ]);
  assert.deepEqual(out.buckets, {
    server: { label: '服务端错误码', issues: 1, families: 1, users: 700 },
    network: { label: '网络', issues: 1, families: 1, users: 800 },
    host: { label: '宿主与 Native 桥', issues: 1, families: 1, users: 900 },
  });
  assert.equal(out.exhausted, false);
  assert.equal(JSON.stringify(state), before);
});

test('walk 按同文案聚合的合计用户数排序，同族相邻、族内按单条用户数', () => {
  const scan = [
    snap({ issue_id: 'lone', message: "[warn] CommonError: Cannot read properties of undefined (reading 'length')", users: 500 }),
    snap({ issue_id: 'f-small', message: "[warn] ErrorBoundary: o.map is not a function. (In 'o.map((e,t)=>n.createElement', 'o.map' is undefined)", users: 200 }),
    snap({ issue_id: 'f-big', message: '[warn] ErrorBoundary: n.map is not a function', users: 400 }),
  ];
  const { state } = mergeScan(empty(), scan, T0);
  const out = walk(state, scan);
  assert.deepEqual(out.items.map((i) => [i.issue_id, i.family_users, i.family_size]), [['f-big', 600, 2], ['f-small', 600, 2], ['lone', 500, 1]]);
  assert.equal(out.items[0].family_key, out.items[1].family_key);
});

test('walk 把新族候选排在最前并带首次出现时间；老文案换堆栈的新 issue 仍按量级排；池里记住基线首次出现', () => {
  const scan = [
    snap({ issue_id: 'big', message: 'APINotProvided', users: 900, baseline_first_seen: 1787000000000 }),
    snap({ issue_id: 'variant', message: '[warn] ErrorBoundary: n.map is not a function', users: 300, is_new: true, new_family: false, baseline_first_seen: 1788100000000 }),
    snap({ issue_id: 'fresh', message: "Cannot read properties of null (reading 'meetingId')", users: 7, is_new: true, new_family: true, baseline_first_seen: 1788120000000 }),
  ];
  const { state } = mergeScan(empty(), scan, T0);
  assert.equal(state.candidates.fresh.baseline_first_seen, 1788120000000);
  const out = walk(state, scan);
  assert.deepEqual(out.items.map((i) => [i.issue_id, i.class, i.is_new, i.new_family, i.baseline_first_seen]), [
    ['fresh', 'unjudged', true, true, 1788120000000],
    ['big', 'skip', false, false, 1787000000000],
    ['variant', 'unjudged', true, false, 1788100000000],
  ]);
  assert.equal(out.new_issues, 2);
  // 后续页没有新增检测结果时，首次出现时间从池里回填；有新值时覆盖。
  const later = walk(state, [snap({ issue_id: 'fresh', users: 9 })]).items[0];
  assert.deepEqual([later.is_new, later.baseline_first_seen], [false, 1788120000000]);
  const { state: refreshed } = mergeScan(state, [snap({ issue_id: 'fresh', users: 9, baseline_first_seen: 1788130000000 })], T1);
  assert.equal(refreshed.candidates.fresh.baseline_first_seen, 1788130000000);
  const kept = mergeScan(refreshed, [snap({ issue_id: 'fresh', users: 9 })], T2).state;
  assert.equal(kept.candidates.fresh.baseline_first_seen, 1788130000000);
});

test('walk 以 issue 为单位：文案相同的 issue 各自归类，不继承彼此的派单或判定', () => {
  const scan = [
    snap({ issue_id: 'a', message: 'APINotProvided', users: 900 }),
    snap({ issue_id: 'b', message: 'APINotProvided', users: 500 }),
    snap({ issue_id: 'c', message: 'APINotProvided', users: 90 }),
  ];
  const { state } = mergeScan(empty(), scan, T0);
  markDispatched(state, 'a', { task_id: 't', supplement: 'x', at: T0 });
  judge(state, 'b', { fixable: false, reason: '调用点在宿主内置脚本', at: T0 });
  assert.deepEqual(walk(state, scan).items.map((i) => [i.issue_id, i.class, i.source]), [
    ['a', 'skip', 'dispatched'],
    ['b', 'skip', 'agent'],
    ['c', 'skip', 'bucket'],
  ]);
});

test('CLI walk 输出一行 JSON 且不改池子', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const scanFile = join(dir, 'scan.json');
  writeFileSync(scanFile, JSON.stringify({ scanned_at: T0, candidates: [snap(), snap({ issue_id: 'i2', users: 100 })] }));
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

test('history 给出本条与同缺陷各条的台账行、处置事件、回落比（改名后新 issue 的量加总后再比）', () => {
  const old = snap({ issue_id: 'old', count: 1000 });
  const renamed = snap({ issue_id: 'renamed', count: 150 });
  const other = snap({ issue_id: 'other', count: 77, latest_event: frame() });
  const { state } = mergeScan(empty(), [old, other], T0);
  const ledger = [...ledgerRows(state, [old, other], T0)];
  markDispatched(state, 'old', { task_id: 't', supplement: 'x', at: '2026-09-10T12:00:00.000Z' });
  const merged = mergeScan(state, [{ ...old, count: 1200 }, renamed, other], T1).state;
  judge(merged, 'renamed', { sameAs: 'old', reason: '同缺陷已派单 old', at: T1 });
  ledger.push(...ledgerRows(merged, [{ ...old, count: 1200 }, renamed, other], T1));
  ledger.push(...ledgerRows(merged, [{ ...renamed, count: 90 }, other], T2));

  const h = history(merged, ledger, 'old');
  assert.deepEqual(h.rows.map((r) => [r.at, r.count]), [[T0, 1000], [T1, 1200]]);
  assert.deepEqual(h.covered_rows.map((r) => [r.at, r.count]), [[T1, 150], [T2, 90]]);
  assert.deepEqual(h.events, [
    { type: 'first_seen', at: T0 },
    { type: 'dispatched', at: '2026-09-10T12:00:00.000Z' },
  ]);
  assert.deepEqual(h.recovery, {
    baseline_count: 1000, baseline_at: T0, latest_at: T2, latest_present: true, latest_count: 90, latest_floor: 77, ratio: 0.09,
  });
});

test('history：台账晚于派单的旧单以最早一行为基线；在最新扫描里缺席按那次扫描的最小次数估上界；没有台账时 ratio 为 null', () => {
  const c = snap({ count: 400 });
  const { state } = mergeScan(empty(), [c], T0);
  markDispatched(state, 'i1', { task_id: 't', supplement: 'x', at: '2026-09-01T00:00:00.000Z' });
  assert.deepEqual(history(state, [], 'i1').recovery, {
    baseline_count: null, baseline_at: null, latest_at: null, latest_present: false, latest_count: 0, latest_floor: null, ratio: null,
  });
  const other = snap({ issue_id: 'o', count: 800 });
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

test('history 只按 issue_id 认台账行：同文案的其他 issue 不混入；旧格式行的 family_count 照常读', () => {
  const { state } = mergeScan(empty(), [snap({ count: 400 })], T0);
  const legacy = { at: T0, bid: 'ai_summary', issue_id: 'i1', family_key: 'm', family_count: 900, family_users: 300 };
  markDispatched(state, 'i1', { task_id: 't', supplement: 'x', at: '2026-09-10T12:00:00.000Z' });
  const later = ledgerRows(state, [snap({ count: 400 }), snap({ issue_id: 'twin', count: 7000 })], T1);
  const h = history(state, [legacy, ...later], 'i1');
  assert.deepEqual(h.rows.map((r) => [r.at, r.issue_id]), [[T0, 'i1'], [T1, 'i1']]);
  assert.equal(h.recovery.baseline_count, 900);
  assert.equal(h.recovery.latest_count, 400);
  assert.equal(h.recovery.ratio, 400 / 900);
});

test('缩窗扫描的台账行带 window_hours，history 的基线与回落比不看它们', () => {
  const { state } = mergeScan(empty(), [snap({ count: 1000 })], T0);
  markDispatched(state, 'i1', { task_id: 't', supplement: 'x', at: T0 });
  const day = ledgerRows(state, [snap({ count: 1000 })], T0);
  const tenMinutes = ledgerRows(state, [snap({ count: 3 })], T1, 1 / 6);
  assert.equal(tenMinutes[0].window_hours, 1 / 6);
  const h = history(state, [...day, ...tenMinutes], 'i1');
  assert.deepEqual(h.rows.map((r) => [r.at, r.count]), [[T0, 1000]]);
  assert.equal(h.recovery.latest_at, T0);
  assert.equal(h.recovery.ratio, 1);
  // mergeFromScan 按 scan.window 算窗口长度写进台账。
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  mergeFromScan(dir, { scanned_at: T2, window: { start: 1788000000, end: 1788000600 }, candidates: [snap({ count: 3 })] });
  assert.equal(readLedger(dir)[0].window_hours, 1 / 6);
});

test('history 对没派单的候选不给基线，ratio 为 null', () => {
  const { state } = mergeScan(empty(), [snap({ count: 400 })], T0);
  const ledger = ledgerRows(state, [snap({ count: 400 })], T1);
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
  writeFileSync(scanFile, JSON.stringify({ scanned_at: T0, candidates: [snap(), snap({ issue_id: 'i2' })] }));
  cli('merge', '--dir', dir, '--scan', scanFile);
  cli('reject', '--dir', dir, '--issue-id', 'i2', '--reason', '宿主问题');
  cli('dispatched', '--dir', dir, '--issue-id', 'i1', '--task-id', 't', '--workspace', '/h/ws/i1/biz-vc-web');
  const h = cli('history', '--dir', dir, '--issue-id', 'i1');
  assert.equal(h.ok, true);
  assert.deepEqual(h.events.map((e) => e.type), ['first_seen', 'dispatched']);
  assert.equal(h.rows.length, 1);
  assert.deepEqual(cli('history', '--dir', dir, '--issue-id', 'i2').events.map((e) => e.type), ['first_seen', 'rejected']);
});
