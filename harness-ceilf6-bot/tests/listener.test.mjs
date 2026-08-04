import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/state.mjs';

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
function dmLine(over = {}) {
  return JSON.stringify({
    chat_id: 'oc_p2p_1', chat_type: 'p2p', message_id: 'om_dm_111111',
    message_type: 'text', sender_type: 'user', sender_id: 'ou_me',
    content: '好的，就这么办', ...over,
  });
}
async function poll(fn, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (fn()) return true; await new Promise((r) => setTimeout(r, 150)); }
  return false;
}
// 本机 AI-IDE 守护进程会异步往新 git 仓库写 .git/ai/，清理撞上时 rmSync 抛 ENOTEMPTY；退避重试（机器怪癖，非缺陷）。
const rmFixture = (root) => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });

function makeRepo(root) {
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'master', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return repo;
}
function writeConfig(root, repo, over = {}) {
  const cfgPath = join(root, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({
    chatId: 'oc_test', profile: 'taskhall', repoPath: repo,
    worktreesDir: join(root, 'wt'), stateDir: join(root, 'state'), logsDir: join(root, 'logs'),
    concurrency: 1, taskTimeoutMs: 30000, killGraceMs: 500, minTextLength: 10,
    dmOpenId: 'ou_me', claudeBin: CLAUDE_STUB, larkBin: LARK_STUB,
    reactions: { claimed: 'THUMBSUP', done: 'DONE', failed: 'CrossMark', escalate: 'OnIt', skipped: 'Get', context: 'CTXKEY' },
    ...over,
  }));
  return cfgPath;
}
// 事件流 stub 一次性吐完整个文件，无法在同一进程内编排「任务已就绪之后才到回复」；
// 分两次启动既是确定性的时序编排，也顺带验证 threads.jsonl 跨重启可用。
async function runListener({ cfgPath, root, events, verdict, turns, until }) {
  const eventsFile = join(root, `events-${Math.random().toString(36).slice(2)}.ndjson`);
  writeFileSync(eventsFile, events.join('\n') + '\n');
  const larkLog = join(root, 'lark-calls.log');
  const child = spawn(process.execPath, [SRC, cfgPath], {
    env: {
      ...process.env, STUB_LOG: larkLog, STUB_EVENTS_FILE: eventsFile,
      // undefined 会被 spawn 串化成 "undefined" 字符串，必须条件展开
      ...(verdict ? { STUB_VERDICT: verdict } : {}), ...(turns ? { STUB_TURNS: turns } : {}),
    },
  });
  const closed = new Promise((res) => child.on('close', res));
  const ok = await poll(until);
  child.kill('SIGTERM');
  await closed;
  return { ok, larkLog };
}

test('端到端（stub）：过滤入队 → runTask → 状态与日志落盘', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  const { ok } = await runListener({
    cfgPath, root, verdict: 'pass',
    events: [
      evLine(),                                             // 合法任务 → 跑
      evLine({ message_id: 'om_bot', sender_type: 'bot' }), // bot → 忽略
      evLine(),                                             // 重复 → 忽略
    ],
    until: () => existsSync(join(root, 'state', 'processed.jsonl')) &&
      existsSync(larkLogPath) && readFileSync(larkLogPath, 'utf8').includes('messages-send'),
  });
  assert.ok(ok, 'listener 应完成一次 pass 全链路');
  const processed = readFileSync(join(root, 'state', 'processed.jsonl'), 'utf8');
  assert.equal(processed.trim().split('\n').length, 1); // 只有合法任务被记 processed
  assert.ok(readFileSync(larkLogPath, 'utf8').includes('reactions')); // claimed+done reaction 调用发生
  rmFixture(root);
});

