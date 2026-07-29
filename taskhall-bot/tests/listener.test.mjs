import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SRC = resolve(import.meta.dirname, '../src/listener.mjs');
const LARK_STUB = resolve(import.meta.dirname, 'stubs/lark-cli');
const CLAUDE_STUB = resolve(import.meta.dirname, 'stubs/claude');

function evLine(over = {}) {
  return JSON.stringify({
    // sender_id 而非 sender_open_id：lark-cli 拍平后的实际字段名（TB2 真机校准，normalize.mjs 只认它）。
    chat_id: 'oc_test', chat_type: 'group', message_id: 'om_listener_111111',
    message_type: 'text', sender_type: 'user', sender_id: 'ou_a',
    content: '这是一个足够长的开发任务描述', ...over,
  });
}
async function poll(fn, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (fn()) return true; await new Promise((r) => setTimeout(r, 150)); }
  return false;
}
// 本机 AI-IDE 守护进程会异步往新 git 仓库写 .git/ai/，清理撞上时 rmSync 抛 ENOTEMPTY；退避重试（机器怪癖，非缺陷）。
const rmFixture = (root) => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });

test('端到端（stub）：过滤入队 → runTask → 状态与日志落盘', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-')));
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'master', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const eventsFile = join(root, 'events.ndjson');
  writeFileSync(eventsFile, [
    evLine(),                                             // 合法任务 → 跑
    evLine({ message_id: 'om_bot', sender_type: 'bot' }), // bot → 忽略
    evLine(),                                             // 重复 → 忽略
  ].join('\n') + '\n');
  const config = {
    chatId: 'oc_test', profile: 'taskhall', repoPath: repo,
    worktreesDir: join(root, 'wt'), stateDir: join(root, 'state'), logsDir: join(root, 'logs'),
    concurrency: 1, taskTimeoutMs: 30000, killGraceMs: 500, minTextLength: 10,
    dmOpenId: 'ou_me', claudeBin: CLAUDE_STUB, larkBin: LARK_STUB,
    reactions: { claimed: 'THUMBSUP', done: 'DONE', failed: 'CrossMark', escalate: 'OnIt' },
  };
  const cfgPath = join(root, 'config.json');
  writeFileSync(cfgPath, JSON.stringify(config));
  const larkLog = join(root, 'lark-calls.log');
  const child = spawn(process.execPath, [SRC, cfgPath], {
    env: { ...process.env, STUB_LOG: larkLog, STUB_EVENTS_FILE: eventsFile, STUB_VERDICT: 'pass' },
  });
  const ok = await poll(() =>
    existsSync(join(root, 'state', 'processed.jsonl')) &&
    existsSync(larkLog) &&
    readFileSync(larkLog, 'utf8').includes('messages-send'));
  child.kill('SIGTERM');
  assert.ok(ok, 'listener 应完成一次 pass 全链路');
  const processed = readFileSync(join(root, 'state', 'processed.jsonl'), 'utf8');
  assert.equal(processed.trim().split('\n').length, 1); // 只有合法任务被记 processed
  assert.ok(readFileSync(larkLog, 'utf8').includes('reactions')); // claimed+done reaction 调用发生
  rmFixture(root);
});

test('nextBackoff 指数退避封顶 60s', async () => {
  const { nextBackoff } = await import('../src/listener.mjs');
  assert.equal(nextBackoff(0), 1000);
  assert.equal(nextBackoff(3), 8000);
  assert.equal(nextBackoff(10), 60000);
});

test('symlink 启动：isMain 仍判真，坏 config 路径响亮退出 1', async () => {
  // Node 对 ESM 主入口做 realpath 解析而 argv[1] 保留 symlink 字面路径；
  // isMain 若不 realpath 会静默 exit 0（TB6 install 脚本天然经 symlink 启动）。
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-sym-')));
  const link = join(root, 'listener-link.mjs');
  symlinkSync(SRC, link);
  const out = await new Promise((res) => {
    const child = spawn(process.execPath, [link, join(root, 'no-such-config.json')], { env: { ...process.env } });
    let err = '';
    child.stderr.on('data', (b) => { err += b.toString(); });
    child.on('close', (code) => res({ code, err }));
  });
  assert.equal(out.code, 1, 'symlink 下主体应照常执行并响亮失败，而非静默退 0');
  assert.ok(out.err.length > 0, 'stderr 应非空');
  rmFixture(root);
});

test('启动校验：缺键/坏键一次性全列并退出 1，不 spawn 任何子进程', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-bad-')));
  const cfgPath = join(root, 'config.json');
  // 四类坏法各占一：空串（chatId）、类型错（concurrency）、越下界（taskTimeoutMs=0）、整键缺（profile 等 / reactions 缺 3 键）
  writeFileSync(cfgPath, JSON.stringify({ chatId: '', concurrency: '1', taskTimeoutMs: 0, reactions: { claimed: 'THUMBSUP' } }));
  const out = await new Promise((res) => {
    const child = spawn(process.execPath, [SRC, cfgPath], { env: { ...process.env } });
    let err = '';
    child.stderr.on('data', (b) => { err += b.toString(); });
    child.on('close', (code) => res({ code, err }));
  });
  assert.equal(out.code, 1);
  for (const key of ['chatId', 'profile', 'larkBin', 'concurrency', 'taskTimeoutMs', 'reactions.done']) {
    assert.ok(out.err.includes(key), `stderr 应列出 ${key}，实际：${out.err}`);
  }
  rmFixture(root);
});
