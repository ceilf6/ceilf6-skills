import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalize } from '../src/normalize.mjs';
import { decide } from '../src/filter.mjs';
import { Store } from '../src/state.mjs';
import { parseResult } from '../src/result.mjs';

const CONFIG = { chatId: 'oc_1916a3a15e1a11855ca621d56b3027ed', minTextLength: 10 };
const RAW = {
  chat_id: 'oc_1916a3a15e1a11855ca621d56b3027ed', chat_type: 'group',
  message_id: 'om_abcdef123456', message_type: 'text',
  sender_type: 'user', sender_id: 'ou_sender1',
  content: 'fallback 打包需要走 CI 构建并以 git tag 留痕',
};

test('normalize 提取规整字段', () => {
  const ev = normalize(RAW);
  assert.equal(ev.chatId, CONFIG.chatId);
  assert.equal(ev.messageId, 'om_abcdef123456');
  assert.equal(ev.senderType, 'user');
  assert.equal(ev.messageType, 'text');
  assert.ok(ev.text.includes('git tag'));
});
test('normalize 容错：非对象与缺 message_id 返回 null', () => {
  assert.equal(normalize(null), null);
  assert.equal(normalize({ chat_id: 'x' }), null);
});

const notProcessed = () => false;
test('decide 放行合法任务', () => {
  assert.equal(decide(normalize(RAW), CONFIG, notProcessed).action, 'enqueue');
});
test('decide 拒绝：他群/bot 消息/非文本/过短/重复/null', () => {
  const ev = normalize(RAW);
  assert.equal(decide({ ...ev, chatId: 'oc_other' }, CONFIG, notProcessed).reason, 'other-chat');
  assert.equal(decide({ ...ev, senderType: 'bot' }, CONFIG, notProcessed).reason, 'non-human');
  assert.equal(decide({ ...ev, messageType: 'image' }, CONFIG, notProcessed).reason, 'non-text');
  assert.equal(decide({ ...ev, text: '短' }, CONFIG, notProcessed).reason, 'too-short');
  assert.equal(decide(ev, CONFIG, () => true).reason, 'duplicate');
  assert.equal(decide(null, CONFIG, notProcessed).reason, 'unparseable');
});

test('Store 持久化：processed 与 queue 重启可恢复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thb-'));
  const s1 = new Store(dir);
  assert.equal(s1.isProcessed('om_1'), false);
  s1.markProcessed('om_1');
  s1.enqueue({ messageId: 'om_2', text: 't' });
  const s2 = new Store(dir); // 模拟重启
  assert.equal(s2.isProcessed('om_1'), true);
  assert.equal(s2.size(), 1);
  assert.equal(s2.dequeue().messageId, 'om_2');
  assert.equal(s2.dequeue(), null);
  const s3 = new Store(dir); // dequeue 也持久化
  assert.equal(s3.size(), 0);
  rmSync(dir, { recursive: true, force: true });
});

test('parseResult 解析末行 RESULT', () => {
  const out = '一些过程输出\nRESULT {"verdict":"pass","mr_url":"https://mr/1","branch":"bot/x","summary":"s"}\n';
  assert.equal(parseResult(out).verdict, 'pass');
  assert.equal(parseResult(out).mr_url, 'https://mr/1');
});
test('parseResult 取最后一个 RESULT 行', () => {
  const out = 'RESULT {"verdict":"skip"}\n后续\nRESULT {"verdict":"pass"}\n尾巴';
  assert.equal(parseResult(out).verdict, 'pass');
});
test('parseResult 异常输入返回 null', () => {
  assert.equal(parseResult('没有结果行'), null);
  assert.equal(parseResult('RESULT 不是json'), null);
  assert.equal(parseResult('RESULT {"verdict":"bogus"}'), null);
  assert.equal(parseResult(''), null);
});
