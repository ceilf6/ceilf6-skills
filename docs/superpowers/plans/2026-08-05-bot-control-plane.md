# bot 控制面与看板线程管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 harness-ceilf6-bot 装上刹车——`/stop` `/pause` `/tasks` 三条控制命令经 IM 与看板两个入口作用于在跑任务，并让看板能停止 / 归档 / 清理线程。

**Architecture:** bot 内新增本机控制端口（`src/control.mjs`，绑 127.0.0.1）作为 IM 与看板共用的唯一停止入口；控制命令由 listener 在事件分发早期拦截、**不进会话**，故长轮次里按下的停立刻生效。看板侧 `threads.sh` 新增 archive/unarchive/clean，`web.py` 合并 bot 运行态并代理停止。设计真源：`docs/superpowers/specs/2026-08-05-bot-control-plane-design.md`。

**Tech Stack:** Node ≥ 20.11 纯 ESM `.mjs`（零依赖，`node:http` 内建）+ `node --test`；bash + jq（threads.sh）+ python3 标准库（web.py）。

## Global Constraints

- 工作分支：开工先 `git checkout -b feat/bot-control-plane`（当前在 main，不允许直接提交 main）。
- **绝不 `git add`**：`harness-ceilf6-bot/config.json`（含个人 open_id）、`docs/superpowers/**`、`harness-ceilf6-bot/state/**`、`harness-ceilf6-bot/logs/**`。
- 测试命令（仓库根执行）：
  - bot：`node --test 'harness-ceilf6-bot/tests/**/*.test.mjs'`（glob 必须带引号）
  - 看板：`bash harness-ceilf6/tests/test-threads.sh`、`bash harness-ceilf6/tests/test-web.sh`
- 注释纪律（用户全局偏好）：只写现状与约束，禁止 diff 叙事（「不再/原来/改为」）。
- 群消息上只允许表情回应，**禁止任何 `replyInThread` 文字消息**；状态表情恒为恰好一个（先打新、再撤旧）。
- 成功回执由处置路径自身发出（runner 的 `settle` / `goWaiting`），调用方只在**失败**时回执——避免同一动作两条私信。
- 控制端口默认 `7659`（避开 ht 看板的 7657），绑 `127.0.0.1`，无鉴权；端口占用时 listener **响亮失败退出**。
- 新终态 `stopped` 不进 `result.mjs` 的 VERDICTS（会话不产出该 verdict，它是编排器终态）。
- 最终合并前 squash 成单个实质性 commit（用户偏好）。

---

### Task 1: 基础件——控制命令解析与在册任务列举

**Files:**
- Modify: `harness-ceilf6-bot/src/commands.mjs`
- Modify: `harness-ceilf6-bot/src/state.mjs`
- Test: `harness-ceilf6-bot/tests/commands.test.mjs`、`harness-ceilf6-bot/tests/core.test.mjs`

**Interfaces:**
- Produces（commands.mjs）：`CONTROL: Set<string>`（`stop|pause|tasks`）、`parseControl(text) → {name: string, arg: string} | null`（只认**首行**控制命令）。
- Produces（state.mjs）：`listAwaiting() → entry[]`（全部条目，不过滤 waiting）、`listQueued() → task[]`、`removeQueued(messageId) → task | null`。

- [ ] **Step 0: 建分支**

```bash
git checkout -b feat/bot-control-plane
```

- [ ] **Step 1: 写失败测试**（追加到 `tests/commands.test.mjs` 末尾；import 行加 `parseControl`）

```js
test('parseControl 识别首行控制命令与参数', () => {
  assert.deepEqual(parseControl('/stop'), { name: 'stop', arg: '' });
  assert.deepEqual(parseControl('/stop 2'), { name: 'stop', arg: '2' });
  assert.deepEqual(parseControl('/stop 924955'), { name: 'stop', arg: '924955' });
  assert.deepEqual(parseControl('/pause'), { name: 'pause', arg: '' });
  assert.deepEqual(parseControl('/tasks'), { name: 'tasks', arg: '' });
});
test('parseControl 拒绝：参数命令、非首行、纯文本、原型链名、空', () => {
  assert.equal(parseControl('/model opus'), null); // 参数命令不归控制通道
  assert.equal(parseControl('先看这个\n/stop'), null); // 只认首行，正文里的斜杠行不误杀任务
  assert.equal(parseControl('停一下'), null);
  assert.equal(parseControl('/toString'), null);
  assert.equal(parseControl(''), null);
  assert.equal(parseControl(null), null);
});
```

追加到 `tests/core.test.mjs` 末尾：

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test 'harness-ceilf6-bot/tests/commands.test.mjs' 'harness-ceilf6-bot/tests/core.test.mjs'`
Expected: 新用例 FAIL（`parseControl is not a function`、`s.listQueued is not a function`）。

- [ ] **Step 3: 实现 commands.mjs**（追加在 `SUPPORTED_HINT` 之后）

```js
// 控制命令：由 listener 直接执行（杀进程 / 置终态 / 列表），不进会话也不转 spawn 参数。
// 与 COMMANDS 分属两类——刹车必须在 listener 层立即生效，等会话读到就晚了。
export const CONTROL = new Set(['stop', 'pause', 'tasks']);

