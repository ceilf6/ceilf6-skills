#!/usr/bin/env node
// 候选池、处置账与台账的唯一读写点。candidates.json 是走查与判定的池子；
// dispatched.json 是 prepare-dispatch.sh / board.sh 共用的派单处置账，两份文件按 issue_id 对齐；
// ledger.jsonl 是每次扫描每个 issue 一行的量级台账。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const FILES = { candidates: 'candidates.json', dispatched: 'dispatched.json' };
// 候选池里的 count / users 会被后续扫描覆盖，事后要取「修复前 → 修复后」量级只能靠这份只追加的台账。
const LEDGER = 'ledger.jsonl';

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
    bid: c.bid,
    message: c.message,
    issue_url: c.issue_url ?? null,
    slardar_url: c.slardar_url ?? null,
    users: c.users ?? 0,
    count: c.count ?? 0,
    first_seen: c.first_seen ?? null,
    first_seen_at: now,
    refreshed_at: now,
    status: 'pending',
    verdict: null,
    verdicts: [],
    decision: null,
  };
}

// 扫描是分页的，某页没扫到不代表告警消失；判定与捞回都挂在候选上，缺席的候选一律保留。
export function mergeScan(state, scanned, now) {
  const pool = { ...state.candidates };
  for (const c of scanned) {
    const cur = pool[c.issue_id];
    if (cur) {
      pool[c.issue_id] = {
        ...cur,
        users: c.users ?? cur.users,
        count: c.count ?? cur.count,
        issue_url: c.issue_url ?? cur.issue_url,
        slardar_url: c.slardar_url ?? cur.slardar_url,
        refreshed_at: now,
      };
      continue;
    }
    pool[c.issue_id] = fromScan(c, now);
  }
  return { state: { ...state, candidates: pool } };
}

// verdict 是当前结论，verdicts 是只追加的完整决策史（agent 判定、用户拒绝与捞回）。
function withVerdict(c, verdict) {
  return { ...c, verdict, verdicts: [...(c.verdicts ?? []), verdict] };
}

// agent 的判定是可被用户推翻的缓存；用户捞回过的条目 agent 不得改判。
export function judge(state, issueId, { fixable, reason, sameAs, at }) {
  const c = state.candidates[issueId];
  if (!c) throw new Error(`候选池里没有 ${issueId}`);
  if (c.status !== 'pending') throw new Error(`${issueId} 不是 pending 候选`);
  if (c.verdict?.by === 'user') throw new Error(`${issueId} 已由用户捞回，agent 不能改判`);
  if (!reason) throw new Error('判定必须带 --reason');
  if (sameAs) {
    if (sameAs === issueId) throw new Error(`${issueId} 不能归属到自己`);
    if (state.candidates[sameAs]?.status !== 'dispatched') throw new Error(`${sameAs} 不是已派单候选`);
    state.candidates[issueId] = withVerdict({ ...c, covered_by: sameAs }, { fixable: false, reason, by: 'agent', at });
    return;
  }
  if (typeof fixable !== 'boolean') throw new Error('--fixable 只能是 yes / no');
  state.candidates[issueId] = withVerdict(c, { fixable, reason, by: 'agent', at });
}

// 捞回覆盖 agent 的结论与用户自己之前的拒绝。已派单的续作归 harness 任务链，dispatched.json 的续做记录不能在这里重开。
export function revive(state, issueId, at) {
  const c = state.candidates[issueId];
  if (!c) throw new Error(`候选池里没有 ${issueId}`);
  if (c.status === 'dispatched') throw new Error(`${issueId} 已派单，不能捞回`);
  const { covered_by: _coveredBy, ...rest } = c;
  const reopened = c.status === 'rejected' ? { ...rest, status: 'pending', decision: null } : rest;
  state.candidates[issueId] = withVerdict(reopened, { fixable: true, reason: '捞回', by: 'user', at });
}

export function pendingSorted(state) {
  return Object.values(state.candidates)
    .filter((c) => c.status === 'pending')
    .sort((a, b) => (b.users ?? 0) - (a.users ?? 0));
}

export function reject(state, issueId, reason, now) {
  const c = state.candidates[issueId];
  if (!c) throw new Error(`候选池里没有 ${issueId}`);
  state.candidates[issueId] = withVerdict(
    { ...c, status: 'rejected', decision: { reason, at: now } },
    { fixable: false, reason, by: 'user', at: now },
  );
}

