# harness-ceilf6-bot 私信问答回路（DM ask-loop）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** bot 的 claude 会话在任何拿不准的点以 `ask` 停轮等用户飞书私信回复、回复实时注入续跑；群里零文字消息；支持 `/model` `/effort` 斜杠命令；重启后懒续跑兜底。

**Architecture:** runner 从「一次性 `claude -p` 等退出」改为长驻会话进程（`--input-format stream-json` 多轮 stdin），每轮 result 事件分流（终态 / ask 挂起 / API 错误挂起 / 纠偏）；listener 新增私信路由与斜杠命令通道；awaiting.jsonl 持久化等待态，`claude --resume` 实现懒续跑。设计真源：`docs/superpowers/specs/2026-08-04-bot-dm-ask-loop-design.md`。

**Tech Stack:** Node ≥ 20.11 纯 ESM `.mjs`、零依赖、`node --test` + 可执行 stub（`tests/stubs/claude`、`tests/stubs/lark-cli`）。

## Global Constraints

- 工作分支：开工先 `git checkout -b feat/bot-dm-ask-loop`（当前在 main，不允许直接提交 main）。
- **绝不 `git add`**：`harness-ceilf6-bot/config.json`（含个人 open_id）、`docs/superpowers/**`（用户偏好：spec/plan 不提交）、`harness-ceilf6-bot/state/**`、`harness-ceilf6-bot/logs/**`。
- 测试命令（仓库根执行，glob 必须带引号）：`node --test 'harness-ceilf6-bot/tests/**/*.test.mjs'`。
- 注释纪律（用户全局偏好）：只写现状与约束，禁止 diff 叙事（「不再/原来/改为」）。
- 群消息上只允许表情回应（addReaction/deleteReaction），禁止任何 `replyInThread` 文字消息；状态表情恒为恰好一个（先打新、再撤旧）。
- claude CLI 实测契约（2026-08-04 冒烟钉死，直接照用）：
  - spawn：`claude -p --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions [--name <n> | --resume <session_id>] [--model <m>] [--effort <e>]`
  - stdin 注入一轮：一行 `{"type":"user","message":{"role":"user","content":"…"}}`
  - stdout 事件（换行分隔 JSON）：`{"type":"system","subtype":"init","session_id":"…"}`；每轮末 `{"type":"result","is_error":<bool>,"result":"<本轮最终文本>","session_id":"…"}`
  - stdin `end()` 后进程退出 code 0；`--resume` + 同参数续会话历史无损。
- 最终合并前 squash 成单个实质性 commit（用户偏好），本计划中间 commit 均为过程记录。

---

### Task 1: result.mjs 支持 ask verdict

**Files:**
- Modify: `harness-ceilf6-bot/src/result.mjs`
- Test: `harness-ceilf6-bot/tests/core.test.mjs`

**Interfaces:**
- Produces: `parseResult(stdout)` 额外接受 `verdict:'ask'`，返回对象带 `question` 字段（JSON 里有就有）。VERDICTS 集合 = `skip|ask|escalate|pass|fail|fused`。

- [ ] **Step 0: 建分支**

```bash
git checkout -b feat/bot-dm-ask-loop
```

- [ ] **Step 1: 写失败测试**（追加到 `core.test.mjs` 末尾）

```js
test('parseResult 接受 ask verdict 并带出 question', () => {
  const out = 'RESULT {"verdict":"ask","question":"选 A 还是 B？\\n背景：…"}';
  const r = parseResult(out);
  assert.equal(r.verdict, 'ask');
  assert.ok(r.question.includes('选 A 还是 B'));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test 'harness-ceilf6-bot/tests/core.test.mjs'`
Expected: 新用例 FAIL（`parseResult` 返回 null——ask 不在 VERDICTS）。

- [ ] **Step 3: 实现**（`result.mjs` 第 2 行）

```js
const VERDICTS = new Set(['skip', 'ask', 'escalate', 'pass', 'fail', 'fused']);
```

首行注释同步为现状陈述：

```js
// RESULT 契约解析：stdout 中最后一个 `RESULT ` 前缀行；坏 JSON / 非法 verdict → null（按 fail 处理）。
// ask 是中间态（等用户私信回复），其余为终态；escalate/fused 仅旧会话兼容。
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test 'harness-ceilf6-bot/tests/core.test.mjs'`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add harness-ceilf6-bot/src/result.mjs harness-ceilf6-bot/tests/core.test.mjs
git commit -m "feat(bot): RESULT 契约新增 ask verdict"
```

---

### Task 2: commands.mjs 斜杠命令解析

**Files:**
- Create: `harness-ceilf6-bot/src/commands.mjs`
- Test: `harness-ceilf6-bot/tests/commands.test.mjs`（新文件）

**Interfaces:**
- Produces:
  - `parseDmReply(text) → { flags: Array<[flag, value]>, unknown: string[], body: string }`——消息开头连续的 `/名 参数` 行为命令，其余为正文。
  - `mergeFlags(oldFlat: string[], newPairs: Array<[flag, value]>) → string[]`（扁平数组，同名后写覆盖）。
  - `SUPPORTED_HINT`：回执用命令支持说明字符串。

- [ ] **Step 1: 写失败测试**（新文件 `tests/commands.test.mjs`）

```js
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
test('mergeFlags 同名后写覆盖、异名并存', () => {
  assert.deepEqual(mergeFlags(['--model', 'fable'], [['--model', 'opus']]), ['--model', 'opus']);
  assert.deepEqual(mergeFlags(['--model', 'opus'], [['--effort', 'xhigh']]), ['--model', 'opus', '--effort', 'xhigh']);
});
test('SUPPORTED_HINT 列出支持的命令', () => {
  assert.ok(SUPPORTED_HINT.includes('/model'));
  assert.ok(SUPPORTED_HINT.includes('/effort'));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test 'harness-ceilf6-bot/tests/commands.test.mjs'`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `src/commands.mjs`**

```js
// 私信斜杠命令通道：消息开头的连续 `/名 参数` 行是控制命令（不喂给会话），其余为回复正文。
// 映射表是唯一扩展点：命令名 → claude CLI 参数；表外或缺参命令整条消息拒绝注入，由调用方回执。
const COMMAND_FLAGS = { model: '--model', effort: '--effort' };

export const SUPPORTED_HINT = '当前支持：/model <名>、/effort <级>';

export function parseDmReply(text) {
  const lines = String(text ?? '').split('\n');
  const flags = [];
  const unknown = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('/')) break;
    const [name, ...rest] = line.slice(1).split(/\s+/);
    const value = rest.join(' ');
    if (COMMAND_FLAGS[name] && value) flags.push([COMMAND_FLAGS[name], value]);
    else unknown.push(`/${name}`);
  }
  return { flags, unknown, body: lines.slice(i).join('\n').trim() };
}

