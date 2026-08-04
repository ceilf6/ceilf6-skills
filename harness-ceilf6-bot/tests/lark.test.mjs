import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeLark } from '../src/lark.mjs';

const STUB = resolve(import.meta.dirname, 'stubs/lark-cli');
function setup(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'thb-lark-'));
  const log = join(dir, 'calls.log');
  process.env.STUB_LOG = log;
  delete process.env.STUB_FAIL_FIRST;
  Object.assign(process.env, env);
  const lark = makeLark({ larkBin: STUB, profile: 'taskhall' });
  return { dir, log, lark };
}

test('addReaction 返回 reaction_id 且带 profile', async () => {
  const { dir, log, lark } = setup();
  const rid = await lark.addReaction('om_1', 'THUMBSUP');
  assert.equal(rid, 'rid_123');
  const calls = readFileSync(log, 'utf8');
  assert.ok(calls.includes('om_1'));
  assert.ok(calls.includes('--profile taskhall'));
  rmSync(dir, { recursive: true, force: true });
});
test('deleteReaction 走 DELETE 且返回 true', async () => {
  const { dir, log, lark } = setup();
  assert.equal(await lark.deleteReaction('om_1', 'rid_123'), true);
  assert.ok(readFileSync(log, 'utf8').includes('rid_123'));
  rmSync(dir, { recursive: true, force: true });
});
test('replyInThread 与 sendDm：sendDm 返回 message_id', async () => {
  const { dir, log, lark } = setup();
  assert.equal(await lark.replyInThread('om_1', '回帖文本'), true);
  assert.equal(await lark.sendDm('ou_me', '私信文本'), 'om_send_2'); // 本用例第 2 次调用
  const calls = readFileSync(log, 'utf8');
  assert.ok(calls.includes('messages-reply'));
  assert.ok(calls.includes('messages-send'));
  // --content 必须是 JSON：裸文本会被 lark-cli 以 invalid_argument 拒掉，而 lark.mjs 吞错不抛，
  // 表现是「回帖/私信静默不发」。钉住序列化形态，别让它被改回裸 text。
  assert.ok(calls.includes('{"text":"回帖文本"}'));
  assert.ok(calls.includes('{"text":"私信文本"}'));
  rmSync(dir, { recursive: true, force: true });
});
test('首次失败自动重试一次后成功', async () => {
  const { dir, log, lark } = setup({ STUB_FAIL_FIRST: '1' });
  const rid = await lark.addReaction('om_1', 'THUMBSUP');
  assert.equal(rid, 'rid_123');
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 2);
  rmSync(dir, { recursive: true, force: true });
});
