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
