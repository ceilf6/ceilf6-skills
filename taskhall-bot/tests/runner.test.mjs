import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runTask, killActiveChildren } from '../src/runner.mjs';

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
    reactions: { claimed: 'THUMBSUP', done: 'DONE', failed: 'CROSS', escalate: 'WARN' }, ...over,
  };
}
function fakeLark(calls) {
  return {
    async addReaction(mid, key) { calls.push(['add', mid, key]); return 'rid_1'; },
    async deleteReaction(mid, rid) { calls.push(['del', mid, rid]); return true; },
    async replyInThread(mid, text) { calls.push(['reply', mid, text]); return true; },
    async sendDm(openId, text) { calls.push(['dm', openId, text]); return true; },
  };
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
  const out = await runTask(TASK, makeConfig(root, repo), fakeLark(calls));
  assert.equal(out.verdict, 'pass');
  assert.ok(existsSync(out.worktree));
  assert.ok(out.branch.startsWith('bot/'));
  assert.ok(out.branch.endsWith('654321'));
  assert.ok(readFileSync(process.env.STUB_PROMPT_OUT, 'utf8').includes('修一个真实任务 $&原样'));
  assert.ok(readFileSync(out.logPath, 'utf8').includes('RESULT'));
  assert.deepEqual(calls.map((c) => c[0]), ['add', 'add', 'dm']); // claimed → done → 私信
  assert.equal(calls[1][2], 'DONE'); // 钉住 done 键，防 done/failed 互换后仍然全绿
  assert.ok(calls[2][2].includes('https://mr/9'));
  rmFixture(root);
});

test('skip：worktree 与分支删除、claimed reaction 撤销、零消息', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  process.env.STUB_VERDICT = 'skip';
  delete process.env.STUB_PROMPT_OUT;
  const out = await runTask(TASK, makeConfig(root, repo), fakeLark(calls));
  assert.equal(out.verdict, 'skip');
  assert.equal(existsSync(out.worktree), false);
  const branches = execFileSync('git', ['-C', repo, 'branch', '--list', out.branch]).toString().trim();
  assert.equal(branches, '');
  assert.deepEqual(calls.map((c) => c[0]), ['add', 'del']);
  rmFixture(root);
});

test('escalate：现场保留、⚠️、回帖+私信同文含恢复命令', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  process.env.STUB_VERDICT = 'escalate';
  const out = await runTask(TASK, makeConfig(root, repo), fakeLark(calls));
  assert.equal(out.verdict, 'escalate');
  assert.ok(existsSync(out.worktree));
  const kinds = calls.map((c) => c[0]);
  assert.deepEqual(kinds, ['add', 'add', 'reply', 'dm']); // claimed → ⚠️ → 回帖 → 私信
  const reply = calls[2][2];
  assert.ok(reply.includes('该任务需要人工规划'));
  assert.ok(reply.includes(`cd ${out.worktree} && claude`));
  assert.equal(reply, calls[3][2]); // 双通道同文
  rmFixture(root);
});

test('无 RESULT 行按 fail：❌ + 私信简报含日志路径', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  process.env.STUB_VERDICT = 'garbage';
  const out = await runTask(TASK, makeConfig(root, repo), fakeLark(calls));
  assert.equal(out.verdict, 'fail');
  assert.ok(existsSync(out.worktree)); // 保留供排查
  assert.deepEqual(calls.map((c) => c[0]), ['add', 'add', 'dm']);
  assert.equal(calls[1][2], 'CROSS'); // 钉住 failed 键
  assert.ok(calls[2][2].includes(out.logPath));
  rmFixture(root);
});

test('超时强杀按 fail 且私信标注超时', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  process.env.STUB_VERDICT = 'hang';
  const out = await runTask(TASK, makeConfig(root, repo, { taskTimeoutMs: 1000 }), fakeLark(calls));
  assert.equal(out.verdict, 'fail');
  assert.ok(calls.find((c) => c[0] === 'dm')[2].includes('超时'));
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
  assert.deepEqual(calls.map((c) => c[0]), ['add', 'add', 'dm']);
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
  assert.deepEqual(calls.map((c) => c[0]), ['add', 'add', 'dm']); // ❌ 路径；测试自然跑完即进程存活
  rmFixture(root);
});
