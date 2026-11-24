import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDmReply, mergeFlags, mergeFlat, SUPPORTED_HINT, parseControl, parseErrand, CONTROL } from '../src/commands.mjs';

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
test('parseErrand 取出办事正文：首行剩余 + 第二行起原样', () => {
  assert.equal(parseErrand('/do 看下磁盘'), '看下磁盘');
  assert.equal(parseErrand('/do 把 ~/tmp 清一下\n顺便报个占用'), '把 ~/tmp 清一下\n顺便报个占用');
  assert.equal(parseErrand('/do\n正文只在第二行'), '正文只在第二行');
  // 正文里的空行与缩进属于用户的原文，不得被压平
  assert.equal(parseErrand('/do 步骤：\n\n  1. 先看日志'), '步骤：\n\n  1. 先看日志');
});
// 粘 shell / YAML / 列表进来时正文常常从第二行开始，且靠行首缩进表意：对拼接结果做全局 trim
// 会把这些缩进连同首尾空行一起吃掉，而用户看到的是自己贴的东西被改了。
test('parseErrand 保真：第二行起的行首缩进、空行与末尾换行都不动', () => {
  assert.equal(parseErrand('/do\n  1. keep indent'), '  1. keep indent');
  assert.equal(parseErrand('/do\n\tcurl -sS https://x | jq .'), '\tcurl -sS https://x | jq .');
  assert.equal(parseErrand('/do\n\n  缩进前还空一行'), '\n  缩进前还空一行');
  assert.equal(parseErrand('/do 首行有正文\n  第二行缩进\n'), '首行有正文\n  第二行缩进\n');
});
test('parseErrand 与 parseControl 共用 mention 剥离', () => {
  assert.equal(parseErrand('@harness-ceilf6 /do 看下磁盘'), '看下磁盘');
});
test('parseErrand 无正文回空串，非 /do 回 null', () => {
  assert.equal(parseErrand('/do'), '');
  assert.equal(parseErrand('/do   '), '');
  assert.equal(parseErrand('/stop'), null);
  assert.equal(parseErrand('/document 这不是办事'), null); // 命令名须完整匹配
  assert.equal(parseErrand('帮我看下磁盘'), null);
  assert.equal(parseErrand('先看这个\n/do 看下磁盘'), null); // 只认首行
  assert.equal(parseErrand(''), null);
  assert.equal(parseErrand(null), null);
});
test('/do 不进 CONTROL：办事不是刹车，群话题里的 /do 不得走控制通道', () => {
  assert.equal(CONTROL.has('do'), false);
  assert.equal(parseControl('/do 看下磁盘'), null);
});
test('parseControl 拒绝：参数命令、非首行、纯文本、原型链名、空', () => {
  assert.equal(parseControl('/model opus'), null); // 参数命令不归控制通道
  assert.equal(parseControl('先看这个\n/stop'), null); // 只认首行，正文里的斜杠行不误杀任务
  assert.equal(parseControl('停一下'), null);
  assert.equal(parseControl('/toString'), null);
  assert.equal(parseControl(''), null);
  assert.equal(parseControl(null), null);
});
