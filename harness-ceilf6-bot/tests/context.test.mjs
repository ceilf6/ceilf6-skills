import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { appendContextEntry } from '../src/context.mjs';

// 本机 AI-IDE 守护进程会异步往新 git 仓库写 .git/ai/，清理撞上时 rmSync 抛 ENOTEMPTY；退避重试（机器怪癖，非缺陷）。
const rmFixture = (root) => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });

const EV = {
  chatId: 'oc_hall', messageId: 'om_reply_998877', threadId: 'omt_topic1',
  senderOpenId: 'ou_sender1', text: '补充一句：这个 fallback 还要兼容 7.72 老包',
};

test('appendContextEntry 落在 harness-context 约定路径，分支名 / 换 __', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-ctx-')));
  const worktree = join(root, 'wt', 'bot__260730-1200-x');
  mkdirSync(worktree, { recursive: true });
  const path = appendContextEntry({ branch: 'bot/260730-1200-x', worktree, messageId: 'om_head_111111' }, EV);
  assert.ok(existsSync(path));
  assert.equal(dirname(path), join(worktree, '.harness-ceilf6', 'bot__260730-1200-x', 'context'));
  // 命名须与 ctx-dir.sh new-entry 一致（<YYMMDD-HHmm>-im-<slug>.md），否则续入装载会漏掉本条目
  assert.match(basename(path), /^\d{6}-\d{4}-im-998877\.md$/);
  rmFixture(root);
});

test('appendContextEntry 内容：provenance 三行 + 分隔 + 原文', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-ctx-')));
  const worktree = join(root, 'wt', 'bot__a');
  mkdirSync(worktree, { recursive: true });
  const body = readFileSync(appendContextEntry({ branch: 'bot/a', worktree, messageId: 'om_head' }, EV), 'utf8');
  const lines = body.split('\n');
  assert.equal(lines[0], '> 来源: 飞书群消息 chat=oc_hall message=om_reply_998877 thread=omt_topic1');
  assert.equal(lines[1], '> 发送者: ou_sender1');
  assert.match(lines[2], /^> 抓取时间: \d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  assert.equal(lines[3], '---');
  assert.ok(body.includes(EV.text));
  rmFixture(root);
});

test('appendContextEntry 拒绝往不存在的 worktree 写：不得凭空重建目录换一个假回执', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-ctx-')));
  const worktree = join(root, 'wt', '已被人工删掉');
  assert.throws(() => appendContextEntry({ branch: 'bot/a', worktree, messageId: 'om_head' }, EV), /worktree/);
  assert.equal(existsSync(worktree), false); // 连目录都不许留下
  rmFixture(root);
});

test('appendContextEntry 同分钟同后6位不覆盖：后来者加序号', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-ctx-')));
  const worktree = join(root, 'wt', 'bot__a');
  mkdirSync(worktree, { recursive: true });
  const info = { branch: 'bot/a', worktree, messageId: 'om_head' };
  // 后 6 位相同（不同消息也可能撞）：直接同名写就把前一条静默截断掉
  const p1 = appendContextEntry(info, { ...EV, messageId: 'om_aaa_998877', text: '第一条' });
  const p2 = appendContextEntry(info, { ...EV, messageId: 'om_bbb_998877', text: '第二条' });
  assert.notEqual(p1, p2);
  assert.match(basename(p2), /^\d{6}-\d{4}-im-998877-2\.md$/);
  assert.ok(readFileSync(p1, 'utf8').includes('第一条'));
  assert.ok(readFileSync(p2, 'utf8').includes('第二条'));
  rmFixture(root);
});

test('appendContextEntry 只增不改：同话题多条回复各自成文件', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-ctx-')));
  const worktree = join(root, 'wt', 'bot__a');
  mkdirSync(worktree, { recursive: true });
  const info = { branch: 'bot/a', worktree, messageId: 'om_head' };
  const p1 = appendContextEntry(info, EV);
  const p2 = appendContextEntry(info, { ...EV, messageId: 'om_reply_112233', text: '再补一句' });
  assert.notEqual(p1, p2);
  assert.ok(readFileSync(p1, 'utf8').includes(EV.text)); // 前一条未被覆盖
  assert.ok(readFileSync(p2, 'utf8').includes('再补一句'));
  rmFixture(root);
});
