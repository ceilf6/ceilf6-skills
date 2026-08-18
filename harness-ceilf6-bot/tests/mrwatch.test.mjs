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
const BOT_T1 = { id: 't1', source: 'codebase_thread', kind: 'bot', path: 'src/a.ts', line: 12, handled_before: null,
  new_replies: [{ author: 'Bits CodeGuard', author_kind: 'bot', body: 'x' }] };
const HUMAN_H1 = { id: 'h1', source: 'codebase_thread', kind: 'human', path: 'src/b.ts', line: 7, handled_before: null,
  new_replies: [{ author: 'yuzhou.hz', author_kind: 'human', body: '这个文件是不是没必要了\n第二行' }] };
const SNAP_NEW = (extra = {}) => JSON.stringify({
  mr_id: '9', repo: 'g/r', iid: '1', mr_url: 'https://code.byted.org/g/r/merge_requests/1', closed: false,
  threads: [
    { id: 't1', source: 'codebase_thread', kind: 'bot', resolved: false, replies: [{ author: 'Bits CodeGuard', author_kind: 'bot', body: 'x' }] },
    { id: 'h1', source: 'codebase_thread', kind: 'human', resolved: false, replies: [{ author: 'yuzhou.hz', author_kind: 'human', body: 'y' }] },
  ],
  new: [BOT_T1],
  loop_suspect: false, ...extra,
});