// resumeFlags 以扁平数组持久化（直接可拼进 spawn argv）；同名 flag 后写覆盖先写。
export function mergeFlags(oldFlat, newPairs) {
  const m = new Map();
  for (let i = 0; i + 1 < oldFlat.length; i += 2) m.set(oldFlat[i], oldFlat[i + 1]);
  for (const [f, v] of newPairs) m.set(f, v);
  return [...m].flat();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test 'harness-ceilf6-bot/tests/commands.test.mjs'`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add harness-ceilf6-bot/src/commands.mjs harness-ceilf6-bot/tests/commands.test.mjs
git commit -m "feat(bot): 私信斜杠命令解析（/model /effort → 续跑参数）"
```

---

### Task 3: claude stub 重写（stream-json 协议）+ session.mjs 会话进程封装

**Files:**
- Rewrite: `harness-ceilf6-bot/tests/stubs/claude`（bash → node）
- Create: `harness-ceilf6-bot/src/session.mjs`
- Test: `harness-ceilf6-bot/tests/session.test.mjs`（新文件）

**Interfaces:**
- Produces（session.mjs）:
  - `startSession({ bin, cwd, name, logPath, timeoutMs, killGraceMs, resumeSessionId, extraFlags, onEvent }) → handle`
  - `handle = { alive: bool, sessionId: string, pid, send(text), endInput(), kill() }`
  - `onEvent` 收到三种事件：`{kind:'turn', isError, text, sessionId}`（每轮 result）、`{kind:'timeout'}`（每轮墙钟超时，已对进程组 SIGTERM）、`{kind:'close', code}`。
  - `killActiveChildren()`（进程组收割，语义同旧 runner 导出）。
  - 超时语义：`send()` 起臂 `timeoutMs`，收到 result 事件停表；两轮之间（等回复）无计时。
- Produces（stub claude）：环境变量协议——`STUB_TURNS`（分号分隔逐轮指令：`pass|skip|fail|escalate|fused|noresult|garbage|hang|ask:<question>|error:<text>`，超出用最后一条）、`STUB_VERDICT`（旧名兼容，等价单指令）、`STUB_ARGS_OUT`（argv 落盘）、`STUB_PROMPT_OUT`（首条注入消息）、`STUB_MSGS_OUT`（全部注入消息逐行追加，消息内换行替换为 `⏎`）、`STUB_SESSION_ID`（默认 `sess_stub_1`）。

- [ ] **Step 1: 重写 stub `tests/stubs/claude`**（保持文件名与可执行位）

```js
#!/usr/bin/env node
// 假 claude（stream-json 长驻协议）：启动即发 init 事件；每收到一条 user 消息按 STUB_TURNS
// 第 N 条指令回一个 result 事件（超出用最后一条）；stdin 关闭即退出。
// hang 指令不回 result（进程仍活着），用于触发每轮超时。STUB_VERDICT 是单指令旧名。
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (process.env.STUB_ARGS_OUT) writeFileSync(process.env.STUB_ARGS_OUT, args.join('\n') + '\n');
const turns = (process.env.STUB_TURNS ?? process.env.STUB_VERDICT ?? 'pass').split(';');
const SESSION = process.env.STUB_SESSION_ID ?? 'sess_stub_1';
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let n = 0;
emit({ type: 'system', subtype: 'init', session_id: SESSION });
createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const content = String(msg?.message?.content ?? '');
  if (n === 0 && process.env.STUB_PROMPT_OUT) writeFileSync(process.env.STUB_PROMPT_OUT, content);
  if (process.env.STUB_MSGS_OUT) appendFileSync(process.env.STUB_MSGS_OUT, content.replaceAll('\n', '⏎') + '\n');
  const directive = turns[Math.min(n, turns.length - 1)];
  n++;
  const [kind, ...rest] = directive.split(':');
  const arg = rest.join(':');
  if (kind === 'hang') return;
  if (kind === 'error') { emit({ type: 'result', is_error: true, result: arg || '假 API 错误', session_id: SESSION }); return; }
  const finalLine = {
    pass: 'RESULT {"verdict":"pass","branch":"b","mr_url":"https://mr/9","summary":"完成"}',
    skip: 'RESULT {"verdict":"skip","reason":"闲聊"}',
    fail: 'RESULT {"verdict":"fail","reason":"跑挂了"}',
    escalate: 'RESULT {"verdict":"escalate","reason":"需求不明确"}',
    fused: 'RESULT {"verdict":"fused","reason":"CR 熔断"}',
    noresult: '没有结果行',
    garbage: '没有结果行',
    ask: `RESULT {"verdict":"ask","question":${JSON.stringify(arg || '缺信息')}}`,
  }[kind] ?? `RESULT {"verdict":"${kind}"}`;
  emit({ type: 'result', is_error: false, result: `过程输出\n${finalLine}`, session_id: SESSION });
});
process.stdin.on('end', () => process.exit(0));
```

```bash
chmod +x harness-ceilf6-bot/tests/stubs/claude
```

- [ ] **Step 2: 写失败测试**（新文件 `tests/session.test.mjs`）

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startSession, killActiveChildren } from '../src/session.mjs';

const CLAUDE_STUB = resolve(import.meta.dirname, 'stubs/claude');
const rmFixture = (root) => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
function collect() { const evs = []; return { evs, onEvent: (e) => evs.push(e) }; }
async function poll(fn, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
}
function setup(over = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-sess-')));
  const { evs, onEvent } = collect();
  return { root, evs, opts: { bin: CLAUDE_STUB, cwd: root, name: '会话名', logPath: join(root, 's.log'), timeoutMs: 60_000, killGraceMs: 500, onEvent, ...over } };
}

test('多轮：两次 send 各得一个 turn 事件，init 带出 sessionId，消息记录在案', async () => {
  const { root, evs, opts } = setup();
  process.env.STUB_TURNS = 'ask:问题一;pass';
  process.env.STUB_MSGS_OUT = join(root, 'msgs.txt');
  process.env.STUB_ARGS_OUT = join(root, 'args.txt');
  const h = startSession(opts);
  h.send('第一条');
  await poll(() => evs.some((e) => e.kind === 'turn'));
  h.send('第二条');
  await poll(() => evs.filter((e) => e.kind === 'turn').length === 2);
  h.endInput();
  await poll(() => evs.some((e) => e.kind === 'close'));
  const turns = evs.filter((e) => e.kind === 'turn');
  assert.equal(turns.length, 2);
  assert.ok(turns[0].text.includes('"verdict":"ask"'));
  assert.equal(turns[0].isError, false);
  assert.equal(turns[0].sessionId, 'sess_stub_1');
  assert.ok(turns[1].text.includes('"verdict":"pass"'));
  assert.equal(h.alive, false);
  const args = readFileSync(join(root, 'args.txt'), 'utf8').split('\n');
  assert.ok(args.includes('--input-format') && args.includes('stream-json'));
  assert.equal(args[args.indexOf('--name') + 1], '会话名');
  assert.equal(readFileSync(join(root, 'msgs.txt'), 'utf8').trim().split('\n').length, 2);
  delete process.env.STUB_MSGS_OUT; delete process.env.STUB_ARGS_OUT; delete process.env.STUB_TURNS;
  rmFixture(root);
});

test('error 指令：turn 事件 isError=true 且带错误文本', async () => {
  const { root, evs, opts } = setup();
  process.env.STUB_TURNS = 'error:usage limit reached';
  const h = startSession(opts);
  h.send('x');
  await poll(() => evs.some((e) => e.kind === 'turn'));
  assert.equal(evs.find((e) => e.kind === 'turn').isError, true);
  assert.ok(evs.find((e) => e.kind === 'turn').text.includes('usage limit'));
  h.kill();
  await poll(() => evs.some((e) => e.kind === 'close'));
  delete process.env.STUB_TURNS;
  rmFixture(root);
});

test('每轮超时：hang 轮触发 timeout 事件并收割进程组；等待期（不 send）不计时', async () => {
  const { root, evs, opts } = setup({ timeoutMs: 800 });
  process.env.STUB_TURNS = 'ask:q;hang';
  const h = startSession(opts);
  h.send('第一轮');
  await poll(() => evs.some((e) => e.kind === 'turn'));
  await new Promise((r) => setTimeout(r, 1200)); // 挂起超过 timeoutMs：不得出现 timeout
  assert.equal(evs.some((e) => e.kind === 'timeout'), false, '等待期不计时');
  h.send('第二轮（hang）');
  await poll(() => evs.some((e) => e.kind === 'timeout'), 5000);
  assert.ok(evs.some((e) => e.kind === 'timeout'));
  await poll(() => evs.some((e) => e.kind === 'close'));
  delete process.env.STUB_TURNS;
  rmFixture(root);
});

test('resume 形态：--resume <id> 且不带 --name', async () => {
  const { root, evs, opts } = setup({ resumeSessionId: 'sess_prev_9' });
  process.env.STUB_TURNS = 'pass';
  process.env.STUB_ARGS_OUT = join(root, 'args.txt');
  const h = startSession(opts);
  h.send('续跑');
  await poll(() => evs.some((e) => e.kind === 'turn'));
  h.endInput();
  await poll(() => evs.some((e) => e.kind === 'close'));
  const args = readFileSync(join(root, 'args.txt'), 'utf8').split('\n');
  assert.equal(args[args.indexOf('--resume') + 1], 'sess_prev_9');
  assert.equal(args.includes('--name'), false);
  delete process.env.STUB_ARGS_OUT; delete process.env.STUB_TURNS;
  rmFixture(root);
});

test('extraFlags 透传进 argv', async () => {
  const { root, evs, opts } = setup({ extraFlags: ['--model', 'opus'] });
  process.env.STUB_TURNS = 'pass';
  process.env.STUB_ARGS_OUT = join(root, 'args.txt');
  const h = startSession(opts);
  h.send('x');
  await poll(() => evs.some((e) => e.kind === 'turn'));
  h.endInput();
  await poll(() => evs.some((e) => e.kind === 'close'));
  const args = readFileSync(join(root, 'args.txt'), 'utf8').split('\n');
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  delete process.env.STUB_ARGS_OUT; delete process.env.STUB_TURNS;
  rmFixture(root);
});

