import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanStranded, readLogTail } from '../src/stranded.mjs';

// 任务日志是 stream-json：每行一个事件，RESULT 行藏在 result 事件的 result 字段里。
function logLine(verdict, { sessionId = 'sess_1', ...extra } = {}) {
  const body = verdict ? `过程输出\nRESULT ${JSON.stringify({ verdict, ...extra })}` : '过程输出（没有结果行）';
  return JSON.stringify({ type: 'result', is_error: false, result: body, session_id: sessionId }) + '\n';
}
function initLine(sessionId = 'sess_1') {
  return JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\n';
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'thb-stranded-'));
  const logsDir = join(root, 'logs');
  mkdirSync(logsDir, { recursive: true });
  const wt = join(root, 'wt-a');
  mkdirSync(wt, { recursive: true });
  const thread = (id, over = {}) => ({
    threadId: `omt_${id}`, messageId: `om_${id}`, branch: `bot/${id}`, worktree: wt, ...over,
  });
  return { root, logsDir, wt, thread, rm: () => rmSync(root, { recursive: true, force: true }) };
}

test('活跃轮次中被重启：日志尾无终态 RESULT → 判滞留，带出 sessionId', () => {
  const f = fixture();
  writeFileSync(join(f.logsDir, 'task-om_a.log'), initLine('sess_live') + logLine(null, { sessionId: 'sess_live' }));
  const out = scanStranded([f.thread('a')], { logsDir: f.logsDir, isSettled: () => false, findAwaiting: () => null });
  assert.equal(out.length, 1);
  assert.equal(out[0].messageId, 'om_a');
  assert.equal(out[0].sessionId, 'sess_live');
  assert.equal(out[0].branch, 'bot/a');
  assert.equal(out[0].worktree, f.wt);
  f.rm();
});

test('终态任务不复活：pass/fail/skip 与旧契约 escalate/fused 的日志一律跳过', () => {
  const f = fixture();
  const verdicts = ['pass', 'fail', 'skip', 'escalate', 'fused'];
  for (const v of verdicts) {
    writeFileSync(join(f.logsDir, `task-om_${v}.log`), initLine() + logLine(v));
  }
  const threads = verdicts.map((v) => f.thread(v));
  assert.deepEqual(scanStranded(threads, { logsDir: f.logsDir, isSettled: () => false, findAwaiting: () => null }), []);
  f.rm();
});

// 迁移期的真盘面形态：stream-json 之前的任务日志是纯文本，RESULT 就是裸行，一个 type:"result"
// 事件都没有。只认事件的话这类日志取不到 verdict，判据就朝「复活」失手——已经建了 MR 的任务
// 会在首次启动时被捞回控制面。
test('readLogTail：没有任何 result 事件时回落到原文解析，旧格式的裸 RESULT 行照样算数', () => {
  const f = fixture();
  const p = join(f.logsDir, 'task-om_old.log');
  writeFileSync(p, 'Warning: no stdin data received in 3s\n过程输出若干\n'
    + 'RESULT {"verdict":"pass","mr_url":"https://mr/8293690"}\n');
  assert.deepEqual(readLogTail(p), { lastVerdict: 'pass', sessionId: '' });
  f.rm();
});

// 「有日志文件」担不起「有可 --resume 的历史」：空文件、只写了半行的文件同样 existsSync 为真，
// 凭它们登记出来的条目一按 /resume 只会换来一条 ❌（还撤不掉群里那枚接单表情）。
test('无会话 id 的日志不登记：空文件、只有坏行、旧格式纯文本都不算可续跑', () => {
  const f = fixture();
  const scan = (ids) => scanStranded(ids.map((id) => f.thread(id)),
    { logsDir: f.logsDir, isSettled: () => false, findAwaiting: () => null });
  writeFileSync(join(f.logsDir, 'task-om_empty.log'), '');
  writeFileSync(join(f.logsDir, 'task-om_half.log'), '{"type":"system","subty');
  writeFileSync(join(f.logsDir, 'task-om_plain.log'), '过程输出，没有会话 id，也没有结果行\n');
  assert.deepEqual(scan(['empty', 'half', 'plain']), []);
  // 对照：同样没有终态 RESULT，但日志里有会话 id → 这才是可续跑的滞留任务
  writeFileSync(join(f.logsDir, 'task-om_live.log'), initLine('sess_live'));
  assert.deepEqual(scan(['live']).map((e) => e.sessionId), ['sess_live']);
  f.rm();
});

test('中间态 RESULT（ask/working）不算终态，但已被 /stop 记账的不复活', () => {
  const f = fixture();
  writeFileSync(join(f.logsDir, 'task-om_ask.log'), initLine() + logLine('ask', { question: '选 A 还是 B' }));
  const threads = [f.thread('ask')];
  // 无 settled 记账 → 判滞留（进程已不在、又没有 awaiting 条目）
  assert.equal(scanStranded(threads, { logsDir: f.logsDir, isSettled: () => false, findAwaiting: () => null }).length, 1);
  // 已被人工 /stop（记了 settled）→ 不得复活
  assert.deepEqual(scanStranded(threads, { logsDir: f.logsDir, isSettled: (id) => id === 'om_ask', findAwaiting: () => null }), []);
  f.rm();
});

test('已有 awaiting 条目的不重复登记；worktree 或日志不在的跳过', () => {
  const f = fixture();
  writeFileSync(join(f.logsDir, 'task-om_dup.log'), initLine() + logLine(null));
  assert.deepEqual(
    scanStranded([f.thread('dup')], { logsDir: f.logsDir, isSettled: () => false, findAwaiting: (id) => (id === 'om_dup' ? { messageId: id } : null) }),
    [], 'awaiting 已有条目');
  assert.deepEqual(
    scanStranded([f.thread('nolog')], { logsDir: f.logsDir, isSettled: () => false, findAwaiting: () => null }),
    [], '没有任务日志 = 会话从没起来，无从续跑');
  writeFileSync(join(f.logsDir, 'task-om_gone.log'), initLine() + logLine(null));
  assert.deepEqual(
    scanStranded([f.thread('gone', { worktree: join(f.root, 'no-such-wt') })], { logsDir: f.logsDir, isSettled: () => false, findAwaiting: () => null }),
    [], 'worktree 已被清掉');
  f.rm();
});

test('坏行与超大日志：只读末尾也能取到最后一个 RESULT，坏行跳过不抛', () => {
  const f = fixture();
  const padding = 'x'.repeat(300_000); // 超过尾读窗口的前缀，且不是合法 JSON 行
  writeFileSync(join(f.logsDir, 'task-om_big.log'),
    `${padding}\n{坏行\n` + initLine('sess_big') + logLine(null, { sessionId: 'sess_big' }) + '{又一个坏行\n');
  const out = scanStranded([f.thread('big')], { logsDir: f.logsDir, isSettled: () => false, findAwaiting: () => null });
  assert.equal(out.length, 1);
  assert.equal(out[0].sessionId, 'sess_big');
  // 同样的超大日志，末尾是终态 → 不复活
  writeFileSync(join(f.logsDir, 'task-om_big2.log'), `${padding}\n` + initLine() + logLine('pass'));
  assert.deepEqual(scanStranded([f.thread('big2')], { logsDir: f.logsDir, isSettled: () => false, findAwaiting: () => null }), []);
  f.rm();
});
