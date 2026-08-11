import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeMrWatch, DEFAULTS } from '../src/mrwatch.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'thb-mrw-'));
  const ctx = join(root, 'repo', '.harness-ceilf6', 'feat__x');
  mkdirSync(ctx, { recursive: true });
  const row = { idx: 1, cwd: join(root, 'repo'), ctx_dir: ctx, branch: 'feat/x', mr_id: '9', status: 'awaiting_human', archived: false };
  return { root, ctx, row };
}
const SNAP_NEW = (extra = {}) => JSON.stringify({
  mr_id: '9', repo: 'g/r', iid: '1', closed: false,
  threads: [{ id: 't1', resolved: false, replies: [{ author: 'cr-bot', body: 'x' }] }],
  new: [{ id: 't1', handled_before: null, new_replies: [{ author: 'cr-bot', body: 'x' }] }],
  loop_suspect: false, ...extra,
});

// run 假实现：按命令特征路由。git 两问（symbolic-ref / status）由 gitAnswers 控制。
function makeDeps(row, { fetchOut = SNAP_NEW(), fetchCode = 0, gitBranch = 'feat/x', gitDirty = '', capacity = true, active = false } = {}) {
  const calls = { run: [], dm: [], chat: [], duty: [], log: [] };
  const deps = {
    config: { chatId: 'oc_hall', dmOpenId: 'ou_me', repoPath: row.cwd, mrWatch: { intervalMs: 1000 } },
    lark: {
      async sendToChat(chatId, text) { calls.chat.push([chatId, text]); return { messageId: 'om_a1', threadId: 'omt_a1' }; },
      async sendDm(openId, text) { calls.dm.push(text); return 'om_dm'; },
    },
    hasCapacity: () => capacity,
    hasActiveTaskAt: () => active,
    launchDuty: (task, opts) => { calls.duty.push({ task, opts }); return true; },
    log: (...a) => { calls.log.push(a.join(' ')); },
    run: async (bin, args) => {
      calls.run.push([bin, ...args]);
      const line = args.join(' ');
      if (line.includes('threads.sh')) return { code: 0, stdout: JSON.stringify([row]), stderr: '' };
      if (line.includes('fetch')) return { code: fetchCode, stdout: fetchOut, stderr: 'boom' };
      if (line.includes('symbolic-ref')) return { code: 0, stdout: `${gitBranch}\n`, stderr: '' };
      if (line.includes('status --porcelain')) return { code: 0, stdout: gitDirty, stderr: '' };
      return { code: 0, stdout: '', stderr: '' }; // mark / disable
    },
  };
  return { deps, calls };
}

test('主路：锚点 → mark --count-trigger → launchDuty，prompt 含快照路径', async () => {
  const { row } = fixture();
  const { deps, calls } = makeDeps(row);
  await makeMrWatch(deps).tick();
  assert.equal(calls.chat.length, 1);
  assert.ok(calls.chat[0][1].includes('MR 9'));
  const markCall = calls.run.find((c) => c.join(' ').includes(' mark '));
  assert.ok(markCall.join(' ').includes('--count-trigger'));
  assert.equal(calls.duty.length, 1);
  assert.equal(calls.duty[0].task.messageId, 'om_a1');
  assert.equal(calls.duty[0].opts.cwd, row.cwd);
  assert.ok(calls.duty[0].opts.firstMessage.includes('snapshot.json'));
  assert.ok(!calls.duty[0].opts.firstMessage.includes('{{'), '占位符须全部被替换（含 LOOP_SUSPECT）');
  const snapPath = calls.duty[0].opts.firstMessage.match(/快照：(\S+snapshot\.json)/)?.[1];
  assert.ok(snapPath && existsSync(snapPath), '快照文件已落盘');
});

test('无新评论：零动作', async () => {
  const { row } = fixture();
  const { deps, calls } = makeDeps(row, { fetchOut: SNAP_NEW({ new: [], loop_suspect: false }) });
  await makeMrWatch(deps).tick();
  assert.equal(calls.chat.length + calls.dm.length + calls.duty.length, 0);
});

test('检出被占（脏）：私信 + mark 不带 count-trigger，不起任务', async () => {
  const { row } = fixture();
  const { deps, calls } = makeDeps(row, { gitDirty: ' M a.ts\n' });
  await makeMrWatch(deps).tick();
  assert.equal(calls.duty.length, 0);
  assert.equal(calls.dm.length, 1);
  assert.ok(calls.dm[0].includes('未自动处置'));
  const markCall = calls.run.find((c) => c.join(' ').includes(' mark '));
  assert.ok(markCall && !markCall.join(' ').includes('--count-trigger'));
});