export function markDispatched(state, issueId, { task_id, task_slug, workspace, supplement, at }) {
  const c = state.candidates[issueId];
  if (!c) throw new Error(`候选池里没有 ${issueId}`);
  state.candidates[issueId] = { ...c, status: 'dispatched', decision: { task_id, supplement: supplement ?? '', at } };
  state.dispatched[issueId] = {
    ...(state.dispatched[issueId] ?? {}),
    task_id,
    ...(task_slug ? { task_slug } : {}),
    ...(workspace ? { workspace } : {}),
    dispatched_at: at,
  };
}

const UNJUDGED = { class: 'unjudged', source: null, reason: '', at: null };

function classify(state, owner) {
  if (!owner) return UNJUDGED;
  if (owner.status === 'dispatched') return { class: 'skip', source: 'dispatched', reason: '', at: owner.decision?.at ?? null };
  if (owner.covered_by && state.candidates[owner.covered_by]?.status === 'dispatched') {
    return { class: 'skip', source: 'dispatched', reason: owner.verdict?.reason ?? '', at: owner.verdict?.at ?? null };
  }
  if (owner.status === 'rejected') return { class: 'skip', source: 'rejected', reason: owner.decision?.reason ?? '', at: owner.decision?.at ?? null };
  const v = owner.verdict;
  if (!v) return UNJUDGED;
  return { class: v.fixable ? 'fixable' : 'skip', source: v.by, reason: v.reason, at: v.at };
}

// 纯函数：以 issue 为单位按用户数降序给出每条的归类。agent 遇到 unjudged 判定落档后重跑，直到第一条非 skip 的是 fixable；
// 排在它前面的 skip 项就是呈现给用户的跳过清单，不存在不可见的剔除。同文案的 issue 各自归类，不互相继承。
export function walk(state, scanned, { skip = [] } = {}) {
  const items = [];
  for (const c of [...scanned].sort((a, b) => (b.users ?? 0) - (a.users ?? 0))) {
    const id = c.issue_id;
    const owner = state.candidates[id] ?? null;
    const verdict = classify(state, owner);
    const e = c.latest_event ?? {};
    items.push({
      issue_id: id,
      users: c.users ?? 0,
      count: c.count ?? 0,
      // 池里的 message 冻在首见那次，可能还带着早已换掉的 logId 之类易变量；呈现要用本次扫描的原文。
      message: c.message ?? owner?.message ?? '',
      issue_url: c.issue_url ?? owner?.issue_url ?? null,
      ...(verdict.class !== 'skip' && skip.includes(id) ? { class: 'skip', source: 'session', reason: '', at: null } : verdict),
      detail_error: c.detail_error ?? null,
      mapped_path: e.mapped_path ?? null,
      line: e.line ?? null,
      function: e.function ?? null,
      page: e.page ?? null,
      release: e.release ?? null,
    });
  }
  const todo = Object.values(state.candidates)
    .filter((p) => p.status === 'pending' && p.verdict?.by === 'user' && p.verdict.fixable)
    .sort((a, b) => (b.users ?? 0) - (a.users ?? 0))
    .map((p) => ({ issue_id: p.issue_id, users: p.users ?? 0, message: p.message, issue_url: p.issue_url, at: p.verdict.at }));
  return { items, todo, exhausted: !items.some((i) => i.class !== 'skip') };
}

function topOf(dist) {
  const entry = Object.entries(dist ?? {}).sort((a, b) => b[1] - a[1])[0];
  return entry ? [entry[0], entry[1]] : null;
}

// 台账是进程外可能被截断或手改的文本，一行读不出不该让整个技能卡住：坏行跳过，其余照常可读。
export function readLedger(dir) {
  const file = join(dir, LEDGER);
  if (!existsSync(file)) return [];
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return rows;
}

export function ledgerRows(state, scanned, now) {
  return scanned.map((c) => {
    const owner = state.candidates[c.issue_id];
    return {
      at: now,
      bid: c.bid,
      issue_id: c.issue_id,
      count: c.count ?? 0,
      users: c.users ?? 0,
      distinct_sessions: c.distinct_sessions ?? 0,
      pid_top: topOf(c.pid_dist),
      os_top: topOf(c.os_dist),
      release_top: topOf(c.release_dist),
      host_version_top: topOf(c.host_version_dist),
      source_type_top: topOf(c.source_type_dist),
      status: owner?.status ?? 'unknown',
    };
  });
}