// 只认首行：正文里出现的斜杠行是普通文本，误判会凭空杀掉一个任务。
export function parseControl(text) {
  const first = String(text ?? '').split('\n')[0].trim();
  if (!first.startsWith('/')) return null;
  const [name, ...rest] = first.slice(1).split(/\s+/);
  if (!CONTROL.has(name)) return null;
  return { name, arg: rest.join(' ').trim() };
}
```

- [ ] **Step 4: 实现 state.mjs**（在 `dropAwaiting` 之后追加）

```js
listAwaiting() { return [...this.awaiting.values()]; }
listQueued() { return [...this.queue]; }
// 控制面停止排队中任务：按 id 精确出队，避免 dequeue 的 FIFO 语义误伤队首。
removeQueued(messageId) {
  const i = this.queue.findIndex((t) => t.messageId === messageId);
  if (i < 0) return null;
  const [t] = this.queue.splice(i, 1);
  this.#flushQueue();
  return t;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test 'harness-ceilf6-bot/tests/**/*.test.mjs'`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add harness-ceilf6-bot/src/commands.mjs harness-ceilf6-bot/src/state.mjs \
        harness-ceilf6-bot/tests/commands.test.mjs harness-ceilf6-bot/tests/core.test.mjs
git commit -m "feat(bot): 控制命令解析与在册任务列举基础件"
```

---

### Task 2: runner——stopped 终态、stopLive、taskSnapshot

**Files:**
- Modify: `harness-ceilf6-bot/src/runner.mjs`
- Test: `harness-ceilf6-bot/tests/runner.test.mjs`

**Interfaces:**
- Consumes: `goWaiting(rt, question, progress)`、`settle(rt, verdict, {why, result})`、`swapReaction`（本文件既有）。
- Produces:
  - `taskSnapshot() → Array<{messageId, short, title, branch, worktree, state, startedAt, sessionId}>`，`state ∈ 'active'|'waiting'`，仅含未 settle 的活表任务。
  - `stopLive(messageId, mode) → Promise<'active'|'waiting'|null>`，`mode ∈ 'stop'|'pause'`；返回处置**前**的状态，活表未命中返回 `null`。
  - `settle` 支持 `verdict === 'stopped'`：杀进程 + `reactions.stopped` 表情 + 私信回执 + promise 以 `verdict:'stopped'` resolve。

- [ ] **Step 1: 写失败测试**（追加到 `tests/runner.test.mjs`；import 行加 `taskSnapshot, stopLive`；`makeConfig` 的 `reactions` 加 `stopped: 'MUTE'`）

先改 `makeConfig`（文件顶部）的 reactions 一行为：

```js
    reactions: { claimed: 'THUMBSUP', done: 'DONE', failed: 'CROSS', escalate: 'WARN', skipped: 'GET', stopped: 'MUTE' }, ...over,
```

再追加用例：

```js
test('stopLive stop：活跃轮次立即停，🛑 终态、私信含 worktree、verdict=stopped', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  delete process.env.STUB_VERDICT;
  process.env.STUB_TURNS = 'hang'; // 长轮次：刹车不得等这轮跑完
  const p = runTask(TASK, makeConfig(root, repo, { taskTimeoutMs: 60_000 }), fakeLark(calls));
  // 按 messageId 取而非 [0]：同文件内先前用例的残留（若有）不该让断言变成偶然通过或偶然失败
  const mine = () => taskSnapshot().find((t) => t.messageId === TASK.messageId);
  await poll(() => !!mine());
  const snap = mine();
  assert.equal(snap.state, 'active');
  assert.equal(snap.short, '654321');
  assert.equal(snap.title, '修一个真实任务 $&原样');
  assert.ok(snap.worktree.includes('bot__'));
  assert.equal(await stopLive(TASK.messageId, 'stop'), 'active');
  const out = await p;
  assert.equal(out.verdict, 'stopped');
  assert.ok(existsSync(out.worktree)); // 现场保留
  const rx = calls.filter((c) => c[0] !== 'dm');
  assert.deepEqual(rx.map((c) => [c[0], c[2]]), [['add', 'THUMBSUP'], ['add', 'MUTE'], ['del', 'rid_1']]);
  const dm = calls.find((c) => c[0] === 'dm')[2];
  assert.ok(dm.includes('已停止'));
  assert.ok(dm.includes(out.worktree));
  assert.equal(mine(), undefined); // 已移出活表
  delete process.env.STUB_TURNS;
  rmFixture(root);
});

test('stopLive stop：挂起态停止走 ⚠️→🛑，同样 verdict=stopped', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  const asks = [];
  process.env.STUB_TURNS = 'ask:等指示';
  const p = runTask(TASK, makeConfig(root, repo), fakeLark(calls), { onAsk: (i) => asks.push(i) });
  await poll(() => asks.length === 1);
  assert.equal(taskSnapshot().find((t) => t.messageId === TASK.messageId).state, 'waiting');
  assert.equal(await stopLive(TASK.messageId, 'stop'), 'waiting');
  assert.equal((await p).verdict, 'stopped');
  const rx = calls.filter((c) => c[0] !== 'dm');
  assert.deepEqual(rx.map((c) => [c[0], c[2]]), [
    ['add', 'THUMBSUP'], ['add', 'WARN'], ['del', 'rid_1'], ['add', 'MUTE'], ['del', 'rid_2'],
  ]);
  delete process.env.STUB_TURNS;
  rmFixture(root);
});

test('stopLive pause：活跃轮次转挂起态、进程被杀、任务不终态（可懒续跑）', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  const asks = [];
  process.env.STUB_TURNS = 'hang';
  const p = runTask(TASK, makeConfig(root, repo, { taskTimeoutMs: 60_000 }), fakeLark(calls), { onAsk: (i) => asks.push(i) });
  await poll(() => taskSnapshot().some((t) => t.messageId === TASK.messageId));
  assert.equal(await stopLive(TASK.messageId, 'pause'), 'active');
  await poll(() => asks.length === 1);
  assert.ok(asks[0].question.includes('人工暂停')); // 登记成可续跑的等待态
  assert.equal(calls.filter((c) => c[0] !== 'dm')[1][2], 'WARN');
  // 不终态：promise 保持 pending，等用户回复走懒续跑
  const raced = await Promise.race([p, new Promise((r) => setTimeout(() => r('pending'), 800))]);
  assert.equal(raced, 'pending');
  assert.equal(await injectReply(TASK.messageId, '来晚了'), false); // 进程已死 → 交给懒续跑
  delete process.env.STUB_TURNS;
  rmFixture(root);
});

test('stopLive：未知任务与重复调用返回 null，不重复处置', async () => {
  const { root, repo } = makeFixture();
  const calls = [];
  process.env.STUB_TURNS = 'hang';
  const p = runTask(TASK, makeConfig(root, repo, { taskTimeoutMs: 60_000 }), fakeLark(calls));
  await poll(() => taskSnapshot().some((t) => t.messageId === TASK.messageId));
  assert.equal(await stopLive('om_nope', 'stop'), null);
  assert.equal(await stopLive(TASK.messageId, 'stop'), 'active');
  assert.equal(await stopLive(TASK.messageId, 'stop'), null); // 二次调用无副作用
  assert.equal((await p).verdict, 'stopped');
  assert.equal(calls.filter((c) => c[2] === 'MUTE').length, 1);
  delete process.env.STUB_TURNS;
  rmFixture(root);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test 'harness-ceilf6-bot/tests/runner.test.mjs'`
Expected: 新用例 FAIL（`taskSnapshot is not a function`）。

- [ ] **Step 3: 实现——`settle` 加 stopped 分支**

把 `settle` 开头的 `rt.session?.endInput();` 一行替换为：

```js
  // stopped 是人工叫停：必须立刻断掉进程组，不能等它把当前轮跑完。
  if (verdict === 'stopped') rt.session?.kill(); else rt.session?.endInput();
```

在 `settle` 内 `} else if (verdict === 'pass') {` 之前插入分支：

```js
  } else if (verdict === 'stopped') {
    rt.statusRid = await swapReaction(lark, task.messageId, config.reactions.stopped, rt.statusRid);
    const takeover = rt.sessionId
      ? `cd ${rt.worktree} && claude --resume ${rt.sessionId}`
      : `cd ${rt.worktree} && claude`;
    await lark.sendDm(config.dmOpenId,
      `🛑 任务已停止（${why}）\n${rt.title}\n分支：${rt.branch}\nworktree：${rt.worktree}\n如需接管：${takeover}`);
```

- [ ] **Step 4: 实现——`stopping` 守卫**

`handleEvent` 开头的 `if (rt.settled) return;` 替换为：

```js
  if (rt.settled) return;
  // 控制面动作期间到达的事件不得再驱动状态机：pause 的「补挂起态 → 杀进程」之间若放行
  // 一个带 RESULT 的 turn，会把刚建立的等待态又推回活跃。close 仍需把自己移出活表。
  if (rt.stopping) {
    if (ev.kind === 'close' && liveTasks.get(rt.task.messageId) === rt) liveTasks.delete(rt.task.messageId);
    return;
  }
```

`injectReply` 的守卫行替换为：

```js
  if (!rt || rt.stopping || !rt.session?.alive) return false;
```

`startTurnLoop` 的 rt 构造行加 `startedAt`：

```js
  const rt = { ...init, state: 'active', settled: false, stopping: false, correctionUsed: false, session: null, startedAt: new Date().toISOString() };
```

- [ ] **Step 5: 实现——导出 taskSnapshot 与 stopLive**（放在 `injectReply` 之前）

```js
// 控制面只读视图：状态取内存真源（store 的 waiting 标志在自唤醒后不更新，不可作为运行态依据）。
export function taskSnapshot() {
  return [...liveTasks.values()].filter((rt) => !rt.settled && !rt.stopping).map((rt) => ({
    messageId: rt.task.messageId, short: rt.task.messageId.slice(-6), title: rt.title,
    branch: rt.branch, worktree: rt.worktree, state: rt.state,
    startedAt: rt.startedAt, sessionId: rt.sessionId,
  }));
}

// stop：走 stopped 终态（杀进程组、终态表情、私信回执、promise resolve）。
// pause：补一个等待态再杀进程——顺序反了会让 close 先到并按活跃轮次判 fail 终态。
// 返回处置前的状态；活表未命中返回 null（调用方据此转去处理无进程的残留态）。
export async function stopLive(messageId, mode) {
  const rt = liveTasks.get(messageId);
  if (!rt || rt.settled || rt.stopping) return null;
  const was = rt.state;
  if (mode === 'pause') {
    rt.stopping = true;
    if (was !== 'waiting') await goWaiting(rt, '人工暂停，回复任意内容即续跑。');
    rt.session?.kill();
    return was;
  }
  await settle(rt, 'stopped', { why: was === 'waiting' ? '挂起中人工停止' : '活跃轮次人工停止' });
  return was;
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test 'harness-ceilf6-bot/tests/**/*.test.mjs'`
Expected: 全部 PASS。

- [ ] **Step 7: Commit**

```bash
git add harness-ceilf6-bot/src/runner.mjs harness-ceilf6-bot/tests/runner.test.mjs
git commit -m "feat(bot): stopped 终态与 stopLive/taskSnapshot 控制面原语"
```

---

### Task 3: control.mjs——本机控制端口

**Files:**
- Create: `harness-ceilf6-bot/src/control.mjs`
- Test: `harness-ceilf6-bot/tests/control.test.mjs`（新文件）

**Interfaces:**
- Produces: `startControlServer({ port, handlers, onListen }) → server`
  - `handlers.listTasks() → Array<任务对象>`（同步）
  - `handlers.control(body, mode) → Promise<{ok: boolean, error?: string, was?: string, title?: string, messageId?: string}>`，`mode ∈ 'stop'|'pause'`
  - `onListen(server)` 在监听就绪后调用（测试用它取实际端口）
- 路由：`GET /api/tasks` → `{tasks}`；`POST /api/stop`、`POST /api/pause` → handlers.control 的返回（`ok` 为 true 时 200，否则 404）；其余 404。坏 JSON 400。

- [ ] **Step 1: 写失败测试**（新文件 `tests/control.test.mjs`）

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startControlServer } from '../src/control.mjs';

