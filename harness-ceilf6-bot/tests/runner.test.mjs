import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runTask, resumeTask, killActiveChildren, injectReply, killSession } from '../src/runner.mjs';

const CLAUDE_STUB = resolve(import.meta.dirname, 'stubs/claude');

function makeFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-run-')));
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'master', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return { root, repo };
}
function makeConfig(root, repo, over = {}) {
  return {
    repoPath: repo, worktreesDir: join(root, 'wt'), logsDir: join(root, 'logs'),
    taskTimeoutMs: 60_000, killGraceMs: 500, claudeBin: CLAUDE_STUB, dmOpenId: 'ou_me',
    reactions: { claimed: 'THUMBSUP', done: 'DONE', failed: 'CROSS', escalate: 'WARN', skipped: 'GET' }, ...over,
  };
}
function fakeLark(calls) {
  let n = 0;
  let m = 0;
  return {
    // 每次 add 回不同 rid：撤销的必须是接单那一枚，若都回同一个 rid，「撤错表情」的回归无从暴露。
    async addReaction(mid, key) { calls.push(['add', mid, key]); return `rid_${++n}`; },
    async deleteReaction(mid, rid) { calls.push(['del', mid, rid]); return true; },
    async replyInThread(mid, text) { calls.push(['reply', mid, text]); return true; },
    async sendDm(openId, text) { calls.push(['dm', openId, text]); return `om_dm_${++m}`; },
  };
}
async function poll(fn, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
}
// 文本带 `$&`：锁定 renderPrompt 不吃 String.replaceAll 的 `$` 替换模式（真实任务文本常含代码/正则）。
const TASK = { messageId: 'om_x_654321', senderOpenId: 'ou_a', text: '修一个真实任务 $&原样', receivedAt: '2026-07-29T10:00:00Z' };
// 本机 AI-IDE 守护进程会异步往新 git 仓库写 .git/ai/，清理撞上时 rmSync 抛 ENOTEMPTY；退避重试（机器怪癖，非缺陷）。
const rmFixture = (root) => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });

test('pass：worktree 保留、✅、私信含 MR 链接、prompt 含任务原文', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  process.env.STUB_VERDICT = 'pass';
  process.env.STUB_PROMPT_OUT = join(root, 'prompt.txt');
  process.env.STUB_ARGS_OUT = join(root, 'args.txt');
  const out = await runTask(TASK, makeConfig(root, repo), fakeLark(calls));
  assert.equal(out.verdict, 'pass');
  assert.ok(existsSync(out.worktree));
  assert.ok(out.branch.startsWith('bot/'));
  assert.ok(out.branch.endsWith('654321'));
  assert.ok(readFileSync(process.env.STUB_PROMPT_OUT, 'utf8').includes('修一个真实任务 $&原样'));
  const args = readFileSync(process.env.STUB_ARGS_OUT, 'utf8').split('\n');
  const ni = args.indexOf('--name');
  assert.ok(ni > -1, '--name 参数缺失');
  assert.equal(args[ni + 1], '修一个真实任务 $&原样'); // 首行 12 code points，不截断
  assert.ok(readFileSync(out.logPath, 'utf8').includes('RESULT'));
  assert.deepEqual(calls.map((c) => c[0]), ['add', 'add', 'del', 'dm']); // claimed → done → 撤 claimed → 私信
  assert.equal(calls[0][2], 'THUMBSUP');
  assert.equal(calls[1][2], 'DONE'); // 钉住 done 键，防 done/failed 互换后仍然全绿
  assert.equal(calls[2][2], 'rid_1'); // 撤的是接单那一枚，不是刚打上的终态
  assert.ok(calls[3][2].includes('https://mr/9'));
  delete process.env.STUB_ARGS_OUT;
  rmFixture(root);
});

