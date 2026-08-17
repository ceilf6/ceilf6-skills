import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync, rmSync, symlinkSync, openSync, writeSync, closeSync, constants as FS } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/state.mjs';
import { validateConfig } from '../src/listener.mjs';

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
// 判据可以是异步的（如查控制端口）：不 await 的话 Promise 恒真值，poll 首轮即假绿，
// 且未决的请求会漏到用例之外变成 unhandledRejection。
// 预算给到 20s：判据一成立即返回，budget 只决定「真失败要等多久才现形」。本套件每条用例都要
// spawn 一串 listener / claude / lark 子进程，node --test 又并行跑各测试文件——8s 在忙机器上
// 会把这些编排判成假红（无断言可放宽，poll 从不用来做否定判断）。
async function poll(fn, ms = 20_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 150)); }
  return false;
}
// 本机 AI-IDE 守护进程会异步往新 git 仓库写 .git/ai/，清理撞上时 rmSync 抛 ENOTEMPTY；退避重试（机器怪癖，非缺陷）。
const rmFixture = (root) => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });

// 「worktree 就绪」（threads.jsonl 落盘）早于「会话真的起来了」：中间隔着接单表情的飞书往返与
// 一次进程 spawn，忙机器上是秒级。要对活跃轮次动手（取 sessionId、断言状态是运行中）就得等
// init 事件落进任务日志——那一刻运行时已在活表里、sessionId 已回填。
const sessionUp = (root, messageId) => {
  const p = join(root, 'logs', `task-${messageId}.log`);
  return existsSync(p) && readFileSync(p, 'utf8').includes('"subtype":"init"');
};

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
    // 端口区间放宽：测试文件并行跑，撞端口会让 listener 按「端口占用」退出 1、失败面误导
    controlPort: (Math.floor(Math.random() * 8000) + 40000),
    dmOpenId: 'ou_me', claudeBin: CLAUDE_STUB, larkBin: LARK_STUB,
    reactions: { claimed: 'THUMBSUP', done: 'DONE', failed: 'CrossMark', escalate: 'OnIt', skipped: 'Get', context: 'CTXKEY', stopped: 'MUTE' },
    ...over,
  }));
  return cfgPath;
}
// listener 的 stderr 默认落进没人读的管道：诊断信息全丢，写满 64KB 还会把它自己堵死。
// 接住并在用例失败时回吐——否则 boot 期失败（如控制端口被占）只表现为一次 8s 空等，无从查起。
function tapStderr(child) {
  const chunks = [];
  child.stderr.on('data', (b) => chunks.push(b.toString()));
  return () => chunks.join('');
}

// 事件流 stub 一次性吐完整个文件，无法在同一进程内编排「任务已就绪之后才到回复」；
// 分两次启动既是确定性的时序编排，也顺带验证 threads.jsonl 跨重启可用。
async function runListener({ cfgPath, root, events, verdict, turns, until, env = {} }) {
  const eventsFile = join(root, `events-${Math.random().toString(36).slice(2)}.ndjson`);
  writeFileSync(eventsFile, events.join('\n') + '\n');
  const larkLog = join(root, 'lark-calls.log');
  const child = spawn(process.execPath, [SRC, cfgPath], {
    env: {
      ...process.env, STUB_LOG: larkLog, STUB_EVENTS_FILE: eventsFile,
      // undefined 会被 spawn 串化成 "undefined" 字符串，必须条件展开
      ...(verdict ? { STUB_VERDICT: verdict } : {}), ...(turns ? { STUB_TURNS: turns } : {}), ...env,
    },
  });
  const closed = new Promise((res) => child.on('close', res));
  const stderr = tapStderr(child);
  const ok = await poll(until);
  child.kill('SIGTERM');
  await closed;
  if (!ok) console.error(`[fixture] listener stderr：\n${stderr().slice(-2000)}`);
  return { ok, larkLog };
}

// 停「正在跑的活跃任务」这条路径要求任务先跑起来、控制命令后到，而事件流 stub 一次性 cat 完
// 事件文件——用 FIFO 当事件文件即可按节奏逐条投递。O_RDWR 打开：FIFO 的只写打开会阻塞到读端就位，
// listener 起不来时会把用例挂死而不是超时报错。
async function runFedListener({ cfgPath, root, turns, env = {}, feed }) {
  const fifo = join(root, `events-${Math.random().toString(36).slice(2)}.fifo`);
  execFileSync('mkfifo', [fifo]);
  const larkLog = join(root, 'lark-calls.log');
  const child = spawn(process.execPath, [SRC, cfgPath], {
    env: { ...process.env, STUB_LOG: larkLog, STUB_EVENTS_FILE: fifo, ...(turns ? { STUB_TURNS: turns } : {}), ...env },
  });
  const closed = new Promise((res) => child.on('close', res));
  const stderr = tapStderr(child);
  const fd = openSync(fifo, FS.O_RDWR);
  let ok = false;
  try {
    ok = await feed((line) => writeSync(fd, line + '\n'));
  } finally {
    closeSync(fd);
    child.kill('SIGTERM');
    await closed;
    if (!ok) console.error(`[fixture] listener stderr：\n${stderr().slice(-2000)}`);
  }
  // stderr 一并交出去：控制命令落到了哪个任务、原状态是什么，只在那里留痕。
  return { ok, larkLog, stderr };
}

// 把在册水位垫到指定高度：awaiting 条目就是 registry() 的一路来源，起 N 个真任务只是把同一件事跑得更慢。
function seedAwaiting(root, n, decorate = () => ({})) {
  mkdirSync(join(root, 'state'), { recursive: true });
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(JSON.stringify({
      messageId: `om_seed_${String(i).padStart(6, '0')}`, kind: 'user', waiting: true,
      title: `旧任务 ${i}`, branch: `bot/seed-${i}`, worktree: join(root, 'wt', `seed-${i}`),
      sessionId: `sess_seed_${i}`, question: '等你回复', askedAt: `2026-08-14T00:0${i}:00Z`,
      ...decorate(i),
    }));
  }
  writeFileSync(join(root, 'state', 'awaiting.jsonl'), lines.join('\n') + '\n');
}

// 从办事会话的首轮 prompt 里切出「原文」那一段（errand-prompt.md 里 {{TASK_TEXT}} 的位置）：
// 断言正文保真必须逐字节比，includes 会被模板自带的空行糊过去。
function errandBodyIn(prompt) {
  return prompt.split('- 原文：\n\n')[1]?.split('\n\n## 指令')[0] ?? '';
}

// 只挡 `git worktree add` 一个子命令（拖慢或拖垮），其余 git 调用原样透传：
// 出队到 liveTasks 登记之间的启动窗口在小仓库上只有毫秒级，撑开它才谈得上观测。
function gitShim(root, mode) {
  const dir = join(root, `bin-${mode}`);
  mkdirSync(dir, { recursive: true });
  const real = execFileSync('which', ['git']).toString().trim();
  const body = mode === 'slow' ? 'sleep 4' : 'echo "stub：worktree add 故意失败" >&2; exit 1';
  writeFileSync(join(dir, 'git'),
    `#!/bin/sh\ncase " $* " in *" worktree add "*) ${body} ;; esac\nexec ${real} "$@"\n`, { mode: 0o755 });
  return dir;
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

test('接单水位：在册第 5 个照接、满 5 之后拒单并在话题里回一句', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-quota-')));
  const cfgPath = writeConfig(root, makeRepo(root), { botName: 'harness-ceilf6' });
  const larkLogPath = join(root, 'lark-calls.log');
  const awaitingPath = join(root, 'state', 'awaiting.jsonl');
  seedAwaiting(root, 4);
  const { ok } = await runFedListener({
    cfgPath, root, turns: 'ask:先确认一下需求边界',
    feed: async (send) => {
      // 第五个：水位未满，照常接单并挂起在 ask 上 → 在册满 5
      send(evLine({ message_id: 'om_wm_aaaaaa', content: '这是第五个任务，描述足够长' }));
      if (!await poll(() => readFileSync(awaitingPath, 'utf8').includes('om_wm_aaaaaa'))) return false;
      // 第六个：水位已满 → 不接
      send(evLine({ message_id: 'om_wm_bbbbbb', content: '这是第六个任务，描述足够长' }));
      return poll(() => existsSync(larkLogPath) && readFileSync(larkLogPath, 'utf8').includes('先不接新单'));
    },
  });
  assert.ok(ok, '满水位的新任务应收到拒单回复');
  const calls = readFileSync(larkLogPath, 'utf8');
  assert.ok(calls.includes('om_wm_bbbbbb'), '拒单回复应发在被拒的那条消息上');
  assert.ok(calls.includes('reply-in-thread'), '拒单回复走话题内回复，不刷群');
  assert.ok(/先不接新单|开做/.test(calls));
  // 拒单 = 不接：没有现场、没有会话、队列里也没有它
  assert.equal(existsSync(join(root, 'logs', 'task-om_wm_bbbbbb.log')), false, '拒单不得起会话');
  assert.deepEqual(readdirSync(join(root, 'wt')).filter((d) => d.includes('bbbbbb')), []);
  assert.equal(new Store(join(root, 'state')).size(), 0, '拒单不得入队');
  // 记 processed：事件重放不该让同一条消息再收一次拒单回复
  assert.ok(readFileSync(join(root, 'state', 'processed.jsonl'), 'utf8').includes('om_wm_bbbbbb'));
  rmFixture(root);
});

