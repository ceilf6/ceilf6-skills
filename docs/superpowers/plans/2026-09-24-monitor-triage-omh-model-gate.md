# monitor-triage omh 模型约束 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** monitor-triage 派出去的 omh 任务固定跑 opus：派单命令带 `ANTHROPIC_MODEL=opus` 前缀，起单后用 `task-model.mjs` 核验第一个 stage 的实际模型，不符即 cancel。

**Architecture:** 一个只读脚本 `scripts/task-model.mjs` 读 omh Task 目录里最早 stage 的 `events.jsonl` `system/init` 记录取 `model`；SKILL.md 派单一节加前缀纪律与核验步骤。不改 `~/.claude/settings.json`、不改团队 `omh.config.yaml`。

**Tech Stack:** Node.js 24 ESM（`node:test`，零 npm 依赖）。

Spec：`docs/superpowers/specs/2026-09-24-monitor-triage-harness-handoff-v2-design.md` §4.4、§5.2 第 9/10 步、§5.3。

## Global Constraints

- 仓库根 `/Users/<user>/Desktop/ceilf/ceilf6-skills`，技能目录 `monitor-triage/`。在分支 `feat/monitor-triage-omh-model-gate` 上开发（从 main 切）。
- 所有脚本 stdout 只有一行 JSON。
- `task-model.mjs` 只读，不 cancel、不写任何文件。
- `--expect` 只接受 `opus`（对应 `^claude-opus-`）；其它值退出 2 并打用法。
- 注释与文档以首次打开文件的读者视角陈述现状，不写「不再 / 原来 / 改为 / 已删除」等变更叙事。
- `docs/superpowers/` 不提交。commit 末尾带 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`（放正文，不放标题行）。
- 全量测试：`bash monitor-triage/tests/run.sh`，node 汇总行 `ℹ fail 0`，bash 套件 `pass=16 fail=0`（board）、`pass=21 fail=0`（prepare-dispatch）。
- orchestrator 0.1.105 的取消命令是 `orchestrator task cancel --task-id <id>`（没有 `task-cancel`）。

---

### Task 1: `scripts/task-model.mjs` 与单测

**Files:**
- Create: `monitor-triage/scripts/task-model.mjs`
- Create: `monitor-triage/tests/task-model.test.mjs`

**Interfaces:**
- Produces: `node task-model.mjs --workspace <abs> --task-id <id> --expect opus [--wait <秒>]` → stdout 一行 `{ok:true, model, stage, session, matches}`；`--wait` 秒内无记录 → `{ok:false, error:"<wait> 秒内未见 stage 启动记录"}` 退出 1；参数错误退出 2。导出 `firstStageModel(taskDir)` → `{model, stage, session} | null`，`matchesFamily(model, family)`。

- [ ] **Step 1: 写失败测试**

`monitor-triage/tests/task-model.test.mjs`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { firstStageModel, matchesFamily } from '../scripts/task-model.mjs';

const CLI = fileURLToPath(new URL('../scripts/task-model.mjs', import.meta.url));
const run = (...args) => {
  try {
    return { status: 0, out: JSON.parse(execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' })) };
  } catch (error) {
    return { status: error.status, out: error.stdout ? JSON.parse(error.stdout) : null, err: error.stderr };
  }
};

// 与 orchestrator 0.1.105 写进 system/runtime/raw/events.jsonl 的记录同形：
// 首行 trace_started，随后 session_started 携带 provider system/init，model 在 provider.data 里。
function writeStage(taskDir, session, stage, model) {
  const dir = join(taskDir, 'sessions', session, 'stages', stage, 'system', 'runtime', 'raw');
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ ts: 1, event: 'trace_started', data: { schema_version: 2, runtime: 'claude' } }),
    JSON.stringify({ event: 'input_received', data: { channel: 'system', source: 'initial', content: '# x' } }),
  ];
  if (model) lines.push(JSON.stringify({ event: 'session_started', data: { session_id: 's' }, provider: { kind: 'claude', event: 'system/init', direction: 'inbound', data: { type: 'system', subtype: 'init', model, cwd: '/w' } } }));
  writeFileSync(join(dir, 'events.jsonl'), lines.join('\n') + '\n');
}

const taskDir = (ws, id) => join(ws, '.omh', 'tasks', id);

test('firstStageModel 取序号最小的 stage，stage 目录按数字前缀而非字典序', () => {
  const ws = mkdtempSync(join(tmpdir(), 'tm-'));
  const td = taskDir(ws, 'task_a');
  writeStage(td, '20260924T000000', '10-gen-test', 'claude-fable-5-1');
  writeStage(td, '20260924T000000', '2-impl', 'claude-opus-5-5');
  assert.deepEqual(firstStageModel(td), { model: 'claude-opus-5-5', stage: '2-impl', session: '20260924T000000' });
});

test('firstStageModel 跳过还没有 init 记录的 stage，全部没有时返回 null', () => {
  const ws = mkdtempSync(join(tmpdir(), 'tm-'));
  const td = taskDir(ws, 'task_b');
  writeStage(td, '20260924T000000', '1-ptd', null);
  assert.equal(firstStageModel(td), null);
  writeStage(td, '20260924T000000', '2-impl', 'claude-opus-5-5');
  assert.equal(firstStageModel(td).stage, '2-impl');
  assert.equal(firstStageModel(join(ws, '.omh', 'tasks', 'nope')), null);
});

test('matchesFamily 只认 opus 族前缀', () => {
  assert.equal(matchesFamily('claude-opus-5-5', 'opus'), true);
  assert.equal(matchesFamily('claude-opus-5-5[1m]', 'opus'), true);
  assert.equal(matchesFamily('claude-fable-5-1', 'opus'), false);
  assert.throws(() => matchesFamily('claude-opus-5-5', 'sonnet'), /expect/);
});

test('CLI 输出 model / stage / matches；--wait 0 且无记录时退出 1；--expect 非 opus 退出 2', () => {
  const ws = mkdtempSync(join(tmpdir(), 'tm-'));
  writeStage(taskDir(ws, 'task_c'), '20260924T000000', '1-ptd', 'claude-fable-5-1');
  const r = run('--workspace', ws, '--task-id', 'task_c', '--expect', 'opus', '--wait', '0');
  assert.equal(r.status, 0);
  assert.deepEqual(r.out, { ok: true, model: 'claude-fable-5-1', stage: '1-ptd', session: '20260924T000000', matches: false });
  const empty = run('--workspace', ws, '--task-id', 'task_none', '--expect', 'opus', '--wait', '0');
  assert.equal(empty.status, 1);
  assert.match(empty.out.error, /未见 stage 启动记录/);
  assert.equal(run('--workspace', ws, '--task-id', 'task_c', '--expect', 'sonnet', '--wait', '0').status, 2);
  assert.equal(run('--workspace', ws, '--task-id', 'task_c').status, 2);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test monitor-triage/tests/task-model.test.mjs 2>&1 | tail -12`