test('skip：worktree 与分支删除（注册表已 prune）、留下 skipped 终态表情、零消息', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  process.env.STUB_VERDICT = 'skip';
  delete process.env.STUB_PROMPT_OUT;
  const out = await runTask(TASK, makeConfig(root, repo), fakeLark(calls));
  assert.equal(out.verdict, 'skip');
  assert.equal(existsSync(out.worktree), false);
  const wtList = execFileSync('git', ['-C', repo, 'worktree', 'list']).toString();
  assert.ok(!wtList.includes(out.worktree), `注册表应已 prune 掉该 worktree，实际：${wtList}`);
  const branches = execFileSync('git', ['-C', repo, 'branch', '--list', out.branch]).toString().trim();
  assert.equal(branches, '');
  // 状态表情恒为一个：skip 也要留终态表情（旧行为撤掉 claimed 后是零表情 = 群里看不出 bot 处理过）
  assert.deepEqual(calls.map((c) => c[0]), ['add', 'add', 'del']);
  assert.equal(calls[1][2], 'GET');
  assert.equal(calls[2][2], 'rid_1');
  rmFixture(root);
});

test('escalate（旧会话兼容）：映射为挂起等回复——私信带真实原因与接管命令，回复后续跑', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  const asks = [];
  delete process.env.STUB_VERDICT;
  process.env.STUB_TURNS = 'escalate;pass';
  const p = runTask(TASK, makeConfig(root, repo), fakeLark(calls), { onAsk: (i) => asks.push(i) });
  await poll(() => asks.length === 1);
  assert.ok(existsSync(asks[0].worktree));
  assert.ok(asks[0].question.includes('需求不明确')); // RESULT 的 reason 原文转达，不得丢成固定文案
  assert.ok(asks[0].question.includes(`cd ${asks[0].worktree} && claude`)); // 手工接管逃生口保留
  const dmQ = calls.find((c) => c[0] === 'dm')[2];
  assert.ok(dmQ.includes('需求不明确'));
  assert.ok(!dmQ.includes('该任务需要人工规划')); // 旧固定文案吞原因，用户无从作答
  const rx = calls.filter((c) => c[0] !== 'dm');
  assert.deepEqual(rx.slice(0, 3).map((c) => [c[0], c[2]]), [['add', 'THUMBSUP'], ['add', 'WARN'], ['del', 'rid_1']]); // 挂起态 ⚠️，非终态
  assert.equal(await injectReply(TASK.messageId, '按 A 方案继续'), true);
  assert.equal((await p).verdict, 'pass');
  delete process.env.STUB_TURNS;
  rmFixture(root);
});

test('fused（旧会话兼容）：同样映射为挂起等回复，⚠️ 而非 ❌ 终态', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  const asks = [];
  process.env.STUB_TURNS = 'fused;pass';
  const p = runTask(TASK, makeConfig(root, repo), fakeLark(calls), { onAsk: (i) => asks.push(i) });
  await poll(() => asks.length === 1);
  assert.ok(asks[0].question.includes('CR 熔断')); // reason 原文转达
  const rx = calls.filter((c) => c[0] !== 'dm');
  assert.equal(rx[1][2], 'WARN'); // 挂起态表情：熔断裁决权交回用户，不直接 ❌
  assert.equal(await injectReply(TASK.messageId, '放宽该项，继续'), true);
  assert.equal((await p).verdict, 'pass');
  delete process.env.STUB_TURNS;
  rmFixture(root);
});

test('无 RESULT 行：纠偏一次仍无 → fail，纠偏消息已注入会话', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  process.env.STUB_VERDICT = 'garbage';
  process.env.STUB_MSGS_OUT = join(root, 'msgs.txt');
  const out = await runTask(TASK, makeConfig(root, repo), fakeLark(calls));
  assert.equal(out.verdict, 'fail');
  assert.ok(existsSync(out.worktree)); // 保留供排查
  assert.deepEqual(calls.map((c) => c[0]), ['add', 'add', 'del', 'dm']);
  assert.equal(calls[1][2], 'CROSS');
  assert.ok(calls[3][2].includes(out.logPath));
  const msgs = readFileSync(join(root, 'msgs.txt'), 'utf8').trim().split('\n');
  assert.equal(msgs.length, 2); // bootstrap + 纠偏
  assert.ok(msgs[1].includes('RESULT'));
  delete process.env.STUB_MSGS_OUT;
  rmFixture(root);
});