test('接单水位：@ 了 bot 的消息无视水位照接', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-mention-')));
  const cfgPath = writeConfig(root, makeRepo(root), { botName: 'harness-ceilf6' });
  const larkLogPath = join(root, 'lark-calls.log');
  seedAwaiting(root, 5);
  const { ok } = await runFedListener({
    cfgPath, root, turns: 'ask:先确认一下需求边界',
    feed: async (send) => {
      send(evLine({ message_id: 'om_wm_cccccc', content: '@harness-ceilf6 这个急，帮我改一下配置项' }));
      return poll(() => sessionUp(root, 'om_wm_cccccc'));
    },
  });
  assert.ok(ok, '被 @ 的任务应照常起会话');
  assert.equal(readFileSync(larkLogPath, 'utf8').includes('先不接新单'), false, '被 @ 的消息不得收到拒单回复');
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
  // 就绪判据取 ✅ 私信而不是 awaiting 条目消失：条目在终态一选定就销账（早于终态表情与回执的
  // 飞书往返），拿它当判据会在回执发出之前就 SIGTERM 掉 listener。
  const second = await runListener({
    cfgPath, root, turns: 'pass',
    events: [dmLine({ message_id: 'om_dm_222222', content: '选 A' })],
    until: () => readFileSync(larkLogPath, 'utf8').includes('任务完成'),
  });
  assert.ok(second.ok, '懒续跑应跑到 pass 并发出 ✅ 私信');
  assert.equal(existsSync(awaitingPath) ? readFileSync(awaitingPath, 'utf8').trim() : '', '', '终态后 awaiting 条目应删除');
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

test('端到端（stub）：话题内 /stop 立即停掉长轮次任务，不写 context、群里零文字消息，多余正文有回执', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-stop-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  const threadsPath = join(root, 'state', 'threads.jsonl');
  const { ok } = await runFedListener({
    cfgPath, root, turns: 'hang',
    feed: async (send) => {
      // 先起一个 hang 任务（长轮次），等它登记 thread，再在同话题里发 /stop
      send(evLine({ message_id: 'om_stop_111111', message_type: 'post', thread_id: 'omt_stop1' }));
      assert.ok(await poll(() => existsSync(threadsPath) && readFileSync(threadsPath, 'utf8').includes('omt_stop1')),
        '任务应已登记 thread');
      // 命令行之后还带正文：它不会进会话，用户必须被告知，否则会以为补充说明也送到了
      send(evLine({
        message_id: 'om_stopcmd_2222', thread_id: 'omt_stop1', root_id: 'om_stop_111111',
        content: '/stop\n顺带说一句：A 模块先别动',
      }));
      return poll(() => existsSync(larkLogPath) && readFileSync(larkLogPath, 'utf8').includes('MUTE')
        && readFileSync(larkLogPath, 'utf8').includes('控制命令之后的正文未注入会话'));
    },
  });
  assert.ok(ok, '/stop 应落下 stopped 表情，且多余正文有明确回执');
  const info = new Store(join(root, 'state')).findThread('omt_stop1');
  const ctxDir = join(info.worktree, '.harness-ceilf6', info.branch.replaceAll('/', '__'), 'context');
  const calls = readFileSync(larkLogPath, 'utf8');
  assert.ok(calls.includes('om_stop_111111/reactions'), '终态表情打在任务消息上');
  assert.ok(!calls.includes('messages-reply'), '群里零文字消息');
  assert.ok(!calls.includes('CTXKEY'), '控制命令不是补充信息，不该打 📝 回执');
  assert.equal(existsSync(ctxDir) && readdirSync(ctxDir).length > 0, false, '控制命令不写 context');
  rmFixture(root);
});

// 真实事故形态：bot 重启后进程没了、awaiting 条目还在，此前只能手改 awaiting.jsonl 手打表情收场。
// 两程编排在这里是必需的——awaiting.jsonl 跨重启存活，第二程的新进程活表为空，
// 在册视图只能来自 awaiting 残留这一路。
test('端到端（stub）：bot 重启后 /stop 收拾无进程的等待态残留', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-residue-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  const awaitingPath = join(root, 'state', 'awaiting.jsonl');
  const first = await runListener({
    cfgPath, root, turns: 'ask:等指示',
    events: [evLine({ message_id: 'om_res_111111', message_type: 'post', thread_id: 'omt_res' })],
    until: () => existsSync(awaitingPath) && readFileSync(awaitingPath, 'utf8').includes('"waiting":true'),
  });
  assert.ok(first.ok, 'ask 后 awaiting 条目应落盘');
  const entry = JSON.parse(readFileSync(awaitingPath, 'utf8').trim());
  assert.ok(entry.statusRid && entry.sessionId);
  // 两程共用一份 lark 日志，且 stub 的 reaction_id 恒为 rid_123——第一程 ask 时的
  // swapReaction 已经写过一条一模一样的 DELETE。断言必须只看第二程追加的那一段，
  // 否则「旧表情被撤」是条恒真断言（摘掉 deleteReaction 也照绿）。
  const beforeSecond = readFileSync(larkLogPath, 'utf8').length;
  const second = await runListener({
    cfgPath, root, verdict: 'pass',
    events: [dmLine({ message_id: 'om_dm_res1111', content: '/stop' })],
    until: () => readFileSync(larkLogPath, 'utf8').includes('等待态作废'),
  });
  assert.ok(second.ok, '/stop 应处置掉无进程的等待态');
  assert.equal(readFileSync(awaitingPath, 'utf8').trim(), '', 'awaiting 条目应被删除，否则回复还会懒续跑起来');
  const calls = readFileSync(larkLogPath, 'utf8').slice(beforeSecond).split('\n');
  assert.ok(calls.find((l) => l.includes('om_res_111111/reactions') && l.includes('MUTE')), '任务消息上应落 stopped 表情');
  assert.ok(calls.some((l) => l.includes(`om_res_111111/reactions/${entry.statusRid}`)), '旧状态表情应被撤（一条消息恒一个状态表情）');
  assert.ok(calls.some((l) => l.includes(`cd ${entry.worktree} && claude --resume ${entry.sessionId}`)), '回执须给出可接管的命令');
  rmFixture(root);
});

test('端到端（stub）：私信 /pause 把活跃任务转挂起态，不终态', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-pause-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  const threadsPath = join(root, 'state', 'threads.jsonl');
  const awaitingPath = join(root, 'state', 'awaiting.jsonl');
  const { ok } = await runFedListener({
    cfgPath, root, turns: 'hang',
    feed: async (send) => {
      send(evLine({ message_id: 'om_pause_1111', message_type: 'post', thread_id: 'omt_pause' }));
      assert.ok(await poll(() => existsSync(threadsPath) && readFileSync(threadsPath, 'utf8').includes('omt_pause')));
      // 会话起来之后再按暂停：更早按下时 sessionId 尚未回填，条目会缺它（另有其事，非本例所测）
      assert.ok(await poll(() => sessionUp(root, 'om_pause_1111')), '会话进程应已起来');
      send(dmLine({ message_id: 'om_dm_pause11', content: '/pause' }));
      return poll(() => existsSync(awaitingPath) && readFileSync(awaitingPath, 'utf8').includes('"waiting":true'));
    },
  });
  assert.ok(ok, '/pause 应给活跃任务补出等待态条目');
  const entry = JSON.parse(readFileSync(awaitingPath, 'utf8').trim());
  assert.equal(entry.messageId, 'om_pause_1111');
  assert.ok(entry.sessionId, '等待条目须带 sessionId，否则回复只会得到一条「无法续跑」');
  const calls = readFileSync(larkLogPath, 'utf8');
  assert.ok(calls.split('\n').find((l) => l.includes('om_pause_1111/reactions') && l.includes('OnIt')), '应换成等回复的表情');
  assert.ok(calls.includes('人工暂停，回复任意内容即续跑'), '挂起私信须是可回复的');
  assert.equal(calls.includes('MUTE'), false, 'pause 不终态：不得落 stopped 表情');
  rmFixture(root);
});

