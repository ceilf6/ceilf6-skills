import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startSession, killActiveChildren } from '../src/session.mjs';

const CLAUDE_STUB = resolve(import.meta.dirname, 'stubs/claude');
const rmFixture = (root) => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
function collect() { const evs = []; return { evs, onEvent: (e) => evs.push(e) }; }
async function poll(fn, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
}
function setup(over = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-sess-')));
  const { evs, onEvent } = collect();
  return { root, evs, opts: { bin: CLAUDE_STUB, cwd: root, name: '会话名', logPath: join(root, 's.log'), timeoutMs: 60_000, killGraceMs: 500, onEvent, ...over } };
}

test('多轮：两次 send 各得一个 turn 事件，init 带出 sessionId，消息记录在案', async () => {
  const { root, evs, opts } = setup();
  process.env.STUB_TURNS = 'ask:问题一;pass';
  process.env.STUB_MSGS_OUT = join(root, 'msgs.txt');
  process.env.STUB_ARGS_OUT = join(root, 'args.txt');
  const h = startSession(opts);
  h.send('第一条');
  await poll(() => evs.some((e) => e.kind === 'turn'));
  h.send('第二条');
  await poll(() => evs.filter((e) => e.kind === 'turn').length === 2);
  h.endInput();
  await poll(() => evs.some((e) => e.kind === 'close'));
  const turns = evs.filter((e) => e.kind === 'turn');
  assert.equal(turns.length, 2);
  assert.ok(turns[0].text.includes('"verdict":"ask"'));
  assert.equal(turns[0].isError, false);
  assert.equal(turns[0].sessionId, 'sess_stub_1');
  assert.ok(turns[1].text.includes('"verdict":"pass"'));
  assert.equal(h.alive, false);
  const args = readFileSync(join(root, 'args.txt'), 'utf8').split('\n');
  assert.ok(args.includes('--input-format') && args.includes('stream-json'));
  assert.equal(args[args.indexOf('--name') + 1], '会话名');
  assert.equal(readFileSync(join(root, 'msgs.txt'), 'utf8').trim().split('\n').length, 2);
  delete process.env.STUB_MSGS_OUT; delete process.env.STUB_ARGS_OUT; delete process.env.STUB_TURNS;
  rmFixture(root);
});

test('error 指令：turn 事件 isError=true 且带错误文本', async () => {
  const { root, evs, opts } = setup();
  process.env.STUB_TURNS = 'error:usage limit reached';
  const h = startSession(opts);
  h.send('x');
  await poll(() => evs.some((e) => e.kind === 'turn'));
  assert.equal(evs.find((e) => e.kind === 'turn').isError, true);
  assert.ok(evs.find((e) => e.kind === 'turn').text.includes('usage limit'));
  h.kill();
  await poll(() => evs.some((e) => e.kind === 'close'));
  delete process.env.STUB_TURNS;
  rmFixture(root);
});

test('每轮超时：hang 轮触发 timeout 事件并收割进程组；等待期（不 send）不计时', async () => {
  const { root, evs, opts } = setup({ timeoutMs: 800 });
  process.env.STUB_TURNS = 'ask:q;hang';
  const h = startSession(opts);
  h.send('第一轮');
  await poll(() => evs.some((e) => e.kind === 'turn'));
  await new Promise((r) => setTimeout(r, 1200)); // 挂起超过 timeoutMs：不得出现 timeout
  assert.equal(evs.some((e) => e.kind === 'timeout'), false, '等待期不计时');
  h.send('第二轮（hang）');
  await poll(() => evs.some((e) => e.kind === 'timeout'), 5000);
  assert.ok(evs.some((e) => e.kind === 'timeout'));
  await poll(() => evs.some((e) => e.kind === 'close'));
  delete process.env.STUB_TURNS;
  rmFixture(root);
});