test('端到端（stub）：话题首帖起任务，同话题回复并入其上下文而非另起任务', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-topic-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  const threadsPath = join(root, 'state', 'threads.jsonl');
  // 第一程：话题首帖（post、无 root_id）→ 正常任务，并登记 thread_id → 现场
  const first = await runListener({
    cfgPath, root, verdict: 'pass',
    events: [evLine({ message_id: 'om_head_111111', message_type: 'post', thread_id: 'omt_topic1' })],
    until: () => existsSync(threadsPath) && readFileSync(larkLogPath, 'utf8').includes('messages-send'),
  });
  assert.ok(first.ok, '话题首帖（post）应被放行并跑完一次任务');
  const info = new Store(join(root, 'state')).findThread('omt_topic1');
  assert.ok(info, 'worktree 就绪后应登记 thread_id → 现场');
  assert.ok(existsSync(info.worktree));

  // 第二程：同话题回复（text、有 root_id）→ 只并上下文
  const ctxDir = join(info.worktree, '.harness-ceilf6', info.branch.replaceAll('/', '__'), 'context');
  const second = await runListener({
    cfgPath, root, verdict: 'pass',
    events: [evLine({
      message_id: 'om_reply_222222', thread_id: 'omt_topic1', root_id: 'om_head_111111',
      content: '补充一句：还要兼容 7.72 老包',
    })],
    until: () => existsSync(ctxDir) && readdirSync(ctxDir).length > 0,
  });
  assert.ok(second.ok, `回复应写出上下文条目到 ${ctxDir}`);
  const entries = readdirSync(ctxDir);
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^\d{6}-\d{4}-im-222222\.md$/);
  const body = readFileSync(join(ctxDir, entries[0]), 'utf8');
  assert.ok(body.includes('thread=omt_topic1'));
  assert.ok(body.includes('补充一句：还要兼容 7.72 老包'));
  // 不另起任务：没有第二个 worktree、没有第二份任务日志、队列已空
  assert.deepEqual(readdirSync(join(root, 'wt')), [info.branch.replaceAll('/', '__')]);
  assert.equal(existsSync(join(root, 'logs', 'task-om_reply_222222.log')), false);
  assert.equal(new Store(join(root, 'state')).size(), 0);
  // 回执 reaction 用 context 键（钉住键名，防与接单/完成键互换）且打在回复那条消息上
  const calls = readFileSync(larkLogPath, 'utf8');
  assert.ok(calls.includes('om_reply_222222/reactions'), `应对回复打 reaction，实际：${calls}`);
  assert.ok(calls.includes('CTXKEY'));
  assert.ok(new Store(join(root, 'state')).isProcessed('om_reply_222222')); // 记 processed：重放不重写
  rmFixture(root);
});

test('端到端（stub）：skip 判定注销线程登记，后续回复不会写进已删 worktree', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-skip-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const threadsPath = join(root, 'state', 'threads.jsonl');
  const { ok } = await runListener({
    cfgPath, root, verdict: 'skip',
    events: [evLine({ message_id: 'om_head_333333', message_type: 'post', thread_id: 'omt_topic2' })],
    // 文件存在证明登记发生过，内容空证明 skip 后已注销
    until: () => existsSync(threadsPath) && readFileSync(threadsPath, 'utf8').trim() === '',
  });
  assert.ok(ok, 'skip 后 threads.jsonl 应被清空（登记过又注销）');
  assert.equal(new Store(join(root, 'state')).findThread('omt_topic2'), null);
  assert.deepEqual(readdirSync(join(root, 'wt')), []); // skip 已删现场，登记留着就是坏地址
  rmFixture(root);
});

test('端到端（stub）：ask 挂起 → 私信含问题 → 重启后私信回复懒续跑至 pass（群里零文字消息）', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-ask-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  const awaitingPath = join(root, 'state', 'awaiting.jsonl');
  // 第一程：任务 → ask → awaiting 落盘（waiting=true）→ SIGTERM（模拟 bot 重启收割挂起进程）
  const first = await runListener({
    cfgPath, root, turns: 'ask:选方案 A 还是 B？',
    events: [evLine({ message_id: 'om_ask_111111', message_type: 'post', thread_id: 'omt_ask1' })],
    until: () => existsSync(awaitingPath) && readFileSync(awaitingPath, 'utf8').includes('"waiting":true'),
  });
  assert.ok(first.ok, 'ask 后 awaiting.jsonl 应落盘');
  const entry = JSON.parse(readFileSync(awaitingPath, 'utf8').trim());
  assert.equal(entry.messageId, 'om_ask_111111');
  assert.ok(entry.question.includes('选方案 A 还是 B'));
  assert.ok(entry.questionMsgIds.length === 1);
  assert.ok(entry.sessionId);
  const qDm = readFileSync(larkLogPath, 'utf8');
  assert.ok(qDm.includes('messages-send'), '提问应走私信');
  assert.ok(!qDm.includes('messages-reply'), '群里零文字消息');
  // 第二程：私信直发回复（单任务免引用）→ 懒续跑 → pass ✅
  const second = await runListener({
    cfgPath, root, turns: 'pass',
    events: [dmLine({ message_id: 'om_dm_222222', content: '选 A' })],
    until: () => !existsSync(awaitingPath) || readFileSync(awaitingPath, 'utf8').trim() === '',
  });
  assert.ok(second.ok, '终态后 awaiting 条目应删除');
  const calls = readFileSync(larkLogPath, 'utf8');
  assert.ok(calls.includes('任务完成'), '应收到 ✅ 私信');
  rmFixture(root);
});

