import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runErrandTask, resumeTask, killSession, stopLive } from '../src/runner.mjs';

const CLAUDE_STUB = resolve(import.meta.dirname, 'stubs/claude');

// 办事不建现场，fixture 只需要一个「家目录」替身与放日志的地方。
function makeFixture(tag) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `thb-errand-${tag}-`)));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return { root, home };
}
function makeConfig(root, home) {
  return {
    repoPath: join(root, 'repo'), worktreesDir: join(root, 'wt'), logsDir: join(root, 'logs'),
    errandCwd: home, taskTimeoutMs: 60_000, killGraceMs: 500, claudeBin: CLAUDE_STUB, dmOpenId: 'ou_me',
    reactions: { claimed: 'THUMBSUP', done: 'DONE', failed: 'CROSS', escalate: 'WARN', skipped: 'GET', stopped: 'MUTE' },
  };
}
function fakeLark(calls) {
  let n = 0;
  return {
    async addReaction(mid, key) { calls.push(['add', mid, key]); return `rid_${++n}`; },
    async deleteReaction(mid, rid) { calls.push(['del', mid, rid]); return true; },
    async sendDm(openId, text) { calls.push(['dm', openId, text]); return 'om_dm'; },
  };
}
const dmTexts = (calls) => calls.filter((c) => c[0] === 'dm').map((c) => c[2]).join('\n');
const TASK = { messageId: 'om_errand_111111', senderOpenId: 'ou_me', text: '看下 ~/Downloads 有多大', receivedAt: '2026-08-17T10:00:00Z' };
const rmFixture = (root) => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });

test('runErrandTask：在 errandCwd 起会话，不建 worktree、不建分支', async () => {
  const { root, home } = makeFixture('cwd');
  const calls = [];
  process.env.STUB_VERDICT = 'pass';
  process.env.STUB_PROMPT_OUT = join(root, 'prompt.txt');
  process.env.STUB_CWD_OUT = join(root, 'cwd.txt');
  const out = await runErrandTask(TASK, makeConfig(root, home), fakeLark(calls), {});
  assert.equal(out.verdict, 'pass');
  assert.equal(out.worktree, home, '办事现场就是 errandCwd');
  assert.equal(readFileSync(process.env.STUB_CWD_OUT, 'utf8').trim(), home, '会话进程的 cwd 必须是家目录');
  assert.ok(!existsSync(join(root, 'wt')), '不得创建 worktree');
  const prompt = readFileSync(process.env.STUB_PROMPT_OUT, 'utf8');
  assert.ok(prompt.includes('看下 ~/Downloads 有多大'), '首轮 prompt 应带办事原文');
  assert.ok(prompt.includes(home), '首轮 prompt 应告知会话所在目录');
  assert.ok(prompt.includes('RESULT '), '办事同样按 RESULT 契约收轮');
  delete process.env.STUB_VERDICT; delete process.env.STUB_PROMPT_OUT; delete process.env.STUB_CWD_OUT;
  rmFixture(root);
});

test('runErrandTask：errandCwd 省略即家目录', async () => {
  const { root, home } = makeFixture('home');
  const config = makeConfig(root, home);
  delete config.errandCwd;
  process.env.STUB_VERDICT = 'pass';
  const out = await runErrandTask(TASK, config, fakeLark([]), {});
  assert.equal(out.worktree, homedir());
  delete process.env.STUB_VERDICT;
  rmFixture(root);
});

test('runErrandTask：pass 私信报摘要与目录，不提 MR', async () => {
  const { root, home } = makeFixture('pass');
  const calls = [];
  delete process.env.STUB_VERDICT;
  // 摘要取一句只属于本用例的话：模板里那句「✅ 办事完成」自带「完成」二字，
  // 拿它断言「摘要送到了」在摘要为空时也恒真。
  process.env.STUB_TURNS = 'pass:Downloads 占 42G，最大的是 xcode.dmg';
  await runErrandTask(TASK, makeConfig(root, home), fakeLark(calls), {});
  const dm = dmTexts(calls);
  assert.ok(dm.includes('Downloads 占 42G，最大的是 xcode.dmg'), `回执必须带上结论：${dm}`);
  assert.ok(dm.includes(home), '回执应指明办事目录');
  assert.ok(!/MR/.test(dm), `办事回执不得出现 MR 字样：${dm}`);
  assert.ok(!/分支/.test(dm), `办事回执不得报分支：${dm}`);
  delete process.env.STUB_TURNS;
  rmFixture(root);
});