test('超时强杀按 fail 且私信标注超时', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  process.env.STUB_VERDICT = 'hang';
  const out = await runTask(TASK, makeConfig(root, repo, { taskTimeoutMs: 1000 }), fakeLark(calls));
  assert.equal(out.verdict, 'fail');
  assert.deepEqual(calls.map((c) => c[0]), ['add', 'add', 'del', 'dm']);
  assert.equal(calls[1][2], 'CROSS');
  assert.equal(calls[2][2], 'rid_1');
  assert.ok(calls.find((c) => c[0] === 'dm')[2].includes('超时'));
  rmFixture(root);
});

test('活跃轮次进程死亡（不回 RESULT）：fail、❌、私信标注进程退出、worktree 保留', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  process.env.STUB_VERDICT = 'die';
  delete process.env.STUB_PROMPT_OUT;
  const out = await runTask(TASK, makeConfig(root, repo), fakeLark(calls));
  assert.equal(out.verdict, 'fail');
  assert.ok(existsSync(out.worktree)); // 现场留给人工排查
  assert.deepEqual(calls.map((c) => c[0]), ['add', 'add', 'del', 'dm']);
  assert.equal(calls[1][2], 'CROSS');
  assert.equal(calls[2][2], 'rid_1');
  assert.ok(calls.find((c) => c[0] === 'dm')[2].includes('会话进程退出'));
  rmFixture(root);
});

test('killActiveChildren：SIGTERM 达进程组，hang 任务立即收敛为 fail', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  process.env.STUB_VERDICT = 'hang';
  delete process.env.STUB_PROMPT_OUT;
  const t0 = Date.now();
  let settled = false;
  // 超时给足 60s：任务收敛只能来自收割，不可能来自超时机制
  const p = runTask(TASK, makeConfig(root, repo, { taskTimeoutMs: 60_000 }), fakeLark(calls))
    .finally(() => { settled = true; });
  // spawn 时点在 git worktree add 之后、外部不可观测：反复收割直到收敛（空集时是无害 no-op）
  while (!settled && Date.now() - t0 < 5000) {
    killActiveChildren();
    await new Promise((r) => setTimeout(r, 100));
  }
  const out = await p;
  const elapsed = Date.now() - t0;
  assert.equal(out.verdict, 'fail');
  assert.ok(elapsed < 3000, `收割应远快于 60s 超时（实际 ${elapsed}ms）`);
  rmFixture(root);
});

test('worktree 两次都建不出来：不静默丢单，走 fail 通道且进程存活', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-run-')));
  const notARepo = join(root, 'not-a-repo');
  mkdirSync(notARepo, { recursive: true });
  const calls = [];
  process.env.STUB_VERDICT = 'pass'; // 无论 stub 想说什么，claude 根本不该被启动
  delete process.env.STUB_PROMPT_OUT;
  const out = await runTask(TASK, makeConfig(root, notARepo), fakeLark(calls));
  assert.equal(out.verdict, 'fail');
  assert.equal(out.logPath, ''); // 没跑过任务，简报不得引用不存在的日志
  assert.deepEqual(calls.map((c) => c[0]), ['add', 'dm']); // 无 claimed：失败在接单动作之前
  assert.equal(calls[0][2], 'CROSS');
  assert.ok(calls[1][2].includes(TASK.messageId)); // 简报能定位到是哪条消息
  assert.ok(calls[1][2].includes('not a git repository')); // 首次错误原文入简报
  rmFixture(root);
});

test('onWorktreeReady：worktree 就绪即回调，带 threadId/branch/worktree，且早于 claimed reaction', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  process.env.STUB_VERDICT = 'pass';
  delete process.env.STUB_PROMPT_OUT;
  const seen = [];
  const out = await runTask({ ...TASK, threadId: 'omt_topic1' }, makeConfig(root, repo), fakeLark(calls), {
    onWorktreeReady: (info) => { seen.push({ ...info, larkCallsSoFar: calls.length }); },
  });
  assert.equal(out.verdict, 'pass');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].threadId, 'omt_topic1');
  assert.equal(seen[0].branch, out.branch);
  assert.equal(seen[0].worktree, out.worktree);
  assert.equal(seen[0].messageId, TASK.messageId);
  // 登记必须早于任何飞书动作：接单 reaction 之后才登记的话，中间到达的回复会找不到归属而另起任务。
  assert.equal(seen[0].larkCallsSoFar, 0);
  rmFixture(root);
});