export function appendLedger(dir, rows) {
  const have = new Set(readLedger(dir).map((r) => `${r.at}|${r.issue_id}`));
  const fresh = rows.filter((r) => !have.has(`${r.at}|${r.issue_id}`));
  if (fresh.length) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, LEDGER);
    // 末行被截断（没有换行收尾）时先补一个换行：坏行的字节原样留着，新行才不会被粘上去一起读坏。
    const gap = existsSync(file) && !readFileSync(file, 'utf8').endsWith('\n') ? '\n' : '';
    appendFileSync(file, gap + fresh.map((r) => `${JSON.stringify(r)}\n`).join(''));
  }
  return fresh.length;
}

export function mergeFromScan(dir, scan) {
  const { state } = mergeScan(loadState(dir), scan.candidates, scan.scanned_at);
  saveState(dir, state);
  const appended = appendLedger(dir, ledgerRows(state, scan.candidates, scan.scanned_at));
  const pending = pendingSorted(state);
  mkdirSync(join(dir, 'scans'), { recursive: true });
  writeFileSync(join(dir, 'scans', 'merge-latest.json'), `${JSON.stringify({ pending }, null, 2)}\n`);
  return { pending: pending.length, ledger_appended: appended };
}

// 台账行只按 issue_id 认：同文案的其他 issue 是 Slardar 按堆栈拆开的另一条，混进来会虚增基线。
function rowMatcher(cand) {
  return (r) => r.issue_id === cand.issue_id;
}

// 早期台账行的次数字段名是 family_count。
function rowCount(r) {
  return r.count ?? r.family_count ?? 0;
}