function boot(handlers) {
  return new Promise((resolve) => {
    const server = startControlServer({
      port: 0, handlers,
      onListen: (s) => resolve({ server: s, base: `http://127.0.0.1:${s.address().port}` }),
    });
    server.on('error', () => {});
  });
}

test('GET /api/tasks 返回注入的快照', async () => {
  const { server, base } = await boot({ listTasks: () => [{ messageId: 'om_1', short: '000001', state: 'active' }], control: async () => ({ ok: true }) });
  const r = await fetch(`${base}/api/tasks`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.tasks[0].short, '000001');
  server.close();
});

test('POST /api/stop 与 /api/pause 透传 mode，ok 决定状态码', async () => {
  const seen = [];
  const { server, base } = await boot({
    listTasks: () => [],
    control: async (body, mode) => { seen.push([body, mode]); return body.messageId === 'om_1' ? { ok: true, was: 'active', title: 'T' } : { ok: false, error: '未找到匹配的任务' }; },
  });
  const ok = await fetch(`${base}/api/stop`, { method: 'POST', body: JSON.stringify({ messageId: 'om_1' }) });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).was, 'active');
  const miss = await fetch(`${base}/api/pause`, { method: 'POST', body: JSON.stringify({ messageId: 'om_x' }) });
  assert.equal(miss.status, 404);
  assert.deepEqual(seen.map((s) => s[1]), ['stop', 'pause']);
  assert.equal(seen[0][0].messageId, 'om_1');
  server.close();
});

test('坏 JSON 返回 400，未知路径与方法返回 404', async () => {
  const { server, base } = await boot({ listTasks: () => [], control: async () => ({ ok: true }) });
  const bad = await fetch(`${base}/api/stop`, { method: 'POST', body: '{不是json' });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  assert.equal((await fetch(`${base}/api/tasks`, { method: 'POST', body: '{}' })).status, 404);
  server.close();
});

