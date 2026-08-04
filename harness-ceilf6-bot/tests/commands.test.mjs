import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDmReply, mergeFlags, SUPPORTED_HINT } from '../src/commands.mjs';

test('纯正文：无命令原样返回', () => {
  const r = parseDmReply('用方案 A，注意兼容 7.72');
  assert.deepEqual(r.flags, []);
  assert.deepEqual(r.unknown, []);
  assert.equal(r.body, '用方案 A，注意兼容 7.72');
});
test('开头命令行 + 正文：命令与正文分离', () => {
  const r = parseDmReply('/model opus\n/effort xhigh\n继续，用方案 B');
  assert.deepEqual(r.flags, [['--model', 'opus'], ['--effort', 'xhigh']]);
  assert.equal(r.body, '继续，用方案 B');
});
test('只有命令：body 为空串', () => {
  const r = parseDmReply('/model opus');
  assert.deepEqual(r.flags, [['--model', 'opus']]);
  assert.equal(r.body, '');
});
test('正文中间的斜杠行不算命令', () => {
  const r = parseDmReply('先看这个\n/model opus');
  assert.deepEqual(r.flags, []);
  assert.equal(r.body, '先看这个\n/model opus');
});
test('未知命令与缺参命令进 unknown', () => {
  assert.deepEqual(parseDmReply('/compact').unknown, ['/compact']);
  assert.deepEqual(parseDmReply('/model').unknown, ['/model']);
});
test('原型链上的名字不是命令', () => {
  const r = parseDmReply('/toString hi');
  assert.deepEqual(r.flags, []);
  assert.deepEqual(r.unknown, ['/toString']);
});
test('mergeFlags 同名后写覆盖、异名并存', () => {
  assert.deepEqual(mergeFlags(['--model', 'fable'], [['--model', 'opus']]), ['--model', 'opus']);
  assert.deepEqual(mergeFlags(['--model', 'opus'], [['--effort', 'xhigh']]), ['--model', 'opus', '--effort', 'xhigh']);
});
test('SUPPORTED_HINT 列出支持的命令', () => {
  assert.ok(SUPPORTED_HINT.includes('/model'));
  assert.ok(SUPPORTED_HINT.includes('/effort'));
});
test('SUPPORTED_HINT 由命令表派生：表中每个命令连同参数占位自动入 hint', async () => {
  const { COMMANDS } = await import('../src/commands.mjs');
  // 遍历命令表而非枚举命令名：日后新增命令无需改本测试，漏进 hint 即红。
  const names = Object.keys(COMMANDS);
  assert.ok(names.length >= 2);
  for (const name of names) {
    assert.ok(SUPPORTED_HINT.includes(`/${name} ${COMMANDS[name].argLabel}`), `hint 应含 /${name} 及其参数占位`);
  }
  // 钉住现状文案：派生改动不得悄悄改变用户可见提示
  assert.equal(SUPPORTED_HINT, '当前支持：/model <名>、/effort <级>');
});
