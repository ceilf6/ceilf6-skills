#!/usr/bin/env node
// 候选池与处置账的唯一读写点。candidates.json 是 agent 呈现给用户、由用户决策的池子；
// dispatched.json 是 dispatch.sh / board.sh / progress.mjs 共用的派单处置账，两者按 issue_id 对齐。
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const FILES = { candidates: 'candidates.json', dispatched: 'dispatched.json' };
// pending 连续两次扫描都不再出现才移出：一次缺席可能只是 Slardar 采样或时间窗边界。
const STALE_REMOVE_AT = 2;
export const LIKELIHOOD_ORDER = ['高', '中', '低', '排除'];

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function loadState(dir) {
  return {
    candidates: readJson(join(dir, FILES.candidates), {}),
    dispatched: readJson(join(dir, FILES.dispatched), {}),
  };
}

export function saveState(dir, state) {
  mkdirSync(dir, { recursive: true });
  for (const [key, file] of Object.entries(FILES)) {
    writeFileSync(join(dir, file), `${JSON.stringify(state[key] ?? {}, null, 2)}\n`);
  }
}

function fromScan(c, now) {
  return {
    issue_id: c.issue_id,
    family_key: c.family_key,
    bid: c.bid,
    message: c.message,
    member_issue_ids: c.member_issue_ids ?? [c.issue_id],
    issue_url: c.issue_url ?? null,
    slardar_url: c.slardar_url ?? null,
    users: c.family_users ?? c.users ?? 0,
    count: c.family_count ?? c.count ?? 0,
    first_seen: c.first_seen ?? null,
    likelihood: null,
    summary: '',
    first_seen_at: now,
    refreshed_at: now,
    stale_count: 0,
    status: 'pending',
    decision: null,
  };
}

export function mergeScan(state, scanned, now) {
  const pool = { ...state.candidates };
  const seen = new Set();
  const settledFamilies = new Set(Object.values(pool).filter((c) => c.status !== 'pending').map((c) => c.family_key));
  for (const c of scanned) {
    seen.add(c.issue_id);
    const cur = pool[c.issue_id];
    if (cur) {
      pool[c.issue_id] = {
        ...cur,
        users: c.family_users ?? c.users ?? cur.users,
        count: c.family_count ?? c.count ?? cur.count,
        issue_url: c.issue_url ?? cur.issue_url,
        slardar_url: c.slardar_url ?? cur.slardar_url,
        member_issue_ids: c.member_issue_ids ?? cur.member_issue_ids,
        refreshed_at: now,
        stale_count: 0,
      };
      continue;
    }
    if (settledFamilies.has(c.family_key)) continue;
    pool[c.issue_id] = fromScan(c, now);
  }
  const removed = [];
  for (const [id, c] of Object.entries(pool)) {
    if (seen.has(id) || c.status !== 'pending') continue;
    const stale = (c.stale_count ?? 0) + 1;
    if (stale >= STALE_REMOVE_AT) {
      removed.push(c);
      delete pool[id];
    } else {
      pool[id] = { ...c, stale_count: stale };
    }
  }
  return { state: { ...state, candidates: pool }, removed };
}

export function setJudgment(state, issueId, { likelihood, summary }) {
  const c = state.candidates[issueId];
  if (!c) throw new Error(`候选池里没有 ${issueId}`);
  if (!LIKELIHOOD_ORDER.includes(likelihood)) throw new Error(`档位只能是 ${LIKELIHOOD_ORDER.join('/')}：${likelihood}`);
  state.candidates[issueId] = { ...c, likelihood, summary: summary ?? '' };
}

export function pendingSorted(state) {
  const rank = (l) => (LIKELIHOOD_ORDER.includes(l) ? LIKELIHOOD_ORDER.indexOf(l) : LIKELIHOOD_ORDER.length);
  return Object.values(state.candidates)
    .filter((c) => c.status === 'pending')
    .sort((a, b) => rank(a.likelihood) - rank(b.likelihood) || (b.users ?? 0) - (a.users ?? 0));
}

export function reject(state, issueId, reason, now) {
  const c = state.candidates[issueId];
  if (!c) throw new Error(`候选池里没有 ${issueId}`);
  state.candidates[issueId] = { ...c, status: 'rejected', decision: { reason, at: now } };
}

export function markDispatched(state, issueId, { task_id, supplement, at }) {
  const c = state.candidates[issueId];
  if (!c) throw new Error(`候选池里没有 ${issueId}`);
  state.candidates[issueId] = { ...c, status: 'dispatched', decision: { task_id, supplement: supplement ?? '', at } };
  state.dispatched[issueId] = { ...(state.dispatched[issueId] ?? {}), task_id };
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
    process.stderr.write('用法: state.mjs pending|judge|reject|dispatched --dir <state> [--issue-id <id>] [--likelihood <档>] [--summary <text>] [--reason <text>] [--task-id <id>] [--supplement <text>]\n');
    process.exit(2);
  }
  const state = loadState(dir);
  const now = new Date().toISOString();
  try {
    if (cmd === 'pending') {
      process.stdout.write(`${JSON.stringify(pendingSorted(state))}\n`);
    } else if (cmd === 'judge') {
      setJudgment(state, arg('--issue-id'), { likelihood: arg('--likelihood'), summary: arg('--summary') ?? '' });
      saveState(dir, state);
      process.stdout.write(`${JSON.stringify({ ok: true, issue_id: arg('--issue-id'), likelihood: arg('--likelihood') })}\n`);
    } else if (cmd === 'reject') {
      reject(state, arg('--issue-id'), arg('--reason') ?? '', now);
      saveState(dir, state);
      process.stdout.write(`${JSON.stringify({ ok: true, rejected: arg('--issue-id') })}\n`);
    } else if (cmd === 'dispatched') {
      markDispatched(state, arg('--issue-id'), { task_id: arg('--task-id'), supplement: arg('--supplement') ?? '', at: now });
      saveState(dir, state);
      process.stdout.write(`${JSON.stringify({ ok: true, dispatched: arg('--issue-id') })}\n`);
    } else {
      process.stderr.write(`未知子命令: ${cmd}\n`);
      process.exit(2);
    }
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(error.message ?? error) })}\n`);
    process.exit(1);
  }
}