test('handlers 抛错不炸进程，返回 500', async () => {
  const { server, base } = await boot({ listTasks: () => [], control: async () => { throw new Error('炸了'); } });
  const r = await fetch(`${base}/api/stop`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(r.status, 500);
  assert.ok((await r.json()).error.includes('炸了'));
  server.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test 'harness-ceilf6-bot/tests/control.test.mjs'`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `src/control.mjs`**

```js
// bot 本机控制端口：IM 与看板共用的停止入口。绑 127.0.0.1、无鉴权——
// 沿用 ht 看板的本机单用户姿态。本文件只做传输与参数校验，任务定位与处置
// 全在注入的 handlers 里，故可脱离 listener 单测。
import { createServer } from 'node:http';

const MAX_BODY = 64 * 1024;

function readJson(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > MAX_BODY) { req.destroy(); resolve(null); }
    });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

export function startControlServer({ port, handlers, onListen }) {
  const send = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  };
  const server = createServer((req, res) => {
    (async () => {
      if (req.method === 'GET' && req.url === '/api/tasks') {
        return send(res, 200, { tasks: handlers.listTasks() });
      }
      if (req.method === 'POST' && (req.url === '/api/stop' || req.url === '/api/pause')) {
        const body = await readJson(req);
        if (!body) return send(res, 400, { ok: false, error: '请求体须为 JSON' });
        const out = await handlers.control(body, req.url === '/api/stop' ? 'stop' : 'pause');
        return send(res, out.ok ? 200 : 404, out);
      }
      send(res, 404, { ok: false, error: 'not found' });
    })().catch((e) => send(res, 500, { ok: false, error: e.message }));
  });
  server.listen(port, '127.0.0.1', () => onListen?.(server));
  return server;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test 'harness-ceilf6-bot/tests/control.test.mjs'`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add harness-ceilf6-bot/src/control.mjs harness-ceilf6-bot/tests/control.test.mjs
git commit -m "feat(bot): 本机控制端口（tasks/stop/pause）"
```

---

### Task 4: listener——在册视图、控制编排、IM 拦截、端口启动

**Files:**
- Modify: `harness-ceilf6-bot/src/listener.mjs`
- Test: `harness-ceilf6-bot/tests/listener.test.mjs`

**Interfaces:**
- Consumes: `parseControl`（Task 1）、`taskSnapshot` / `stopLive`（Task 2）、`startControlServer`（Task 3）、`store.listAwaiting/listQueued/removeQueued`（Task 1）。
- Produces：完整控制回路——`/tasks` 列表、`/stop` `/pause` 三态处置（活表 / 无进程的残留等待态 / 队列）、话题与私信两个入口、控制端口启动与 config 校验。

- [ ] **Step 1: 实现 listener 改动**（先实现后补端到端测试——本任务红/绿在端到端层）

import 区两行替换为：

```js
import { runTask, resumeTask, injectReply, killSession, killActiveChildren, taskSnapshot, stopLive } from './runner.mjs';
import { parseDmReply, mergeFlags, parseControl, SUPPORTED_HINT } from './commands.mjs';
```

并新增：

```js
import { startControlServer } from './control.mjs';
```

`validateConfig` 的两个循环各加一项：数字键列表加 `'controlPort'`，reactions 键列表加 `'stopped'`：

```js
  for (const k of ['concurrency', 'taskTimeoutMs', 'minTextLength', 'controlPort']) {
```

```js
  for (const k of ['claimed', 'done', 'failed', 'escalate', 'skipped', 'context', 'stopped']) {
```

在 `handleDm` 之前插入在册视图与控制编排：

```js
  const STATE_LABEL = { active: '运行中', waiting: '等回复', queued: '排队中' };

  // 在册任务 = 活表（有运行时）+ awaiting 残留（bot 重启后无进程）+ 队列（未起进程）。
  // 按此优先级去重：同一 messageId 只取运行态最真的那份。
  function registry() {
    const out = [];
    const seen = new Set();
    for (const t of taskSnapshot()) { out.push(t); seen.add(t.messageId); }
    for (const e of store.listAwaiting()) {
      if (seen.has(e.messageId)) continue;
      seen.add(e.messageId);
      out.push({
        messageId: e.messageId, short: e.messageId.slice(-6), title: e.title ?? '', branch: e.branch ?? '',
        worktree: e.worktree ?? '', state: 'waiting', startedAt: e.askedAt ?? '', sessionId: e.sessionId ?? '',
      });
    }
    for (const t of store.listQueued()) {
      if (seen.has(t.messageId)) continue;
      seen.add(t.messageId);
      out.push({
        messageId: t.messageId, short: t.messageId.slice(-6),
        title: [...(String(t.text ?? '').split('\n')[0])].slice(0, 20).join(''),
        branch: '', worktree: '', state: 'queued', startedAt: t.receivedAt ?? '', sessionId: '',
      });
    }
    return out.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  }

  function formatTasks(list) {
    return list.map((t, i) =>
      `${i + 1}. [${STATE_LABEL[t.state]}] ${t.title || t.branch}（${t.short}）${t.branch ? ` · ${t.branch}` : ''}`).join('\n');
  }

  // 选择子：messageId / worktree（看板按路径定位）/ short / index（1 基，与 /tasks 当轮输出一致）；
  // 全空时仅当在册恰有一个任务才命中——多个时必须显式指名，避免停错。
  function resolveTarget(sel, list) {
    if (sel.messageId) return list.find((t) => t.messageId === sel.messageId) ?? null;
    if (sel.worktree) return list.find((t) => t.worktree === sel.worktree) ?? null;
    if (sel.short) return list.find((t) => t.short === sel.short) ?? null;
    if (sel.index) return list[Number(sel.index) - 1] ?? null;
    return list.length === 1 ? list[0] : null;
  }

  // 成功回执由处置路径自身发出（settle / goWaiting / 本函数内的非活表分支），
  // 调用方只在失败时回执——同一动作发两条私信会让人以为发生了两件事。
  async function controlTask(sel, mode) {
    const list = registry();
    if (list.length === 0) return { ok: false, error: '当前没有在册任务。' };
    const t = resolveTarget(sel, list);
    if (!t) {
      return {
        ok: false,
        error: list.length > 1
          ? `有 ${list.length} 个任务在册，请带序号或 short（如 /${mode} 2）：\n${formatTasks(list)}`
          : '未找到匹配的任务。',
      };
    }
    if (t.state === 'queued') {
      if (mode === 'pause') return { ok: false, error: '排队中的任务尚未起进程，请改用 /stop。' };
      store.removeQueued(t.messageId);
      await lark.addReaction(t.messageId, config.reactions.stopped);
      await lark.sendDm(config.dmOpenId, `🛑 已出队（未起进程）：${t.title}`);
      return { ok: true, was: 'queued', title: t.title, messageId: t.messageId };
    }
    const was = await stopLive(t.messageId, mode);
    if (was) return { ok: true, was, title: t.title, messageId: t.messageId };
    // 活表没有 → bot 重启后遗留的等待态：进程早已不在，只需处置登记与表情。
    const entry = store.findAwaiting(t.messageId);
    if (!entry) return { ok: false, error: '该任务已结束。' };
    if (mode === 'pause') {
      await lark.sendDm(config.dmOpenId, `⏸ ${entry.title} 本就无进程在跑，等待态保留，回复即续跑。`);
      return { ok: true, was: 'waiting', title: entry.title, messageId: t.messageId };
    }
    store.dropAwaiting(t.messageId);
    await lark.addReaction(t.messageId, config.reactions.stopped);
    if (entry.statusRid) await lark.deleteReaction(t.messageId, entry.statusRid);
    const takeover = entry.sessionId
      ? `cd ${entry.worktree} && claude --resume ${entry.sessionId}`
      : `cd ${entry.worktree} && claude`;
    await lark.sendDm(config.dmOpenId,
      `🛑 任务已停止（等待态作废，进程不在）\n${entry.title}\nworktree：${entry.worktree}\n如需接管：${takeover}`);
    return { ok: true, was: 'waiting', title: entry.title, messageId: t.messageId };
  }

  async function sendTaskList() {
    const list = registry();
    await lark.sendDm(config.dmOpenId, list.length ? `在册任务：\n${formatTasks(list)}` : '当前没有在册任务。');
  }

  async function runControl(sel, ctl) {
    if (ctl.name === 'tasks') return sendTaskList();
    const out = await controlTask(sel, ctl.name);
    if (!out.ok) await lark.sendDm(config.dmOpenId, out.error);
  }
```

`handleDm` 的 `store.markProcessed(ev.messageId);` 之后插入控制命令拦截：

```js
    // 控制命令先于路由：/stop 必须能作用于活跃任务，而活跃任务不在 listWaiting 里。
    const ctl = parseControl(ev.text);
    if (ctl) {
      const sel = ctl.arg ? (/^\d+$/.test(ctl.arg) ? { index: ctl.arg } : { short: ctl.arg }) : {};
      await runControl(sel, ctl);
      // 控制命令与会话输入互斥：多出来的正文若静默丢弃，用户会以为它也送进去了。
      if (String(ev.text ?? '').split('\n').length > 1) {
        await lark.sendDm(config.dmOpenId, '（控制命令之后的正文未注入会话：控制命令独占一条消息）');
      }
      return;
    }
```

事件分发处的 `if (d.action === 'reply')` 块替换为：

```js
      if (d.action === 'reply') {
        const taskInfo = store.findThread(ev.threadId);
        const ctl = parseControl(ev.text);
        if (ctl) {
          // 控制命令是对任务的操作，不是给会话的补充信息：不写 context 条目、不打 📝。
          store.markProcessed(ev.messageId);
          const sel = taskInfo ? { messageId: taskInfo.messageId } : {};
          const act = ctl.name === 'tasks' || taskInfo
            ? runControl(sel, ctl)
            : lark.sendDm(config.dmOpenId, `该话题没有登记的任务，无法执行 /${ctl.name}。`);
          Promise.resolve(act).catch((e) => console.error(`[listener] 话题控制异常：${e.message}`));
          return;
        }
        if (taskInfo) {
          // 本回调是同步的，未捕获的 rejection 会按默认策略掀掉常驻进程。
          absorbReply(taskInfo, ev).catch((e) => console.error(`[listener] 回复处理异常：${e.message}`));
          return;
        }
      }
```

在 `startConsumer();` 之前启动控制端口：

```js
  const control = startControlServer({
    port: config.controlPort,
    handlers: { listTasks: () => registry(), control: (body, mode) => controlTask(body ?? {}, mode) },
  });
  // 端口占用必须响亮失败：静默降级会让看板的停止按钮一直连不上却无从排查。
  control.on('error', (e) => {
    console.error(`[listener] 控制端口 ${config.controlPort} 启动失败：${e.message}`);
    process.exit(1);
  });
```

- [ ] **Step 2: 写端到端测试**（追加到 `tests/listener.test.mjs`）

`writeConfig` 的 reactions 一行加 `stopped`，并加 `controlPort`（随机端口避免并发用例撞车）：

```js
    concurrency: 1, taskTimeoutMs: 30000, killGraceMs: 500, minTextLength: 10,
    // 端口区间放宽：测试文件并行跑，撞端口会让 listener 按「端口占用」退出 1、失败面误导
    controlPort: (Math.floor(Math.random() * 8000) + 40000),
    dmOpenId: 'ou_me', claudeBin: CLAUDE_STUB, larkBin: LARK_STUB,
    reactions: { claimed: 'THUMBSUP', done: 'DONE', failed: 'CrossMark', escalate: 'OnIt', skipped: 'Get', context: 'CTXKEY', stopped: 'MUTE' },
```

用例：

```js
test('端到端（stub）：话题内 /stop 立即停掉长轮次任务，不写 context、群里零文字消息', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-stop-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  const threadsPath = join(root, 'state', 'threads.jsonl');
  // 第一程：起一个 hang 任务（长轮次），等它登记 thread
  const first = await runListener({
    cfgPath, root, turns: 'hang',
    events: [evLine({ message_id: 'om_stop_111111', message_type: 'post', thread_id: 'omt_stop1' })],
    until: () => existsSync(threadsPath) && readFileSync(threadsPath, 'utf8').includes('omt_stop1'),
  });
  assert.ok(first.ok, '任务应已登记 thread');
  const info = new Store(join(root, 'state')).findThread('omt_stop1');
  const ctxDir = join(info.worktree, '.harness-ceilf6', info.branch.replaceAll('/', '__'), 'context');
  // 第二程：话题内 /stop
  const second = await runListener({
    cfgPath, root, turns: 'hang',
    events: [evLine({ message_id: 'om_stopcmd_2222', thread_id: 'omt_stop1', root_id: 'om_stop_111111', content: '/stop' })],
    until: () => existsSync(larkLogPath) && readFileSync(larkLogPath, 'utf8').includes('MUTE'),
  });
  assert.ok(second.ok, '/stop 应落下 stopped 表情');
  const calls = readFileSync(larkLogPath, 'utf8');
  assert.ok(calls.includes('om_stop_111111/reactions'), '终态表情打在任务消息上');
  assert.ok(!calls.includes('messages-reply'), '群里零文字消息');
  assert.equal(existsSync(ctxDir) && readdirSync(ctxDir).length > 0, false, '控制命令不写 context');
  rmFixture(root);
});

test('端到端（stub）：私信 /tasks 列出在册任务，/stop 停掉唯一一个', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thb-lis-dmstop-')));
  const cfgPath = writeConfig(root, makeRepo(root));
  const larkLogPath = join(root, 'lark-calls.log');
  const threadsPath = join(root, 'state', 'threads.jsonl');
  const first = await runListener({
    cfgPath, root, turns: 'hang',
    events: [evLine({ message_id: 'om_dmstop_1111', message_type: 'post', thread_id: 'omt_dmstop' })],
    until: () => existsSync(threadsPath) && readFileSync(threadsPath, 'utf8').includes('omt_dmstop'),
  });
  assert.ok(first.ok);
  const second = await runListener({
    cfgPath, root, turns: 'hang',
    events: [
      dmLine({ message_id: 'om_dm_tasks11', content: '/tasks' }),
      dmLine({ message_id: 'om_dm_stop111', content: '/stop' }),
    ],
    until: () => existsSync(larkLogPath) && readFileSync(larkLogPath, 'utf8').includes('在册任务')
      && readFileSync(larkLogPath, 'utf8').includes('MUTE'),
  });
  assert.ok(second.ok, '/tasks 应回列表且 /stop 应生效');
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
  await poll(() => existsSync(threadsPath) && readFileSync(threadsPath, 'utf8').includes('omt_port'));
  const list = await (await fetch(`http://127.0.0.1:${port}/api/tasks`)).json();
  assert.equal(list.tasks.length, 1);
  assert.equal(list.tasks[0].state, 'active');
  const worktree = list.tasks[0].worktree;
  const stopped = await fetch(`http://127.0.0.1:${port}/api/stop`, { method: 'POST', body: JSON.stringify({ worktree }) });
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).was, 'active');
  await poll(async () => (await (await fetch(`http://127.0.0.1:${port}/api/tasks`)).json()).tasks.length === 0);
  child.kill('SIGTERM');
  await closed;
  rmFixture(root);
});
```

`listener.test.mjs` 顶部 import 补 `readdirSync`（若尚未引入）与 `import { createServer } from 'node:net';`（端口占用用例的占位服务器）；`writeConfig` 已有 `over` 形参，第三参覆盖可直接用。

- [ ] **Step 3: 跑测试**

Run: `node --test 'harness-ceilf6-bot/tests/**/*.test.mjs'`
Expected: 全部 PASS（若端到端红，按报错修 listener，不改断言语义）。

- [ ] **Step 4: Commit**

```bash
git add harness-ceilf6-bot/src/listener.mjs harness-ceilf6-bot/tests/listener.test.mjs
git commit -m "feat(bot): 控制回路编排、IM 拦截与控制端口接线"
```

---

### Task 5: 配置与 runbook

**Files:**
- Modify: `harness-ceilf6-bot/config.json`（**不 git add**，只改本机文件）
- Modify: `harness-ceilf6-bot/runbook.md`

**Interfaces:**
- Consumes: `config.controlPort`、`config.reactions.stopped`（Task 4 的校验清单已包含它们）。

- [ ] **Step 1: 改本机 config.json**（新增两处；该文件带个人 open_id，**绝不提交**）

在 `"minTextLength": 10,` 之后加一行：

```json
  "controlPort": 7659,
