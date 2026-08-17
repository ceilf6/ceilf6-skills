import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalize } from '../src/normalize.mjs';
import { decide, mentionsBot } from '../src/filter.mjs';
import { Store } from '../src/state.mjs';
import { parseResult } from '../src/result.mjs';

const CONFIG = { chatId: 'oc_1916a3a15e1a11855ca621d56b3027ed', minTextLength: 10 };
const RAW = {
  chat_id: 'oc_1916a3a15e1a11855ca621d56b3027ed', chat_type: 'group',
  message_id: 'om_abcdef123456', message_type: 'text',
  sender_type: 'user', sender_id: 'ou_sender1',
  content: 'fallback 打包需要走 CI 构建并以 git tag 留痕',
};

// 话题群实测形态（2026-07-30 抓自真实事件）：首帖是 post 且无 root_id，回复是 text 且带 root_id，两者 thread_id 相同。
const RAW_HEAD = { ...RAW, message_id: 'om_head_111111', message_type: 'post', thread_id: 'omt_topic1' };
const RAW_REPLY = { ...RAW, message_id: 'om_reply_222222', thread_id: 'omt_topic1', root_id: 'om_head_111111' };

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
test('normalize 提取话题字段：thread_id/root_id，缺省为空串', () => {
  assert.equal(normalize(RAW_HEAD).threadId, 'omt_topic1');
  assert.equal(normalize(RAW_HEAD).rootId, ''); // 首帖无 root_id
  assert.equal(normalize(RAW_REPLY).threadId, 'omt_topic1');
  assert.equal(normalize(RAW_REPLY).rootId, 'om_head_111111');
  const plain = normalize(RAW); // 普通群消息两者皆无
  assert.equal(plain.threadId, '');
  assert.equal(plain.rootId, '');
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
test('mentionsBot：按字面 @显示名 匹配，位置不限；名字没配即不成立', () => {
  assert.equal(mentionsBot('@harness-ceilf6 这个急，帮我改一下', 'harness-ceilf6'), true);
  assert.equal(mentionsBot('这个急 @harness-ceilf6 帮我改一下', 'harness-ceilf6'), true);
  assert.equal(mentionsBot('@别人 帮我改一下', 'harness-ceilf6'), false);
  assert.equal(mentionsBot('harness-ceilf6 帮我改一下', 'harness-ceilf6'), false); // 没有 @ 不算
  assert.equal(mentionsBot('@harness-ceilf6 帮我改一下', ''), false);
  assert.equal(mentionsBot('@harness-ceilf6 帮我改一下', undefined), false);
  assert.equal(mentionsBot(undefined, 'harness-ceilf6'), false);
});
test('decide 放行 post：话题首帖才是真任务，只认 text 会把它全丢掉', () => {
  assert.equal(decide(normalize(RAW_HEAD), CONFIG, notProcessed).action, 'enqueue');
});
test('decide 话题内回复（有 root_id）判 reply，首帖（无 root_id）判 enqueue', () => {
  assert.equal(decide(normalize(RAW_REPLY), CONFIG, notProcessed).action, 'reply');
  assert.equal(decide(normalize(RAW_HEAD), CONFIG, notProcessed).action, 'enqueue');
});
test('decide 门禁对 reply 同样生效：他群/bot/过短/重复一律先被拦', () => {
  const ev = normalize(RAW_REPLY);
  assert.equal(decide({ ...ev, chatId: 'oc_other' }, CONFIG, notProcessed).reason, 'other-chat');
  assert.equal(decide({ ...ev, senderType: 'bot' }, CONFIG, notProcessed).reason, 'non-human');
  assert.equal(decide({ ...ev, messageType: 'image' }, CONFIG, notProcessed).reason, 'non-text');
  assert.equal(decide({ ...ev, text: '短' }, CONFIG, notProcessed).reason, 'too-short');
  assert.equal(decide(ev, CONFIG, () => true).reason, 'duplicate');
});

const RAW_DM = { chat_id: 'oc_p2p_1', chat_type: 'p2p', message_id: 'om_dm_1', message_type: 'text', sender_type: 'user', sender_id: 'ou_me', content: '好的' };
const DM_CONFIG = { ...CONFIG, dmOpenId: 'ou_me' };

test('normalize 提取 chatType', () => {
  assert.equal(normalize(RAW_DM).chatType, 'p2p');
  assert.equal(normalize(RAW).chatType, 'group');
});
test('decide 私信：本人 p2p 消息判 dm，且不受 minTextLength 门槛（「好的」也是合法拍板）', () => {
  assert.equal(decide(normalize(RAW_DM), DM_CONFIG, notProcessed).action, 'dm');
});
test('decide 私信拒绝：他人 p2p / bot 自己 / 空文本 / 重复', () => {
  const ev = normalize(RAW_DM);
  assert.equal(decide({ ...ev, senderOpenId: 'ou_other' }, DM_CONFIG, notProcessed).reason, 'other-dm');
  assert.equal(decide({ ...ev, senderType: 'bot' }, DM_CONFIG, notProcessed).reason, 'other-dm');
  assert.equal(decide({ ...ev, text: '' }, DM_CONFIG, notProcessed).reason, 'too-short');
  assert.equal(decide(ev, DM_CONFIG, () => true).reason, 'duplicate');
});
test('decide 群链路回归：chatType=group 走既有三态', () => {
  assert.equal(decide(normalize(RAW), DM_CONFIG, notProcessed).action, 'enqueue');
  assert.equal(decide(normalize(RAW_REPLY), DM_CONFIG, notProcessed).action, 'reply');
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

test('Store FIFO：先入先出，幸存任务跨重启保序', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thb-'));
  const s1 = new Store(dir);
  s1.enqueue({ messageId: 'om_first' });
  s1.enqueue({ messageId: 'om_second' });
  assert.equal(s1.dequeue().messageId, 'om_first');
  const s2 = new Store(dir); // 重启后幸存者仍在、顺序不变
  assert.equal(s2.size(), 1);
  assert.equal(s2.dequeue().messageId, 'om_second');
  rmSync(dir, { recursive: true, force: true });
});
test('Store markProcessed 幂等：重复调用 processed.jsonl 只落一行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thb-'));
  const s = new Store(dir);
  s.markProcessed('om_dup');
  s.markProcessed('om_dup');
  const lines = readFileSync(join(dir, 'processed.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  rmSync(dir, { recursive: true, force: true });
});
test('Store 容错：两文件坏行只跳过不抛，好行照常加载', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thb-'));
  const s1 = new Store(dir);
  s1.markProcessed('om_good');
  s1.enqueue({ messageId: 'om_q1' });
  appendFileSync(join(dir, 'processed.jsonl'), '{{{ 坏行\nnull\n');
  appendFileSync(join(dir, 'queue.jsonl'), 'not-json\n');
  const s2 = new Store(dir); // 不得 throw
  assert.equal(s2.isProcessed('om_good'), true);
  assert.equal(s2.size(), 1);
  assert.equal(s2.dequeue().messageId, 'om_q1');
  rmSync(dir, { recursive: true, force: true });
});

test('Store 线程登记：record/find/drop，同 threadId 覆盖，跨重启仍在', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thb-'));
  const s1 = new Store(dir);
  assert.equal(s1.findThread('omt_1'), null);
  s1.recordThread('omt_1', { branch: 'bot/a', worktree: '/wt/bot__a', messageId: 'om_a' });
  s1.recordThread('omt_1', { branch: 'bot/a-2', worktree: '/wt/bot__a-2', messageId: 'om_a' }); // 覆盖
  s1.recordThread('omt_2', { branch: 'bot/b', worktree: '/wt/bot__b', messageId: 'om_b' });
  assert.equal(s1.findThread('omt_1').branch, 'bot/a-2');
  const s2 = new Store(dir); // 模拟重启
  assert.equal(s2.findThread('omt_1').worktree, '/wt/bot__a-2');
  assert.equal(s2.findThread('omt_2').branch, 'bot/b');
  s2.dropThread('omt_1');
  assert.equal(s2.findThread('omt_1'), null);
  assert.equal(new Store(dir).findThread('omt_1'), null); // 注销也持久化
  assert.equal(new Store(dir).findThread('omt_2').branch, 'bot/b'); // 只注销目标那条
  rmSync(dir, { recursive: true, force: true });
});
test('Store 容错：threads.jsonl 坏行只跳过不抛，好行照常加载', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thb-'));
  const s1 = new Store(dir);
  s1.recordThread('omt_good', { branch: 'bot/g', worktree: '/wt/g', messageId: 'om_g' });
  appendFileSync(join(dir, 'threads.jsonl'), '{{{ 坏行\nnull\n{"info":{"branch":"无 threadId"}}\n');
  const s2 = new Store(dir); // 不得 throw
  assert.equal(s2.findThread('omt_good').branch, 'bot/g');
  rmSync(dir, { recursive: true, force: true });
});

