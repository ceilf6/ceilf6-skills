#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadState, saveState } from './state.mjs';

function readJson(file, fallback) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}

// 阶段目录名形如 `3-code-review` 或 `5-code-review@2`：序号-阶段名[@重试次数]。
function parseStageDir(name) {
  const m = /^(\d+)-(.+?)(?:@(\d+))?$/.exec(name);
  return m ? { order: Number(m[1]), name: m[2], attempt: m[3] ? Number(m[3]) : 1 } : null;
}

function readJsonLine(line) {
  try {
    return line.trim() ? JSON.parse(line) : null;
  } catch {
    return null;
  }
}

export function summarizeTask(taskDir) {
  const empty = { phase: 'unknown', session_status: 'unknown', stages: [], mr_url: null };
  if (!existsSync(taskDir)) return empty;
  const phase = readJson(join(taskDir, 'meta.json'), {}).phase ?? 'unknown';
  const sessionsDir = join(taskDir, 'sessions');
  const sids = existsSync(sessionsDir) ? readdirSync(sessionsDir).sort() : [];
  const sid = sids[sids.length - 1];
  if (!sid) return { ...empty, phase };
  const sessionDir = join(sessionsDir, sid);
  const sessionStatus = readJson(join(sessionDir, 'session.json'), {}).status ?? 'unknown';
  const stagesDir = join(sessionDir, 'stages');
  const stages = [];
  let mrUrl = null;
  for (const dir of existsSync(stagesDir) ? readdirSync(stagesDir) : []) {
    const parsed = parseStageDir(dir);
    if (!parsed) continue;
    const result = readJson(join(stagesDir, dir, 'system', 'result.json'), {});
    stages.push({ ...parsed, verdict: result.verdict ?? 'running', summary: result.summary ?? '' });
    const deliveries = join(stagesDir, dir, 'system', 'code-deliveries.jsonl');
    if (existsSync(deliveries)) {
      for (const line of readFileSync(deliveries, 'utf8').split('\n')) {
        const url = readJsonLine(line)?.delivery_url;
        if (url) mrUrl = url;
      }
    }
  }
  stages.sort((a, b) => a.order - b.order);
  return { phase, session_status: sessionStatus, stages, mr_url: mrUrl };
}

// omh handoff 出 MR 后把 mr_id 回填到看板 ctx 的 meta.json：卡片标题按 mr_id 显示「MR <号>」，
// meego.sh 的表单占位也读它。只在缺失时写，不覆盖人工改过的值。
export function backfillMrId(metaPath, mrUrl) {
  const id = /\/detail\/(\d+)/.exec(mrUrl ?? '')?.[1];
  if (!id || !existsSync(metaPath)) return { updated: false, mr_id: id ?? null };
  const meta = readJson(metaPath, null);
  if (!meta || meta.mr_id) return { updated: false, mr_id: meta?.mr_id ?? id };
  writeFileSync(metaPath, `${JSON.stringify({ ...meta, mr_id: id }, null, 2)}\n`);
  return { updated: true, mr_id: id };
}

function isMain() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// 技能目录经 symlink 安装，argv[1] 是链接路径而 import.meta.url 是真实路径，须按 realpath 比较。
if (isMain()) {
  const state = loadState(arg('--state'));
  const entries = Object.entries(state.dispatched).filter(([, d]) => d.task_id && d.workspace);
  const wanted = arg('--issue-id');
  const picked = wanted
    ? entries.find(([id]) => id === wanted)
    : entries.sort((a, b) => (b[1].dispatched_at ?? '').localeCompare(a[1].dispatched_at ?? ''))[0];
  if (!picked) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: '没有已派发的 Task' })}\n`);
    process.exit(0);
  }
  const [issueId, d] = picked;
  const summary = summarizeTask(join(d.workspace, '.omh', 'tasks', d.task_id));
  const alive = spawnSync('pgrep', ['-f', 'traecli exec'], { encoding: 'utf8' }).status === 0;
  const board = d.slug ? backfillMrId(join(d.workspace, '.harness-ceilf6', d.slug, 'meta.json'), summary.mr_url) : { updated: false, mr_id: null };
  if (board.mr_id && !d.mr_id) {
    d.mr_id = board.mr_id;
    saveState(arg('--state'), state);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, issue_id: issueId, task_id: d.task_id, workspace: d.workspace, meego_url: d.meego_url ?? null, host_alive: alive, board_mr_backfilled: board.updated, ...summary })}\n`);
}