test('端到端（stub）：零任务在等时私信收到提示', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-dm-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  const { ok } = await runListener({
    cfgPath, root, verdict: 'pass',
    events: [dmLine()],
    until: () => existsSync(larkLogPath) && readFileSync(larkLogPath, 'utf8').includes('没有等待回复的任务'),
  });
  assert.ok(ok);
  // dm 必须在 admit 之前拦截：p2p 事件不入队、不凭空起 claude（否则私信被烧掉不可重放）
  const st = new Store(join(root, 'state'));
  assert.equal(st.size(), 0, 'p2p 事件不得入 queue');
  assert.ok(st.isProcessed('om_dm_111111'), 'processed 应由 handleDm 显式写入');
  const logsDir = join(root, 'logs');
  const taskLogs = existsSync(logsDir) ? readdirSync(logsDir).filter((f) => f.startsWith('task-om_dm_')) : [];
  assert.deepEqual(taskLogs, [], '不得产生任务日志');
  assert.equal(existsSync(join(root, 'wt')), false, '不得创建 worktree');
  rmFixture(root);
});

test('端到端（stub）：两任务同时在等 → 直发要求引用，引用回复精确路由到对应任务', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-quote-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  const awaitingPath = join(root, 'state', 'awaiting.jsonl');
  // 第一程：两任务先后 ask 挂起（concurrency=1，首次 ask 释放槽位第二个才进得来）→ SIGTERM 收割
  const first = await runListener({
    cfgPath, root, turns: 'ask:两个方向选哪个？',
    events: [
      evLine({ message_id: 'om_qa_111111', message_type: 'post', thread_id: 'omt_qa1' }),
      evLine({ message_id: 'om_qb_222222', message_type: 'post', thread_id: 'omt_qb2' }),
    ],
    until: () => existsSync(awaitingPath)
      && readFileSync(awaitingPath, 'utf8').split('\n').filter((l) => l.includes('"waiting":true')).length === 2,
  });
  assert.ok(first.ok, '两个任务都应 ask 挂起（首次 ask 释放槽位是前提）');
  const entries = readFileSync(awaitingPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const target = entries.find((e) => e.messageId === 'om_qa_111111');
  const other = entries.find((e) => e.messageId === 'om_qb_222222');
  assert.ok(target?.questionMsgIds?.[0], '目标任务的提问私信 message_id 应已落盘');
  assert.ok(other?.questionMsgIds?.[0], '另一任务的提问私信 message_id 应已落盘');
  assert.notEqual(target.questionMsgIds[0], other.questionMsgIds[0]);
  // 第二程：直发（无引用）→ 请引用提示；引用目标任务的提问私信（root_id）→ 只有它续跑至 pass
  const second = await runListener({
    cfgPath, root, turns: 'pass',
    events: [
      dmLine({ message_id: 'om_dm_q66666', content: '选 A' }),
      dmLine({ message_id: 'om_dm_q77777', content: '选 A', root_id: target.questionMsgIds[0] }),
    ],
    until: () => readFileSync(larkLogPath, 'utf8').includes('有 2 个任务在等回复')
      && readFileSync(larkLogPath, 'utf8').includes('任务完成')
      && !readFileSync(awaitingPath, 'utf8').includes('om_qa_111111'),
  });
  assert.ok(second.ok, '直发应得请引用回执，引用后目标任务应续跑至终态并删除其 awaiting 条目');
  const calls = readFileSync(larkLogPath, 'utf8');
  assert.ok(calls.includes('有 2 个任务在等回复，请引用对应提问消息回复'), '直发应收到请引用提示');
  const left = readFileSync(awaitingPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(left.length, 1, '未被引用的任务条目应原样留存');
  assert.equal(left[0].messageId, 'om_qb_222222');
  assert.equal(left[0].waiting, true, '另一任务应仍在等待回复');
  rmFixture(root);
});

test('端到端（stub）：/model 命令记入 resumeFlags、回执确认、后续回复续跑带上参数', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-cmd-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  const awaitingPath = join(root, 'state', 'awaiting.jsonl');
  const first = await runListener({
    cfgPath, root, turns: 'ask:用哪个模型都行，问一下',
    events: [evLine({ message_id: 'om_cmd_111111', message_type: 'post', thread_id: 'omt_cmd1' })],
    until: () => existsSync(awaitingPath) && readFileSync(awaitingPath, 'utf8').includes('"waiting":true'),
  });
  assert.ok(first.ok);
  // 第二程：未知命令被拒（有任务在等才走得到命令解析）→ 纯命令记 flags + 确认回执，任务仍在等
  const second = await runListener({
    cfgPath, root, turns: 'pass',
    events: [
      dmLine({ message_id: 'om_dm_333333', content: '/compact 现在' }),
      dmLine({ message_id: 'om_dm_444444', content: '/model opus' }),
    ],
    until: () => existsSync(larkLogPath) && readFileSync(larkLogPath, 'utf8').includes('无法执行的命令')
      && readFileSync(larkLogPath, 'utf8').includes('已记录 --model opus'),
  });
  assert.ok(second.ok);
  const entry = JSON.parse(readFileSync(awaitingPath, 'utf8').trim());
  assert.deepEqual(entry.resumeFlags, ['--model', 'opus']);
  assert.equal(entry.waiting, true);
  // 第三程：正文回复 → 懒续跑 spawn 带 --model opus → pass
  process.env.STUB_ARGS_OUT = join(root, 'args3.txt');
  const third = await runListener({
    cfgPath, root, turns: 'pass',
    events: [dmLine({ message_id: 'om_dm_555555', content: '就用它继续' })],
    until: () => readFileSync(join(root, 'state', 'awaiting.jsonl'), 'utf8').trim() === '',
  });
  delete process.env.STUB_ARGS_OUT;
  assert.ok(third.ok);
  const args = readFileSync(join(root, 'args3.txt'), 'utf8').split('\n');
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  assert.ok(args.includes('--resume'));
  rmFixture(root);
});