test('onWorktreeReady 抛错不中断任务：verdict 照常 pass', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  process.env.STUB_VERDICT = 'pass';
  delete process.env.STUB_PROMPT_OUT;
  const out = await runTask(TASK, makeConfig(root, repo), fakeLark(calls), {
    onWorktreeReady: () => { throw new Error('登记炸了'); },
  });
  assert.equal(out.verdict, 'pass');
  assert.deepEqual(calls.map((c) => c[0]), ['add', 'add', 'del', 'dm']);
  rmFixture(root);
});

test('worktree 建不出来时不回调 onWorktreeReady：没有现场可登记', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-run-')));
  const notARepo = join(root, 'not-a-repo');
  mkdirSync(notARepo, { recursive: true });
  const calls = [];
  process.env.STUB_VERDICT = 'pass';
  let called = 0;
  const out = await runTask({ ...TASK, threadId: 'omt_topic1' }, makeConfig(root, notARepo), fakeLark(calls), {
    onWorktreeReady: () => { called++; },
  });
  assert.equal(out.verdict, 'fail');
  assert.equal(called, 0);
  rmFixture(root);
});

test('claudeBin 缺失：spawn 失败不崩进程、按 fail 分发', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  const out = await runTask(TASK, makeConfig(root, repo, { claudeBin: '/nonexistent-claude-bin' }), fakeLark(calls));
  assert.equal(out.verdict, 'fail');
  assert.deepEqual(calls.map((c) => c[0]), ['add', 'add', 'del', 'dm']); // ❌ 路径；测试自然跑完即进程存活
  rmFixture(root);
});

test('会话名：任务首行按 code point 截 20，跨行不带入', async () => {
  const { root, repo } = makeFixture();
  process.env.STUB_VERDICT = 'skip';
  delete process.env.STUB_PROMPT_OUT;
  process.env.STUB_ARGS_OUT = join(root, 'args.txt');
  const longTask = { ...TASK, text: '一二三四五六七八九十一二三四五六七八九十超出部分\n第二行不应出现' };
  await runTask(longTask, makeConfig(root, repo), fakeLark([]));
  const args = readFileSync(process.env.STUB_ARGS_OUT, 'utf8').split('\n');
  assert.equal(args[args.indexOf('--name') + 1], '一二三四五六七八九十一二三四五六七八九十');
  delete process.env.STUB_ARGS_OUT;
  rmFixture(root);
});

test('ask：私信具体问题、⚠️、注入回复续跑至 pass，表情全程恒为一个', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  const asks = [];
  delete process.env.STUB_VERDICT;
  process.env.STUB_TURNS = 'ask:选 A 还是 B？;pass';
  process.env.STUB_MSGS_OUT = join(root, 'msgs.txt');
  const p = runTask(TASK, makeConfig(root, repo), fakeLark(calls), { onAsk: (i) => asks.push(i) });
  await poll(() => asks.length === 1);
  assert.equal(asks[0].question, '选 A 还是 B？');
  assert.equal(asks[0].questionMsgId, 'om_dm_1');
  assert.equal(asks[0].sessionId, 'sess_stub_1');
  assert.equal(asks[0].title, '修一个真实任务 $&原样');
  const dmQ = calls.find((c) => c[0] === 'dm')[2];
  assert.ok(dmQ.includes('选 A 还是 B？'));
  assert.ok(dmQ.includes('引用'));
  assert.equal(await injectReply('om_nope', '回复'), false); // 不认识的任务
  assert.equal(await injectReply(TASK.messageId, '选 A，注意兼容'), true);
  const out = await p;
  assert.equal(out.verdict, 'pass');
  // 表情序列：claimed → [ask] WARN+撤 claimed → [注入] claimed+撤 WARN → [pass] DONE+撤 claimed
  assert.deepEqual(calls.filter((c) => c[0] !== 'dm').map((c) => [c[0], c[2]]), [
    ['add', 'THUMBSUP'], ['add', 'WARN'], ['del', 'rid_1'],
    ['add', 'THUMBSUP'], ['del', 'rid_2'],
    ['add', 'DONE'], ['del', 'rid_3'],
  ]);
  const msgs = readFileSync(join(root, 'msgs.txt'), 'utf8').trim().split('\n');
  assert.equal(msgs.length, 2);
  assert.ok(msgs[1].includes('选 A，注意兼容'));
  assert.ok(msgs[1].includes('RESULT 行收尾')); // 回复框架带契约提醒
  delete process.env.STUB_TURNS; delete process.env.STUB_MSGS_OUT;
  rmFixture(root);
});