test('分支漂移同被占；已有任务在跑则完全跳过（不 mark）', async () => {
  const { row } = fixture();
  const drift = makeDeps(row, { gitBranch: 'other' });
  await makeMrWatch(drift.deps).tick();
  assert.equal(drift.calls.duty.length, 0);
  assert.equal(drift.calls.dm.length, 1);
  const busy = makeDeps(row, { active: true });
  await makeMrWatch(busy.deps).tick();
  assert.equal(busy.calls.duty.length + busy.calls.dm.length, 0);
  assert.ok(!busy.calls.run.some((c) => c.join(' ').includes(' mark ')));
});

test('并发满：不 mark 不发锚点，留待下轮', async () => {
  const { row } = fixture();
  const { deps, calls } = makeDeps(row, { capacity: false });
  await makeMrWatch(deps).tick();
  assert.equal(calls.chat.length + calls.duty.length, 0);
  assert.ok(!calls.run.some((c) => c.join(' ').includes(' mark ')));
});

test('熔断：trigger_count 达上限 → disable + 私信一次', async () => {
  const { row, ctx } = fixture();
  writeFileSync(join(ctx, 'mr-comments.json'), JSON.stringify({ trigger_count: 5, auto_disabled: false, closed: false }));
  const { deps, calls } = makeDeps(row);
  const w = makeMrWatch(deps);
  await w.tick(); await w.tick();
  assert.ok(calls.run.some((c) => c.join(' ').includes('disable')));
  assert.equal(calls.dm.filter((t) => t.includes('熔断')).length, 1, '告警只发一次');
  assert.equal(calls.duty.length, 0);
});

test('auto_disabled/closed 水位：直接跳过（连 fetch 都不发）', async () => {
  const { row, ctx } = fixture();
  writeFileSync(join(ctx, 'mr-comments.json'), JSON.stringify({ auto_disabled: true }));
  const { deps, calls } = makeDeps(row);
  await makeMrWatch(deps).tick();
  assert.ok(!calls.run.some((c) => c.join(' ').includes('fetch')));
});

test('fetch 连败到 12：私信一次，log 带 stderr 首行', async () => {
  const { row, ctx } = fixture();
  writeFileSync(join(ctx, 'mr-comments.json'), JSON.stringify({ consecutive_failures: 12, auto_disabled: false, closed: false }));
  const { deps, calls } = makeDeps(row, { fetchCode: 4 });
  await makeMrWatch(deps).tick();
  assert.equal(calls.dm.filter((t) => t.includes('连续失败')).length, 1);
  assert.ok(calls.log.some((l) => l.includes('boom')), 'exit 4 每轮也要 log');
});

test('fetch 其余非零（如水位损坏 die 出的 1）：log 不 DM——脚本不落连败，DM 永远到不了', async () => {
  const { row, ctx } = fixture();
  writeFileSync(join(ctx, 'mr-comments.json'), JSON.stringify({ consecutive_failures: 12, auto_disabled: false, closed: false }));
  const { deps, calls } = makeDeps(row, { fetchCode: 1 });
  await makeMrWatch(deps).tick();
  assert.equal(calls.dm.length, 0, 'exit 1 不得走连败 DM 分支');
  assert.ok(calls.log.some((l) => l.includes('boom')), '必须 log stderr 首行，不能静默');
  assert.equal(calls.duty.length + calls.chat.length, 0);
});

test('closed 快照：提醒点完成一次，不触发', async () => {
  const { row } = fixture();
  const { deps, calls } = makeDeps(row, { fetchOut: JSON.stringify({ mr_id: '9', closed: true }) });
  const w = makeMrWatch(deps);
  await w.tick(); await w.tick();
  assert.equal(calls.dm.filter((t) => t.includes('完成')).length, 1);
  assert.equal(calls.duty.length, 0);
});

test('枚举过滤：无 mr_id / done / archived 的线程连 fetch 都不发', async () => {
  const { row } = fixture();
  const rows = [{ ...row, mr_id: null }, { ...row, status: 'done' }, { ...row, archived: true }];
  const { deps, calls } = makeDeps(row);
  deps.run = async (bin, args) => {
    calls.run.push([bin, ...args]);
    if (args.join(' ').includes('threads.sh')) return { code: 0, stdout: JSON.stringify(rows), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  await makeMrWatch(deps).tick();
  assert.ok(!calls.run.some((c) => c.join(' ').includes('fetch')));
});

test('start：缺 Bits token 自禁用', () => {
  const { row } = fixture();
  const { deps } = makeDeps(row);
  const saved = process.env.CLIENT_BITS_TOKEN;
  delete process.env.CLIENT_BITS_TOKEN;
  assert.equal(makeMrWatch(deps).start(), null);
  if (saved !== undefined) process.env.CLIENT_BITS_TOKEN = saved;
});
