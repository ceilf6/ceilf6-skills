#!/usr/bin/env node
// 队列与处置账的唯一读写点。三份文件分开存：queue.json 是待派发 A 档，
// dispatched.json / skipped.json 是终态账，扫描合并时只读不改。
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const FILES = { queue: 'queue.json', dispatched: 'dispatched.json', skipped: 'skipped.json' };
// 同一族 24h 内两次扫描都不再出现才移出：一次缺席可能只是 Slardar 采样或时间窗边界。
const STALE_REMOVE_AT = 2;

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function loadState(dir) {
  return {
    queue: readJson(join(dir, FILES.queue), []),
    dispatched: readJson(join(dir, FILES.dispatched), {}),
    skipped: readJson(join(dir, FILES.skipped), {}),
  };
}

export function saveState(dir, state) {
  mkdirSync(dir, { recursive: true });
  for (const [key, file] of Object.entries(FILES)) {
    writeFileSync(join(dir, file), `${JSON.stringify(state[key], null, 2)}\n`);
  }
}

export function mergeScan(state, candidates, now) {
  const byIssue = new Map(candidates.map((c) => [c.issue_id, c]));
  const byFamily = new Map();
  for (const c of candidates) if (!byFamily.has(c.family_key)) byFamily.set(c.family_key, c);

  const kept = [];
  const removed = [];
  for (const entry of state.queue) {
    const hit = byIssue.get(entry.issue_id) ?? byFamily.get(entry.family_key);
    if (hit) {
      kept.push({ ...entry, users: hit.family_users, count: hit.family_count, refreshed_at: now, stale_count: 0 });
    } else if (entry.stale_count + 1 >= STALE_REMOVE_AT) {
      removed.push(entry);
    } else {
      kept.push({ ...entry, stale_count: entry.stale_count + 1 });
    }
  }

  const queuedFamilies = new Set(kept.map((e) => e.family_key));
  const seenFamilies = new Set();
  const fresh = [];
  for (const c of candidates) {
    if (state.dispatched[c.issue_id] || state.skipped[c.issue_id]) continue;
    if (queuedFamilies.has(c.family_key) || seenFamilies.has(c.family_key)) continue;
    seenFamilies.add(c.family_key);
    fresh.push(c);
  }
  return { state: { ...state, queue: kept, removed_stale: removed }, fresh };
}

export function enqueue(state, entry) {
  if (state.queue.some((e) => e.issue_id === entry.issue_id)) return;
  state.queue.push(entry);
}

export function nextToDispatch(state) {
  const live = state.queue.filter((e) => e.stale_count === 0);
  if (!live.length) return null;
  const oldest = live.reduce((a, b) => (a.enqueued_at <= b.enqueued_at ? a : b)).enqueued_at;
  const tier = live.filter((e) => e.enqueued_at === oldest);
  tier.sort((a, b) => b.users - a.users || b.count - a.count);
  return tier[0];
}

export function markDispatched(state, issueId, dispatch) {
  state.queue = state.queue.filter((e) => e.issue_id !== issueId);
  state.dispatched[issueId] = { ...(state.dispatched[issueId] ?? {}), ...dispatch };
}

export function skip(state, issueId, reason, now) {
  state.queue = state.queue.filter((e) => e.issue_id !== issueId);
  state.skipped[issueId] = { reason, at: now };
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
  const cmd = process.argv[2];
  const dir = arg('--dir');
  if (!dir) {
    process.stderr.write('用法: state.mjs next|skip --dir <state> [--issue-id <id> --reason <text>]\n');
    process.exit(2);
  }
  const state = loadState(dir);
  if (cmd === 'next') {
    process.stdout.write(`${JSON.stringify(nextToDispatch(state))}\n`);
  } else if (cmd === 'skip') {
    skip(state, arg('--issue-id'), arg('--reason') ?? '', new Date().toISOString());
    saveState(dir, state);
    process.stdout.write(`${JSON.stringify({ ok: true, skipped: arg('--issue-id') })}\n`);
  } else {
    process.stderr.write(`未知子命令: ${cmd}\n`);
    process.exit(2);
  }
}