// 单元级：这两条覆盖「首帖 worktree 就绪前回复就到」的 in-flight 形态——该形态下回复必然退化成
// 第二个任务，而端到端用例（分两程投递）按设计跳过了它，只能在此钉住。
test('线程登记归属：退化任务抢不走登记，也注销不了别人的登记', async () => {
  const { registerThread, unregisterThread } = await import('../src/listener.mjs');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-own-')));
  const store = new Store(join(root, 'state'));
  const headWt = join(root, 'wt', 'bot__head');
  const replyWt = join(root, 'wt', 'bot__reply');
  mkdirSync(headWt, { recursive: true });
  mkdirSync(replyWt, { recursive: true });
  store.recordThread('omt_x', { threadId: 'omt_x', messageId: 'om_head', branch: 'bot/head', worktree: headWt });
  // 抢登记 = 此后 📝 全写进讨论派生的 worktree，而人按 escalate 私信去的是首帖 worktree，永远看不到
  assert.equal(registerThread(store, { threadId: 'omt_x', messageId: 'om_reply', branch: 'bot/reply', worktree: replyWt }), false);
  assert.equal(store.findThread('omt_x').messageId, 'om_head');
  // 退化任务判 skip：注销别人的登记会让下一条回复又起一个全权 claude
  assert.equal(unregisterThread(store, { threadId: 'omt_x', messageId: 'om_reply' }), false);
  assert.equal(store.findThread('omt_x').messageId, 'om_head');
  // 登记所有者自己 skip 才注销
  assert.equal(unregisterThread(store, { threadId: 'omt_x', messageId: 'om_head' }), true);
  assert.equal(store.findThread('omt_x'), null);
  rmFixture(root);
});

test('线程登记：worktree 已不在的失效登记可被新任务接管', async () => {
  const { registerThread } = await import('../src/listener.mjs');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-own-')));
  const store = new Store(join(root, 'state'));
  const liveWt = join(root, 'wt', 'bot__new');
  mkdirSync(liveWt, { recursive: true });
  store.recordThread('omt_y', { threadId: 'omt_y', messageId: 'om_gone', branch: 'bot/gone', worktree: join(root, 'wt', 'bot__gone') });
  assert.equal(registerThread(store, { threadId: 'omt_y', messageId: 'om_new', branch: 'bot/new', worktree: liveWt }), true);
  assert.equal(store.findThread('omt_y').messageId, 'om_new');
  // 非话题群消息（无 threadId）不进登记表
  assert.equal(registerThread(store, { threadId: '', messageId: 'om_plain', branch: 'bot/p', worktree: liveWt }), false);
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
  // 四类坏法各占一：空串（chatId）、类型错（concurrency）、越下界（taskTimeoutMs=0）、整键缺（profile 等 / reactions 缺 4 键）
  writeFileSync(cfgPath, JSON.stringify({ chatId: '', concurrency: '1', taskTimeoutMs: 0, reactions: { claimed: 'THUMBSUP' } }));
  const out = await new Promise((res) => {
    const child = spawn(process.execPath, [SRC, cfgPath], { env: { ...process.env } });
    let err = '';
    child.stderr.on('data', (b) => { err += b.toString(); });
    child.on('close', (code) => res({ code, err }));
  });
  assert.equal(out.code, 1);
  for (const key of ['chatId', 'profile', 'larkBin', 'concurrency', 'taskTimeoutMs', 'reactions.done', 'reactions.skipped', 'reactions.context']) {
    assert.ok(out.err.includes(key), `stderr 应列出 ${key}，实际：${out.err}`);
  }
  rmFixture(root);
});