test('Store awaiting：recordAsk 跨轮累积 questionMsgIds、waiting 翻转、resumeFlags 保留、跨重启可恢复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thb-'));
  const s1 = new Store(dir);
  assert.equal(s1.findAwaiting('om_t'), null);
  s1.recordAsk('om_t', { threadId: 'omt_1', branch: 'bot/x', worktree: '/wt/x', sessionId: 'sess_1', question: '问1', questionMsgId: 'om_q1', statusRid: 'rid_9', title: '短题' });
  assert.equal(s1.findAwaiting('om_t').waiting, true);
  assert.equal(s1.findAwaitingByQuestionMsg('om_q1').messageId, 'om_t');
  s1.patchAwaiting('om_t', { waiting: false, resumeFlags: ['--model', 'opus'] });
  assert.equal(s1.listWaiting().length, 0);
  s1.recordAsk('om_t', { sessionId: 'sess_1', question: '问2', questionMsgId: 'om_q2', statusRid: 'rid_10', title: '短题' });
  const e = s1.findAwaiting('om_t');
  assert.deepEqual(e.questionMsgIds, ['om_q1', 'om_q2']); // 引用任一轮提问都可命中
  assert.deepEqual(e.resumeFlags, ['--model', 'opus']);   // 命令设置跨轮存续
  assert.equal(e.waiting, true);
  assert.equal(e.branch, 'bot/x'); // 未再传的字段保留
  const s2 = new Store(dir); // 模拟重启
  assert.equal(s2.findAwaitingByQuestionMsg('om_q2').sessionId, 'sess_1');
  assert.equal(s2.listWaiting().length, 1);
  s2.dropAwaiting('om_t');
  assert.equal(new Store(dir).findAwaiting('om_t'), null); // 删除也持久化
  rmSync(dir, { recursive: true, force: true });
});
test('Store awaiting 容错：坏行只跳过不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thb-'));
  const s1 = new Store(dir);
  s1.recordAsk('om_ok', { question: 'q', questionMsgId: 'om_qq', title: 't' });
  appendFileSync(join(dir, 'awaiting.jsonl'), '{{{ 坏行\nnull\n{"noMessageId":1}\n');
  const s2 = new Store(dir);
  assert.equal(s2.findAwaiting('om_ok').question, 'q');
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
test('parseResult 接受 ask verdict 并带出 question', () => {
  const out = 'RESULT {"verdict":"ask","question":"选 A 还是 B？\\n背景：…"}';
  const r = parseResult(out);
  assert.equal(r.verdict, 'ask');
  assert.ok(r.question.includes('选 A 还是 B'));
});