```

`reactions` 对象内加一行：

```json
    "stopped": "MUTE"
```

- [ ] **Step 2: 验证配置可被接受**

Run: `node -e "const c=require('./harness-ceilf6-bot/config.json'); console.log(c.controlPort, c.reactions.stopped)"`
Expected: 输出 `7659 MUTE`。

- [ ] **Step 3: 改 runbook.md**

依赖表下方、「一次性：创建飞书应用」之前插入新小节：

```markdown
## 控制命令（刹车）

bot 跑起来后随时可用，**控制命令由 listener 直接执行、不进会话**，所以长轮次（跑全量测试、机审 CR）里按下的停立刻生效。

| 命令 | 发在哪 | 作用 |
|---|---|---|
| `/tasks` | 私信 | 列出在册任务（运行中 / 等回复 / 排队中），带序号与 short（消息 id 后 6 位） |
| `/stop` | 话题内回复 | 停掉该话题的任务 |
| `/stop` / `/stop <序号\|short>` | 私信 | 在册只有一个时免参；多个时先 `/tasks` 再带序号 |
| `/pause` | 话题或私信 | 只杀进程、保留可续跑的等待态，之后私信回一句即懒续跑 |

- **停止**：杀进程组（连同会话自布的后台任务，如 pre-commit 钩子、traex 机审），群消息表情落 🛑（`reactions.stopped`），私信回执带 worktree 与接管命令。**现场（worktree / 分支 / 提交）一律保留**。
- **暂停**：表情落 ⚠️，回执说明回复即续跑。排队中的任务不能暂停（还没起进程），用 `/stop`。
- 控制命令只认**消息首行**：正文里出现的 `/stop` 是普通文本，不会误杀任务。
- **自然语言不生效**：话题里说「暂停」「先别跑」只会被存进 `context/` 供下次续入用（📝），正在跑的会话读不到。要停就发 `/stop`。
- 控制端口：`config.json` 的 `controlPort`（默认 7659，绑 127.0.0.1）。看板的停止按钮走它；端口被占时 bot 启动即响亮失败退出。
```

表情语义表加一行（`context` 行之后）：

```markdown
> | 人工叫停 | 🛑 | `stopped` | `MUTE` |
```

「已知边界」追加一条：

```markdown
- 准入规则是「群里发消息即任务」：讨论补充也可能被判成新任务（尤其在首帖 worktree 就绪前到达的话题回复会退化成独立任务）。误起的任务用 `/stop` 收拾，bot 不做 @ 点名才跑的过滤。
```

- [ ] **Step 4: 跑全量测试确认文档未破坏行为**

Run: `node --test 'harness-ceilf6-bot/tests/**/*.test.mjs'`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**（只提交 runbook，config.json 留在工作区）

```bash
git add harness-ceilf6-bot/runbook.md
git commit -m "docs(bot): 控制命令速查与停止/暂停语义"
```

---

### Task 6: threads.sh——archive / unarchive / clean 与 JSON 字段

**Files:**
- Modify: `harness-ceilf6/scripts/threads.sh`
- Test: `harness-ceilf6/tests/test-threads.sh`

**Interfaces:**
- Produces:
  - `ht archive --ctx-dir <路径>` / `ht unarchive --ctx-dir <路径>`：写 `meta.json` 的 `archived` 布尔字段。
  - `ht clean --ctx-dir <路径>`：删 worktree 目录 + `worktree prune` + `branch -D` + 登记表 prune；**主检出硬拒绝**。
  - `enumerate` 默认过滤 `archived == true`（`--all` 包含）。
  - `list --json` 每行新增 `cwd`（检出目录，看板据此与 bot 的 worktree 对齐）与 `archived`（布尔）。

- [ ] **Step 1: 写失败测试**（追加到 `harness-ceilf6/tests/test-threads.sh` 末尾统计行之前，复用文件内既有的 `make_env` / `make_repo` / `ok` / `bad` / `has` / `hasnt` / `check_die`）

```bash
# ---- archive / unarchive：看板视图开关，不动任何文件 ----
make_env
make_repo repo-arch feat/arch developing
(cd "$REPO" && bash "$TH" register --ctx-dir "$CTX" --title '归档冒烟') >/dev/null
out=$(bash "$TH" list --json)
echo "$out" | jq -e '.[0].archived == false' >/dev/null && ok "list --json 默认 archived=false" || bad "archived 默认值：$out"
echo "$out" | jq -e --arg w "$REPO" '.[0].cwd == $w' >/dev/null && ok "list --json 含 cwd" || bad "cwd 字段：$out"
bash "$TH" archive --ctx-dir "$CTX" >/dev/null
jq -e '.archived == true' "$CTX/meta.json" >/dev/null && ok "archive 写 meta.archived" || bad "archive 未写 meta"
[ -f "$CTX/meta.json" ] && [ -d "$REPO" ] && ok "archive 不删任何文件" || bad "archive 删了东西"
out=$(bash "$TH" list --json)
echo "$out" | jq -e 'length == 0' >/dev/null && ok "默认视图隐藏已归档" || bad "默认视图未隐藏：$out"
out=$(bash "$TH" list --json --all)
echo "$out" | jq -e 'length == 1 and .[0].archived == true' >/dev/null && ok "--all 显示已归档" || bad "--all 未显示：$out"
bash "$TH" unarchive --ctx-dir "$CTX" >/dev/null
out=$(bash "$TH" list --json)
echo "$out" | jq -e 'length == 1 and .[0].archived == false' >/dev/null && ok "unarchive 恢复显示" || bad "unarchive 失败：$out"
check_die "archive 缺 --ctx-dir" "用法" bash "$TH" archive
check_die "archive 指向无 meta 的目录" "meta.json" bash "$TH" archive --ctx-dir "$T/nope"
rm -rf "$T"