test('killActiveChildren 收割存活会话', async () => {
  const { root, evs, opts } = setup();
  process.env.STUB_TURNS = 'hang';
  const h = startSession(opts);
  h.send('x');
  await new Promise((r) => setTimeout(r, 200));
  killActiveChildren();
  await poll(() => evs.some((e) => e.kind === 'close'));
  assert.equal(h.alive, false);
  delete process.env.STUB_TURNS;
  rmFixture(root);
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node --test 'harness-ceilf6-bot/tests/session.test.mjs'`
Expected: FAIL（session.mjs 不存在）。

- [ ] **Step 4: 实现 `src/session.mjs`**

```js
// claude 长驻会话进程封装：stream-json 多轮输入输出。
// 事件形状（2026-08-04 对真 CLI 冒烟钉死）：
//   init  {"type":"system","subtype":"init","session_id":"…"}
//   轮末  {"type":"result","is_error":<bool>,"result":"<本轮最终文本>","session_id":"…"}
//   注入  stdin 一行 {"type":"user","message":{"role":"user","content":"…"}}
// 超时是每轮墙钟：send() 起臂，收到 result 事件停表；等待人工回复期间无计时。
// detached 子进程自成会话组长：bot 关停时必须显式对各活跃进程组补刀，否则孤儿一个跑着的 claude。
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

const activePids = new Set();
export function killActiveChildren() {
  for (const pid of activePids) {
    try { process.kill(-pid, 'SIGTERM'); } catch { /* 进程组已消失 */ }
  }
}

export function startSession({ bin, cwd, name, logPath, timeoutMs, killGraceMs, resumeSessionId, extraFlags = [], onEvent }) {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  if (resumeSessionId) args.push('--resume', resumeSessionId); // 续跑会话已有名字，--name 不再适用
  else if (name) args.push('--name', name);
  args.push(...extraFlags);
  const child = spawn(bin, args, { cwd, detached: true });
  if (child.pid) activePids.add(child.pid); // spawn 失败时 pid 为 undefined，不登记
  const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { /* 进程组已消失 */ } };
  const log = createWriteStream(logPath, { flags: 'a' });
  // 写流无监听时 ENOSPC 等写错误会以未处理 'error' 事件崩掉常驻进程。
  log.on('error', (e) => console.error(`[session] 日志写入失败：${e.message}`));
  let killer = null;
  let sigkill = null;
  const disarm = () => { clearTimeout(killer); clearTimeout(sigkill); killer = sigkill = null; };
  const handle = {
    alive: true,
    sessionId: resumeSessionId ?? '',
    pid: child.pid,
    send(text) {
      try { child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'); } catch { /* 进程已死：close 事件走分发 */ }
      disarm();
      killer = setTimeout(() => {
        killGroup('SIGTERM');
        sigkill = setTimeout(() => killGroup('SIGKILL'), killGraceMs ?? 10_000);
        sigkill.unref();
        onEvent({ kind: 'timeout' });
      }, timeoutMs);
    },
    endInput() { try { child.stdin.end(); } catch { /* 已关闭 */ } },
    kill() { killGroup('SIGTERM'); },
  };
  let buf = '';
  child.stdout.on('data', (b) => {
    log.write(b);
    buf += b.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let ev;
      try { ev = JSON.parse(line); } catch { continue; } // 非 JSON 行只进日志
      if (ev?.type === 'system' && ev.subtype === 'init') handle.sessionId = ev.session_id ?? handle.sessionId;
      if (ev?.type === 'result') {
        disarm();
        onEvent({ kind: 'turn', isError: !!ev.is_error, text: String(ev.result ?? ''), sessionId: handle.sessionId });
      }
    }
  });
  child.stderr.on('data', (b) => log.write(b));
  // 不挂 error 监听时 spawn 失败会以未处理 'error' 事件炸掉整个进程；挂上后 'close' 仍会触发。
  child.on('error', (e) => log.write(`[session] spawn 失败：${e.message}\n`));
  child.on('close', (code) => {
    activePids.delete(child.pid);
    handle.alive = false;
    disarm();
    log.end();
    onEvent({ kind: 'close', code });
  });
  return handle;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test 'harness-ceilf6-bot/tests/session.test.mjs'`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add harness-ceilf6-bot/src/session.mjs harness-ceilf6-bot/tests/session.test.mjs harness-ceilf6-bot/tests/stubs/claude
git commit -m "feat(bot): stream-json 长驻会话封装 + claude stub 重写"
```

---

### Task 4: state.mjs awaiting 登记表

**Files:**
- Modify: `harness-ceilf6-bot/src/state.mjs`
- Test: `harness-ceilf6-bot/tests/core.test.mjs`

**Interfaces:**
- Produces（Store 新方法）:
  - `recordAsk(messageId, info)`：info 含 `{threadId, branch, worktree, sessionId, question, questionMsgId, statusRid, title}`；跨轮保留既有条目（追加 questionMsgIds、保留 resumeFlags），置 `waiting:true`、刷新 `askedAt`。
  - `findAwaiting(messageId) → entry | null`；`findAwaitingByQuestionMsg(msgId) → entry | null`
  - `listWaiting() → entry[]`（仅 waiting=true）
  - `patchAwaiting(messageId, patch) → bool`；`dropAwaiting(messageId) → bool`
  - 持久化文件 `state/awaiting.jsonl`（全量重写，同 threads.jsonl 模式）。

- [ ] **Step 1: 写失败测试**（追加到 `core.test.mjs`）

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test 'harness-ceilf6-bot/tests/core.test.mjs'`
Expected: 新增两用例 FAIL（方法不存在）。

- [ ] **Step 3: 实现**（`state.mjs`；首行注释补 awaiting 一句）

constructor 增加：

```js
this.awaitingPath = join(stateDir, 'awaiting.jsonl');
this.awaiting = new Map(this.#readEntries(this.awaitingPath)
  .filter((e) => typeof e.messageId === 'string' && e.messageId)
  .map((e) => [e.messageId, e]));
```

类内新增方法（放在 thread 方法之后）：

```js
// awaiting 登记表：等私信回复的任务（懒续跑真源）。条目跨多轮 ask 存续，终态才删。
#flushAwaiting() { this.#flushLines(this.awaitingPath, [...this.awaiting.values()]); }
recordAsk(messageId, info) {
  const prev = this.awaiting.get(messageId) ?? {};
  const { questionMsgId, ...rest } = info;
  this.awaiting.set(messageId, {
    ...prev, ...rest, messageId,
    questionMsgIds: [...(prev.questionMsgIds ?? []), ...(questionMsgId ? [questionMsgId] : [])],
    resumeFlags: prev.resumeFlags ?? [],
    waiting: true,
    askedAt: new Date().toISOString(),
  });
  this.#flushAwaiting();
}
findAwaiting(messageId) { return this.awaiting.get(messageId) ?? null; }
findAwaitingByQuestionMsg(msgId) {
  for (const e of this.awaiting.values()) if (e.questionMsgIds?.includes(msgId)) return e;
  return null;
}
listWaiting() { return [...this.awaiting.values()].filter((e) => e.waiting); }
patchAwaiting(messageId, patch) {
  const prev = this.awaiting.get(messageId);
  if (!prev) return false;
  this.awaiting.set(messageId, { ...prev, ...patch });
  this.#flushAwaiting();
  return true;
}
dropAwaiting(messageId) {
  if (!this.awaiting.delete(messageId)) return false;
  this.#flushAwaiting();
  return true;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test 'harness-ceilf6-bot/tests/core.test.mjs'`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add harness-ceilf6-bot/src/state.mjs harness-ceilf6-bot/tests/core.test.mjs
git commit -m "feat(bot): awaiting.jsonl 等待态登记表"
```

---

### Task 5: lark.sendDm 返回 message_id

**Files:**
- Modify: `harness-ceilf6-bot/src/lark.mjs`（仅 sendDm）
- Modify: `harness-ceilf6-bot/tests/stubs/lark-cli`（im 分支响应）
- Test: `harness-ceilf6-bot/tests/lark.test.mjs`

**Interfaces:**
- Produces: `lark.sendDm(openId, text) → message_id 字符串（成功）| null（失败）`。既有调用方忽略返回值不受影响（真值语义保持：成功即 truthy——lark-cli 实际总返回非空 message_id）。

- [ ] **Step 1: 改测试**（`lark.test.mjs` 第三个用例中 sendDm 断言）

```js
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
```

- [ ] **Step 2: 改 stub `tests/stubs/lark-cli` 的 im 分支**（每次调用回不同 message_id，供引用匹配断言）

```bash
  im) echo "{\"ok\":true,\"data\":{\"message_id\":\"om_send_${calls}\"}}" ;;
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node --test 'harness-ceilf6-bot/tests/lark.test.mjs'`
Expected: sendDm 用例 FAIL（返回 true 而非 message_id）。

- [ ] **Step 4: 实现**（`lark.mjs` sendDm）

```js
    async sendDm(openId, text) {
      const res = await call(['im', '+messages-send', '--user-id', openId,
        '--msg-type', 'text', '--content', JSON.stringify({ text })]);
      if (!res?.ok) { console.error(`[lark] sendDm 失败 ${openId}`); return null; }
      // message_id 供 awaiting 登记做「引用回复」匹配；调用方不关心时忽略即可。
      return res.data?.message_id ?? '';
    },
```

- [ ] **Step 5: 跑全量测试确认通过**（listener 端到端也用该 stub）

Run: `node --test 'harness-ceilf6-bot/tests/**/*.test.mjs'`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add harness-ceilf6-bot/src/lark.mjs harness-ceilf6-bot/tests/lark.test.mjs harness-ceilf6-bot/tests/stubs/lark-cli
git commit -m "feat(bot): sendDm 返回 message_id 供引用路由"
```

---

### Task 6: normalize + filter 私信路由三态

**Files:**
- Modify: `harness-ceilf6-bot/src/normalize.mjs`、`harness-ceilf6-bot/src/filter.mjs`
- Modify: `harness-ceilf6-bot/src/listener.mjs`（仅静默 reason 判断一行）
- Test: `harness-ceilf6-bot/tests/core.test.mjs`

**Interfaces:**
- Produces: `normalize` 返回对象新增 `chatType`（`raw.chat_type ?? raw.message?.chat_type ?? ''`）。`decide` 新增出口 `{action:'dm'}`；新增 ignore reason `other-dm`（静默，同 other-chat）。群链路三态完全不变。

- [ ] **Step 1: 写失败测试**（追加到 `core.test.mjs`）

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test 'harness-ceilf6-bot/tests/core.test.mjs'`
Expected: 新用例 FAIL。

- [ ] **Step 3: 实现**

`normalize.mjs` 返回对象增加一行（chatId 之后）：

```js
    chatType: raw.chat_type ?? raw.message?.chat_type ?? '',
```

`filter.mjs` 在 `if (!ev)` 之后、群链路之前插入 p2p 分支：

```js
  if (ev.chatType === 'p2p') {
    // 私聊只认配置用户本人：bot 自发的提问回执、他人私聊一律静默忽略（reason 同 other-chat 不落日志）。
    if (ev.senderOpenId !== config.dmOpenId || ev.senderType !== 'user') return { action: 'ignore', reason: 'other-dm' };
    if (ev.messageType !== 'text' && ev.messageType !== 'post') return { action: 'ignore', reason: 'non-text' };
    // 回复不设长度门槛：「好的」「用A」都是合法拍板输入。
    if (ev.text.length === 0) return { action: 'ignore', reason: 'too-short' };
    if (isProcessed(ev.messageId)) return { action: 'ignore', reason: 'duplicate' };
    return { action: 'dm' };
  }
```

`listener.mjs` 静默判断行改为：

```js
      if (d.action === 'ignore') {
        if (d.reason !== 'other-chat' && d.reason !== 'other-dm') console.error(`[listener] 忽略 ${ev?.messageId ?? '?'}（${d.reason}）`);
        return;
      }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test 'harness-ceilf6-bot/tests/**/*.test.mjs'`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add harness-ceilf6-bot/src/normalize.mjs harness-ceilf6-bot/src/filter.mjs harness-ceilf6-bot/src/listener.mjs harness-ceilf6-bot/tests/core.test.mjs
git commit -m "feat(bot): 私信事件路由三态（dm 出口）"
```

---

### Task 7: runner 重写 · 终态路径迁移到长驻会话

**Files:**
- Rewrite: `harness-ceilf6-bot/src/runner.mjs`
- Test: `harness-ceilf6-bot/tests/runner.test.mjs`（改造既有用例）

**Interfaces:**
- Consumes: `startSession/killActiveChildren`（Task 3）、`parseResult`（Task 1）。
- Produces:
  - `runTask(task, config, lark, hooks)`：签名不变，promise 在**终态**resolve `{verdict, branch, worktree, logPath}`；hooks 新增 `onAsk(info)`（本任务先定义形状、Task 8 触发）。
  - `killActiveChildren` re-export（listener 既有 import 不动）。
  - 模块级 `liveTasks: Map<messageId, rt>`（Task 8/9 的 injectReply/killSession/resumeTask 寻址用）。
  - 内部纠偏协议：无 RESULT 行→注入 `CORRECTION_MSG` 一次，连续两轮无→fail。

- [ ] **Step 1: 改造既有测试**（`runner.test.mjs`）

逐用例改动：

1. fakeLark 的 sendDm 改为返回递增 message id（Task 8 的引用登记要用）：

```js
function fakeLark(calls) {
  let n = 0;
  let m = 0;
  return {
    // 每次 add 回不同 rid：撤销的必须是接单那一枚，若都回同一个 rid，「撤错表情」的回归无从暴露。
    async addReaction(mid, key) { calls.push(['add', mid, key]); return `rid_${++n}`; },
    async deleteReaction(mid, rid) { calls.push(['del', mid, rid]); return true; },
    async replyInThread(mid, text) { calls.push(['reply', mid, text]); return true; },
    async sendDm(openId, text) { calls.push(['dm', openId, text]); return `om_dm_${++m}`; },
  };
}
```

2. 顶部补 poll 工具（与 listener.test 同款）：

```js
async function poll(fn, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
}
```

3. `escalate` 用例改名并去掉回帖断言（群里零文字消息）：

```js
test('escalate（旧契约兼容）：现场保留、⚠️、仅私信含恢复命令、零回帖', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  process.env.STUB_VERDICT = 'escalate';
  const out = await runTask(TASK, makeConfig(root, repo), fakeLark(calls));
  assert.equal(out.verdict, 'escalate');
  assert.ok(existsSync(out.worktree));
  assert.deepEqual(calls.map((c) => c[0]), ['add', 'add', 'del', 'dm']); // claimed → ⚠️ → 撤 claimed → 私信
  assert.equal(calls[1][2], 'WARN');
  assert.equal(calls[2][2], 'rid_1');
  assert.ok(calls[3][2].includes('该任务需要人工规划'));
  assert.ok(calls[3][2].includes(`cd ${out.worktree} && claude`));
  rmFixture(root);
});
```

4. `无 RESULT 行` 用例改为纠偏语义（STUB_VERDICT=garbage 每轮都无 RESULT → 纠偏 1 次后 fail）：

```js
test('无 RESULT 行：纠偏一次仍无 → fail，纠偏消息已注入会话', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  process.env.STUB_VERDICT = 'garbage';
  process.env.STUB_MSGS_OUT = join(root, 'msgs.txt');
  const out = await runTask(TASK, makeConfig(root, repo), fakeLark(calls));
  assert.equal(out.verdict, 'fail');
  assert.ok(existsSync(out.worktree)); // 保留供排查
  assert.deepEqual(calls.map((c) => c[0]), ['add', 'add', 'del', 'dm']);
  assert.equal(calls[1][2], 'CROSS');
  assert.ok(calls[3][2].includes(out.logPath));
  const msgs = readFileSync(join(root, 'msgs.txt'), 'utf8').trim().split('\n');
  assert.equal(msgs.length, 2); // bootstrap + 纠偏
  assert.ok(msgs[1].includes('RESULT'));
  delete process.env.STUB_MSGS_OUT;
  rmFixture(root);
});
```

5. 其余用例（pass/skip/超时/killActiveChildren/worktree 失败×2/onWorktreeReady×2/claudeBin 缺失/会话名）**断言不动**，仅注意：pass 用例中 `STUB_PROMPT_OUT` 现在来自首条 stdin 消息（stub 已兼容，断言原样通过）。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test 'harness-ceilf6-bot/tests/runner.test.mjs'`
Expected: 大面积 FAIL（runner 还是一次性 `-p prompt` 形态，stub 已是 stream 协议——`claude` stub 等 stdin 输入而旧 runner 只传 argv，全部超时或 fail）。

- [ ] **Step 3: 重写 `src/runner.mjs`**（全文）

```js
// 任务生命周期：worktree → 长驻 claude 会话（stream-json 多轮）→ 每轮 RESULT 分发。
// 判断在 claude 会话里；这里只有机械动作与回应。进程组收割纪律在 session.mjs。
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseResult } from './result.mjs';
import { startSession, killActiveChildren } from './session.mjs';

export { killActiveChildren };

const TPL_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'bootstrap-prompt.md');

// messageId → 运行时。挂起（等私信回复）的会话也在此登记，injectReply/killSession 按它寻址。
const liveTasks = new Map();

const REPLY_FRAME = (text) => `用户对上一轮问题的私信回复如下（原文）：\n${text}\n——继续按无人值守契约执行，本轮结束仍以 RESULT 行收尾。`;
const CORRECTION_MSG = '上一轮输出未以 RESULT 行收尾，违反无人值守契约。立即单独补发一行结果行（RESULT + 单行 JSON），不要其他内容。';

function git(repo, args) {
  return new Promise((res, rej) => {
    execFile('git', ['-C', repo, ...args], (err, stdout, stderr) => (err ? rej(new Error(stderr || err.message)) : res(stdout)));
  });
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function renderPrompt(task, branch, chatId) {
  return readFileSync(TPL_PATH, 'utf8')
    .replaceAll('{{BRANCH}}', branch)
    .replaceAll('{{SENDER}}', task.senderOpenId)
    .replaceAll('{{TIME}}', task.receivedAt)
    .replaceAll('{{CHAT_ID}}', chatId ?? '')
    .replaceAll('{{MESSAGE_ID}}', task.messageId)
    // 函数形式：任务原文是任意用户文本，字符串形式会把其中的 $&/$'/$` 当替换模式吃掉。
    // TASK_TEXT 必须最后替换——防任务文本中的 {{...}} 被二次展开。
    .replaceAll('{{TASK_TEXT}}', () => task.text);
}