test('Store 队列列举与按 id 移除：命中出队并落盘，未命中返回 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thb-'));
  const s = new Store(dir);
  s.enqueue({ messageId: 'om_a', text: 'a' });
  s.enqueue({ messageId: 'om_b', text: 'b' });
  assert.deepEqual(s.listQueued().map((t) => t.messageId), ['om_a', 'om_b']);
  assert.equal(s.removeQueued('om_nope'), null);
  assert.equal(s.removeQueued('om_a').text, 'a');
  assert.equal(s.size(), 1);
  assert.equal(new Store(dir).listQueued()[0].messageId, 'om_b'); // 移除已落盘
  rmSync(dir, { recursive: true, force: true });
});
test('Store listAwaiting 返回全部条目，不受 waiting 过滤', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thb-'));
  const s = new Store(dir);
  s.recordAsk('om_1', { question: 'q1', questionMsgId: 'om_q1', title: 't1' });
  s.recordAsk('om_2', { question: 'q2', questionMsgId: 'om_q2', title: 't2' });
  s.patchAwaiting('om_2', { waiting: false });
  assert.equal(s.listWaiting().length, 1);
  assert.deepEqual(s.listAwaiting().map((e) => e.messageId).sort(), ['om_1', 'om_2']);
  rmSync(dir, { recursive: true, force: true });
});