test('API 错误轮转挂起：is_error 不终态，回复后续跑', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  const asks = [];
  process.env.STUB_TURNS = 'error:usage limit reached;pass';
  const p = runTask(TASK, makeConfig(root, repo), fakeLark(calls), { onAsk: (i) => asks.push(i) });
  await poll(() => asks.length === 1);
  assert.ok(asks[0].question.includes('usage limit reached'));
  assert.ok(asks[0].question.includes('/model'));
  assert.equal(await injectReply(TASK.messageId, '重试'), true);
  assert.equal((await p).verdict, 'pass');
  delete process.env.STUB_TURNS;
  rmFixture(root);
});

test('ask 私信带 summary 进展：question 贫瘠时用户仍有决策依据', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  const asks = [];
  process.env.STUB_TURNS = 'ask:回复继续即可|开发已完成全绿，等 pre-commit 钩子;pass';
  const p = runTask(TASK, makeConfig(root, repo), fakeLark(calls), { onAsk: (i) => asks.push(i) });
  await poll(() => asks.length === 1);
  const dmQ = calls.find((c) => c[0] === 'dm')[2];
  assert.ok(dmQ.includes('问题：回复继续即可'));
  assert.ok(dmQ.includes('进展：开发已完成全绿，等 pre-commit 钩子')); // summary 不得丢
  assert.equal(await injectReply(TASK.messageId, '继续'), true);
  assert.equal((await p).verdict, 'pass');
  delete process.env.STUB_TURNS;
  rmFixture(root);
});

test('自唤醒：挂起中会话自发的有效 RESULT 轮被正常续上，无需用户回复', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  const asks = [];
  process.env.STUB_TURNS = 'ask:等钩子跑完，无需人工输入';
  process.env.STUB_SELF_TURN = '{"afterMs":300,"directive":"pass"}';
  const out = await runTask(TASK, makeConfig(root, repo), fakeLark(calls), { onAsk: (i) => asks.push(i) });
  assert.equal(out.verdict, 'pass'); // 自唤醒 pass 直达终态，没被当杂音吞掉
  assert.equal(asks.length, 1);
  // 表情链：claimed → ⚠️（撤 claimed）→ ✅（撤 ⚠️）——自唤醒轮不经 injectReply，无中间回切
  const rx = calls.filter((c) => c[0] !== 'dm');
  assert.deepEqual(rx.map((c) => [c[0], c[2]]), [
    ['add', 'THUMBSUP'], ['add', 'WARN'], ['del', 'rid_1'], ['add', 'DONE'], ['del', 'rid_2'],
  ]);
  delete process.env.STUB_TURNS;
  delete process.env.STUB_SELF_TURN;
  rmFixture(root);
});

test('自唤醒守卫：无有效 RESULT 的自发轮仍被忽略，等待态不动、注入照常', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  const asks = [];
  process.env.STUB_TURNS = 'ask:等指示;pass';
  process.env.STUB_SELF_TURN = '{"afterMs":250,"directive":"noresult"}';
  const p = runTask(TASK, makeConfig(root, repo), fakeLark(calls), { onAsk: (i) => asks.push(i) });
  await poll(() => asks.length === 1);
  await new Promise((r) => setTimeout(r, 600)); // 自发杂音已到达
  const raced = await Promise.race([p, new Promise((r) => setTimeout(() => r('pending'), 100))]);
  assert.equal(raced, 'pending'); // 未被纠偏或终态化
  assert.equal(await injectReply(TASK.messageId, '好，继续'), true);
  assert.equal((await p).verdict, 'pass');
  delete process.env.STUB_TURNS;
  delete process.env.STUB_SELF_TURN;
  rmFixture(root);
});

