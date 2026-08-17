import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDmReply, mergeFlags, mergeFlat, SUPPORTED_HINT, parseControl, CONTROL } from '../src/commands.mjs';

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
test('mergeFlat：两个扁平数组同名后写覆盖、奇数长度的残尾丢弃', () => {
  assert.deepEqual(mergeFlat(['--model', 'opus'], ['--model', 'fable']), ['--model', 'fable']);
  assert.deepEqual(mergeFlat(['--model', 'opus'], ['--effort', 'xhigh']), ['--model', 'opus', '--effort', 'xhigh']);
  assert.deepEqual(mergeFlat([], ['--model', 'fable']), ['--model', 'fable']);
  assert.deepEqual(mergeFlat(['--model', 'opus'], ['--effort']), ['--model', 'opus']);
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
test('parseControl 识别首行控制命令与参数', () => {
  assert.deepEqual(parseControl('/stop'), { name: 'stop', arg: '' });
  assert.deepEqual(parseControl('/stop 2'), { name: 'stop', arg: '2' });
  assert.deepEqual(parseControl('/stop 924955'), { name: 'stop', arg: '924955' });
  assert.deepEqual(parseControl('/pause'), { name: 'pause', arg: '' });
  assert.deepEqual(parseControl('/tasks'), { name: 'tasks', arg: '' });
  assert.deepEqual(parseControl('/resume'), { name: 'resume', arg: '' });
  // /resume 的参数一段扛两件事：选择子与正文同在首行，拆分在 listener（要对着在册列表才判得准）
  assert.deepEqual(parseControl('/resume 2 用方案 A 继续'), { name: 'resume', arg: '2 用方案 A 继续' });
});
test('parseControl 剥掉首行开头的 @mention：飞书 mention 在正文里是字面文本', () => {
  assert.deepEqual(parseControl('@harness-ceilf6 /stop'), { name: 'stop', arg: '' });
  assert.deepEqual(parseControl('@harness-ceilf6 /stop 2'), { name: 'stop', arg: '2' });
  assert.deepEqual(parseControl('@某人 @harness-ceilf6 /pause'), { name: 'pause', arg: '' }); // 连续多个 mention
  assert.equal(parseControl('@harness-ceilf6 帮我看看'), null); // 剥完不是命令仍判 null
});
test('parseControl 只取首行：命令行之后的正文被丢弃', () => {
  assert.deepEqual(parseControl('/stop\n多余的话'), { name: 'stop', arg: '' });
});
test('CONTROL 钉住控制命令集合：新增/删改控制通道成员即红', () => {
  assert.deepEqual([...CONTROL].sort(), ['pause', 'resume', 'stop', 'tasks']);
});
test('parseControl 拒绝：参数命令、非首行、纯文本、原型链名、空', () => {
  assert.equal(parseControl('/model opus'), null); // 参数命令不归控制通道
  assert.equal(parseControl('先看这个\n/stop'), null); // 只认首行，正文里的斜杠行不误杀任务
  assert.equal(parseControl('停一下'), null);
  assert.equal(parseControl('/toString'), null);
  assert.equal(parseControl(''), null);
  assert.equal(parseControl(null), null);
});