test('端到端（stub）：/tasks 合并活表与队列，排队中拒 /pause、/stop <short> 只把排队那个出队', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-queued-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  const threadsPath = join(root, 'state', 'threads.jsonl');
  const queuePath = join(root, 'state', 'queue.jsonl');
  const { ok } = await runFedListener({
    cfgPath, root, turns: 'hang',
    feed: async (send) => {
      // concurrency=1：第一个 hang 任务占住槽位，第二个只能留在队列里（尚未起进程）
      send(evLine({ message_id: 'om_live_111111', message_type: 'post', thread_id: 'omt_live' }));
      assert.ok(await poll(() => existsSync(threadsPath) && readFileSync(threadsPath, 'utf8').includes('omt_live')));
      send(evLine({ message_id: 'om_queued_abc222', message_type: 'post', thread_id: 'omt_queued' }));
      assert.ok(await poll(() => existsSync(queuePath) && readFileSync(queuePath, 'utf8').includes('om_queued_abc222')));
      send(dmLine({ message_id: 'om_dm_tasks22', content: '/tasks' }));
      assert.ok(await poll(() => readFileSync(larkLogPath, 'utf8').includes('运行中')
        && readFileSync(larkLogPath, 'utf8').includes('排队中')), '/tasks 应同时列出活表与队列');
      // short 定位（消息 id 后六位；纯数字参数按序号解释，故这里用非纯数字的后六位）
      send(dmLine({ message_id: 'om_dm_pauseq1', content: '/pause abc222' }));
      assert.ok(await poll(() => readFileSync(larkLogPath, 'utf8').includes('请改用 /stop')),
        '排队中的任务没有进程可挂起，pause 应被拒并指路 /stop');
      // 排队那个尚无进程，只需出队 + 终态表情
      send(dmLine({ message_id: 'om_dm_stopq11', content: '/stop abc222' }));
      return poll(() => readFileSync(larkLogPath, 'utf8').includes('已出队'));
    },
  });
  assert.ok(ok, '/stop <short> 应把排队中的任务出队');
  const listed = readFileSync(larkLogPath, 'utf8');
  // 同一份列表里两种计时语义并存：跑着的行计已跑，还在队列里的行计已等。
  assert.ok(/\[运行中\][^[]*· 已跑 \d+[smh]/.test(listed), `运行中的行应计已跑，实际：${listed}`);
  assert.ok(/\[排队中\][^[]*· 已等 \d+[smh]/.test(listed), `排队中的行应计已等，实际：${listed}`);
  const calls = listed.split('\n');
  assert.ok(calls.find((l) => l.includes('om_queued_abc222/reactions'))?.includes('MUTE'), '终态表情打在出队的那条消息上');
  assert.equal(calls.some((l) => l.includes('om_live_111111/reactions') && l.includes('MUTE')), false, '活跃任务不该被误停');
  assert.deepEqual(new Store(join(root, 'state')).listQueued(), [], '队列应已清空');
  rmFixture(root);
});

// 出队后、liveTasks 登记前的启动窗口：任务既不在队列里也不在活表里。此前这段时间 /tasks 不列它、
// /stop 回「当前没有在册任务。」——而 byteview-web 上建 worktree 是分钟级，正是「发错了想立刻撤」
// 的高频时刻，回执还是误导的。
test('端到端（stub）：建 worktree 期间任务列为「启动中」，/stop 回执指明稍候重试', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-starting-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  const queuePath = join(root, 'state', 'queue.jsonl');
  const hits = (s, needle) => s.split('\n').filter((l) => l.includes(needle)).length;
  const { ok } = await runFedListener({
    cfgPath, root, turns: 'hang', env: { PATH: `${gitShim(root, 'slow')}:${process.env.PATH}` },
    feed: async (send) => {
      send(evLine({ message_id: 'om_start_111111', message_type: 'post', thread_id: 'omt_start' }));
      // 空闲队列即刻出队，随后卡在 worktree add 上：队列已空 + 尚无 thread 登记 = 正处启动窗口
      assert.ok(await poll(() => existsSync(queuePath) && readFileSync(queuePath, 'utf8').trim() === ''),
        '任务应已出队');
      // 三条一并投递，全落在同一个启动窗口里：话题（群里喊停的主通道）、私信、列表
      send(evLine({
        message_id: 'om_stopstart22', thread_id: 'omt_start', root_id: 'om_start_111111', content: '/stop',
      }));
      send(dmLine({ message_id: 'om_dm_sstart1', content: '/stop' }));
      send(dmLine({ message_id: 'om_dm_tstart1', content: '/tasks' }));
      return poll(() => {
        const c = existsSync(larkLogPath) ? readFileSync(larkLogPath, 'utf8') : '';
        return hits(c, '正在建 worktree') >= 2 && c.includes('启动中');
      });
    },
  });
  assert.ok(ok, '启动窗口内 /stop 应说明任务正在建 worktree，而不是「没有在册任务」');
  const calls = readFileSync(larkLogPath, 'utf8');
  assert.equal(hits(calls, '正在建 worktree'), 2, '话题与私信两条通道给同一条回执');
  assert.equal(calls.includes('没有在册任务'), false, '启动中的任务必须在册可见');
  assert.equal(calls.includes('该话题没有登记的任务'), false, '启动中的任务在话题里同样认领得到');
  assert.ok(calls.includes('[启动中] 这是一个足够长的开发任务描述（111111）'),
    `列表须带状态、标题与可定位的 short，实际：${calls}`);
  // 尚未起进程的行，计时起点是消息入队时刻，量的是「等了多久」。
  assert.ok(/\[启动中\][^[]*· 已等 \d+[smh]/.test(calls), `启动中的行应计已等，实际：${calls}`);
  assert.equal(/\[启动中\][^[]*已跑/.test(calls), false, '尚未开跑的行不该说已跑');
  rmFixture(root);
});

// 启动窗口的出口：worktree 就绪、活表登记完成即交棒。残留的「启动中」条目平时被在册视图的去重
// 盖住，会在 pause 的飞书往返里浮出来——那段时间活表条目已按 stopping 隐去、等待态尚未落盘，
// 视图里只剩它。于是运行了半天的任务被说成「启动中」，/stop 被挡在「稍候重试」上，而这正是
// 人按刹车的时刻。
test('端到端（stub）：worktree 就绪即出启动窗口，pause 的飞书往返期间不冒出「启动中」', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-onlive-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  const threadsPath = join(root, 'state', 'threads.jsonl');
  const hits = (s, needle) => s.split('\n').filter((l) => l.includes(needle)).length;
  const read = () => (existsSync(larkLogPath) ? readFileSync(larkLogPath, 'utf8') : '');
  const { ok } = await runFedListener({
    // 私信整体慢 2s：pause 的提问私信一发出就把窗口撑开，够在里面问一次 /tasks
    cfgPath, root, turns: 'hang', env: { STUB_SLOW_IM_S: '2' },
    feed: async (send) => {
      send(evLine({ message_id: 'om_onlive_aa1111', message_type: 'post', thread_id: 'omt_onlive' }));
      assert.ok(await poll(() => existsSync(threadsPath) && readFileSync(threadsPath, 'utf8').includes('omt_onlive')),
        'worktree 应已就绪');
      assert.ok(await poll(() => sessionUp(root, 'om_onlive_aa1111')), '会话进程应已起来');
      send(dmLine({ message_id: 'om_dm_onlive11', content: '/tasks' }));
      assert.ok(await poll(() => read().includes('在册任务')), '/tasks 应列出该任务');
      assert.equal(hits(read(), 'aa1111）'), 1, '同一任务只应占一行');
      assert.ok(read().includes('[运行中]'), 'worktree 就绪后状态应是运行中');
      // pause 卡在提问私信上：此刻活表条目已隐去、awaiting 还没落盘
      send(dmLine({ message_id: 'om_dm_onlivep1', content: '/pause aa1111' }));
      assert.ok(await poll(() => read().includes('人工暂停')), 'pause 应已发出提问私信');
      send(dmLine({ message_id: 'om_dm_onlive22', content: '/tasks' }));
      return poll(() => hits(read(), '没有在册任务') === 1);
    },
  });
  assert.ok(ok, 'pause 往返期间的 /tasks 不该把在跑的任务报成启动中');
  assert.equal(read().includes('[启动中]'), false, `启动窗口条目应在 worktree 就绪时清掉，实际：${read()}`);
  rmFixture(root);
});

// 启动窗口的另一半：worktree 建不起来时没有 startTurnLoop 可登记，条目必须由失败路径清掉——
// 漏清则该 messageId 永远显示「启动中」，/stop 永远回「稍候重试」，一条死任务把在册视图钉死。
test('端到端（stub）：worktree 创建失败后启动窗口条目清除，/stop 回「没有在册任务」', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-startfail-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  const { ok } = await runFedListener({
    cfgPath, root, turns: 'hang', env: { PATH: `${gitShim(root, 'fail')}:${process.env.PATH}` },
    feed: async (send) => {
      send(evLine({ message_id: 'om_wtfail_1111', message_type: 'post', thread_id: 'omt_wtfail' }));
      assert.ok(await poll(() => existsSync(larkLogPath) && readFileSync(larkLogPath, 'utf8').includes('任务未启动')),
        'worktree 建不起来应走 fail 通道');
      // 日志由 lark stub 在调用之初写下，此刻那条私信还没发完、runTask 也就还没落地；
      // 清理挂在它 resolve 之后，故这里让出足够时间再问，测的才是清理本身而不是竞速。
      await new Promise((r) => setTimeout(r, 800));
      send(dmLine({ message_id: 'om_dm_wtf1111', content: '/stop' }));
      return poll(() => readFileSync(larkLogPath, 'utf8').includes('没有在册任务'));
    },
  });
  assert.ok(ok, '启动失败的任务不得永久占着「启动中」这一格');
  rmFixture(root);
});

// spec §6 点名的分支：多个任务在册时无参 /stop 必须拒绝执行——猜一个停掉就是停错人的现场。
test('端到端（stub）：多任务在册时无参 /stop 不猜目标，回执列出全部候选', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-many-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  const threadsPath = join(root, 'state', 'threads.jsonl');
  const queuePath = join(root, 'state', 'queue.jsonl');
  const { ok } = await runFedListener({
    cfgPath, root, turns: 'hang',
    feed: async (send) => {
      // concurrency=1：第一个 hang 占住槽位跑着，第二个留在队列里，凑出两个在册任务
      send(evLine({ message_id: 'om_manya_aaa111', message_type: 'post', thread_id: 'omt_manya' }));
      assert.ok(await poll(() => existsSync(threadsPath) && readFileSync(threadsPath, 'utf8').includes('omt_manya')));
      send(evLine({ message_id: 'om_manyb_bbb222', message_type: 'post', thread_id: 'omt_manyb' }));
      assert.ok(await poll(() => existsSync(queuePath) && readFileSync(queuePath, 'utf8').includes('om_manyb_bbb222')));
      send(dmLine({ message_id: 'om_dm_many111', content: '/stop' }));
      return poll(() => existsSync(larkLogPath) && readFileSync(larkLogPath, 'utf8').includes('有 2 个任务在册'));
    },
  });
  assert.ok(ok, '两个任务在册时无参 /stop 应回「有 2 个任务在册」');
  const calls = readFileSync(larkLogPath, 'utf8');
  assert.ok(calls.includes('请带序号或 short'), '回执须给出下一步怎么指名');
  assert.ok(calls.includes('aaa111') && calls.includes('bbb222'), `回执须列全两个候选，实际：${calls}`);
  assert.equal(calls.includes('MUTE'), false, '拒绝执行意味着谁都没被停');
  rmFixture(root);
});