// 会话名 = 任务首行按 code point 截 20（slice 字节截断会撕裂 CJK/emoji）：
// /resume 列表可辨识即可；子会话过计划门后会用 custom-title 覆盖成需求短题。
function sessionName(text) {
  return [...(text.split('\n')[0] ?? '')].slice(0, 20).join('') || 'harness 任务';
}

function truncate(s, n = 300) {
  const cs = [...String(s ?? '')];
  return cs.length > n ? cs.slice(0, n).join('') + '…' : cs.join('');
}

async function retrying(label, fn) {
  for (let i = 0; i < 3; i++) {
    try { await fn(); return true; } catch (e) {
      if (i === 2) { console.error(`[runner] ${label}（留人工）：${e.message}`); return false; }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}

// 不用 `git worktree remove --force`：它要遍历校验整棵工作树，在 byteview-web 这类巨型 monorepo 上
// 实测耗时数分钟，而 skip 是最常见路径——串行队列被它占死、终态表情迟迟不落地。`--force` 本已放弃
// 那些保护，语义上无损失，于是拆成「删目录 + prune 注册表 + 删分支」三步，各自秒级。
// prune 必须在 branch -D 之前：注册表还挂着该 worktree 时 git 认为分支仍被检出，拒绝删除。
// 三步各自有界重试而非整体重试：已成功的步骤重跑必然再失败，整体重试会让后一步永远做不成。
async function cleanupWorktree(config, worktree, branch) {
  // maxRetries 必需：本机 AI-IDE daemon 会异步往新仓写 .git/ai/，撞上时 rmSync 抛 ENOTEMPTY。
  const removed = await retrying('worktree 目录删除失败', async () => rmSync(worktree, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }));
  const pruned = await retrying('worktree 注册表 prune 失败', () => git(config.repoPath, ['worktree', 'prune']));
  const deleted = await retrying('分支删除失败', () => git(config.repoPath, ['branch', '-D', branch]));
  return removed && pruned && deleted;
}

// 状态表情不变量（2026-07-30 用户裁定）：一条被处理的消息上，本 bot 的状态表情恒为恰好一个。
// 故顺序是「先打新、再撤旧」——反过来会出现零表情窗口，而群里「没表情」等于「bot 没看见」。
// currentRid 为 null（前一动作失败）时只打新表情，不当错误处理。
async function swapReaction(lark, messageId, newKey, currentRid) {
  const rid = await lark.addReaction(messageId, newKey);
  if (currentRid) await lark.deleteReaction(messageId, currentRid);
  return rid;
}

function askDmText(rt, question) {
  return `⏳ ${rt.title} 需要你拍板\n问题：${question}\n分支：${rt.branch}\nworktree：${rt.worktree}\n直接回复本消息即可续跑；多任务在等时请引用本条回复。`;
}

async function goWaiting(rt, question) {
  rt.state = 'waiting';
  rt.correctionUsed = false;
  const qMsgId = await rt.lark.sendDm(rt.config.dmOpenId, askDmText(rt, question));
  rt.statusRid = await swapReaction(rt.lark, rt.task.messageId, rt.config.reactions.escalate, rt.statusRid);
  try {
    rt.hooks.onAsk?.({
      messageId: rt.task.messageId, threadId: rt.task.threadId ?? '', branch: rt.branch,
      worktree: rt.worktree, sessionId: rt.sessionId, question,
      questionMsgId: qMsgId || '', statusRid: rt.statusRid, title: rt.title,
    });
  } catch (e) {
    // 登记只决定「回复能否路由回来」，不该连带杀掉活着的会话。
    console.error(`[runner] onAsk 回调失败：${e.message}`);
  }
}

async function settle(rt, verdict, { why, result } = {}) {
  if (rt.settled) return;
  rt.settled = true;
  // 只删指向自己的登记：懒续跑可能已用新运行时覆盖同 key，误删会让后续回复重复起会话。
  if (liveTasks.get(rt.task.messageId) === rt) liveTasks.delete(rt.task.messageId);
  rt.session?.endInput();
  const { config, lark, task } = rt;
  if (verdict === 'skip') {
    await cleanupWorktree(config, rt.worktree, rt.branch);
    rt.statusRid = await swapReaction(lark, task.messageId, config.reactions.skipped, rt.statusRid);
  } else if (verdict === 'escalate') {
    // 旧契约兼容：仅私信（群里零文字消息），保留手工接管命令。
    rt.statusRid = await swapReaction(lark, task.messageId, config.reactions.escalate, rt.statusRid);
    await lark.sendDm(config.dmOpenId,
      `该任务需要人工规划，请用命令 \`cd ${rt.worktree} && claude "载入 /harness-context 上下文，走计划门完整路径"\` 进行 spec。`);
  } else if (verdict === 'pass') {
    rt.statusRid = await swapReaction(lark, task.messageId, config.reactions.done, rt.statusRid);
    await lark.sendDm(config.dmOpenId,
      `✅ 任务完成\nMR：${result?.mr_url || '（RESULT 未带链接）'}\n分支：${rt.branch}\n摘要：${result?.summary || ''}`);
  } else {
    rt.statusRid = await swapReaction(lark, task.messageId, config.reactions.failed, rt.statusRid);
    await lark.sendDm(config.dmOpenId,
      `❌ 任务未完成（${why}）\nworktree：${rt.worktree}\n日志：${rt.logPath}\nreason：${result?.reason || ''}`);
  }
  rt.finish({ verdict, branch: rt.branch, worktree: rt.worktree, logPath: rt.logPath });
}

async function handleEvent(rt, ev) {
  if (rt.settled) return;
  if (ev.kind === 'timeout') return settle(rt, 'fail', { why: '超时强杀' });
  if (ev.kind === 'close') {
    // 挂起进程死亡/被收割：等待态不动（懒续跑兜底），仅移出活表。
    // 只删指向自己的登记：懒续跑可能已抢先用新运行时覆盖同 key。
    if (rt.state === 'waiting') {
      if (liveTasks.get(rt.task.messageId) === rt) liveTasks.delete(rt.task.messageId);
      return;
    }
    return settle(rt, 'fail', { why: '会话进程退出且无有效 RESULT 行' });
  }
  if (ev.sessionId) rt.sessionId = ev.sessionId;
  if (ev.isError) {
    return goWaiting(rt, `本轮以 API 错误收场：${truncate(ev.text)}\n（回复任意内容即重试；可先用 /model <名> 或 /effort <级> 调整后再回复）`);
  }
  const result = parseResult(ev.text);
  if (!result) {
    if (rt.correctionUsed) return settle(rt, 'fail', { why: '连续两轮无有效 RESULT 行' });
    rt.correctionUsed = true;
    return rt.session.send(CORRECTION_MSG);
  }
  rt.correctionUsed = false;
  if (result.verdict === 'ask') return goWaiting(rt, result.question || result.reason || '（会话未给出具体问题，请回复指示）');
  return settle(rt, result.verdict, { why: `verdict=${result.verdict}`, result });
}

function startTurnLoop(init) {
  const rt = { ...init, state: 'active', settled: false, correctionUsed: false, session: null };
  liveTasks.set(rt.task.messageId, rt);
  const done = new Promise((res) => { rt.finish = res; });
  rt.session = startSession({
    bin: rt.config.claudeBin, cwd: rt.worktree, name: rt.title, logPath: rt.logPath,
    timeoutMs: rt.config.taskTimeoutMs, killGraceMs: rt.config.killGraceMs,
    resumeSessionId: init.resumeSessionId, extraFlags: init.resumeFlags ?? [],
    onEvent: (ev) => { handleEvent(rt, ev).catch((e) => console.error(`[runner] 轮次处理异常：${e.message}`)); },
  });
  rt.session.send(init.firstMessage);
  return done;
}

export async function runTask(task, config, lark, hooks = {}) {
  mkdirSync(config.worktreesDir, { recursive: true });
  mkdirSync(config.logsDir, { recursive: true });
  const base = `bot/${stamp(new Date(task.receivedAt || Date.now()))}-${task.messageId.slice(-6)}`;
  let branch = base;
  let worktree = join(config.worktreesDir, branch.replaceAll('/', '__'));
  try {
    await git(config.repoPath, ['worktree', 'add', worktree, '-b', branch]);
  } catch (firstErr) {
    branch = `${base}-2`; // 同名冲突追加序号重试一次
    worktree = join(config.worktreesDir, branch.replaceAll('/', '__'));
    try {
      await git(config.repoPath, ['worktree', 'add', worktree, '-b', branch]);
    } catch {
      // 这里抛出去等于静默丢单：listener 的 pump 只会 catch 成一行 stderr，而 message_id
      // 在入队时就已 markProcessed，群里既无 ❌ 也无私信、且永不重试。走 fail 通道让它可见。
      // 首次错误才是根因（第二次多半只是「路径已存在」的派生噪声）。
      await lark.addReaction(task.messageId, config.reactions.failed);
      await lark.sendDm(config.dmOpenId,
        `❌ 任务未启动：worktree 创建失败（尚未运行，无任务日志）\nmessage_id：${task.messageId}\n仓库：${config.repoPath}\n首次错误：${firstErr.message}`);
      return { verdict: 'fail', branch, worktree, logPath: '' };
    }
  }
  // 现场一就绪就通告，早于任何飞书往返：话题内回复要能立刻找到归属任务的 worktree，
  // 而 addReaction 最坏要等两次 30s 超时，这段窗口内到达的回复会被判成新任务。
  try {
    hooks.onWorktreeReady?.({ threadId: task.threadId ?? '', branch, worktree, messageId: task.messageId });
  } catch (e) {
    // 登记只决定「后续回复能否并入上下文」，不该连带丢掉已经建好现场的任务。
    console.error(`[runner] onWorktreeReady 回调失败：${e.message}`);
  }
  const logPath = join(config.logsDir, `task-${task.messageId}.log`);
  const claimedRid = await lark.addReaction(task.messageId, config.reactions.claimed);
  return startTurnLoop({
    task, config, lark, hooks, branch, worktree, logPath,
    statusRid: claimedRid, sessionId: '', title: sessionName(task.text),
    firstMessage: renderPrompt(task, branch, config.chatId),
  });
}
```

（`injectReply/killSession/resumeTask` 在 Task 8/9 追加；本任务结束时模块只导出 `runTask/killActiveChildren`。）

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test 'harness-ceilf6-bot/tests/runner.test.mjs'` 然后全量 `node --test 'harness-ceilf6-bot/tests/**/*.test.mjs'`
Expected: 全部 PASS（listener 端到端走的也是新链路）。

- [ ] **Step 5: Commit**

```bash
git add harness-ceilf6-bot/src/runner.mjs harness-ceilf6-bot/tests/runner.test.mjs
git commit -m "refactor(bot): runner 迁移到长驻 stream-json 会话（终态路径）"
```

---

### Task 8: runner · ask 挂起 / 回复注入 / API 错误轮 / killSession

**Files:**
- Modify: `harness-ceilf6-bot/src/runner.mjs`
- Test: `harness-ceilf6-bot/tests/runner.test.mjs`

**Interfaces:**
- Consumes: Task 7 的 `liveTasks/goWaiting/REPLY_FRAME`。
- Produces:
  - `injectReply(messageId, replyText) → Promise<bool>`：仅当任务在活表中、`state==='waiting'`、进程存活时注入并翻表情（⚠️→👍），否则 false（调用方走懒续跑）。
  - `killSession(messageId) → bool`：仅收割挂起中的会话进程（等待态不动）。
  - `hooks.onAsk(info)`：`info = {messageId, threadId, branch, worktree, sessionId, question, questionMsgId, statusRid, title}`。

- [ ] **Step 1: 写失败测试**（追加到 `runner.test.mjs`；import 行加 `injectReply, killSession`）

```js
test('ask：私信具体问题、⚠️、注入回复续跑至 pass，表情全程恒为一个', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  const asks = [];
  delete process.env.STUB_VERDICT;
  process.env.STUB_TURNS = 'ask:选 A 还是 B？;pass';
  process.env.STUB_MSGS_OUT = join(root, 'msgs.txt');
  const p = runTask(TASK, makeConfig(root, repo), fakeLark(calls), { onAsk: (i) => asks.push(i) });
  await poll(() => asks.length === 1);
  assert.equal(asks[0].question, '选 A 还是 B？');
  assert.equal(asks[0].questionMsgId, 'om_dm_1');
  assert.equal(asks[0].sessionId, 'sess_stub_1');
  assert.equal(asks[0].title, '修一个真实任务 $&原样');
  const dmQ = calls.find((c) => c[0] === 'dm')[2];
  assert.ok(dmQ.includes('选 A 还是 B？'));
  assert.ok(dmQ.includes('引用'));
  assert.equal(await injectReply('om_nope', '回复'), false); // 不认识的任务
  assert.equal(await injectReply(TASK.messageId, '选 A，注意兼容'), true);
  const out = await p;
  assert.equal(out.verdict, 'pass');
  // 表情序列：claimed → [ask] WARN+撤 claimed → [注入] claimed+撤 WARN → [pass] DONE+撤 claimed
  assert.deepEqual(calls.filter((c) => c[0] !== 'dm').map((c) => [c[0], c[2]]), [
    ['add', 'THUMBSUP'], ['add', 'WARN'], ['del', 'rid_1'],
    ['add', 'THUMBSUP'], ['del', 'rid_2'],
    ['add', 'DONE'], ['del', 'rid_3'],
  ]);
  const msgs = readFileSync(join(root, 'msgs.txt'), 'utf8').trim().split('\n');
  assert.equal(msgs.length, 2);
  assert.ok(msgs[1].includes('选 A，注意兼容'));
  assert.ok(msgs[1].includes('RESULT 行收尾')); // 回复框架带契约提醒
  delete process.env.STUB_TURNS; delete process.env.STUB_MSGS_OUT;
  rmFixture(root);
});

test('API 错误轮转挂起：is_error 不终态，回复后续跑', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  const asks = [];
  process.env.STUB_TURNS = 'error:usage limit reached;pass';
  const p = runTask(TASK, makeConfig(root, repo), fakeLark(calls), { onAsk: (i) => asks.push(i) });
  await poll(() => asks.length === 1);
  assert.ok(asks[0].question.includes('usage limit reached'));
  assert.ok(asks[0].question.includes('/model'));
  assert.equal(await injectReply(TASK.messageId, '重试'), true);
  assert.equal((await p).verdict, 'pass');
  delete process.env.STUB_TURNS;
  rmFixture(root);
});

test('多轮 ask：每轮各发一条提问私信、注入后可再 ask', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  const asks = [];
  process.env.STUB_TURNS = 'ask:问一;ask:问二;pass';
  const p = runTask(TASK, makeConfig(root, repo), fakeLark(calls), { onAsk: (i) => asks.push(i) });
  await poll(() => asks.length === 1);
  await injectReply(TASK.messageId, '答一');
  await poll(() => asks.length === 2);
  assert.equal(asks[1].question, '问二');
  assert.equal(asks[1].questionMsgId, 'om_dm_2');
  await injectReply(TASK.messageId, '答二');
  assert.equal((await p).verdict, 'pass');
  delete process.env.STUB_TURNS;
  rmFixture(root);
});

test('killSession：只收割挂起会话，等待态不终态；活跃轮次拒绝收割', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  const asks = [];
  process.env.STUB_TURNS = 'ask:q';
  const p = runTask(TASK, makeConfig(root, repo), fakeLark(calls), { onAsk: (i) => asks.push(i) });
  await poll(() => asks.length === 1);
  assert.equal(killSession(TASK.messageId), true);
  // 进程死后任务不 fail：promise 保持 pending（等懒续跑）
  const raced = await Promise.race([p, new Promise((r) => setTimeout(() => r('pending'), 800))]);
  assert.equal(raced, 'pending');
  assert.equal(await injectReply(TASK.messageId, '来晚了'), false); // 进程已死 → 走懒续跑
  assert.equal(killSession('om_nope'), false);
  delete process.env.STUB_TURNS;
  rmFixture(root);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test 'harness-ceilf6-bot/tests/runner.test.mjs'`
Expected: 新用例 FAIL（injectReply/killSession 未导出）。

- [ ] **Step 3: 实现**（`runner.mjs` 追加导出，放在 `runTask` 之前）

```js
// 私信回复注入活会话：仅挂起态可注入；返回 false 表示需走懒续跑（进程已死或任务不在活表）。
export async function injectReply(messageId, replyText) {
  const rt = liveTasks.get(messageId);
  if (!rt || rt.state !== 'waiting' || !rt.session?.alive) return false;
  rt.state = 'active';
  rt.session.send(REPLY_FRAME(replyText));
  rt.statusRid = await swapReaction(rt.lark, rt.task.messageId, rt.config.reactions.claimed, rt.statusRid);
  return true;
}

// 斜杠命令改参数后收割挂起进程：等待态不动（close 分流对 waiting 不终态），后续回复走懒续跑。
export function killSession(messageId) {
  const rt = liveTasks.get(messageId);
  if (!rt || rt.state !== 'waiting') return false;
  rt.session?.kill();
  return true;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test 'harness-ceilf6-bot/tests/**/*.test.mjs'`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add harness-ceilf6-bot/src/runner.mjs harness-ceilf6-bot/tests/runner.test.mjs
git commit -m "feat(bot): ask 挂起 + 回复注入 + API 错误轮转挂起"
```

---

### Task 9: runner · resumeTask 懒续跑

**Files:**
- Modify: `harness-ceilf6-bot/src/runner.mjs`
- Test: `harness-ceilf6-bot/tests/runner.test.mjs`

**Interfaces:**
- Consumes: awaiting 条目形状（Task 4）：`{messageId, threadId, branch, worktree, sessionId, resumeFlags, statusRid, title}`。
- Produces: `resumeTask(info, replyText, config, lark, hooks) → Promise<{verdict, branch, worktree, logPath}>`——按 `--resume <sessionId>` 重建进程注入回复；worktree 已不存在时 ❌ 私信并 resolve fail。

- [ ] **Step 1: 写失败测试**（追加到 `runner.test.mjs`；import 加 `resumeTask`）

```js
test('resumeTask：--resume + resumeFlags 重建会话、⚠️→👍、续跑至 pass', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  const asks = [];
  process.env.STUB_TURNS = 'ask:q1';
  const p1 = runTask(TASK, makeConfig(root, repo), fakeLark(calls), { onAsk: (i) => asks.push(i) });
  await poll(() => asks.length === 1);
  killSession(TASK.messageId);
  await Promise.race([p1, new Promise((r) => setTimeout(r, 300))]); // 等 close 落定（不 resolve）
  // 懒续跑（模拟 bot 重启后从 awaiting.jsonl 取出的条目）
  const calls2 = [];
  process.env.STUB_TURNS = 'pass';
  process.env.STUB_ARGS_OUT = join(root, 'args2.txt');
  process.env.STUB_MSGS_OUT = join(root, 'msgs2.txt');
  const info = { ...asks[0], resumeFlags: ['--model', 'opus'] };
  const out = await resumeTask(info, '用 opus 继续，选 A', makeConfig(root, repo), fakeLark(calls2), {});
  assert.equal(out.verdict, 'pass');
  const args = readFileSync(join(root, 'args2.txt'), 'utf8').split('\n');
  assert.equal(args[args.indexOf('--resume') + 1], 'sess_stub_1');
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  const msgs = readFileSync(join(root, 'msgs2.txt'), 'utf8').trim().split('\n');
  assert.equal(msgs.length, 1); // 只注入回复框架（无 bootstrap）
  assert.ok(msgs[0].includes('用 opus 继续，选 A'));
  // 表情：claimed（撤 info.statusRid=rid_2）→ pass 终态
  assert.deepEqual(calls2.filter((c) => c[0] !== 'dm').map((c) => [c[0], c[2]]), [
    ['add', 'THUMBSUP'], ['del', 'rid_2'],
    ['add', 'DONE'], ['del', 'rid_1'],
  ]);
  delete process.env.STUB_TURNS; delete process.env.STUB_ARGS_OUT; delete process.env.STUB_MSGS_OUT;
  rmFixture(root);
});