# ---- clean：删 worktree 与分支，主检出硬拒绝 ----
make_env
MAIN="$T/repo-main"; mkdir -p "$MAIN"
git -C "$MAIN" init -q -b master
git -C "$MAIN" config user.email t@t
git -C "$MAIN" config user.name t
git -C "$MAIN" commit -q --allow-empty -m init
WT="$T/wt-clean"
git -C "$MAIN" worktree add -q "$WT" -b feat/clean
CTX2="$WT/.harness-ceilf6/feat__clean"; mkdir -p "$CTX2"
jq -n '{branch:"feat/clean", status:"developing", milestones:{}}' > "$CTX2/meta.json"
(cd "$WT" && bash "$TH" register --ctx-dir "$CTX2" --title '清理冒烟') >/dev/null
# 主检出必须拒绝：删它等于删掉整个仓库
CTXM="$MAIN/.harness-ceilf6/master"; mkdir -p "$CTXM"
jq -n '{branch:"master", status:"developing", milestones:{}}' > "$CTXM/meta.json"
(cd "$MAIN" && bash "$TH" register --ctx-dir "$CTXM" --title '主检出') >/dev/null
check_die "clean 拒绝主检出" "主检出" bash "$TH" clean --ctx-dir "$CTXM"
[ -d "$MAIN/.git" ] && ok "主检出安然无恙" || bad "主检出被删"
bash "$TH" clean --ctx-dir "$CTX2" >/dev/null
[ -d "$WT" ] && bad "clean 未删 worktree 目录" || ok "clean 删掉 worktree 目录"
git -C "$MAIN" branch --list feat/clean | grep -q . && bad "clean 未删分支" || ok "clean 删掉分支"
git -C "$MAIN" worktree list | grep -q "$WT" && bad "worktree 注册表未 prune" || ok "worktree 注册表已 prune"
bash "$TH" list --json --all | jq -e --arg c "$CTX2" 'map(select(.ctx_dir == $c)) | length == 0' >/dev/null \
  && ok "clean 顺带清掉登记" || bad "clean 后登记仍在"
check_die "clean 缺 --ctx-dir" "用法" bash "$TH" clean
rm -rf "$T"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bash harness-ceilf6/tests/test-threads.sh`
Expected: 新增断言 FAIL（`archive` / `clean` 未知子命令、`cwd` / `archived` 字段缺失）。

- [ ] **Step 3: 实现——enumerate 过滤已归档**

`enumerate()` 内 `local` 行加 `arch`，并在 `if [ "$show_all" != 1 ] && [ "$status" = done ]; then continue; fi` 之前插入：

```bash
    arch=0
    if [ -f "$ctx/meta.json" ]; then
      arch=$(jq -r 'if .archived == true then 1 else 0 end' "$ctx/meta.json" 2>/dev/null || echo 0)
    fi
    if [ "$show_all" != 1 ] && [ "$arch" = 1 ]; then continue; fi
```

（`arch` 只用于过滤、不进输出字段——enumerate 的分隔字段被 `locate_thread` / `cmd_list` / `cmd_list_json` 三处按位读取，增列会同时改坏三个消费者。）

- [ ] **Step 4: 实现——list --json 增加 cwd 与 archived**

`cmd_list_json` 的 `local` 行加 `arch`；在 `resume=$(wake_cmd ...)` 之后插入：

```bash
      arch=false
      if [ -f "$ctx/meta.json" ]; then
        arch=$(jq -r 'if .archived == true then "true" else "false" end' "$ctx/meta.json" 2>/dev/null || echo false)
      fi
```

`jq -cn` 调用改为（新增两个入参与两个字段）：

```bash
      jq -cn --arg idx "$idx" --arg ctx "$ctx" --arg cwd "$cwd" --arg branch "$branch" --arg title "$title" \
        --arg status "$status" --arg node "$nodecol" --arg progress "$prog" --argjson ms "$ms" \
        --arg current "$curnode" --arg crr "$crr" --arg resume "$resume" --argjson arch "$arch" \
        '{idx:($idx|tonumber), ctx_dir:$ctx, cwd:$cwd, branch:$branch, title:$title, status:$status,
          node:$node, current:$current, cr_rounds:($crr|tonumber), progress:$progress,
          resume:$resume, archived:$arch, milestones:$ms}'
```

- [ ] **Step 5: 实现——archive / unarchive / clean 三个子命令**（放在 `cmd_prune` 之后、`cmd_web` 之前）

```bash
cmd_archive() { # <1|0>：看板视图开关，只写 meta.json 的 archived，不动任何文件
  local flag="$1" ctx="" meta tmp
  shift
  while [ $# -gt 0 ]; do
    case "$1" in --ctx-dir) ctx="${2:-}"; shift 2 ;; *) usage ;; esac
  done
  [ -n "$ctx" ] || die "用法：${0##*/} archive|unarchive --ctx-dir <路径>"
  meta="$ctx/meta.json"
  [ -f "$meta" ] || die "meta.json 不存在：${meta}"
  jq -e . "$meta" >/dev/null 2>&1 || die "meta.json 解析失败：${meta}"
  tmp=$(mktemp)
  jq --argjson a "$flag" '.archived = ($a == 1)' "$meta" > "$tmp" && mv "$tmp" "$meta"
  if [ "$flag" = 1 ]; then echo "harness-threads: 已归档 ${ctx}"; else echo "harness-threads: 已取消归档 ${ctx}"; fi
}