// 滞留条目是启动扫描凭空造出来的，群里那枚接单表情的 reaction_id 无从继承——必须自己补回来
// （飞书 reaction 按 (user, emoji) 唯一，重复 add 即幂等取回既有的那枚）。补不回来时 /stop 只是
// 再叠一枚 🛑，而要收拾的那枚 👍 永远挂着，撞「一条被处理的消息上状态表情恒为一个」的不变量。
test('端到端（stub）：/stop 收拾滞留任务，接单表情被撤，消息上只留停止表情', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-strandstop-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  const awaitingPath = join(root, 'state', 'awaiting.jsonl');
  const threadsPath = join(root, 'state', 'threads.jsonl');
  const first = await runListener({
    cfgPath, root, turns: 'hang',
    events: [evLine({ message_id: 'om_ss_111111', message_type: 'post', thread_id: 'omt_ss' })],
    until: () => existsSync(threadsPath) && readFileSync(threadsPath, 'utf8').includes('omt_ss')
      && existsSync(join(root, 'logs', 'task-om_ss_111111.log')),
  });
  assert.ok(first.ok, '任务应已在活跃轮次中被收割，只留线程登记与任务日志');
  const beforeSecond = readFileSync(larkLogPath, 'utf8').length;
  const read = () => readFileSync(larkLogPath, 'utf8');
  let entry = null;
  const { ok, stderr } = await runFedListener({
    cfgPath, root, turns: 'pass',
    feed: async (send) => {
      // 补 rid 要走一次飞书往返（事件流不等它），故先等条目落上 statusRid 再按停——
      // 测的是「补回来之后 /stop 撤不撤旧表情」，不是与补 rid 竞速。
      assert.ok(await poll(() => existsSync(awaitingPath) && readFileSync(awaitingPath, 'utf8').includes('"statusRid"')),
        '滞留条目应把群里那枚接单表情的 reaction_id 补回来');
      entry = JSON.parse(readFileSync(awaitingPath, 'utf8').trim());
      // 滞留任务不等你回复，自由文本落不到它身上——兜底回执得说清在册的是什么，别报成后台运行中
      send(dmLine({ message_id: 'om_dm_ssfree1', content: '这条自由文本没有任务在等着收' }));
      assert.ok(await poll(() => read().includes('当前没有等待回复的任务')), '自由文本应得兜底回执');
      assert.equal(read().includes('在后台运行中'), false, `滞留任务不是后台运行中，实际：${read()}`);
      send(dmLine({ message_id: 'om_dm_ss1111', content: '/stop' }));
      return poll(() => read().includes('等待态作废'));
    },
  });
  assert.ok(ok, '/stop 应能处置掉滞留任务');
  assert.ok(stderr().includes('（原状态 stranded）'),
    `刹车审计须记下真实原状态，实际 stderr：${stderr().slice(-800)}`);
  assert.equal(entry.kind, 'stranded');
  assert.ok(entry.statusRid, '扫描登记的条目须带 statusRid');
  const calls = readFileSync(larkLogPath, 'utf8').slice(beforeSecond).split('\n');
  assert.ok(calls.some((l) => l.includes('om_ss_111111/reactions') && l.includes('MUTE')), '任务消息上应落 stopped 表情');
  assert.ok(calls.some((l) => l.includes('DELETE') && l.includes(`om_ss_111111/reactions/${entry.statusRid}`)),
    `接单表情应被撤（一条消息恒一个状态表情），实际：${calls.join('\n')}`);
  assert.equal(readFileSync(awaitingPath, 'utf8').trim(), '', '条目应被删除，否则重启后又是一条滞留任务');
  rmFixture(root);
});

test('端到端（stub）：活跃轮次中被重启的任务，重启后自动登记为已滞留并可 /resume', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-strand-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  const awaitingPath = join(root, 'state', 'awaiting.jsonl');
  const threadsPath = join(root, 'state', 'threads.jsonl');
  // 第一程：任务进入长轮次（hang，从不产出 RESULT）→ SIGTERM 模拟部署重启，
  // 会话被收割在活跃轮次里：无 awaiting 条目、无终态记账，群里只留一枚 claimed。
  const first = await runListener({
    cfgPath, root, turns: 'hang',
    events: [evLine({ message_id: 'om_strand_1111', message_type: 'post', thread_id: 'omt_strand' })],
    // 判据要等到会话 id 真的落进日志：日志文件在 spawn 时就建好了，只判存在会在 init 事件写盘
    // 之前就收割 listener，留下一份空日志——而滞留登记正是靠日志里的会话 id 成立的。
    until: () => existsSync(threadsPath) && readFileSync(threadsPath, 'utf8').includes('omt_strand')
      && sessionUp(root, 'om_strand_1111'),
  });
  assert.ok(first.ok, '任务应已登记线程并落下带会话 id 的任务日志');
  // 文件压根没被写过也算「没有条目」：滞留任务从没 ask 过
  const awaitingText = () => (existsSync(awaitingPath) ? readFileSync(awaitingPath, 'utf8') : '');
  assert.equal(awaitingText().trim(), '', '收割时没有 awaiting 条目——这正是滞留的成因');
  // 第二程（新进程 = bot 重启）：启动扫描应把它捞成 stranded，/tasks 看得见
  const second = await runListener({
    cfgPath, root, turns: 'pass',
    events: [dmLine({ message_id: 'om_dm_strand1', content: '/tasks' })],
    until: () => readFileSync(larkLogPath, 'utf8').includes('已滞留'),
  });
  assert.ok(second.ok, '重启后应自动登记滞留任务并在 /tasks 中显示');
  assert.ok(awaitingText().includes('"kind":"stranded"'));
  const line = readFileSync(larkLogPath, 'utf8').split('\n').find((l) => l.includes('[已滞留]'));
  // 时长那一段量的是「停在这儿多久了」，复读一遍状态徽标等于白占一格
  assert.ok(/\[已滞留\][^[]*· 已停 \d+[smh]/.test(line), `滞留行应带可读的停滞时长，实际：${line}`);
  assert.equal(/已滞留 \d+[smh]/.test(line), false, `状态徽标已写明已滞留，时长段不该复读，实际：${line}`);
  assert.equal((line.match(/bot\/\d{6}-\d{4}-\w+/g) ?? []).length, 1, `分支名只该出现一次，实际：${line}`);
  // 登记时写下的处置指引：滞留任务不发私信，这一行是它唯一的对外出口
  assert.ok(line.includes('/resume 即接着跑'), `滞留行须带处置指引，实际：${line}`);
  assert.ok(line.includes('task-om_strand_1111.log'), `指引里的日志路径不该被截掉，实际：${line}`);
  // 第三程：/resume 凭 sessionId 续跑，本轮进程不落 RESULT 就死（会话崩溃 / OOM / 被外部 kill 的
  // 形态）→ 走 fail 终态。终态不落在日志里，正是只有终态记账兜得住的那三类之一。
  const beforeThird = readFileSync(larkLogPath, 'utf8').length;
  const third = await runListener({
    cfgPath, root, turns: 'die',
    events: [dmLine({ message_id: 'om_dm_strand2', content: '/resume' })],
    until: () => awaitingText().trim() === '',
  });
  assert.ok(third.ok, '/resume 应能把滞留任务推到终态');
  const thirdCalls = readFileSync(larkLogPath, 'utf8').slice(beforeThird).split('\n');
  assert.ok(thirdCalls.some((l) => l.includes('任务未完成')), '进程不落 RESULT 就死应走 fail 终态');
  // 续跑不得先撤再打：滞留条目的 statusRid 就是群里那枚接单表情，(user, emoji) 唯一意味着
  // re-add 拿不到第二枚，随后那次 del 撤掉的正是它自己——群消息上就此零表情。
  assert.equal(thirdCalls.filter((l) => l.includes('DELETE') && l.includes('om_strand_1111/reactions/')).length, 1,
    `续跑到终态之间只该有终态换表情那一次 del，实际：${thirdCalls.join('\n')}`);
  // 第四程：终态没在日志里留下 RESULT（判据看日志尾只会判它还滞留着），全靠 settled 记账兜住
  const tailLog = readFileSync(join(root, 'logs', 'task-om_strand_1111.log'), 'utf8');
  assert.equal(tailLog.includes('RESULT'), false, '日志里没有终态 RESULT，第四程才是真的只靠记账');
  const fourth = await runListener({
    cfgPath, root, turns: 'pass',
    events: [dmLine({ message_id: 'om_dm_strand3', content: '/tasks' })],
    until: () => readFileSync(larkLogPath, 'utf8').includes('当前没有在册任务'),
  });
  assert.ok(fourth.ok, '已处置的任务不得被滞留扫描复活');
  rmFixture(root);
});