test('resume 形态：--resume <id> 且不带 --name', async () => {
  const { root, evs, opts } = setup({ resumeSessionId: 'sess_prev_9' });
  process.env.STUB_TURNS = 'pass';
  process.env.STUB_ARGS_OUT = join(root, 'args.txt');
  const h = startSession(opts);
  h.send('续跑');
  await poll(() => evs.some((e) => e.kind === 'turn'));
  h.endInput();
  await poll(() => evs.some((e) => e.kind === 'close'));
  const args = readFileSync(join(root, 'args.txt'), 'utf8').split('\n');
  assert.equal(args[args.indexOf('--resume') + 1], 'sess_prev_9');
  assert.equal(args.includes('--name'), false);
  delete process.env.STUB_ARGS_OUT; delete process.env.STUB_TURNS;
  rmFixture(root);
});

test('extraFlags 透传进 argv', async () => {
  const { root, evs, opts } = setup({ extraFlags: ['--model', 'opus'] });
  process.env.STUB_TURNS = 'pass';
  process.env.STUB_ARGS_OUT = join(root, 'args.txt');
  const h = startSession(opts);
  h.send('x');
  await poll(() => evs.some((e) => e.kind === 'turn'));
  h.endInput();
  await poll(() => evs.some((e) => e.kind === 'close'));
  const args = readFileSync(join(root, 'args.txt'), 'utf8').split('\n');
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  delete process.env.STUB_ARGS_OUT; delete process.env.STUB_TURNS;
  rmFixture(root);
});

test('多字节字符被 chunk 边界劈开：turn 文本完整无 U+FFFD', async () => {
  const { root, evs, opts } = setup();
  process.env.STUB_TURNS = 'ask:请补充需求背景';
  process.env.STUB_SPLIT_MULTIBYTE = '1';
  const h = startSession(opts);
  h.send('x');
  await poll(() => evs.some((e) => e.kind === 'turn'));
  const turn = evs.find((e) => e.kind === 'turn');
  assert.ok(turn.text.includes('过程输出'), '劈开点的中文字符须完整还原');
  assert.ok(turn.text.includes('请补充需求背景'));
  assert.equal(turn.text.includes('�'), false, '不得出现替换字符');
  h.endInput();
  await poll(() => evs.some((e) => e.kind === 'close'));
  delete process.env.STUB_TURNS; delete process.env.STUB_SPLIT_MULTIBYTE;
  rmFixture(root);
});

test('kill 后同 tick 大块 send：stdin 异步 EPIPE 被吸收不炸进程', async () => {
  const { root, evs, opts } = setup();
  process.env.STUB_TURNS = 'hang';
  const h = startSession(opts);
  h.send('x');
  await new Promise((r) => setTimeout(r, 200));
  h.kill();
  h.send('y'.repeat(1 << 22)); // close 未派发、流未 destroy：flush 撞上已死对端 → 异步 EPIPE
  await poll(() => evs.some((e) => e.kind === 'close'));
  assert.equal(h.alive, false);
  delete process.env.STUB_TURNS;
  rmFixture(root);
});

// 只发 SIGTERM 的 kill() 会让 stop/pause 的「已停止」回执落在仍在跑的现场上：
// 群里显示已停、机器上进程还在改文件，正是控制面要消灭的形态。
test('kill 升级：忽略 SIGTERM 的进程组在宽限期后被 SIGKILL 收割', async () => {
  const { root, evs, opts } = setup({ killGraceMs: 600 });
  process.env.STUB_TURNS = 'hang';
  process.env.STUB_IGNORE_SIGTERM = '1';
  const h = startSession(opts);
  // 子进程已继承环境，就地清掉：断言失败时抛出会跳过收尾，残留的开关会污染后续用例。
  delete process.env.STUB_TURNS; delete process.env.STUB_IGNORE_SIGTERM;
  h.send('x');
  await new Promise((r) => setTimeout(r, 300));
  h.kill();
  await new Promise((r) => setTimeout(r, 250)); // 宽限期内：SIGTERM 被忽略，进程照活
  assert.equal(evs.some((e) => e.kind === 'close'), false, 'SIGTERM 被忽略时不该已退出');
  assert.ok(await poll(() => evs.some((e) => e.kind === 'close'), 5000), '宽限期后应补 SIGKILL 收割');
  assert.equal(h.alive, false);
  rmFixture(root);
});