Expected: 报 `Cannot find module '../scripts/task-model.mjs'`

- [ ] **Step 3: 实现**

`monitor-triage/scripts/task-model.mjs`：

```js
#!/usr/bin/env node
// 起单后核验 omh 实际跑的模型。omh 起每个 stage 的 claude 子进程不带 --model，模型来自进程 env
// （ANTHROPIC_MODEL）或执行机的 ~/.claude/settings.json；唯一可靠的事后证据是 stage 会话首条
// system/init 记录里的 model。本脚本只读，不 cancel、不写文件。
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 只钉 opus 族：派单纪律要求固定 opus，其它族没有被接受的理由。
const FAMILIES = { opus: /^claude-opus-/ };

function byStageNumber(a, b) {
  return (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0) || a.localeCompare(b);
}

function initModel(eventsFile) {
  if (!existsSync(eventsFile)) return null;
  for (const line of readFileSync(eventsFile, 'utf8').split('\n')) {
    if (!line.includes('system/init')) continue;
    try {
      const record = JSON.parse(line);
      const model = record?.provider?.event === 'system/init' ? record.provider.data?.model : undefined;
      if (typeof model === 'string' && model) return model;
    } catch {
      // 半写入的行留给下一轮重读
    }
  }
  return null;
}

export function firstStageModel(taskDir) {
  const sessionsDir = join(taskDir, 'sessions');
  if (!existsSync(sessionsDir)) return null;
  for (const session of readdirSync(sessionsDir).sort()) {
    const stagesDir = join(sessionsDir, session, 'stages');
    if (!existsSync(stagesDir)) continue;
    for (const stage of readdirSync(stagesDir).sort(byStageNumber)) {
      const model = initModel(join(stagesDir, stage, 'system', 'runtime', 'raw', 'events.jsonl'));
      if (model) return { model, stage, session };
    }
  }
  return null;
}

export function matchesFamily(model, family) {
  const re = FAMILIES[family];
  if (!re) throw new Error(`--expect 只接受 ${Object.keys(FAMILIES).join('|')}`);
  return re.test(model);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function isMain() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

const USAGE = '用法: task-model.mjs --workspace <abs> --task-id <id> --expect opus [--wait <秒，默认 600>]\n';

if (isMain()) {
  const workspace = arg('--workspace');
  const taskId = arg('--task-id');
  const family = arg('--expect');
  const wait = Number(arg('--wait') ?? 600);
  if (!workspace || !taskId || !FAMILIES[family] || !Number.isFinite(wait) || wait < 0) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const taskDir = join(workspace, '.omh', 'tasks', taskId);
  const deadline = Date.now() + wait * 1000;
  let found = firstStageModel(taskDir);
  while (!found && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
    found = firstStageModel(taskDir);
  }
  if (!found) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: `${wait} 秒内未见 stage 启动记录：${taskDir}` })}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, ...found, matches: matchesFamily(found.model, family) })}\n`);
}
```

`chmod +x monitor-triage/scripts/task-model.mjs`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test monitor-triage/tests/task-model.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: `ℹ fail 0`

Run: `bash monitor-triage/tests/run.sh 2>&1 | grep -E "^ℹ (pass|fail)|pass="`
Expected: `ℹ fail 0`，`pass=16 fail=0`，`pass=21 fail=0`

- [ ] **Step 5: Commit**

```bash
git add monitor-triage/scripts/task-model.mjs monitor-triage/tests/task-model.test.mjs
git commit -m "feat(monitor-triage): task-model.mjs 核验 omh 第一个 stage 的实际模型" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: SKILL.md 前缀纪律与核验步骤