// 值班任务从未 ask 过、活跃轮次中被 bot 重启收割：滞留登记的来源是线程表里 onWorktreeReady
// 存下的 info。手拼 recordAsk 载荷时 preserveWorktree 一旦掉队，登记出来的就是「不带保护」的
// 滞留条目——之后 /resume + skip 会删掉用户的检出与需求分支。
test('端到端（stub）：带 preserveWorktree 的线程登记，滞留登记条目仍带免清场保护', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-strandduty-')));
  const repo = makeRepo(root);
  const cfgPath = writeConfig(root, repo);
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(root, 'logs'), { recursive: true });
  // 线程表条目即 runDutyTask onWorktreeReady 存的形状：值班任务跑在既有检出上，带免清场标记
  writeFileSync(join(root, 'state', 'threads.jsonl'), JSON.stringify({
    threadId: 'omt_duty', info: {
      threadId: 'omt_duty', messageId: 'om_dutystrand1', branch: 'feat/x', worktree: repo, preserveWorktree: true,
    },
  }) + '\n');
  // 日志停在活跃轮次：有会话 id、无终态 RESULT——正是滞留判据
  writeFileSync(join(root, 'logs', 'task-om_dutystrand1.log'),
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess_duty1' }) + '\n');
  const awaitingPath = join(root, 'state', 'awaiting.jsonl');
  const { ok } = await runListener({
    cfgPath, root, turns: 'pass',
    events: [dmLine({ message_id: 'om_dm_dstrand1', content: '/tasks' })],
    until: () => existsSync(awaitingPath) && readFileSync(awaitingPath, 'utf8').includes('"kind":"stranded"'),
  });
  assert.ok(ok, '带 preserveWorktree 的线程登记应照常被扫成滞留条目');
  const entry = JSON.parse(readFileSync(awaitingPath, 'utf8').trim().split('\n')[0]);
  assert.equal(entry.messageId, 'om_dutystrand1');
  assert.equal(entry.preserveWorktree, true,
    '滞留登记必须透传 preserveWorktree，否则 /resume + skip 会清掉用户检出');
  rmFixture(root);
});

test('端到端（stub）：working 态零私信；bot 重启后 /tasks 仍显示后台运行中', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-bg-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  const awaitingPath = join(root, 'state', 'awaiting.jsonl');
  // 第一程：任务以 working 收轮 → 登记落盘，且全程零私信
  const first = await runListener({
    cfgPath, root, turns: 'working:等钩子|开发完成，全仓测试后台跑着',
    events: [evLine({ message_id: 'om_bg_111111', message_type: 'post', thread_id: 'omt_bg1' })],
    until: () => existsSync(awaitingPath) && readFileSync(awaitingPath, 'utf8').includes('"kind":"background"'),
  });
  assert.ok(first.ok, 'working 应落下 background 登记');
  const calls1 = readFileSync(larkLogPath, 'utf8');
  assert.ok(!calls1.includes('messages-send'), 'working 态不得发私信');
  assert.ok(!calls1.includes('OnIt'), 'working 态不得换 ⚠️ 表情');
  // 第二程（新进程 = bot 重启）：/tasks 应还原成「后台运行中」而非误报「等回复」
  const second = await runListener({
    cfgPath, root, turns: 'pass',
    events: [dmLine({ message_id: 'om_dm_bgls11', content: '/tasks' })],
    until: () => readFileSync(larkLogPath, 'utf8').includes('后台运行中'),
  });
  assert.ok(second.ok, '重启后在册视图应保留 background 态');
  // 不发私信之后 /tasks 是进展的唯一出口：不打扰也不告知就成了纯黑盒
  assert.ok(readFileSync(larkLogPath, 'utf8').includes('进展：开发完成，全仓测试后台跑着'),
    `后台运行中的行须带进展，实际：${readFileSync(larkLogPath, 'utf8')}`);
  rmFixture(root);
});

// background 条目从没发过私信，也就没有可引用的提问消息。它若参与「唯一在等的那个」这条隐式
// 路由，多任务时直发一律被逼成「请引用」——而它恰恰无消息可引，到终态前不可达。
test('端到端（stub）：background 不吃直发回复，/resume 显式把它捞回来', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-bgres-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  const awaitingPath = join(root, 'state', 'awaiting.jsonl');
  const read = () => (existsSync(larkLogPath) ? readFileSync(larkLogPath, 'utf8') : '');
  // 第一程：A 以 working 收轮 → background 登记落盘
  const first = await runListener({
    cfgPath, root, turns: 'working:等钩子|全仓测试后台跑着',
    events: [evLine({ message_id: 'om_bgr_aaa111', message_type: 'post', thread_id: 'omt_bgr_a' })],
    until: () => existsSync(awaitingPath) && readFileSync(awaitingPath, 'utf8').includes('"kind":"background"'),
  });
  assert.ok(first.ok, 'working 应落下 background 登记');
  // 第二程：B ask 挂起 → 直发回复。真的在等人的只有 B，直发必须落到它身上
  const second = await runFedListener({
    cfgPath, root, turns: 'ask:选 A 还是 B？;pass',
    feed: async (send) => {
      send(evLine({ message_id: 'om_bgr_bbb222', message_type: 'post', thread_id: 'omt_bgr_b' }));
      assert.ok(await poll(() => readFileSync(awaitingPath, 'utf8').includes('om_bgr_bbb222')), 'B 应 ask 挂起');
      send(dmLine({ message_id: 'om_dm_bgr111', content: '选 A' }));
      // 等条目删除而非只等 ✅ 私信：lark stub 在调用之初就记账，而删条目挂在私信返回之后，
      // 只等日志会在忙机器上抢在删除之前拆掉 listener（B 的条目留下 = 假红）。
      return poll(() => read().includes('任务完成') && !readFileSync(awaitingPath, 'utf8').includes('om_bgr_bbb222'));
    },
  });
  assert.ok(second.ok, '直发回复应路由给唯一在等人的任务');
  assert.equal(read().includes('有 2 个任务在等回复'), false, 'background 不该把直发逼成「请引用」');
  const left = readFileSync(awaitingPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(left.map((e) => e.messageId), ['om_bgr_aaa111'], '只有 B 该被推进到终态');
  assert.equal(left[0].kind, 'background');
  // 第三程（新进程 = bot 重启，后台工作已随之被杀）：/resume <short> 带正文 → 懒续跑至终态
  const third = await runListener({
    cfgPath, root, turns: 'pass',
    events: [dmLine({ message_id: 'om_dm_bgr222', content: '/resume aaa111 继续' })],
    until: () => readFileSync(awaitingPath, 'utf8').trim() === '',
  });
  assert.ok(third.ok, '/resume <short> 应把 background 任务续跑到终态');
  assert.ok(read().includes('已续跑'), '显式命令须有回执，否则无从判断它有没有生效');
  rmFixture(root);
});

// 无参 /resume 与无参 /stop 同一套纪律：在册多个时不猜，列候选。
test('端到端（stub）：多任务在册时无参 /resume 不猜目标，回执列出候选', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-resmany-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  const threadsPath = join(root, 'state', 'threads.jsonl');
  const queuePath = join(root, 'state', 'queue.jsonl');
  const { ok } = await runFedListener({
    cfgPath, root, turns: 'hang',
    feed: async (send) => {
      send(evLine({ message_id: 'om_resa_aaa111', message_type: 'post', thread_id: 'omt_resa' }));
      assert.ok(await poll(() => existsSync(threadsPath) && readFileSync(threadsPath, 'utf8').includes('omt_resa')));
      send(evLine({ message_id: 'om_resb_bbb222', message_type: 'post', thread_id: 'omt_resb' }));
      assert.ok(await poll(() => existsSync(queuePath) && readFileSync(queuePath, 'utf8').includes('om_resb_bbb222')));
      send(dmLine({ message_id: 'om_dm_resmany', content: '/resume 继续' }));
      return poll(() => existsSync(larkLogPath) && readFileSync(larkLogPath, 'utf8').includes('有 2 个任务在册'));
    },
  });
  assert.ok(ok, '两个任务在册时无参 /resume 应回「有 2 个任务在册」');
  const calls = readFileSync(larkLogPath, 'utf8');
  assert.ok(calls.includes('/resume 2'), '回执须给出下一步怎么指名');
  assert.ok(calls.includes('aaa111') && calls.includes('bbb222'), `回执须列全两个候选，实际：${calls}`);
  rmFixture(root);
});

// background 恰是机器最忙的时刻（全仓测试 / 机审在烧 CPU）：放行下一个任务会让 concurrency:1
// 变成两份重负载并行。
test('端到端（stub）：后台运行中仍占 concurrency 槽，后来的任务留在队列', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-bgslot-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  const awaitingPath = join(root, 'state', 'awaiting.jsonl');
  const queuePath = join(root, 'state', 'queue.jsonl');
  const read = () => (existsSync(larkLogPath) ? readFileSync(larkLogPath, 'utf8') : '');
  const { ok } = await runFedListener({
    cfgPath, root, turns: 'working:等钩子|全仓测试后台跑着',
    feed: async (send) => {
      send(evLine({ message_id: 'om_bgs_aaa111', message_type: 'post', thread_id: 'omt_bgs_a' }));
      assert.ok(await poll(() => existsSync(awaitingPath) && readFileSync(awaitingPath, 'utf8').includes('"kind":"background"')),
        'A 应以 working 收轮');
      send(evLine({ message_id: 'om_bgs_bbb222', message_type: 'post', thread_id: 'omt_bgs_b' }));
      assert.ok(await poll(() => existsSync(queuePath) && readFileSync(queuePath, 'utf8').includes('om_bgs_bbb222')),
        'B 应入队');
      send(dmLine({ message_id: 'om_dm_bgslot1', content: '/tasks' }));
      return poll(() => read().includes('后台运行中') && read().includes('排队中'));
    },
  });
  assert.ok(ok, '/tasks 应同时列出后台运行中的 A 与排队中的 B');
  assert.ok(readFileSync(queuePath, 'utf8').includes('om_bgs_bbb222'), 'A 还占着槽位，B 不得出队开跑');
  assert.equal(existsSync(join(root, 'logs', 'task-om_bgs_bbb222.log')), false, 'B 不得起进程');
  assert.ok(read().includes('进展：全仓测试后台跑着'), '在跑的后台任务同样要在 /tasks 里给出进展');
  rmFixture(root);
});