// 办事没有 MR 那种能自己说话的产物，summary 就是交付物本身：空 summary 的 pass 是一条
// 「办完了，但不告诉你办成什么样」的回执，等于什么都没交付。
test('runErrandTask：pass 缺 summary 先纠偏，仍缺则按 fail 收束', async () => {
  const { root, home } = makeFixture('nosummary');
  const calls = [];
  delete process.env.STUB_VERDICT;
  process.env.STUB_TURNS = 'emptypass;emptypass';
  process.env.STUB_MSGS_OUT = join(root, 'msgs.txt');
  const out = await runErrandTask(TASK, makeConfig(root, home), fakeLark(calls), {});
  assert.equal(out.verdict, 'fail', '空 summary 的 pass 不得成为终态');
  assert.ok(readFileSync(process.env.STUB_MSGS_OUT, 'utf8').includes('summary'), '纠偏要点名 summary 缺失');
  const dm = dmTexts(calls);
  assert.ok(dm.includes('办事未完成'), '收束必须有私信');
  assert.ok(dm.includes('缺 summary'), `回执应说清卡在哪：${dm}`);
  delete process.env.STUB_TURNS; delete process.env.STUB_MSGS_OUT;
  rmFixture(root);
});

test('runErrandTask：纠偏后补上 summary 即照常收束', async () => {
  const { root, home } = makeFixture('nosummary-ok');
  const calls = [];
  delete process.env.STUB_VERDICT;
  process.env.STUB_TURNS = 'emptypass;pass:清掉 3.2G 缓存';
  const out = await runErrandTask(TASK, makeConfig(root, home), fakeLark(calls), {});
  assert.equal(out.verdict, 'pass');
  assert.ok(dmTexts(calls).includes('清掉 3.2G 缓存'));
  delete process.env.STUB_TURNS;
  rmFixture(root);
});

test('runErrandTask：fail 私信带日志路径', async () => {
  const { root, home } = makeFixture('fail');
  const calls = [];
  process.env.STUB_VERDICT = 'fail';
  const out = await runErrandTask(TASK, makeConfig(root, home), fakeLark(calls), {});
  assert.equal(out.verdict, 'fail');
  assert.ok(dmTexts(calls).includes(out.logPath), '失败回执应带日志路径');
  delete process.env.STUB_VERDICT;
  rmFixture(root);
});

// 办事契约只认 ask/working/pass/fail。skip 走的是「只换表情、不发私信」的分支——办事落进去
// 就是「你吩咐的事一句回音都没有」；escalate/fused 还会把 harness 的接管文案发给一件杂活。
// prompt 里写了没有 skip 拦不住模型跑偏，状态机这一层必须自己收。
test('runErrandTask：非法 verdict 先纠偏，仍非法则按 fail 收束', async () => {
  const { root, home } = makeFixture('verdict');
  const calls = [];
  writeFileSync(join(home, 'keep.txt'), 'x');
  delete process.env.STUB_VERDICT;
  process.env.STUB_TURNS = 'skip;skip';
  process.env.STUB_MSGS_OUT = join(root, 'msgs.txt');
  const out = await runErrandTask(TASK, makeConfig(root, home), fakeLark(calls), {});
  assert.equal(out.verdict, 'fail', 'skip 不得成为办事的终态');
  const injected = readFileSync(process.env.STUB_MSGS_OUT, 'utf8');
  assert.ok(injected.includes('办事契约'), `第一次非法 verdict 应收到纠偏：${injected}`);
  const dm = dmTexts(calls);
  assert.ok(dm.includes('办事未完成'), '收束必须有私信，不能只换个表情');
  assert.ok(dm.includes('verdict=skip'), '回执应指明卡在哪');
  assert.ok(existsSync(join(home, 'keep.txt')), '办事目录被清了');
  delete process.env.STUB_TURNS; delete process.env.STUB_MSGS_OUT;
  rmFixture(root);
});