// 组长（claude 本体）按默认行为收到 SIGTERM 即退，而组里捕获 SIGTERM 且把 stdio 重定向到文件的
// 成员不随之消失。这类成员不占着会话管道，close 因此毫秒级到达——补刀若跟着 close 一起撤销，
// 它就永久存活，「已停止」的回执落在仍在改文件的现场上。
test('kill 升级：组长先退时补刀仍落地，捕获 SIGTERM 的组员不逃逸', async () => {
  const { root, evs, opts } = setup({ killGraceMs: 500 });
  const beat = join(root, 'beat.txt');
  process.env.STUB_TURNS = 'hang';
  process.env.STUB_GRANDCHILD = beat;
  const h = startSession(opts);
  // 子进程已继承环境，就地清掉：断言失败时抛出会跳过收尾，残留的开关会污染后续用例。
  delete process.env.STUB_TURNS; delete process.env.STUB_GRANDCHILD;
  h.send('x');
  assert.ok(await poll(() => existsSync(beat) && readFileSync(beat, 'utf8').length >= 2), '组员应先跑起来');
  h.kill();
  assert.ok(await poll(() => evs.some((e) => e.kind === 'close')), '组长应按默认行为响应 SIGTERM 退出');
  const atClose = readFileSync(beat, 'utf8').length;
  const gcPid = Number(readFileSync(`${beat}.pid`, 'utf8'));
  const gone = await poll(() => { try { process.kill(gcPid, 0); return false; } catch { return true; } }, 2500);
  const grew = readFileSync(beat, 'utf8').length - atClose;
  if (!gone) { try { process.kill(gcPid, 'SIGKILL'); } catch { /* 已消失 */ } }
  assert.ok(gone, `组长退出后组员应被补刀收割（close 后又跳了 ${grew} 次心跳）`);
  assert.ok(grew <= 1, `补刀应在 close 当刻发出，心跳不该继续（多跳了 ${grew} 次）`);
  rmFixture(root);
});

// 收割意图只对活着的句柄有效：pause 在置 stopping 与 kill() 之间要等飞书往返（最坏数十秒），
// 期间进程可能自死，而那时 pgid 可能已被复用。
test('句柄已死：kill() 不再对 pgid 发信号', async () => {
  const { root, evs, opts } = setup({ killGraceMs: 100 });
  const beat = join(root, 'beat.txt');
  process.env.STUB_TURNS = 'pass';
  process.env.STUB_GRANDCHILD = beat;
  const h = startSession(opts);
  delete process.env.STUB_TURNS; delete process.env.STUB_GRANDCHILD;
  h.send('x');
  await poll(() => evs.some((e) => e.kind === 'turn'));
  assert.ok(await poll(() => existsSync(beat) && readFileSync(beat, 'utf8').length >= 2), '组员应先跑起来');
  h.endInput();
  assert.ok(await poll(() => evs.some((e) => e.kind === 'close')), 'stdin 关闭后组长应退出');
  const atClose = readFileSync(beat, 'utf8').length;
  h.kill();
  await new Promise((r) => setTimeout(r, 900)); // 远超 killGraceMs：排上的补刀早已落地
  const grew = readFileSync(beat, 'utf8').length - atClose;
  const gcPid = Number(readFileSync(`${beat}.pid`, 'utf8'));
  try { process.kill(gcPid, 'SIGKILL'); } catch { /* 已消失 */ }
  assert.ok(grew >= 3, `已死句柄的 kill() 不该打到 pgid 上的进程（心跳只多跳了 ${grew} 次）`);
  rmFixture(root);
});

test('killActiveChildren 收割存活会话', async () => {
  const { root, evs, opts } = setup();
  process.env.STUB_TURNS = 'hang';
  const h = startSession(opts);
  h.send('x');
  await new Promise((r) => setTimeout(r, 200));
  killActiveChildren();
  await poll(() => evs.some((e) => e.kind === 'close'));
  assert.equal(h.alive, false);
  delete process.env.STUB_TURNS;
  rmFixture(root);
});