// run 假实现：按命令特征路由。git 两问（symbolic-ref / status）由 gitAnswers 控制。
// topic：该线程在任务大厅的话题（null = 交互会话开的线程，走私信）。
function makeDeps(row, { fetchOut = SNAP_NEW(), fetchCode = 0, gitBranch = 'feat/x', gitDirty = '', capacity = true, active = false,
  topic = null } = {}) {
  const calls = { run: [], dm: [], chat: [], reply: [], duty: [], log: [] };
  const deps = {
    config: { chatId: 'oc_hall', dmOpenId: 'ou_me', repoPath: row.cwd, mrWatch: { intervalMs: 1000 } },
    lark: {
      async sendToChat(chatId, text) { calls.chat.push([chatId, text]); return { messageId: 'om_a1', threadId: 'omt_a1' }; },
      async sendDm(openId, text) { calls.dm.push(text); return `om_dm${calls.dm.length}`; },
      async replyInThread(messageId, text) { calls.reply.push([messageId, text]); return { messageId: `om_r${calls.reply.length}`, threadId: 'omt_topic' }; },
    },
    findTopic: () => topic,
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

test('主路（无话题的线程）：私信当锚点 → mark --count-trigger → launchDuty，prompt 含快照路径；群里零消息', async () => {
  const { row } = fixture();
  const { deps, calls } = makeDeps(row);
  await makeMrWatch(deps).tick();
  assert.equal(calls.chat.length, 0, '绝不开新话题');
  assert.equal(calls.reply.length, 0);
  assert.equal(calls.dm.length, 1);
  assert.ok(calls.dm[0].includes('MR 9') && calls.dm[0].includes('自动处置中') && calls.dm[0].includes('feat/x'), calls.dm[0]);
  const markCall = calls.run.find((c) => c.join(' ').includes(' mark '));
  assert.ok(markCall.join(' ').includes('--count-trigger'));
  assert.equal(calls.duty.length, 1);
  assert.equal(calls.duty[0].task.messageId, 'om_dm1', '锚点是那条私信');
  assert.equal(calls.duty[0].task.threadId, '');
  assert.equal(calls.duty[0].opts.cwd, row.cwd);
  assert.ok(calls.duty[0].opts.firstMessage.includes('snapshot.json'));
  assert.ok(!calls.duty[0].opts.firstMessage.includes('{{'), '占位符须全部被替换（含 LOOP_SUSPECT）');
  const snapPath = calls.duty[0].opts.firstMessage.match(/快照：(\S+snapshot\.json)/)?.[1];
  assert.ok(snapPath && existsSync(snapPath), '快照文件已落盘');
});

test('主路（源自任务大厅话题的线程）：在该话题回帖当锚点，不开新话题、不私信', async () => {
  const { row } = fixture();
  const topic = { rootMessageId: 'om_root', threadId: 'omt_topic' };
  const { deps, calls } = makeDeps(row, { topic });
  await makeMrWatch(deps).tick();
  assert.equal(calls.chat.length + calls.dm.length, 0);
  assert.equal(calls.reply.length, 1);
  assert.equal(calls.reply[0][0], 'om_root', '回在话题首帖下');
  assert.ok(calls.reply[0][1].includes('自动处置中') && !calls.reply[0][1].startsWith('【bot】'), calls.reply[0][1]);
  assert.equal(calls.duty.length, 1);
  assert.equal(calls.duty[0].task.messageId, 'om_r1', '锚点是回帖自身');
  assert.equal(calls.duty[0].task.threadId, 'omt_topic');
});

test('人工评论：私信清单 + 只推人工线程水位（不计 count-trigger），不起任务不发锚点', async () => {
  const { row } = fixture();
  const { deps, calls } = makeDeps(row, { fetchOut: SNAP_NEW({ new: [HUMAN_H1] }) });
  await makeMrWatch(deps).tick();
  assert.equal(calls.duty.length + calls.chat.length, 0);
  assert.equal(calls.dm.length, 1);
  const dm = calls.dm[0];
  assert.ok(dm.includes('人工 CR 评论') && dm.includes('yuzhou.hz') && dm.includes('src/b.ts:7'), dm);
  assert.ok(dm.includes('这个文件是不是没必要了 第二行'), '摘要换行折成空格');
  assert.ok(dm.includes('https://code.byted.org/g/r/merge_requests/1'), '带 MR 链接');
  assert.ok(dm.includes('不自动回复'), '写明不自动回复');
  const marks = calls.run.filter((c) => c.join(' ').includes(' mark '));
  assert.equal(marks.length, 1);
  assert.ok(!marks[0].join(' ').includes('--count-trigger'), '人工评论不计熔断配额');
  const humanPath = marks[0][marks[0].indexOf('--from-snapshot') + 1];
  assert.ok(humanPath.endsWith('human.json'), humanPath);
  const written = JSON.parse(readFileSync(humanPath, 'utf8'));
  assert.deepEqual(written.threads.map((t) => t.id), ['h1'], '人工快照只含人工线程，机器人线程水位不动');
  assert.equal(written.loop_suspect, false);
});

test('人工 + 机器人混合：私信人工清单，值班任务只拿机器人条目', async () => {
  const { row } = fixture();
  const { deps, calls } = makeDeps(row, { fetchOut: SNAP_NEW({ new: [HUMAN_H1, BOT_T1] }) });
  await makeMrWatch(deps).tick();
  assert.equal(calls.dm.length, 2, '人工清单私信一次 + 无话题线程的值班锚点私信一次');
  assert.ok(calls.dm[0].includes('人工 CR 评论'));
  assert.equal(calls.duty.length, 1, '机器人条目照常起任务');
  assert.ok(calls.dm[1].includes('1 条新机器人 CR 评论'), calls.dm[1]);
  const snapPath = calls.duty[0].opts.firstMessage.match(/快照：(\S+snapshot\.json)/)?.[1];
  const written = JSON.parse(readFileSync(snapPath, 'utf8'));
  assert.deepEqual(written.new.map((n) => n.id), ['t1'], '值班快照 new 只含机器人');
  assert.equal(written.threads.length, 2, 'threads 仍全量（mark 幂等）');
  const marks = calls.run.filter((c) => c.join(' ').includes(' mark '));
  assert.equal(marks.length, 2, '人工一次（无配额）+ 机器人一次（计配额）');
  assert.equal(marks.filter((m) => m.join(' ').includes('--count-trigger')).length, 1);
});

test('人工评论 + 机器人条目但并发满：人工照私信并 mark，机器人不 mark 留待下轮', async () => {
  const { row } = fixture();
  const { deps, calls } = makeDeps(row, { fetchOut: SNAP_NEW({ new: [HUMAN_H1, BOT_T1] }), capacity: false });
  await makeMrWatch(deps).tick();
  assert.equal(calls.dm.length, 1, '只有人工清单');
  assert.equal(calls.duty.length + calls.chat.length + calls.reply.length, 0);
  const marks = calls.run.filter((c) => c.join(' ').includes(' mark '));
  assert.equal(marks.length, 1);
  assert.ok(marks[0].join(' ').includes('human.json'));
});

test('人工评论超过 10 条：私信只列 10 条并指向快照', async () => {
  const { row } = fixture();
  const many = Array.from({ length: 12 }, (_, i) => ({ ...HUMAN_H1, id: `h${i}` }));
  const { deps, calls } = makeDeps(row, { fetchOut: SNAP_NEW({ new: many }) });
  await makeMrWatch(deps).tick();
  assert.equal(calls.dm.length, 1);
  assert.ok(calls.dm[0].includes('12 条人工') && calls.dm[0].includes('另 2 条见快照'), calls.dm[0]);
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

test('mark 退出非零：log 留因（带 stderr 首行），私信照发不中断', async () => {
  const { row } = fixture();
  const { deps, calls } = makeDeps(row, { gitDirty: ' M a.ts\n' });
  const inner = deps.run;
  deps.run = async (bin, args) => (args.join(' ').includes(' mark ')
    ? (calls.run.push([bin, ...args]), { code: 1, stdout: '', stderr: 'mark boom\n详情' })
    : inner(bin, args));
  await makeMrWatch(deps).tick();
  assert.ok(calls.log.some((l) => l.includes('mark 失败') && l.includes('mark boom')));
  assert.equal(calls.dm.length, 1, '被占私信不因 mark 失败而丢');
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

test('closed 水位但 mr_id 已变（MR 重建）：不静默，fetch 照发恢复巡检', async () => {
  const { row, ctx } = fixture();
  writeFileSync(join(ctx, 'mr-comments.json'), JSON.stringify({ closed: true, mr_id: '8' }));
  const { deps, calls } = makeDeps(row); // row.mr_id='9'
  await makeMrWatch(deps).tick();
  assert.ok(calls.run.some((c) => c.join(' ').includes('fetch')), '重建后须交给 fetch 重置水位');
});

test('closed 水位且 mr_id 一致：连 fetch 都不发', async () => {
  const { row, ctx } = fixture();
  writeFileSync(join(ctx, 'mr-comments.json'), JSON.stringify({ closed: true, mr_id: '9' }));
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

test('start：出厂关闭；显式 enabled 才启动，且不看 BITS token（bytedcli 走登录态）', () => {
  const { row } = fixture();
  const saved = process.env.CLIENT_BITS_TOKEN;
  delete process.env.CLIENT_BITS_TOKEN;
  try {
    assert.equal(DEFAULTS.enabled, false);
    const off = makeDeps(row);
    off.deps.config.mrWatch = { intervalMs: 1000 }; // 未写 enabled → 出厂关闭
    assert.equal(makeMrWatch(off.deps).start(), null);
    assert.ok(off.calls.log.some((l) => l.includes('停用')));
    const on = makeDeps(row);
    on.deps.config.mrWatch = { enabled: true, intervalMs: 1000 };
    const t = makeMrWatch(on.deps).start();
    assert.ok(t, '显式打开且无 token 也启动');
    clearInterval(t);
    assert.ok(on.calls.log.some((l) => l.includes('评论巡检启动')));
  } finally {
    if (saved !== undefined) process.env.CLIENT_BITS_TOKEN = saved;
  }
});