cmd_clean() { # 删 worktree 目录 + 分支 + 登记；主检出硬拒绝
  local ctx="" cwd branch cwdp commonp repo
  while [ $# -gt 0 ]; do
    case "$1" in --ctx-dir) ctx="${2:-}"; shift 2 ;; *) usage ;; esac
  done
  [ -n "$ctx" ] || die "用法：${0##*/} clean --ctx-dir <路径>"
  cwd=$(rows | jq -r --arg c "$ctx" 'select(.ctx_dir == $c) | .cwd' | tail -1)
  branch=$(rows | jq -r --arg c "$ctx" 'select(.ctx_dir == $c) | .branch' | tail -1)
  [ -n "$cwd" ] || die "登记表里没有 ctx_dir=${ctx}"
  [ -d "$cwd" ] || die "检出目录不存在：${cwd}"
  cwdp=$(cd "$cwd" && pwd -P)
  commonp=$(cd "$cwd" && cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P) \
    || die "不是 git 检出：${cwd}"
  # 主检出的 git-common-dir 就是它自己的 .git：删它等于删掉整个仓库
  [ "$commonp" = "${cwdp}/.git" ] && die "拒绝清理主检出：${cwd}"
  repo=$(dirname "$commonp")
  # 三步各自独立：worktree remove --force 要遍历校验整棵工作树，巨型仓库上要数分钟
  rm -rf "$cwdp"
  git -C "$repo" worktree prune
  git -C "$repo" branch -D "$branch" >/dev/null 2>&1 || true
  cmd_prune >/dev/null
  echo "harness-threads: 已清理 ${branch}（${cwdp}）"
}
```

case 分发加三行（`prune)` 之后）：

```bash
  archive) cmd_archive 1 "$@" ;;
  unarchive) cmd_archive 0 "$@" ;;
  clean) cmd_clean "$@" ;;
```

`usage()` 的命令清单加三行：

```
  ht archive|unarchive --ctx-dir <路径>   看板视图开关（不删文件）
  ht clean --ctx-dir <路径>               删 worktree 目录与分支（主检出拒绝）
```

- [ ] **Step 6: 跑测试确认通过**

Run: `bash harness-ceilf6/tests/test-threads.sh`
Expected: `FAIL=0`。

- [ ] **Step 7: Commit**

```bash
git add harness-ceilf6/scripts/threads.sh harness-ceilf6/tests/test-threads.sh
git commit -m "feat(harness-ceilf6): 线程归档/取消归档/清理与看板 JSON 字段"
```

---

### Task 7: web.py——运行态合并与停止 / 归档 / 清理

**Files:**
- Modify: `harness-ceilf6/scripts/web.py`
- Test: `harness-ceilf6/tests/test-web.sh`

**Interfaces:**
- Consumes: `threads.sh list --json` 的 `cwd` / `archived` 字段（Task 6）、`threads.sh archive|unarchive|clean`（Task 6）、bot 控制端口的 `GET /api/tasks` 与 `POST /api/stop`（Task 3/4）。

**对 spec §3.1 的一处偏离（已知，需实现者照此执行）**：spec 写「停止后线程标灰显示『已停』」。看板无法知道一个线程曾被停止——运行态只存在于 bot 内存，停止后即消失；要持久化「已停」得让 bot 去写 harness-ceilf6 的 `meta.json`，那是跨技能的写入越权（该文件的单点写入者是 `threads.sh` 与 `ctx-dir.sh`）。本计划的处置是：**停止后卡片仅失去「运行中」徽标**，归档/清理两个按钮就在原地供接续。IM 侧的 🛑 仍是「曾被人工叫停」的完整记录。
- Produces：`GET /api/running`（bot 离线时降级为 `{"tasks": [], "offline": true}` + 200）、`POST /api/stop {cwd}`、`POST /api/archive {ctx_dir, archived}`、`POST /api/clean {ctx_dir}`。

- [ ] **Step 1: 写失败测试**（追加到 `harness-ceilf6/tests/test-web.sh` 末尾统计行之前）

```bash
# bot 未运行时 /api/running 降级为空列表 + offline，看板照常渲染
out=$(curl -s "http://127.0.0.1:${PORT}/api/running")
echo "$out" | jq -e '.offline == true and (.tasks | length) == 0' >/dev/null \
  && ok "bot 离线时 running 降级" || bad "running 降级：$out"

# 归档 → 默认视图消失 → --all 可见 → 取消归档回来
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/archive" \
  -d "{\"ctx_dir\":\"$CTX\",\"archived\":true}")
[ "$code" = 200 ] && ok "api/archive 200" || bad "api/archive: $code"
jq -e '.archived == true' "$CTX/meta.json" >/dev/null && ok "archive 落盘" || bad "archive 未落盘"
out=$(curl -s "http://127.0.0.1:${PORT}/api/threads")
echo "$out" | jq -e 'length == 0' >/dev/null && ok "默认视图隐藏已归档" || bad "默认视图：$out"
out=$(curl -s "http://127.0.0.1:${PORT}/api/threads?all=1")
echo "$out" | jq -e 'length == 1' >/dev/null && ok "all=1 显示已归档" || bad "all=1：$out"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/archive" \
  -d "{\"ctx_dir\":\"$CTX\",\"archived\":false}")
[ "$code" = 200 ] && ok "api/archive 取消 200" || bad "api/archive 取消: $code"

# bot 离线时停止请求给出 503 而非 500，且不改变任何盘上状态
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/stop" \
  -d "{\"cwd\":\"$REPO\"}")
[ "$code" = 503 ] && ok "bot 离线时 stop 返回 503" || bad "stop 离线码: $code"

# 坏入参一律 400
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/archive" -d '{}')
[ "$code" = 400 ] && ok "api/archive 缺参 400" || bad "api/archive 缺参: $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/clean" -d '{}')
[ "$code" = 400 ] && ok "api/clean 缺参 400" || bad "api/clean 缺参: $code"

# clean 走 threads.sh：主检出被拒绝时返回 500 且仓库安然无恙
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/clean" \
  -d "{\"ctx_dir\":\"$CTX\"}")
[ "$code" = 500 ] && ok "clean 主检出被拒（500）" || bad "clean 主检出码: $code"
[ -d "$REPO/.git" ] && ok "主检出安然无恙" || bad "主检出被删"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bash harness-ceilf6/tests/test-web.sh`
Expected: 新增断言 FAIL（`/api/running` 等路径 404）。

- [ ] **Step 3: 实现——引入 bot 控制端口代理**

文件头 import 区加两行：

```python
import urllib.error
import urllib.request
```

常量区（`SET_TARGETS` 之后）加：

```python
# bot 控制端口：看板的停止按钮转调它。bot 未运行时看板只是少了运行态信息，不是错误。
BOT_CONTROL = os.environ.get("HARNESS_BOT_CONTROL", "http://127.0.0.1:7659")


def bot_request(path, payload=None, timeout=5):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        BOT_CONTROL.rstrip("/") + path, data=data,
        method="POST" if data is not None else "GET",
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8") or "{}")
```

- [ ] **Step 4: 实现——新增四个端点**

`do_GET` 的 `elif self.path.split("?")[0] == "/api/threads":` 分支之后插入：

```python
        elif self.path == "/api/running":
            try:
                self._send(200, json.dumps(bot_request("/api/tasks")))
            except Exception:
                # bot 未运行时看板照常渲染静态进度：这里的失败是「没有运行态信息」而非错误
                self._send(200, json.dumps({"tasks": [], "offline": True}))