**Files:**
- Modify: `monitor-triage/SKILL.md`

**Interfaces:**
- Consumes: `task-model.mjs`（Task 1）。

先完整读一遍 `monitor-triage/SKILL.md`。所有替换用精确字符串。

- [ ] **Step 1: description**

把 `转交 biz-vc-web-harness 任务链修复、登记看板。` 改为 `转交 biz-vc-web-harness 任务链修复（omh 固定跑 opus）、登记看板。`

- [ ] **Step 2: 派单第 9 步**

把第 9 步整行替换为：

```
9. 执行：按 `<harness>/skills/task-execute/SKILL.md` 执行。**本 Task 的 `task-entry create` 与之后每条 `orchestrator` / omh-resume 命令，都在同一条 Bash 内以 `ANTHROPIC_MODEL=opus` 为前缀**——omh 起 stage 子进程不带 `--model`，模型从这棵进程树的 env 继承；只改这一棵树，不动 `~/.claude/settings.json` 与团队 `omh.config.yaml`。渲染 omh-loop handoff 时 `<stage_goal>` 写明：workflow 用 `pc-web-bugfix`；任务书即已批准方案，无需再 plan；ticket-platform 已提供（见任务书首行）；以上前缀规则。
```

- [ ] **Step 3: 插入核验步骤并重编号**

在第 9 步之后、现第 10 步（`omh-loop 建单返回 \`task_id\` 后立即落账…`）之前插入：

```
10. 核验模型：omh-loop 建单返回 `task_id` 后、spawn monitor 之前，执行 `node <skill>/scripts/task-model.mjs --workspace <worktree 绝对路径> --task-id <task_id> --expect opus`（默认最多等 600 秒到第一个 stage 启动）。`matches:false` 或超时：在 worktree 内 `ANTHROPIC_MODEL=opus orchestrator task cancel --task-id <task_id>`，按 task-schedule 把任务置 `blocked`（原因写实际模型），回话题说明并停；不写处置账，issue 保持 pending，下次「派这条」从第 6 步续做（ticket-platform、任务书、managed task 复用，第 8 步见目录已存在即跳过）。
```

然后把原第 10、11、12 步的编号改为 11、12、13。原第 12 步（回话题）里的 `orchestrator task-cancel --task-id <id>` 改为 `orchestrator task cancel --task-id <id>`，并在「Task ID、worktree」之后加「实际模型」。

- [ ] **Step 4: 第 8 步补续派说明**

第 8 步末尾追加一句：`\`workspaces/tasks/<slug>\` 已存在（上次因模型核验 cancel 后续派）则跳过本步。`

- [ ] **Step 5: 纪律**

在 `- 派单只经 biz-vc-web-harness 任务链；本技能不开 worktree、不起 omh。` 之后插入一条：

```
- monitor-triage 派的 omh 固定跑 opus：`ANTHROPIC_MODEL=opus` 前缀覆盖本 Task 全部 `task-entry` / `orchestrator` / omh-resume 命令，起单后经 `task-model.mjs` 核验第一个 stage 的实际模型，不符即 cancel。不改 `~/.claude/settings.json`，不改 `biz-vc-web` 的 `omh.config.yaml`。
```

- [ ] **Step 6: 自查**

Run: `grep -n "task-cancel\|不再 " monitor-triage/SKILL.md`
Expected: 无输出

Run: `grep -c "ANTHROPIC_MODEL=opus" monitor-triage/SKILL.md`
Expected: `3`（第 9 步、第 10 步、纪律）

Run: `grep -nE "^(1[0-3])\. " monitor-triage/SKILL.md`
Expected: 10 核验模型、11 落账、12 lark-sediment、13 回话题，各一行

Run: `bash monitor-triage/tests/run.sh 2>&1 | grep -E "^ℹ fail|pass="`
Expected: 全绿

- [ ] **Step 7: Commit**

```bash
git add monitor-triage/SKILL.md
git commit -m "feat(monitor-triage): 派单的 omh 固定跑 opus，起单后核验实际模型" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: 收口

- [ ] 全量测试；`git log main..HEAD --name-only --format= | grep docs/` 为空；squash 成一个 commit：

```
feat(monitor-triage): 派单的 omh 固定跑 opus

派单命令以 ANTHROPIC_MODEL=opus 前缀执行，omh 起的 stage 子进程从这棵进程树
继承模型；起单后 task-model.mjs 读第一个 stage 的 system/init 记录核验实际模型，
不符即 cancel。不改 ~/.claude/settings.json，不改团队 omh.config.yaml。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