// 占槽的判据是「有没有进程在烧 CPU」，不是那条永不 resolve 的 runTask promise：后台运行中的
// 会话进程一旦非终态死亡（claude 崩溃 / OOM / 被外部 kill），槽必须立刻归还。漏还则 concurrency:1
// 的 bot 从此静默不接单——新任务只在 /tasks 里堆成「排队中」，群里落了 👍 再无动静，且无人工出路
// （/stop 的无进程残留分支不碰槽位，/resume 走懒续跑本就不占槽），只能重启 bot。
test('端到端（stub）：后台运行中的进程死亡即归还槽位，排队任务照常出队开跑', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-bgdead-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const awaitingPath = join(root, 'state', 'awaiting.jsonl');
  const bLog = join(root, 'logs', 'task-om_dead_bbb222.log');
  const { ok } = await runFedListener({
    cfgPath, root, turns: 'working:等钩子|全仓测试后台跑着',
    // 收轮 400ms 后进程自杀且不给 RESULT：会话进程非终态死亡的形态
    env: { STUB_SELF_TURN: JSON.stringify({ afterMs: 400, directive: 'die' }) },
    feed: async (send) => {
      send(evLine({ message_id: 'om_dead_aaa111', message_type: 'post', thread_id: 'omt_dead_a' }));
      assert.ok(await poll(() => existsSync(awaitingPath) && readFileSync(awaitingPath, 'utf8').includes('"kind":"background"')),
        'A 应以 working 收轮并落下 background 登记');
      send(evLine({ message_id: 'om_dead_bbb222', message_type: 'post', thread_id: 'omt_dead_b' }));
      return poll(() => existsSync(bLog));
    },
  });
  assert.ok(ok, 'A 的进程已死、没有进程在烧 CPU 了，B 必须出队开跑');
  assert.deepEqual(new Store(join(root, 'state')).listQueued(), [], '队列应已清空');
  // 归还槽位不等于终态化：A 的等待态原样留着交懒续跑
  const left = readFileSync(awaitingPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(left.find((e) => e.messageId === 'om_dead_aaa111' && e.kind === 'background'),
    `A 的 background 登记应原样留存，实际：${JSON.stringify(left)}`);
  rmFixture(root);
});

// 首 token 只在指得到在册任务时才算选择子。序号分支漏了范围校验时，在册只有 1 个任务的
// `/resume 3 天后再说` 会被拆成 {index:'3'} + 正文「天后再说」，换来一句「未找到匹配的任务」，
// 正文连同那个「3」一起丢掉。
test('端到端（stub）：/resume 的越界数字首 token 当正文，不当序号', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-resnum-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  const awaitingPath = join(root, 'state', 'awaiting.jsonl');
  const first = await runListener({
    cfgPath, root, turns: 'ask:选方案 A 还是 B？',
    events: [evLine({ message_id: 'om_rn_aaa111', message_type: 'post', thread_id: 'omt_rn' })],
    until: () => existsSync(awaitingPath) && readFileSync(awaitingPath, 'utf8').includes('"waiting":true'),
  });
  assert.ok(first.ok, 'ask 后 awaiting 条目应落盘');
  // 第二程（新进程 = bot 重启）：在册恰一个任务，序号 3 越界 → 整段都是正文，走懒续跑注入
  const msgsOut = join(root, 'msgs.txt');
  const second = await runFedListener({
    cfgPath, root, turns: 'pass', env: { STUB_MSGS_OUT: msgsOut },
    feed: async (send) => {
      send(dmLine({ message_id: 'om_dm_rn1111', content: '/resume 3 天后再说' }));
      return poll(() => existsSync(msgsOut));
    },
  });
  assert.ok(second.ok, '越界序号不该把这条 /resume 挡下');
  const msgs = readFileSync(msgsOut, 'utf8');
  assert.ok(msgs.includes('（原文）：⏎3 天后再说⏎'), `正文须整段注入，实际：${msgs}`);
  assert.equal(readFileSync(larkLogPath, 'utf8').includes('未找到匹配的任务'), false);
  rmFixture(root);
});

// ▶️ 已续跑 是回执不是预告：懒续跑是 fire-and-forget，resumeTask 随后可能立刻发现现场已被人工
// 删掉而回 ❌——同一个动作两条相互矛盾的私信。
test('端到端（stub）：worktree 已不在时 /resume 只回 ❌，不先报「已续跑」', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-resgone-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  const awaitingPath = join(root, 'state', 'awaiting.jsonl');
  const first = await runListener({
    cfgPath, root, turns: 'ask:等指示',
    events: [evLine({ message_id: 'om_rg_aaa111', message_type: 'post', thread_id: 'omt_rg' })],
    until: () => existsSync(awaitingPath) && readFileSync(awaitingPath, 'utf8').includes('"waiting":true'),
  });
  assert.ok(first.ok, 'ask 后 awaiting 条目应落盘');
  const entry = JSON.parse(readFileSync(awaitingPath, 'utf8').trim());
  rmFixture(entry.worktree); // 人工删掉现场
  const beforeSecond = readFileSync(larkLogPath, 'utf8').length;
  const second = await runListener({
    cfgPath, root, turns: 'pass',
    events: [dmLine({ message_id: 'om_dm_rg1111', content: '/resume 继续' })],
    until: () => readFileSync(larkLogPath, 'utf8').includes('无法续跑'),
  });
  assert.ok(second.ok, '现场已被删应回一条 ❌');
  const calls = readFileSync(larkLogPath, 'utf8').slice(beforeSecond);
  assert.equal(calls.includes('已续跑'), false, `同一动作不得先乐观回执再打脸，实际：${calls}`);
  rmFixture(root);
});

test('端到端（stub）：私信 /tasks 列出在册任务，/stop 停掉唯一一个', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-dmstop-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  const threadsPath = join(root, 'state', 'threads.jsonl');
  const { ok } = await runFedListener({
    cfgPath, root, turns: 'hang',
    feed: async (send) => {
      send(evLine({ message_id: 'om_dmstop_1111', message_type: 'post', thread_id: 'omt_dmstop' }));
      assert.ok(await poll(() => existsSync(threadsPath) && readFileSync(threadsPath, 'utf8').includes('omt_dmstop')));
      send(dmLine({ message_id: 'om_dm_tasks11', content: '/tasks' }));
      assert.ok(await poll(() => existsSync(larkLogPath) && readFileSync(larkLogPath, 'utf8').includes('运行中')),
        '/tasks 应把运行中的任务列出来');
      send(dmLine({ message_id: 'om_dm_stop111', content: '/stop' }));
      return poll(() => existsSync(larkLogPath) && readFileSync(larkLogPath, 'utf8').includes('在册任务')
        && readFileSync(larkLogPath, 'utf8').includes('MUTE'));
    },
  });
  assert.ok(ok, '/tasks 应回列表且 /stop 应生效');
  // 已跑时长（spec §2.3）：判断任务是不是卡住了的唯一现成依据，缺了它列表只剩「它还在」。
  assert.ok(/已跑 \d+[smh]/.test(readFileSync(larkLogPath, 'utf8')), '/tasks 每行应带已跑时长');
  rmFixture(root);
});

test('控制端口被占用：listener 响亮失败退出 1，不带病常驻', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-portdup-')));
  const port = Math.floor(Math.random() * 8000) + 40000;
  const cfgPath = writeConfig(root, makeRepo(root), { controlPort: port });
  const blocker = createServer(() => {});
  await new Promise((r) => blocker.listen(port, '127.0.0.1', r));
  const out = await new Promise((res) => {
    const child = spawn(process.execPath, [SRC, cfgPath], {
      env: { ...process.env, STUB_LOG: join(root, 'lark.log'), STUB_EVENTS_FILE: '/dev/null', STUB_VERDICT: 'pass' },
    });
    let err = '';
    child.stderr.on('data', (b) => { err += b.toString(); });
    child.on('close', (code) => res({ code, err }));
  });
  blocker.close();
  assert.equal(out.code, 1);
  assert.ok(out.err.includes('控制端口'), `stderr 应点名控制端口，实际：${out.err}`);
  rmFixture(root);
});

test('端到端（stub）：无任务在册时 /stop 回执提示，不炸进程', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-noctl-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  const { ok } = await runListener({
    cfgPath, root, verdict: 'pass',
    events: [dmLine({ message_id: 'om_dm_none111', content: '/stop' })],
    until: () => existsSync(larkLogPath) && readFileSync(larkLogPath, 'utf8').includes('没有在册任务'),
  });
  assert.ok(ok);
  rmFixture(root);
});

