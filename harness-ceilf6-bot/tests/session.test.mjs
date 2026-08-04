import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, realpathSync } from 'node:fs';
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