test('多轮 ask：每轮各发一条提问私信、注入后可再 ask', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  const asks = [];
  process.env.STUB_TURNS = 'ask:问一;ask:问二;pass';
  const p = runTask(TASK, makeConfig(root, repo), fakeLark(calls), { onAsk: (i) => asks.push(i) });
  await poll(() => asks.length === 1);
  await injectReply(TASK.messageId, '答一');
  await poll(() => asks.length === 2);
  assert.equal(asks[1].question, '问二');
  assert.equal(asks[1].questionMsgId, 'om_dm_2');
  await injectReply(TASK.messageId, '答二');
  assert.equal((await p).verdict, 'pass');
  // 第二轮链条逐段闭合：二次 ask 撤一次注入那枚、二次注入撤二次 ask 那枚、终态撤二次注入那枚
  assert.deepEqual(calls.filter((c) => c[0] !== 'dm').map((c) => [c[0], c[2]]), [
    ['add', 'THUMBSUP'], ['add', 'WARN'], ['del', 'rid_1'],
    ['add', 'THUMBSUP'], ['del', 'rid_2'],
    ['add', 'WARN'], ['del', 'rid_3'],
    ['add', 'THUMBSUP'], ['del', 'rid_4'],
    ['add', 'DONE'], ['del', 'rid_5'],
  ]);
  delete process.env.STUB_TURNS;
  rmFixture(root);
});

test('注入后的极速 error 轮不与注入 swap 竞争 statusRid：每枚旧表情恰被撤一次', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  const asks = [];
  process.env.STUB_TURNS = 'ask:q;error:429 秒退;pass';
  // reaction 往返慢于一轮 turn（is_error 重试环的真实时序）：注入的 swap 若后于 send 完成，
  // 下一次 goWaiting 会读到未回写的旧 rid，双删同一枚 WARN、残留双表情。
  const lark = fakeLark(calls);
  const slowLark = { ...lark, async addReaction(mid, key) { await new Promise((r) => setTimeout(r, 150)); return lark.addReaction(mid, key); } };
  const p = runTask(TASK, makeConfig(root, repo), slowLark, { onAsk: (i) => asks.push(i) });
  await poll(() => asks.length === 1);
  await injectReply(TASK.messageId, '重试');
  await poll(() => asks.length === 2);
  await injectReply(TASK.messageId, '再试');
  assert.equal((await p).verdict, 'pass');
  const dels = calls.filter((c) => c[0] === 'del').map((c) => c[2]);
  assert.deepEqual(dels, ['rid_1', 'rid_2', 'rid_3', 'rid_4', 'rid_5']);
  delete process.env.STUB_TURNS;
  rmFixture(root);
});

test('resumeTask：--resume + resumeFlags 重建会话、⚠️→👍、续跑至 pass', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  const asks = [];
  process.env.STUB_TURNS = 'ask:q1';
  const p1 = runTask(TASK, makeConfig(root, repo), fakeLark(calls), { onAsk: (i) => asks.push(i) });
  await poll(() => asks.length === 1);
  killSession(TASK.messageId);
  await Promise.race([p1, new Promise((r) => setTimeout(r, 300))]); // 等 close 落定（不 resolve）
  // 懒续跑（模拟 bot 重启后从 awaiting.jsonl 取出的条目）
  const calls2 = [];
  process.env.STUB_TURNS = 'pass';
  process.env.STUB_ARGS_OUT = join(root, 'args2.txt');
  process.env.STUB_MSGS_OUT = join(root, 'msgs2.txt');
  const info = { ...asks[0], resumeFlags: ['--model', 'opus'] };
  const out = await resumeTask(info, '用 opus 继续，选 A', makeConfig(root, repo), fakeLark(calls2), {});
  assert.equal(out.verdict, 'pass');
  const args = readFileSync(join(root, 'args2.txt'), 'utf8').split('\n');
  assert.equal(args[args.indexOf('--resume') + 1], 'sess_stub_1');
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  const msgs = readFileSync(join(root, 'msgs2.txt'), 'utf8').trim().split('\n');
  assert.equal(msgs.length, 1); // 只注入回复框架（无 bootstrap）
  assert.ok(msgs[0].includes('用 opus 继续，选 A'));
  // 表情：claimed（撤 info.statusRid=rid_2）→ pass 终态
  assert.deepEqual(calls2.filter((c) => c[0] !== 'dm').map((c) => [c[0], c[2]]), [
    ['add', 'THUMBSUP'], ['del', 'rid_2'],
    ['add', 'DONE'], ['del', 'rid_1'],
  ]);
  delete process.env.STUB_TURNS; delete process.env.STUB_ARGS_OUT; delete process.env.STUB_MSGS_OUT;
  rmFixture(root);
});