// 回落比拿「派单前最近一次的次数」对「台账最新一次扫描里本条 + 同缺陷各条（covered_by）的次数之和」：
// 报错文案改名会让原 issue 消失、量转到新 issue，只看原 issue 会把改名误判成修好了。
export function history(state, ledger, issueId) {
  const c = state.candidates[issueId];
  if (!c) throw new Error(`候选池里没有 ${issueId}`);
  const byAt = (a, b) => Date.parse(a.at) - Date.parse(b.at);
  const isOwn = rowMatcher(c);
  const coveredMatchers = Object.values(state.candidates).filter((x) => x.covered_by === issueId).map(rowMatcher);
  const rows = ledger.filter(isOwn).sort(byAt);
  // 本条的行优先算本条的，同一行不重复进 covered_rows。
  const coveredRows = ledger.filter((r) => !isOwn(r) && coveredMatchers.some((m) => m(r))).sort(byAt);

  const events = [{ type: 'first_seen', at: c.first_seen_at }];
  if (c.decision?.at) events.push({ type: c.status, at: c.decision.at });
  // 老单的派单时刻可能早于它进池的时刻（台账与候选池是分别回填的），时间序才是读的人要的顺序。
  events.sort(byAt);

  const decidedAt = Date.parse(c.decision?.at ?? '');
  // 没派过单就没有「修复前」这个参照，给出数字会被读成一次测量，基线与回落比一律留空。
  const baseline = c.status === 'dispatched' ? (rows.filter((r) => Date.parse(r.at) <= decidedAt).at(-1) ?? rows[0] ?? null) : null;
  const latestAt = ledger.reduce((max, r) => (max === null || Date.parse(r.at) > Date.parse(max) ? r.at : max), null);
  const latestRows = [...rows, ...coveredRows].filter((r) => r.at === latestAt);
  const latestPresent = latestRows.length > 0;
  const latestCount = latestRows.reduce((sum, r) => sum + rowCount(r), 0);
  // 每次扫描只记前 N 个 issue，所以「最新一次扫描里没有这条」不等于降到 0，只说明它低于那次记下的最小次数。
  // 回落比误判成已修复的代价（对外沉淀难以收回）远高于误判成未修复，缺席时一律按这个上限算。
  const latestFloor = ledger.reduce((min, r) => (r.at === latestAt && (min === null || rowCount(r) < min) ? rowCount(r) : min), null);
  const baselineCount = baseline ? rowCount(baseline) : null;
  return {
    issue_id: issueId,
    rows,
    covered_rows: coveredRows,
    events,
    recovery: {
      baseline_count: baselineCount,
      baseline_at: baseline?.at ?? null,
      latest_at: latestAt,
      latest_present: latestPresent,
      latest_count: latestPresent ? latestCount : 0,
      latest_floor: latestFloor,
      ratio: baselineCount ? (latestPresent ? latestCount : latestFloor) / baselineCount : null,
    },
  };
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

function listArg(name) {
  return (arg(name) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

const NEEDS_ISSUE_ID = new Set(['judge', 'revive', 'reject', 'dispatched', 'history']);

const USAGE = '用法: state.mjs merge|walk|pending|judge|revive|reject|dispatched|history --dir <state> [--scan <scan.json>] [--skip <id,id>] [--issue-id <id>] [--fixable yes|no] [--reason <text>] [--same-as <id>] [--task-id <id>] [--task-slug <slug>] [--workspace <abs>] [--supplement <text>]\n';

function usageExit() {
  process.stderr.write(USAGE);
  process.exit(2);
}

function fixableArg() {
  const v = arg('--fixable');
  if (v === 'yes') return true;
  if (v === 'no') return false;
  return undefined;
}

// 技能目录经 symlink 安装，argv[1] 是链接路径而 import.meta.url 是真实路径，须按 realpath 比较。
if (isMain()) {
  const cmd = process.argv[2];
  const dir = arg('--dir');
  const needsScan = cmd === 'merge' || cmd === 'walk';
  const needsIssue = NEEDS_ISSUE_ID.has(cmd);
  if (!dir || (needsScan && !arg('--scan')) || (needsIssue && !arg('--issue-id'))) usageExit();
  const state = loadState(dir);
  const now = new Date().toISOString();
  const id = arg('--issue-id');
  try {
    if (cmd === 'merge') {
      const scan = JSON.parse(readFileSync(arg('--scan'), 'utf8'));
      process.stdout.write(`${JSON.stringify({ ok: true, ...mergeFromScan(dir, scan) })}\n`);
    } else if (cmd === 'pending') {
      process.stdout.write(`${JSON.stringify(pendingSorted(state))}\n`);
    } else if (cmd === 'judge') {
      judge(state, id, { fixable: fixableArg(), reason: arg('--reason'), sameAs: arg('--same-as'), at: now });
      saveState(dir, state);
      const c = state.candidates[id];
      process.stdout.write(`${JSON.stringify({ ok: true, issue_id: id, fixable: c.verdict.fixable, covered_by: c.covered_by ?? null })}\n`);
    } else if (cmd === 'revive') {
      revive(state, id, now);
      saveState(dir, state);
      process.stdout.write(`${JSON.stringify({ ok: true, revived: id })}\n`);
    } else if (cmd === 'reject') {
      reject(state, id, arg('--reason') ?? '', now);
      saveState(dir, state);
      process.stdout.write(`${JSON.stringify({ ok: true, rejected: id })}\n`);
    } else if (cmd === 'dispatched') {
      // 在途检查与 board.sh 都按 task_id + workspace 定位 omh Task，缺一条这单就查不到。
      for (const k of ['--task-id', '--workspace']) if (!arg(k)) throw new Error(`缺 ${k}`);
      markDispatched(state, id, { task_id: arg('--task-id'), task_slug: arg('--task-slug'), workspace: arg('--workspace'), supplement: arg('--supplement') ?? '', at: now });
      saveState(dir, state);
      process.stdout.write(`${JSON.stringify({ ok: true, dispatched: id })}\n`);
    } else if (cmd === 'walk') {
      const scan = JSON.parse(readFileSync(arg('--scan'), 'utf8'));
      process.stdout.write(`${JSON.stringify({ ok: true, ...walk(state, scan.candidates, { skip: listArg('--skip') }) })}\n`);
    } else if (cmd === 'history') {
      process.stdout.write(`${JSON.stringify({ ok: true, ...history(state, readLedger(dir), id) })}\n`);
    } else {
      process.stderr.write(`未知子命令: ${cmd}\n`);
      process.exit(2);
    }
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(error.message ?? error) })}\n`);
    process.exit(1);
  }
}