test('resumeTask：续跑中再 ask 触发 onAsk（可多轮往复）', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  const asks = [];
  process.env.STUB_TURNS = 'ask:q1';
  const p1 = runTask(TASK, makeConfig(root, repo), fakeLark(calls), { onAsk: (i) => asks.push(i) });
  await poll(() => asks.length === 1);
  killSession(TASK.messageId);
  await Promise.race([p1, new Promise((r) => setTimeout(r, 300))]);
  process.env.STUB_TURNS = 'ask:q2;pass';
  const asks2 = [];
  const p2 = resumeTask({ ...asks[0], resumeFlags: [] }, '答 q1', makeConfig(root, repo), fakeLark(calls), { onAsk: (i) => asks2.push(i) });
  await poll(() => asks2.length === 1);
  assert.equal(asks2[0].question, 'q2');
  await injectReply(TASK.messageId, '答 q2');
  assert.equal((await p2).verdict, 'pass');
  delete process.env.STUB_TURNS;
  rmFixture(root);
});

test('resumeTask：worktree 已删 → ❌ 私信、fail、不 spawn', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  const out = await resumeTask(
    { messageId: 'om_x_654321', threadId: '', branch: 'bot/gone', worktree: join(root, 'wt', 'bot__gone'), sessionId: 'sess_1', resumeFlags: [], statusRid: 'rid_old', title: '短题' },
    '回复', makeConfig(root, repo), fakeLark(calls), {});
  assert.equal(out.verdict, 'fail');
  assert.deepEqual(calls.map((c) => c[0]), ['add', 'del', 'dm']);
  assert.equal(calls[0][2], 'CROSS');
  assert.equal(calls[1][2], 'rid_old');
  assert.ok(calls[2][2].includes('worktree 已不存在'));
  rmFixture(root);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test 'harness-ceilf6-bot/tests/runner.test.mjs'`
Expected: 新用例 FAIL（resumeTask 未导出）。

- [ ] **Step 3: 实现**（`runner.mjs` 追加）

```js
// 懒续跑：bot 重启 / 进程被收割 / 挂起进程意外死亡后，用户回复到达时按 awaiting 条目重建会话。
// info 即 awaiting.jsonl 条目；replyText 是本次要注入的回复正文。
export async function resumeTask(info, replyText, config, lark, hooks = {}) {
  if (!existsSync(info.worktree)) {
    // 现场已被人工删除：无从续跑，终态化交人工（调用方随之删 awaiting 条目）。
    await lark.addReaction(info.messageId, config.reactions.failed);
    if (info.statusRid) await lark.deleteReaction(info.messageId, info.statusRid);
    await lark.sendDm(config.dmOpenId, `❌ 无法续跑：worktree 已不存在\n${info.worktree}\n该任务等待状态已作废，请在群里重新发起。`);
    return { verdict: 'fail', branch: info.branch, worktree: info.worktree, logPath: '' };
  }
  const task = { messageId: info.messageId, threadId: info.threadId ?? '', text: info.title ?? '' };
  const logPath = join(config.logsDir, `task-${info.messageId}.log`);
  const claimedRid = await swapReaction(lark, info.messageId, config.reactions.claimed, info.statusRid);
  return startTurnLoop({
    task, config, lark, hooks, branch: info.branch, worktree: info.worktree, logPath,
    statusRid: claimedRid, sessionId: info.sessionId ?? '', title: info.title || 'harness 任务',
    resumeSessionId: info.sessionId, resumeFlags: info.resumeFlags ?? [],
    firstMessage: REPLY_FRAME(replyText),
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test 'harness-ceilf6-bot/tests/**/*.test.mjs'`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add harness-ceilf6-bot/src/runner.mjs harness-ceilf6-bot/tests/runner.test.mjs
git commit -m "feat(bot): resumeTask 懒续跑（--resume + resumeFlags）"
```

---

### Task 10: listener 私信分发与槽位改造

**Files:**
- Modify: `harness-ceilf6-bot/src/listener.mjs`
- Test: `harness-ceilf6-bot/tests/listener.test.mjs`

**Interfaces:**
- Consumes: `injectReply/killSession/resumeTask`（Task 8/9）、`parseDmReply/mergeFlags/SUPPORTED_HINT`（Task 2）、Store awaiting 方法（Task 4）、`decide` 的 dm 出口（Task 6）。
- Produces: 完整私信回路行为（路由 → 命令 → 注入/懒续跑）；槽位语义 = concurrency 只约束「未曾 ask 的活跃任务」，首次 ask 即释放；终态清 awaiting。

- [ ] **Step 1: 实现 listener 改动**（先实现后补端到端测试——本任务的红/绿在端到端层）

import 区：

```js
import { runTask, resumeTask, injectReply, killSession, killActiveChildren } from './runner.mjs';
import { parseDmReply, mergeFlags, SUPPORTED_HINT } from './commands.mjs';
```

pump 与终态清理（含槽位）：

```js
  const counted = new Set(); // 占着 concurrency 槽的任务：首次 ask 即释放（用户裁定：回复轮不受槽位限制）
  const taskHooks = {
    onWorktreeReady: (info) => registerThread(store, info),
    onAsk: (info) => {
      store.recordAsk(info.messageId, info);
      if (counted.delete(info.messageId)) { running--; pump(); }
    },
  };
  function settleTask(task) {
    return (out) => {
      store.dropAwaiting(task.messageId);
      // skip 会把 worktree 与分支删掉，登记不注销的话后续回复会往已删目录写出无人读的文件。
      if (out?.verdict === 'skip') unregisterThread(store, task);
    };
  }

  async function pump() {
    while (!stopping && running < config.concurrency && store.size() > 0) {
      const task = store.dequeue();
      running++;
      counted.add(task.messageId);
      runTask(task, config, lark, taskHooks)
        .then(settleTask(task))
        .catch((e) => console.error(`[listener] runTask 异常：${e.message}`))
        .finally(() => {
          if (counted.delete(task.messageId)) { running--; pump(); }
        });
    }
  }
```

私信分发（新函数，放在 absorbReply 之后）：

```js
  // 私信回路：路由（引用精确 > 单任务直发）→ 斜杠命令 → 注入活会话或懒续跑。
  // 懒续跑轮不占 concurrency 槽（用户裁定实时优先）。
  async function handleDm(ev) {
    store.markProcessed(ev.messageId);
    let target = ev.rootId ? store.findAwaitingByQuestionMsg(ev.rootId) : null;
    if (target && !target.waiting) {
      await lark.sendDm(config.dmOpenId, '该任务正在跑本轮，暂未等待回复。');
      return;
    }
    if (!target) {
      const waitingList = store.listWaiting();
      if (waitingList.length === 0) { await lark.sendDm(config.dmOpenId, '当前没有等待回复的任务。'); return; }
      if (waitingList.length > 1) { await lark.sendDm(config.dmOpenId, `有 ${waitingList.length} 个任务在等回复，请引用对应提问消息回复。`); return; }
      target = waitingList[0];
    }
    const parsed = parseDmReply(ev.text);
    if (parsed.unknown.length) {
      await lark.sendDm(config.dmOpenId, `无法执行的命令：${parsed.unknown.join(' ')}；${SUPPORTED_HINT}。整条消息未注入。`);
      return;
    }
    if (parsed.flags.length) {
      const merged = mergeFlags(target.resumeFlags ?? [], parsed.flags);
      store.patchAwaiting(target.messageId, { resumeFlags: merged });
      killSession(target.messageId); // 新参数只能在重建进程时生效；挂起态收割无损
      if (!parsed.body) {
        await lark.sendDm(config.dmOpenId, `已记录 ${merged.join(' ')}，下一轮续跑生效。`);
        return;
      }
      target = store.findAwaiting(target.messageId) ?? target;
    }
    store.patchAwaiting(target.messageId, { waiting: false }); // 防同一轮被二次注入
    // 换过参数（flags）必走懒续跑：新参数只在 spawn 生效，且旧进程正在被收割、注入必死于半路。
    if (!parsed.flags.length && await injectReply(target.messageId, parsed.body)) return;
    const info = store.findAwaiting(target.messageId) ?? target;
    resumeTask(info, parsed.body, config, lark, { onAsk: taskHooks.onAsk })
      .then(settleTask({ messageId: info.messageId, threadId: info.threadId }))
      .catch((e) => console.error(`[listener] 懒续跑异常：${e.message}`));
  }
```

事件分发接线（`if (d.action === 'reply')` 之前）：

```js
      if (d.action === 'dm') {
        // 本回调是同步的，未捕获的 rejection 会按默认策略掀掉常驻进程。
        handleDm(ev).catch((e) => console.error(`[listener] 私信处理异常：${e.message}`));
        return;
      }
```

注意：`taskHooks.onAsk` 里 `counted.delete` 对懒续跑任务天然 no-op（从未入 counted）。

- [ ] **Step 2: 写端到端测试**（追加到 `listener.test.mjs`；`runListener` 增加 `turns` 参数）

`runListener` 的 env 行改为：

```js
    env: {
      ...process.env, STUB_LOG: larkLog, STUB_EVENTS_FILE: eventsFile,
      // undefined 会被 spawn 串化成 "undefined" 字符串，必须条件展开
      ...(verdict ? { STUB_VERDICT: verdict } : {}), ...(turns ? { STUB_TURNS: turns } : {}),
    },
```

（函数签名 `{ cfgPath, root, events, verdict, turns, until }`。）

新增私信事件工厂：

```js
function dmLine(over = {}) {
  return JSON.stringify({
    chat_id: 'oc_p2p_1', chat_type: 'p2p', message_id: 'om_dm_111111',
    message_type: 'text', sender_type: 'user', sender_id: 'ou_me',
    content: '好的，就这么办', ...over,
  });
}
```

用例：

```js
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
```

- [ ] **Step 3: 跑测试**

Run: `node --test 'harness-ceilf6-bot/tests/**/*.test.mjs'`
Expected: 全部 PASS（若 listener 实现有漏，端到端用例即红——按报错修 listener，不改断言语义）。

- [ ] **Step 4: Commit**

```bash
git add harness-ceilf6-bot/src/listener.mjs harness-ceilf6-bot/tests/listener.test.mjs
git commit -m "feat(bot): 私信分发（路由/命令/懒续跑）与槽位改造"
```

---

### Task 11: 契约与文档（bootstrap-prompt / SKILL.md / runbook）

**Files:**
- Modify: `harness-ceilf6-bot/bootstrap-prompt.md`
- Modify: `harness-ceilf6/SKILL.md`（「模式」节 + 阶段 0 完整路径行）
- Modify: `harness-ceilf6-bot/runbook.md`

**Interfaces:**
- Consumes: 每轮 RESULT 契约（Task 1/7/8 实现的行为）。
- Produces: 三份文档与代码行为一致；无验收矛盾。

- [ ] **Step 1: 重写 `bootstrap-prompt.md` 指令节**（「## 任务消息」以上不动）

```markdown
## 指令

1. 判定上述消息是否一个针对本仓库的可执行开发任务。闲聊、讨论、纯提问、与本仓库无关 → 直接输出结果行结束，verdict=skip，reason 一句话。
2. 是任务 → 调用 harness-context 技能 init（无 wiki 链接），把任务原文与消息标识作为种子存入；随后调用 harness-ceilf6 技能并声明**无人值守模式**，按其 SKILL.md 跑到底。
3. **任何拿不准的点**（计划门复述不出可信四段、CR 僵局熔断、开发中关键决策缺依据）→ 本轮以 verdict=ask 收尾，question 字段写清具体问题、候选项与你的倾向。用户的回复会作为下一轮输入原文到达，按其指示继续；可多轮 ask。
4. 本会话是**多轮会话**：每一轮输出的最后必须是结果行（单独一行，`RESULT` + 一个空格 + 单行 JSON，字段缺省用空串；question 内换行用 \n 转义）：

RESULT {"verdict":"skip|ask|pass|fail","branch":"{{BRANCH}}","mr_url":"","summary":"","reason":"","question":""}

此行是编排器唯一消费的输出，禁止遗漏、禁止多行 JSON。pass/fail/skip 是终态；ask 表示挂起等用户回复后继续。
```

- [ ] **Step 2: 改 `harness-ceilf6/SKILL.md`「模式」节**（原三条分叉整体替换）

```markdown
- 计划门·完整路径：交互模式转 superpowers brainstorming 与用户协商；无人值守模式按调用方约定输出 ask 结果（question 写清缺口与分歧），等用户回复视作计划门协商输入继续，可多轮。
- 僵局熔断：交互模式停下交用户裁决；无人值守模式同样不擅断——按调用方约定输出 ask 结果（question 写清熔断现场与候选项），等用户裁决后继续。
- 开发中关键决策拿不准（多方案取舍缺依据、需求解读分歧大）：交互模式问用户；无人值守模式以 ask 输出等待回复。
- 结果输出：无人值守模式**每轮**结束按调用方约定输出结果行（如 RESULT 契约），pass/fail/skip 为终态、ask 为等待用户回复的中间态；「未人工CR/未自测」标注写进结果 JSON 的 summary 字段内，不得缀在 JSON 之后或另起一行——契约消费方按行取前缀后整体 JSON.parse，行尾散文会让 pass 被误判为 fail。bot 不能替人完成人工节点，milestones 停在 mr_created；交互模式面向用户汇总。
```

阶段 0 第 3 条完整路径行尾改：「…归一写入 plan.md；无人值守模式按「模式」节输出 ask 等待用户回复。」

- [ ] **Step 3: 改 `runbook.md`**

1. 依赖表 `claude` 行改为：`无人值守执行任务（须支持 --input-format stream-json 多轮输入与 --resume 续会话）`。
2. 表情语义表 `escalate` 行语义改为「等待你回复（ask/API 错误挂起）」；正文与验收演练里「需人工规划」相应改为「等待回复」。
3. 验收演练第 3 条替换为：

```markdown
3. 发一条模糊任务 → ⚠️ + 私信收到**具体卡点问题**；直接私信回复（多任务在等时引用那条提问）→ ⚠️ 变回 👍 续跑，最终 ✅ + MR 私信。私信回 `/model opus` 或 `/effort xhigh` 可为该任务的后续续跑切参数（收到「已记录」回执）。全程群里零 bot 文字消息。
```

4. 「重启恢复」节补充（原「处置」前插入）：

```markdown
**等待回复中的任务不受重启影响**：挂起进程会被收割，但 `state/awaiting.jsonl` 与 claude 会话历史都在盘上——对旧提问私信直接回复即可懒续跑（`--resume` 无损接续）。只有**活跃轮次中**被重启的任务才滞留，处置如下。
```

5. 「已知边界」追加两条：

```markdown
- 等待回复期间任务无超时：`taskTimeoutMs` 是**每轮**墙钟（写入 stdin 起计、收到该轮 RESULT 停表），挂起可无限期等待，靠 awaiting.jsonl 与 ⚠️ 表情可见。
- 挂起进程数不设上限（用户裁定）：每个等待中的任务保有一个常驻 claude 进程（只耗内存不耗 API）；进程意外死亡无损，回复时懒续跑。
```

- [ ] **Step 4: 全量测试（文档不该破坏任何行为）**

Run: `node --test 'harness-ceilf6-bot/tests/**/*.test.mjs'`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add harness-ceilf6-bot/bootstrap-prompt.md harness-ceilf6/SKILL.md harness-ceilf6-bot/runbook.md
git commit -m "docs(bot): ask 契约（每轮 RESULT）+ 无人值守分叉 + runbook"
```

---

### Task 12: 收尾——squash、真机验收

- [ ] **Step 1: 全量回归**

Run: `node --test 'harness-ceilf6-bot/tests/**/*.test.mjs'`
Expected: 全部 PASS，零 skip。

- [ ] **Step 2: squash 成单个实质性 commit**（用户偏好：过程 commit 不进主分支）

```bash
git reset --soft main
git commit -m "feat(harness-ceilf6-bot): 私信问答回路——ask 挂起/实时注入/斜杠命令/懒续跑，群内零文字消息"
```

确认 `git show --stat HEAD` 不含 `config.json`、`docs/superpowers/`、`state/`、`logs/`。

- [ ] **Step 3: 真机部署与验收（需用户在场）**

`bash harness-ceilf6-bot/install.sh` 会重启在跑的 bot——**先向用户确认时机**。验收按 runbook 新版第 1/3 条 + spec §9 演练：模糊任务 → ⚠️ + 问题私信 → 回复续跑 → ✅；两任务并挂 → 直发提示引用；`launchctl unload` 重启后回复旧提问 → 懒续跑成功。

- [ ] **Step 4: 合并 main 与收尾**

按用户指示合并（本仓库无 MR 流程则 `git checkout main && git merge --ff-only feat/bot-dm-ask-loop`），合并后删除工作分支。
