import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

function eventsFile(taskDir, session, stage) {
  return join(taskDir, 'sessions', session, 'stages', stage, 'system', 'runtime', 'raw', 'events.jsonl');
}

function appendInitLine(taskDir, session, stage, model) {
  const line = JSON.stringify({ event: 'session_started', data: { session_id: 's' }, provider: { kind: 'claude', event: 'system/init', direction: 'inbound', data: { type: 'system', subtype: 'init', model, cwd: '/w' } } });
  appendFileSync(eventsFile(taskDir, session, stage), `\n${line}\n`);
}

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

test('firstStageModel 取字典序最早的 session，与目录创建顺序无关', () => {
  const ws = mkdtempSync(join(tmpdir(), 'tm-'));
  const td = taskDir(ws, 'task_d');
  writeStage(td, '20260924T020000', '1-ptd', 'claude-fable-5-1');
  writeStage(td, '20260924T010000', '1-ptd', 'claude-opus-5-5');
  assert.deepEqual(firstStageModel(td), { model: 'claude-opus-5-5', stage: '1-ptd', session: '20260924T010000' });
});

test('firstStageModel 容忍半写入的截断行，写完后能读到 model', () => {
  const ws = mkdtempSync(join(tmpdir(), 'tm-'));
  const td = taskDir(ws, 'task_e');
  writeStage(td, '20260924T000000', '1-ptd', null);
  appendFileSync(eventsFile(td, '20260924T000000', '1-ptd'), '{"event":"session_started","provider":{"event":"system/init","data":{"model":"claude-opu');
  assert.equal(firstStageModel(td), null);
  appendInitLine(td, '20260924T000000', '1-ptd', 'claude-opus-5-5');
  assert.deepEqual(firstStageModel(td), { model: 'claude-opus-5-5', stage: '1-ptd', session: '20260924T000000' });
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
  const badFamily = run('--workspace', ws, '--task-id', 'task_c', '--expect', 'sonnet', '--wait', '0');
  assert.equal(badFamily.status, 2);
  assert.match(badFamily.err, /用法/);
  assert.equal(run('--workspace', ws, '--task-id', 'task_c').status, 2);
});

test('CLI --wait 1 且无记录时按剩余时间退出，不越期睡满 10 秒', () => {
  const ws = mkdtempSync(join(tmpdir(), 'tm-'));
  const startedAt = Date.now();
  const r = run('--workspace', ws, '--task-id', 'task_none', '--expect', 'opus', '--wait', '1');
  const elapsedMs = Date.now() - startedAt;
  assert.equal(r.status, 1);
  assert.ok(elapsedMs < 5000, `耗时 ${elapsedMs}ms，应少于 5000ms`);
});

test('CLI 某个 flag 的值被另一个 flag 误占时视为缺失，退出 2', () => {
  const r = run('--workspace', '--task-id', 't', '--expect', 'opus', '--wait', '0');
  assert.equal(r.status, 2);
  assert.match(r.err, /用法/);
});
