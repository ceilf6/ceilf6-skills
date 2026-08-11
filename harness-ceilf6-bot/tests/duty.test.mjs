import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runDutyTask, resumeTask, killSession } from '../src/runner.mjs';

const CLAUDE_STUB = resolve(import.meta.dirname, 'stubs/claude');

function makeFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-duty-')));
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'master', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', 'feat/x']);
  return { root, repo };
}
function makeConfig(root, repo) {
  return {
    repoPath: repo, worktreesDir: join(root, 'wt'), logsDir: join(root, 'logs'),
    taskTimeoutMs: 60_000, killGraceMs: 500, claudeBin: CLAUDE_STUB, dmOpenId: 'ou_me',
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
const TASK = { messageId: 'om_duty_111111', threadId: 'omt_1', senderOpenId: 'ou_me', text: '【bot】MR 9 发现新评论', receivedAt: '2026-08-11T10:00:00Z' };
const rmFixture = (root) => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });

test('runDutyTask：在既有检出起会话，不建 worktree，prompt 原样注入', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  process.env.STUB_VERDICT = 'pass';
  process.env.STUB_PROMPT_OUT = join(root, 'prompt.txt');
  const out = await runDutyTask(TASK, makeConfig(root, repo), fakeLark(calls), {}, {
    cwd: repo, branch: 'feat/x', title: 'MR 9 评论处置', firstMessage: '值班指令正文 $&原样',
  });
  assert.equal(out.verdict, 'pass');
  assert.equal(out.worktree, repo);
  assert.ok(!existsSync(join(root, 'wt')), '不得创建 worktree');
  assert.ok(readFileSync(process.env.STUB_PROMPT_OUT, 'utf8').includes('值班指令正文 $&原样'));
  delete process.env.STUB_PROMPT_OUT;
  rmFixture(root);
});

test('runDutyTask：skip 也不清场——检出与分支必须保留', async () => {
  const { root, repo } = makeFixture();
  process.env.STUB_VERDICT = 'skip';
  const out = await runDutyTask(TASK, makeConfig(root, repo), fakeLark([]), {}, {
    cwd: repo, branch: 'feat/x', title: 'MR 9 评论处置', firstMessage: 'x',
  });
  assert.equal(out.verdict, 'skip');
  assert.ok(existsSync(repo), '检出被删了');
  const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'feat/x']).toString();
  assert.ok(branches.includes('feat/x'), '需求分支被删了');
  rmFixture(root);
});

// 懒续跑链路：preserveWorktree 必须随 onAsk 登记条目持久化，bot 重启后 resumeTask 原样还原——
// 断链的后果是续跑的值班会话一个 skip 就删掉用户的检出与需求分支。
test('runDutyTask：ask 挂起 → resumeTask 续跑后 skip 仍不清场', async () => {
  const { root, repo } = makeFixture();
  const asks = [];
  delete process.env.STUB_VERDICT;
  process.env.STUB_TURNS = 'ask:MR 处置拿不准';
  const config = makeConfig(root, repo);
  runDutyTask(TASK, config, fakeLark([]), { onAsk: (i) => asks.push(i) }, {
    cwd: repo, branch: 'feat/x', title: 'MR 9 评论处置', firstMessage: 'x',
  });
  const until = Date.now() + 20_000;
  while (asks.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  assert.equal(asks.length, 1, 'ask 未挂起');
  assert.equal(asks[0].preserveWorktree, true, 'onAsk 载荷必须带 preserveWorktree');
  // 模拟 bot 重启：收割挂起进程，再按登记条目懒续跑。
  assert.equal(killSession(TASK.messageId), true);
  delete process.env.STUB_TURNS;
  process.env.STUB_VERDICT = 'skip';
  const out = await resumeTask(asks[0], '按你的判断继续', config, fakeLark([]));
  assert.equal(out.verdict, 'skip');
  assert.ok(existsSync(repo), '续跑后的 skip 删掉了用户检出');
  const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'feat/x']).toString();
  assert.ok(branches.includes('feat/x'), '续跑后的 skip 删掉了需求分支');
  rmFixture(root);
});