test('端到端（stub）：控制端口提供 tasks 与 stop', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-port-')));
  const port = Math.floor(Math.random() * 8000) + 40000;
  const cfgPath = writeConfig(root, makeRepo(root), { controlPort: port });
  const threadsPath = join(root, 'state', 'threads.jsonl');
  const eventsFile = join(root, 'events.ndjson');
  writeFileSync(eventsFile, evLine({ message_id: 'om_port_111111', message_type: 'post', thread_id: 'omt_port' }) + '\n');
  const child = spawn(process.execPath, [SRC, cfgPath], {
    env: { ...process.env, STUB_LOG: join(root, 'lark-calls.log'), STUB_EVENTS_FILE: eventsFile, STUB_TURNS: 'hang' },
  });
  const closed = new Promise((res) => child.on('close', res));
  const stderr = tapStderr(child);
  const started = await poll(() => existsSync(threadsPath) && readFileSync(threadsPath, 'utf8').includes('omt_port'));
  assert.ok(started, `任务未起来，listener stderr：\n${stderr().slice(-2000)}`);
  // fetch 默认无限等：控制端口一旦不答（本用例 2026-08-05 观测到过一次），整个套件会静默挂死
  // 而不是失败，人看到的只是一个永不结束的命令。上限把它变成一次可读的失败。
  const ask = (path, init) => fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(10_000), ...init });
  const list = await (await ask('/api/tasks')).json();
  assert.equal(list.tasks.length, 1);
  assert.equal(list.tasks[0].state, 'active');
  const worktree = list.tasks[0].worktree;
  const stopped = await ask('/api/stop', { method: 'POST', body: JSON.stringify({ worktree }) });
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).was, 'active');
  await poll(async () => (await (await ask('/api/tasks')).json()).tasks.length === 0);
  child.kill('SIGTERM');
  await closed;
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
  for (const key of ['chatId', 'profile', 'larkBin', 'concurrency', 'taskTimeoutMs', 'reactions.done', 'reactions.skipped', 'reactions.context', 'reactions.stopped']) {
    assert.ok(out.err.includes(key), `stderr 应列出 ${key}，实际：${out.err}`);
  }
  // controlPort 是可省略键：这份 config 没写它，不该被算成缺键
  assert.equal(out.err.includes('controlPort'), false, `controlPort 可省略，不该进错误清单，实际：${out.err}`);
  rmFixture(root);
});

test('控制端口出厂值：config 省略即用 7659（spec 与 runbook 的口径）', async () => {
  const { DEFAULT_CONTROL_PORT } = await import('../src/listener.mjs');
  assert.equal(DEFAULT_CONTROL_PORT, 7659);
});

test('启动校验：controlPort 可省略，但给了坏值仍响亮失败', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-badport-')));
  const repo = makeRepo(root);
  // 0 漂成随机端口、非数字/小数/越界要等到 listen 才抛裸栈——都必须在 boot 一次性拦下；
  // 校验先于监听，故这几次启动都不会去绑任何端口。
  for (const bad of [0, 'x', 3.5, 70000]) {
    const cfgPath = writeConfig(root, repo, { controlPort: bad });
    const out = await new Promise((res) => {
      const child = spawn(process.execPath, [SRC, cfgPath], { env: { ...process.env } });
      let err = '';
      child.stderr.on('data', (b) => { err += b.toString(); });
      // 校验一旦漏掉这个键，`listen(0)` 会让 OS 随便派个端口、listener 就此正常常驻，
      // 本用例会挂死而不是失败。设上限把「不退出」变成一次可读的失败。
      const guard = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.on('close', (code) => { clearTimeout(guard); res({ code, err }); });
    });
    assert.equal(out.code, 1, `controlPort=${JSON.stringify(bad)} 应退出 1，实际 stderr：${out.err}`);
    assert.ok(out.err.includes('controlPort'), `stderr 应点名 controlPort，实际：${out.err}`);
  }
  rmFixture(root);
});

test('validateConfig：mrWatch 非法值被点名', () => {
  const base = {
    chatId: 'c', profile: 'p', repoPath: '/r', worktreesDir: '/w', stateDir: '/s', logsDir: '/l',
    dmOpenId: 'o', claudeBin: 'claude', larkBin: 'lark-cli',
    concurrency: 1, taskTimeoutMs: 1000, minTextLength: 10,
    reactions: { claimed: 'a', done: 'b', failed: 'c', escalate: 'd', skipped: 'e', context: 'f', stopped: 'g' },
  };
  assert.equal(validateConfig({ ...base }).length, 0);
  assert.equal(validateConfig({ ...base, mrWatch: { intervalMs: 300000, maxTriggersPerThread: 5 } }).length, 0);
  assert.ok(validateConfig({ ...base, mrWatch: { intervalMs: 0 } }).some((e) => e.includes('mrWatch.intervalMs')));
  assert.ok(validateConfig({ ...base, mrWatch: { enabled: 'yes' } }).some((e) => e.includes('mrWatch.enabled')));
  assert.ok(validateConfig({ ...base, mrWatch: 3 }).some((e) => e.includes('mrWatch')));
  assert.ok(validateConfig({ ...base, mrWatch: [] }).some((e) => e.includes('mrWatch（需对象或省略）')));
});

test('端到端（stub）：私信 /do 在办事目录起会话，不建 worktree、不入队，终态私信回执', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-do-')));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const cfgPath = writeConfig(root, makeRepo(root), { errandCwd: home });
  const larkLogPath = join(root, 'lark-calls.log');
  const cwdOut = join(root, 'cwd.txt');
  const { ok } = await runListener({
    cfgPath, root, verdict: 'pass',
    events: [dmLine({ message_id: 'om_do_111111', content: '/do 看下 ~/Downloads 有多大' })],
    until: () => existsSync(larkLogPath) && readFileSync(larkLogPath, 'utf8').includes('完成'),
    env: { STUB_CWD_OUT: cwdOut },
  });
  assert.ok(ok, '/do 应起一个办事会话并跑到终态');
  assert.equal(readFileSync(cwdOut, 'utf8').trim(), home, '办事会话的 cwd 必须是 errandCwd');
  assert.ok(existsSync(join(root, 'logs', 'task-om_do_111111.log')), '办事应有会话日志');
  assert.equal(existsSync(join(root, 'wt')), false, '办事不得创建 worktree');
  assert.equal(new Store(join(root, 'state')).size(), 0, '私信不得入队');
  const calls = readFileSync(larkLogPath, 'utf8');
  assert.ok(!calls.includes('messages-reply'), '办事全程零群消息');
  rmFixture(root);
});

// 接单表情那次飞书往返（失败时最坏两次 30s 超时）之前，办事还没进活表。这段窗口正是
// 「刚发完 /do、想反悔」的时刻：不占一格在册状态，/tasks 就会回「当前没有在册任务」。
test('端到端（stub）：接单表情还没回来时，/tasks 已能看见启动中的办事', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-do-start-')));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const cfgPath = writeConfig(root, makeRepo(root), { errandCwd: home });
  const larkLogPath = join(root, 'lark-calls.log');
  const { ok, stderr } = await runFedListener({
    cfgPath, root, turns: 'pass', env: { STUB_SLOW_API_S: '6' },
    feed: async (send) => {
      send(dmLine({ message_id: 'om_do_555555', content: '/do 看下磁盘' }));
      // 表情调用已发出（stub 先写日志再挂起）即已进入窗口
      if (!await poll(() => existsSync(larkLogPath) && readFileSync(larkLogPath, 'utf8').includes('reactions'))) return false;
      send(dmLine({ message_id: 'om_do_666666', content: '/tasks' }));
      return poll(() => readFileSync(larkLogPath, 'utf8').includes('启动中'));
    },
  });
  assert.ok(ok, `启动窗口内的办事应出现在 /tasks 里：\n${stderr?.().slice(-800)}`);
  const calls = readFileSync(larkLogPath, 'utf8');
  assert.ok(calls.includes('办事'), '列表里应标出这是办事');
  assert.ok(calls.includes('看下磁盘'), '标题取办事正文首行');
  // 办事那一行的第二格是目录：启动窗口里同样得给出来，否则只剩一个光秃秃的徽标
  assert.ok(calls.includes(home), `启动中的办事也要报目录：${calls.split('\n').find((l) => l.includes('启动中'))}`);
  rmFixture(root);
});

// Round 1 的解析测试直接调 parseErrand，绕过了 normalize→handleDm 这段真实链路。正文保真要
// 端到端成立才算数：飞书事件里的缩进与制表符必须原样出现在会话首轮 prompt 里。
test('端到端（stub）：/do 正文经 normalize 到首轮 prompt 逐字节保真', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-do-fidelity-')));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const cfgPath = writeConfig(root, makeRepo(root), { errandCwd: home });
  const promptOut = join(root, 'prompt.txt');
  const body = '按这个顺序来：\n\n  1. 先看日志\n\tgrep -n ERROR app.log\n  2. 再看磁盘';
  const { ok } = await runListener({
    cfgPath, root, verdict: 'pass',
    events: [dmLine({ message_id: 'om_do_777777', content: `/do ${body}` })],
    until: () => existsSync(promptOut),
    env: { STUB_PROMPT_OUT: promptOut },
  });
  assert.ok(ok, '办事会话应拿到首轮 prompt');
  assert.equal(errandBodyIn(readFileSync(promptOut, 'utf8')), body, '正文被改动了');
  rmFixture(root);
});

// 「原样」的边界在整条消息之内：事件层统一去掉首尾空白（与群任务同一套），末尾空行到不了
// parseErrand。把它钉住，免得日后有人照着「原样保留」四个字去改 normalize。
test('端到端（stub）：消息末尾的空行在事件层已去掉，不进办事正文', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-do-trailing-')));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const cfgPath = writeConfig(root, makeRepo(root), { errandCwd: home });
  const promptOut = join(root, 'prompt.txt');
  const { ok } = await runListener({
    cfgPath, root, verdict: 'pass',
    events: [dmLine({ message_id: 'om_do_888888', content: '/do 首行\n  第二行缩进\n\n' })],
    until: () => existsSync(promptOut),
    env: { STUB_PROMPT_OUT: promptOut },
  });
  assert.ok(ok, '办事会话应拿到首轮 prompt');
  assert.equal(errandBodyIn(readFileSync(promptOut, 'utf8')), '首行\n  第二行缩进',
    '行首缩进要保留，末尾空行不该进正文');
  rmFixture(root);
});