test('resumeTask：续跑中再 ask 触发 onAsk（可多轮往复）', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  const asks = [];
  process.env.STUB_TURNS = 'ask:q1';
  const p1 = runTask(TASK, makeConfig(root, repo), fakeLark(calls), { onAsk: (i) => asks.push(i) });
  await poll(() => asks.length === 1);
  killSession(TASK.messageId);
  await Promise.race([p1, new Promise((r) => setTimeout(r, 300))]);
  process.env.STUB_TURNS = 'ask:q2;pass';
  const asks2 = [];
  const p2 = resumeTask({ ...asks[0], resumeFlags: [] }, '答 q1', makeConfig(root, repo), fakeLark(calls), { onAsk: (i) => asks2.push(i) });
  await poll(() => asks2.length === 1);
  assert.equal(asks2[0].question, 'q2');
  await injectReply(TASK.messageId, '答 q2');
  assert.equal((await p2).verdict, 'pass');
  delete process.env.STUB_TURNS;
  rmFixture(root);
});

test('resumeTask：worktree 已删 → ❌ 私信、fail、不 spawn', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  const out = await resumeTask(
    { messageId: 'om_x_654321', threadId: '', branch: 'bot/gone', worktree: join(root, 'wt', 'bot__gone'), sessionId: 'sess_1', resumeFlags: [], statusRid: 'rid_old', title: '短题' },
    '回复', makeConfig(root, repo), fakeLark(calls), {});
  assert.equal(out.verdict, 'fail');
  assert.deepEqual(calls.map((c) => c[0]), ['add', 'del', 'dm']);
  assert.equal(calls[0][2], 'CROSS');
  assert.equal(calls[1][2], 'rid_old');
  assert.ok(calls[2][2].includes('worktree 已不存在'));
  rmFixture(root);
});

test('resumeTask：sessionId 缺失 → ❌ 私信、fail、不 spawn（不得退化成 --name 新会话）', async () => {
  const { root, repo } = makeFixture();
  const wt = join(root, 'wt', 'bot__nosess');
  mkdirSync(wt, { recursive: true }); // worktree 在场：拒绝理由必须是 sessionId 而非 worktree
  const calls = [];
  process.env.STUB_VERDICT = 'pass'; // 无论 stub 想说什么，claude 根本不该被启动
  process.env.STUB_ARGS_OUT = join(root, 'args-nosess.txt');
  const out = await resumeTask(
    { messageId: 'om_x_654321', threadId: '', branch: 'bot/nosess', worktree: wt, sessionId: '', resumeFlags: [], statusRid: 'rid_old', title: '短题' },
    '回复', makeConfig(root, repo), fakeLark(calls), {});
  assert.equal(out.verdict, 'fail');
  assert.equal(existsSync(join(root, 'args-nosess.txt')), false, '不得 spawn 会话进程');
  assert.deepEqual(calls.map((c) => c[0]), ['add', 'del', 'dm']);
  assert.equal(calls[0][2], 'CROSS');
  assert.equal(calls[1][2], 'rid_old');
  assert.ok(calls[2][2].includes('sessionId'));
  delete process.env.STUB_ARGS_OUT;
  rmFixture(root);
});

test('killSession：只收割挂起会话，等待态不终态；活跃轮次拒绝收割', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  const asks = [];
  process.env.STUB_TURNS = 'ask:q';
  const p = runTask(TASK, makeConfig(root, repo), fakeLark(calls), { onAsk: (i) => asks.push(i) });
  await poll(() => asks.length === 1);
  assert.equal(killSession(TASK.messageId), true);
  // 进程死后任务不 fail：promise 保持 pending（等懒续跑）
  const raced = await Promise.race([p, new Promise((r) => setTimeout(() => r('pending'), 800))]);
  assert.equal(raced, 'pending');
  assert.equal(await injectReply(TASK.messageId, '来晚了'), false); // 进程已死 → 走懒续跑
  assert.equal(killSession('om_nope'), false);
  delete process.env.STUB_TURNS;
  rmFixture(root);
});
