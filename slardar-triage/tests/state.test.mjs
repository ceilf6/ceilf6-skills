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