test('runErrandTask：纠偏后给出合法 verdict 即照常收束', async () => {
  const { root, home } = makeFixture('verdict-ok');
  const calls = [];
  delete process.env.STUB_VERDICT;
  process.env.STUB_TURNS = 'skip;pass';
  const out = await runErrandTask(TASK, makeConfig(root, home), fakeLark(calls), {});
  assert.equal(out.verdict, 'pass');
  assert.ok(dmTexts(calls).includes('办事完成'));
  delete process.env.STUB_TURNS;
  rmFixture(root);
});

test('runErrandTask：ask 挂起——登记带 errand 标记，提问私信报目录不报分支', async () => {
  const { root, home } = makeFixture('ask');
  const calls = [];
  const asks = [];
  delete process.env.STUB_VERDICT;
  process.env.STUB_TURNS = 'ask:要连子目录一起算吗';
  // 不 await：killSession 后走 suspendClose，这个 promise 预期不 resolve
  runErrandTask(TASK, makeConfig(root, home), fakeLark(calls), { onAsk: (i) => asks.push(i) });
  const until = Date.now() + 20_000;
  while (asks.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  assert.equal(asks.length, 1, 'ask 未挂起');
  assert.equal(asks[0].errand, true, 'onAsk 载荷必须带 errand 标记');
  assert.equal(asks[0].preserveWorktree, true, '办事条目必须带免清场保护');
  assert.equal(asks[0].worktree, home);
  const dm = dmTexts(calls);
  assert.ok(dm.includes('要连子目录一起算吗'));
  assert.ok(dm.includes(home));
  assert.ok(!/分支/.test(dm), `办事提问不得报分支：${dm}`);
  assert.equal(killSession(TASK.messageId), true);
  delete process.env.STUB_TURNS;
  rmFixture(root);
});

// 提问一旦可见，回复随时可能到达，而 onAsk 是这条回复能路由回来的唯一凭据。换表情若夹在
// 「问题已发出」和「登记落盘」之间，它失败时要等两次 30s 超时——窗口里到达的回复找不到
// awaiting 条目，会被判成「当前没有等待回复的任务」并记 processed，就此永久丢失。
test('goWaiting：换表情排在发问之前，问题发出时登记随即落盘', async () => {
  const { root, home } = makeFixture('race');
  const order = [];
  const asks = [];
  const lark = {
    async addReaction(mid, key) { order.push(`add:${key}`); return `rid_${order.length}`; },
    async deleteReaction() { order.push('del'); return true; },
    async sendDm() { order.push('dm'); return 'om_q1'; },
  };
  delete process.env.STUB_VERDICT;
  process.env.STUB_TURNS = 'ask:要连子目录一起算吗';
  runErrandTask(TASK, makeConfig(root, home), lark, { onAsk: (i) => { order.push('ask'); asks.push(i); } });
  const until = Date.now() + 20_000;
  while (asks.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  assert.equal(asks.length, 1, '一轮 ask 只登记一次');
  assert.equal(asks[0].questionMsgId, 'om_q1', '登记必须带提问消息 id，引用回复才路由得回来');
  assert.ok(asks[0].statusRid, '登记必须带换来的 statusRid，否则 /stop 撤不掉 ⚠️');
  // 表情往返（add+del）整体排在发问之前，登记紧跟发问，中间不夹任何外部调用
  assert.deepEqual(order, ['add:THUMBSUP', 'add:WARN', 'del', 'dm', 'ask']);
  killSession(TASK.messageId);
  delete process.env.STUB_TURNS;
  rmFixture(root);
});

// 停止是终态。goWaiting 卡在换表情那次往返里时被 /stop 收拾掉，迟到的那半程必须整个作废：
// 继续发问会让人在停止回执之后又收到一条提问，继续 onAsk 会把刚删掉的条目以「等回复」复活。
test('goWaiting：换表情期间被 /stop 收掉，迟到的发问与登记整体作废', async () => {
  const { root, home } = makeFixture('stop-race');
  const calls = [];
  const asks = [];
  let releaseReaction;
  const gate = new Promise((r) => { releaseReaction = r; });
  let entered;
  const entering = new Promise((r) => { entered = r; });
  let adds = 0;
  let warnRid = '';
  const lark = {
    async addReaction(mid, key) {
      const n = ++adds; // 序号在调用时定下：挂起期间别的调用会继续推进计数
      calls.push(['add', mid, key]);
      if (key === 'WARN') { warnRid = `rid_${n}`; entered(); await gate; } // 卡在换成 ⚠️ 的那一次
      return `rid_${n}`;
    },
    async deleteReaction(mid, rid) { calls.push(['del', mid, rid]); return true; },
    async sendDm(openId, text) { calls.push(['dm', openId, text]); return 'om_q1'; },
  };
  delete process.env.STUB_VERDICT;
  process.env.STUB_TURNS = 'ask:要连子目录一起算吗';
  runErrandTask(TASK, makeConfig(root, home), lark, { onAsk: (i) => asks.push(i) });
  await entering;
  // 停止会等在途的等待态转换退出（终态回执要排在迟到的提问后面），故先发起、放行门闩，再收结果
  const stopping = stopLive(TASK.messageId, 'stop');
  await new Promise((r) => setTimeout(r, 100));
  releaseReaction();
  assert.equal(await stopping, 'waiting', '停止应作用在挂起中的办事上');
  // 给迟到的那半程足够时间跑完（要真出问题，它会在这段时间里发问并登记）
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(asks, [], '已停止的办事不得再登记等待条目');
  const dm = dmTexts(calls);
  assert.ok(dm.includes('办事已停止'), '应收到停止回执');
  assert.ok(!dm.includes('需要你拍板'), `停止之后不该再收到提问：${dm}`);
  // 迟到的 ⚠️ 要撤掉：终态表情已由 settle 打好，留着就是一条消息上两枚状态表情
  assert.ok(warnRid && calls.some((c) => c[0] === 'del' && c[2] === warnRid),
    `迟到的 ⚠️（${warnRid}）未撤：${JSON.stringify(calls)}`);
  delete process.env.STUB_TURNS;
  rmFixture(root);
});

// 提问已经发出去就收不回来了，但顺序还能管：停止回执必须排在它后面，否则人读到的是
// 「已停止」之后又被问一句——而那个问题没有登记、回也回不上去。
test('goWaiting：提问在途时被 /stop，停止回执排在那条提问之后', async () => {
  const { root, home } = makeFixture('stop-order');
  const calls = [];
  const asks = [];
  let releaseDm;
  const gate = new Promise((r) => { releaseDm = r; });
  let entered;
  const entering = new Promise((r) => { entered = r; });
  let adds = 0;
  const lark = {
    async addReaction(mid, key) { const n = ++adds; calls.push(['add', key]); return `rid_${n}`; },
    async deleteReaction(mid, rid) { calls.push(['del', rid]); return true; },
    async sendDm(openId, text) {
      if (text.includes('需要你拍板')) { entered(); await gate; } // 只卡提问那一条
      calls.push(['dm', text]);
      return 'om_dm';
    },
  };
  delete process.env.STUB_VERDICT;
  process.env.STUB_TURNS = 'ask:要连子目录一起算吗';
  runErrandTask(TASK, makeConfig(root, home), lark, { onAsk: (i) => asks.push(i) });
  await entering;
  const stopping = stopLive(TASK.messageId, 'stop'); // 不 await：它要等在途的等待态转换退出
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(calls.filter((c) => c[0] === 'dm').length, 0, '提问还卡着，停止回执不该抢在前面');
  releaseDm();
  assert.equal(await stopping, 'waiting');
  const dms = calls.filter((c) => c[0] === 'dm').map((c) => c[1]);
  assert.equal(dms.length, 2, `应恰好两条私信：${JSON.stringify(dms)}`);
  assert.ok(dms[0].includes('需要你拍板'), `第一条该是提问：${dms[0]}`);
  assert.ok(dms[1].includes('办事已停止'), `第二条该是停止回执：${dms[1]}`);
  assert.deepEqual(asks, [], '已停止的办事不得再登记等待条目');
  delete process.env.STUB_TURNS;
  rmFixture(root);
});

// 办事的产物只有那句结论：任务失手了还有 worktree 与 MR 可事后翻，它没有。
test('runErrandTask：结论私信送不出去时重试三次，最后把原文写进日志', async () => {
  const { root, home } = makeFixture('undelivered');
  let dmCalls = 0;
  const lark = {
    async addReaction() { return 'rid_x'; },
    async deleteReaction() { return true; },
    async sendDm() { dmCalls++; return null; }, // lark.mjs 的失败约定：两次都失败即回 null
  };
  delete process.env.STUB_VERDICT;
  process.env.STUB_TURNS = 'pass:清掉 3.2G 缓存';
  const errs = [];
  const origError = console.error;
  console.error = (...a) => errs.push(a.map(String).join(' '));
  try {
    const out = await runErrandTask(TASK, makeConfig(root, home), lark, {});
    assert.equal(out.verdict, 'pass');
  } finally {
    console.error = origError;
  }
  assert.equal(dmCalls, 3, '结论是交付物，不该只发一次就算了');
  assert.ok(errs.some((e) => e.includes('投递失败') && e.includes('清掉 3.2G 缓存')),
    `结论没有落到日志里：${errs.join(' | ')}`);
  delete process.env.STUB_TURNS;
  rmFixture(root);
});

// 懒续跑起会话前隔着一次表情往返，/stop 在这期间会按「无进程的残留态」把它处置掉并回执 🛑。
// 此刻再 spawn 就是「已停止」之后凭空多出一个跑着的会话，它不在任何在册视图里，也再停不掉。
test('resumeTask：起会话前被叫停即不 spawn，盖上去的 👍 撤掉', async () => {
  const { root, home } = makeFixture('resume-stop');
  const calls = [];
  const info = {
    messageId: 'om_errand_222222', worktree: home, branch: '', sessionId: 'sess_stub_1',
    title: '看下磁盘', errand: true, kind: 'user', statusRid: 'rid_old', preserveWorktree: true,
  };
  const out = await resumeTask(info, '继续', makeConfig(root, home), fakeLark(calls), { stillWanted: () => false });
  assert.equal(out.verdict, 'stopped');
  assert.ok(!existsSync(join(root, 'logs', `task-${info.messageId}.log`)), '被叫停后不得起会话');
  const dels = calls.filter((c) => c[0] === 'del').map((c) => c[2]);
  assert.ok(dels.includes('rid_1'), `盖在 🛑 上的 👍 未撤：${JSON.stringify(calls)}`);
  rmFixture(root);
});

// 懒续跑（bot 重启后回复）必须按 errand 标记选续跑框：任务那份写的是 harness 无人值守契约，
// 对办事会话是一段它读不懂也不该照做的指令。
test('runErrandTask：ask 后懒续跑用办事口径的续跑框', async () => {
  const { root, home } = makeFixture('resume');
  const asks = [];
  delete process.env.STUB_VERDICT;
  process.env.STUB_TURNS = 'ask:要连子目录一起算吗';
  runErrandTask(TASK, makeConfig(root, home), fakeLark([]), { onAsk: (i) => asks.push(i) });
  const until = Date.now() + 20_000;
  while (asks.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  assert.equal(asks.length, 1, 'ask 未挂起');
  assert.equal(killSession(TASK.messageId), true);
  delete process.env.STUB_TURNS;
  process.env.STUB_VERDICT = 'pass';
  process.env.STUB_MSGS_OUT = join(root, 'msgs.txt');
  const out = await resumeTask(asks[0], '算上子目录', makeConfig(root, home), fakeLark([]));
  assert.equal(out.verdict, 'pass');
  const injected = readFileSync(process.env.STUB_MSGS_OUT, 'utf8');
  assert.ok(injected.includes('算上子目录'), '回复正文应原样注入');
  assert.ok(!injected.includes('cr/round-N'), `办事续跑框不得夹带 harness 契约：${injected}`);
  assert.ok(!injected.includes('无人值守契约'), `办事续跑框不得夹带 harness 契约：${injected}`);
  delete process.env.STUB_VERDICT; delete process.env.STUB_MSGS_OUT;
  rmFixture(root);
});