test('端到端（stub）：/do 无正文只回用法，不起会话', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-do-empty-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  const { ok } = await runListener({
    cfgPath, root, verdict: 'pass',
    events: [dmLine({ message_id: 'om_do_222222', content: '/do' })],
    until: () => existsSync(larkLogPath) && readFileSync(larkLogPath, 'utf8').includes('/do <要做的事>'),
  });
  assert.ok(ok, '空 /do 应收到用法回执');
  const logsDir = join(root, 'logs');
  const taskLogs = existsSync(logsDir) ? readdirSync(logsDir).filter((f) => f.startsWith('task-om_do_')) : [];
  assert.deepEqual(taskLogs, [], '空 /do 不得起会话');
  rmFixture(root);
});

test('端到端（stub）：路由不到任务的私信，回执把 /do 一并指出来', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-hint-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  const { ok } = await runListener({
    cfgPath, root, verdict: 'pass',
    events: [dmLine({ message_id: 'om_hint_111111', content: '在吗' })],
    until: () => existsSync(larkLogPath) && readFileSync(larkLogPath, 'utf8').includes('/do'),
  });
  assert.ok(ok, '零任务在等时的回执应提到 /do');
  assert.ok(readFileSync(larkLogPath, 'utf8').includes('没有等待回复的任务'), '原有提示仍在');
  rmFixture(root);
});

test('端到端（stub）：在册的办事条目不占接单水位，群里的新任务照接', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-do-quota-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  // 五条在册，其中两条是办事：按需求单只算 3 个，水位（5）未满
  seedAwaiting(root, 5, (i) => (i < 2 ? { errand: true, branch: '', worktree: root, title: `办事 ${i}` } : {}));
  const { ok } = await runFedListener({
    cfgPath, root, turns: 'ask:先确认一下需求边界',
    feed: async (send) => {
      send(evLine({ message_id: 'om_dq_aaaaaa', content: '这是一个新任务，描述足够长' }));
      return poll(() => sessionUp(root, 'om_dq_aaaaaa'));
    },
  });
  assert.ok(ok, '办事条目不该把接单水位垫满');
  assert.equal(readFileSync(larkLogPath, 'utf8').includes('先不接新单'), false, '不得被拒单');
  rmFixture(root);
});

// 两个前置都要真的成立：水位靠四条残留 + 一条真跑起来的群任务垫满（共 5），并发靠那条群任务
// 占住唯一的槽（turns=hang，永不产出 RESULT）。只 seed awaiting 不起进程的话 running 恒为 0，
// 「并发占满」就是句空话——那样即使日后给 launchErrand 加上一条按 concurrency 拒绝的分支也照样绿。
test('端到端（stub）：任务把水位与并发都占满时，/do 照常起会话', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-do-busy-')));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const cfgPath = writeConfig(root, makeRepo(root), { errandCwd: home });
  const larkLogPath = join(root, 'lark-calls.log');
  seedAwaiting(root, 4);
  const { ok, stderr } = await runFedListener({
    cfgPath, root, turns: 'hang',
    feed: async (send) => {
      send(evLine({ message_id: 'om_busy_111111', message_type: 'post', thread_id: 'omt_busy' }));
      // 群任务进了活跃轮次：concurrency=1 已被它占满，在册也随之满 5
      if (!await poll(() => sessionUp(root, 'om_busy_111111'))) return false;
      send(dmLine({ message_id: 'om_do_333333', content: '/do 看下磁盘' }));
      return poll(() => sessionUp(root, 'om_do_333333'));
    },
  });
  assert.ok(ok, `满水位满并发下 /do 仍应起会话：\n${stderr?.().slice(-800)}`);
  const calls = readFileSync(larkLogPath, 'utf8');
  assert.equal(calls.includes('先不接新单'), false, '/do 不得走拒单通道');
  // 那条群任务还挂在活跃轮次里：办事不是等它让出槽位才跑起来的
  const busyLog = readFileSync(join(root, 'logs', 'task-om_busy_111111.log'), 'utf8');
  assert.equal(busyLog.includes('RESULT '), false, '群任务应仍在活跃轮次（未产出终态）');
  rmFixture(root);
});

// 终态一旦选定，条目就该立刻销账：回执要走几次飞书往返（办事那条还带退避重试），这段时间里
// 若还能从旧条目看到「等回复」，人一个 /stop 就会拿到「已停止」，而回执路径仍在投「已完成」。
test('端到端（stub）：办事终态回执在途时，旧等待条目已销账，/stop 不再当残留态处置', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-do-terminal-')));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const cfgPath = writeConfig(root, makeRepo(root), { errandCwd: home });
  const larkLogPath = join(root, 'lark-calls.log');
  const awaitingPath = join(root, 'state', 'awaiting.jsonl');
  const { ok, stderr } = await runFedListener({
    cfgPath, root, turns: 'ask:要连子目录一起算吗;pass:Downloads 占 42G',
    // 只卡「办事完成」那一条：/tasks 与 /stop 的回执要能照常送达，否则拿不到判据
    env: { STUB_SLOW_IM_S: '8', STUB_SLOW_IM_MATCH: '办事完成' },
    feed: async (send) => {
      send(dmLine({ message_id: 'om_do_999999', content: '/do 看下 Downloads' }));
      if (!await poll(() => existsSync(awaitingPath) && readFileSync(awaitingPath, 'utf8').includes('"waiting":true'))) return false;
      send(dmLine({ message_id: 'om_dm_ans111', content: '算上子目录' })); // 单条在等，直发即路由
      // 判据必须落在窗口里：stub 在挂起前写下调用行，日志里出现「办事完成」即说明回执正卡在往返中。
      // 等到窗口过去再问就没有分辨力了——那时两版行为一致。
      if (!await poll(() => readFileSync(larkLogPath, 'utf8').includes('办事完成'))) return false;
      assert.equal(readFileSync(awaitingPath, 'utf8').trim(), '', '终态选定即销账，不该等回执发完');
      send(dmLine({ message_id: 'om_dm_ck1111', content: '/stop' }));
      return poll(() => readFileSync(larkLogPath, 'utf8').includes('当前没有在册任务'));
    },
  });
  assert.ok(ok, `终态在途时 /stop 应回「当前没有在册任务」：\n${stderr?.().slice(-800)}`);
  const calls = readFileSync(larkLogPath, 'utf8');
  assert.equal(calls.includes('办事已停止'), false, '销账之后不该再按残留态回一句「已停止」');
  // stub 在挂起前就写下调用行，故这条断言的是「完成回执确已发出」——正是它在途的那段窗口
  assert.ok(calls.includes('办事完成'), '完成回执应已发出（本用例观测的就是它在途那段）');
  rmFixture(root);
});

test('端到端（stub）：/tasks 把办事条目与需求任务区分开', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-do-tasks-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  seedAwaiting(root, 2, (i) => (i === 0 ? { errand: true, branch: '', worktree: root, title: '清一下 tmp' } : {}));
  const { ok } = await runListener({
    cfgPath, root, verdict: 'pass',
    events: [dmLine({ message_id: 'om_do_444444', content: '/tasks' })],
    until: () => existsSync(larkLogPath) && readFileSync(larkLogPath, 'utf8').includes('清一下 tmp'),
  });
  assert.ok(ok, '/tasks 应列出办事条目');
  const calls = readFileSync(larkLogPath, 'utf8');
  assert.ok(calls.includes('办事'), `办事条目应有可辨识的标记：${calls}`);
  assert.ok(calls.includes('旧任务 1'), '需求任务照常列出');
  rmFixture(root);
});

test('validateConfig：maxOpenTasks / botName 可省略，给了则须合法', () => {
  const base = {
    chatId: 'c', profile: 'p', repoPath: '/r', worktreesDir: '/w', stateDir: '/s', logsDir: '/l',
    dmOpenId: 'o', claudeBin: 'claude', larkBin: 'lark-cli',
    concurrency: 1, taskTimeoutMs: 1000, minTextLength: 10,
    reactions: { claimed: 'a', done: 'b', failed: 'c', escalate: 'd', skipped: 'e', context: 'f', stopped: 'g' },
  };
  assert.equal(validateConfig({ ...base, maxOpenTasks: 5, botName: 'harness-ceilf6' }).length, 0);
  // 0 与负数会让 bot 一单不接、群里只剩拒单回复：静默失败形态，必须在 boot 时点名
  assert.ok(validateConfig({ ...base, maxOpenTasks: 0 }).some((e) => e.includes('maxOpenTasks')));
  assert.ok(validateConfig({ ...base, maxOpenTasks: 2.5 }).some((e) => e.includes('maxOpenTasks')));
  assert.ok(validateConfig({ ...base, botName: '' }).some((e) => e.includes('botName')));
  assert.ok(validateConfig({ ...base, botName: 7 }).some((e) => e.includes('botName')));
});

test('validateConfig：errandCwd 可省略（省略即家目录），给了则须非空字符串', () => {
  const base = {
    chatId: 'c', profile: 'p', repoPath: '/r', worktreesDir: '/w', stateDir: '/s', logsDir: '/l',
    dmOpenId: 'o', claudeBin: 'claude', larkBin: 'lark-cli',
    concurrency: 1, taskTimeoutMs: 1000, minTextLength: 10,
    reactions: { claimed: 'a', done: 'b', failed: 'c', escalate: 'd', skipped: 'e', context: 'f', stopped: 'g' },
  };
  assert.equal(validateConfig({ ...base, errandCwd: '/Users/me' }).length, 0);
  assert.ok(validateConfig({ ...base, errandCwd: '' }).some((e) => e.includes('errandCwd')));
  assert.ok(validateConfig({ ...base, errandCwd: 7 }).some((e) => e.includes('errandCwd')));
});
