import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openThreads, countOpen, makeBacklog } from '../src/backlog.mjs';

const row = (over = {}) => ({ idx: 1, branch: 'feat/a', status: 'awaiting_human', archived: false, ...over });

test('openThreads：archived 与 status=done 都不算未完成', () => {
  const rows = [
    row({ branch: 'feat/a' }),
    row({ branch: 'feat/b', status: 'done' }),
    row({ branch: 'feat/c', archived: true }),
    row({ branch: 'feat/d', status: 'cr' }),
  ];
  assert.deepEqual(openThreads(rows).map((r) => r.branch), ['feat/a', 'feat/d']);
});

test('countOpen：同一分支在两本账上只记一笔', () => {
  const rows = [row({ branch: 'bot/x' }), row({ branch: 'bot/y' })];
  const runtime = [{ messageId: 'om_1', branch: 'bot/x', state: 'active' }];
  assert.equal(countOpen(rows, runtime), 2);
});

test('countOpen：队列中/启动中没有分支，各记一笔', () => {
  const rows = [row({ branch: 'bot/x' })];
  const runtime = [
    { messageId: 'om_1', branch: 'bot/x', state: 'active' },
    { messageId: 'om_2', branch: '', state: 'queued' },
    { messageId: 'om_3', branch: '', state: 'starting' },
  ];
  assert.equal(countOpen(rows, runtime), 3);
});

test('countOpen：台账已归档但运行时仍在册（滞留）的照记', () => {
  const rows = [row({ branch: 'bot/x' }), row({ branch: 'bot/z', archived: true })];
  const runtime = [{ messageId: 'om_1', branch: 'bot/z', state: 'stranded' }];
  assert.equal(countOpen(rows, runtime), 2);
});

test('count：读台账走 threads.sh list --json', async () => {
  const calls = [];
  const backlog = makeBacklog({
    threadsSh: '/tmp/threads.sh',
    run: async (bin, args) => { calls.push([bin, ...args]); return { code: 0, stdout: JSON.stringify([row(), row({ branch: 'feat/b' })]), stderr: '' }; },
    log: () => {},
  });
  const out = await backlog.count([]);
  assert.deepEqual(calls, [['bash', '/tmp/threads.sh', 'list', '--json']]);
  assert.equal(out.open, 2);
  assert.equal(out.degraded, false);
});

test('count：台账读不出来时降级为运行时在册数，并留一行日志', async () => {
  for (const bad of [{ code: 1, stdout: '', stderr: 'jq: not found' }, { code: 0, stdout: '不是 JSON', stderr: '' }]) {
    const logs = [];
    const backlog = makeBacklog({ threadsSh: '/tmp/threads.sh', run: async () => bad, log: (m) => logs.push(m) });
    const out = await backlog.count([{ messageId: 'om_1', branch: '', state: 'queued' }]);
    assert.equal(out.open, 1);
    assert.equal(out.degraded, true);
    assert.equal(logs.length, 1, `降级必须留痕：${JSON.stringify(bad)}`);
  }
});

test('count：run 抛异常也降级，不把异常抛给接单回调', async () => {
  const logs = [];
  const backlog = makeBacklog({ threadsSh: '/tmp/threads.sh', run: async () => { throw new Error('spawn 失败'); }, log: (m) => logs.push(m) });
  const out = await backlog.count([]);
  assert.equal(out.open, 0);
  assert.equal(out.degraded, true);
  assert.equal(logs.length, 1);
});