```

`do_POST` 的 `elif self.path == "/api/set-node":` 分支之后插入：

```python
        elif self.path == "/api/stop":
            got = self._post_body(("cwd",))
            if got is None:
                self._send(400, json.dumps({"error": "需要 JSON：{cwd}"}))
                return
            (cwd,) = got
            try:
                out = bot_request("/api/stop", {"worktree": cwd})
            except Exception as e:
                self._send(503, json.dumps({"error": f"bot 控制端口不可达：{e}"}))
                return
            self._send(200 if out.get("ok") else 400, json.dumps(out))
            return
        elif self.path == "/api/archive":
            got = self._post_body(("ctx_dir", "archived"))
            if got is None:
                self._send(400, json.dumps({"error": "需要 JSON：{ctx_dir, archived}"}))
                return
            ctx, archived = got
            r = run_threads("archive" if archived else "unarchive", "--ctx-dir", ctx)
        elif self.path == "/api/clean":
            got = self._post_body(("ctx_dir",))
            if got is None:
                self._send(400, json.dumps({"error": "需要 JSON：{ctx_dir}"}))
                return
            (ctx,) = got
            r = run_threads("clean", "--ctx-dir", ctx)
```

- [ ] **Step 5: 实现——页面：运行态徽标与三个按钮**

`<style>` 内加一行：

```css
 .badge{margin-left:8px;font-size:12px;border-radius:10px;padding:1px 8px;background:#eef;color:#334}
 .badge.run{background:#dcfce7;color:#166534}
 .acts{display:flex;gap:8px;margin-top:8px}
```

`<label>` 一行改为（一个开关同时管已完成与已归档）：

```html
<label><input type="checkbox" id="all"> 显示已完成/已归档</label>
```

`<script>` 内 `async function load()` 之前插入：

```js
let RUN = {tasks: [], offline: true};
async function loadRunning(){
  try { RUN = await (await fetch('/api/running')).json(); }
  catch(e){ RUN = {tasks: [], offline: true}; }
}
function runningOf(t){ return (RUN.tasks || []).find(x => x.worktree && x.worktree === t.cwd); }
async function post(path, body){
  const r = await fetch(path, {method:'POST', body: JSON.stringify(body)});
  const out = await r.json().catch(() => ({}));
  if (!r.ok) alert(out.error || '操作失败');
  load();
}
function actions(t){
  const wrap = document.createElement('div');
  wrap.className = 'acts';
  const r = runningOf(t);
  const stop = document.createElement('button');
  stop.textContent = '停止';
  if (r){
    stop.onclick = () => { if (confirm('停止「' + (t.title || t.branch) + '」？现场保留，可手工续跑')) post('/api/stop', {cwd: t.cwd}); };
  } else {
    stop.disabled = true;
    stop.title = RUN.offline ? 'bot 未运行' : '该线程当前没有在跑的任务';
  }
  wrap.appendChild(stop);
  const arch = document.createElement('button');
  arch.textContent = t.archived ? '取消归档' : '归档';
  arch.onclick = () => post('/api/archive', {ctx_dir: t.ctx_dir, archived: !t.archived});
  wrap.appendChild(arch);
  const clean = document.createElement('button');
  clean.textContent = '清理';
  clean.onclick = () => {
    if (!confirm('清理「' + (t.title || t.branch) + '」？将删除 worktree 目录与分支，不可撤销')) return;
    if (!confirm('再确认一次：删除 ' + t.cwd)) return;
    post('/api/clean', {ctx_dir: t.ctx_dir});
  };
  wrap.appendChild(clean);
  return wrap;
}
```

`load()` 的第一行改为先取运行态：

```js
async function load(){
  await loadRunning();
  const all = document.getElementById('all').checked ? '?all=1' : '';
```

卡片渲染里 `h.appendChild(b);` 之后插入徽标，`d.appendChild(renderNodes(t));` 之后插入动作条：

```js
    const r = runningOf(t);
    if (r){
      const badge = document.createElement('span');
      badge.className = 'badge run';
      badge.textContent = r.state === 'active' ? '运行中' : (r.state === 'waiting' ? '等回复' : '排队中');
      h.appendChild(badge);
    }
    if (t.archived){
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '已归档';
      h.appendChild(badge);
    }
```

```js
    d.appendChild(actions(t));
```

- [ ] **Step 6: 跑测试确认通过**

Run: `bash harness-ceilf6/tests/test-web.sh`
Expected: `FAIL=0`。

- [ ] **Step 7: Commit**

```bash
git add harness-ceilf6/scripts/web.py harness-ceilf6/tests/test-web.sh
git commit -m "feat(harness-ceilf6): 看板运行态徽标与停止/归档/清理"
```

---

### Task 8: 收尾——全量回归、squash、部署与真机验收

- [ ] **Step 1: 全量回归**

```bash
node --test 'harness-ceilf6-bot/tests/**/*.test.mjs'
bash harness-ceilf6/tests/test-threads.sh
bash harness-ceilf6/tests/test-web.sh
bash harness-ceilf6/tests/test-cr-round.sh
```

Expected: 四套件全绿、零 skip。

- [ ] **Step 2: squash 成单个 commit**

```bash
git reset --soft main
git commit -m "feat(harness-ceilf6-bot): 控制面刹车与看板线程管理

/stop /pause /tasks 三条控制命令由 listener 直接执行、不进会话，长轮次里
按下的停立刻生效；停止走 stopped 终态（🛑、现场保留、私信带接管命令），
暂停只杀进程保留可续跑等待态。IM 与看板共用本机控制端口（127.0.0.1:7659）。
看板新增运行态徽标与停止/归档/清理三个动作，bot 离线时降级不报错。"
```

确认 `git show --stat HEAD` 不含 `config.json`、`docs/superpowers/`、`state/`、`logs/`。

- [ ] **Step 3: 部署**（会重启 live bot——先确认无活跃任务）

```bash
for p in $(pgrep -f "^claude"); do lsof -p $p -a -d cwd -Fn 2>/dev/null | grep '^n' | grep taskhall-worktrees; done
bash harness-ceilf6-bot/install.sh
launchctl list | grep harness-ceilf6-bot
curl -s http://127.0.0.1:7659/api/tasks
```

Expected: 进程列表为空时再装；装后 `launchctl list` 有 PID，`/api/tasks` 返回 `{"tasks":[...]}`。

- [ ] **Step 4: 真机验收**（需用户在飞书配合）

1. 群里发一条任务 → 话题内回 `/stop` → 群消息表情变 🛑、`pgrep -f "^claude"` 里该 worktree 的进程消失、私信回执含 worktree 路径；
2. 同时跑两个任务 → 私信 `/tasks` 见列表 → `/stop` 无参得到「请带序号」提示 → `/stop 2` 精确停掉第二个，回执标题正确；
3. `/pause` 一个活跃任务 → 表情 ⚠️ → 私信回一句 → 懒续跑继续到终态；
4. `ht web` 打开看板：运行中徽标出现 → 点停止 → 卡片转无徽标 → 点归档消失 → 勾「显示已完成/已归档」看回来 → 点清理二次确认后 worktree 与分支消失；
5. `launchctl unload ~/Library/LaunchAgents/com.ceilf6.harness-ceilf6-bot.plist` → 刷新看板：停止按钮置灰提示「bot 未运行」，页面其余部分正常渲染；验收后重新 `install.sh` 启回。

- [ ] **Step 5: 合并**

```bash
git checkout main && git merge --ff-only feat/bot-control-plane
```
