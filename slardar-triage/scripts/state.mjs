#!/usr/bin/env node
// 候选池、处置账与台账的唯一读写点。candidates.json 是 agent 从中选取、由用户决策的池子；
// dispatched.json 是 dispatch.sh / board.sh / progress.mjs 共用的派单处置账，两者按 issue_id 对齐；
// ledger.jsonl 是每次扫描每族一行的量级台账。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const FILES = { candidates: 'candidates.json', dispatched: 'dispatched.json' };
// pending 连续两次扫描都不再出现才移出：一次缺席可能只是 Slardar 采样或时间窗边界。
const STALE_REMOVE_AT = 2;
// 候选池里的 count / users 会被后续扫描覆盖，事后要取「修复前 → 修复后」量级只能靠这份只追加的台账。
const LEDGER = 'ledger.jsonl';
export const LIKELIHOOD_ORDER = ['高', '中', '低', '排除'];
const LOW_MESSAGE = /code: \d{6}|larkErrorCode|invalid user|APINotProvided/;
const OUR_SOURCE = /^(vc-ai|packages)\//;

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

export function markDispatched(state, issueId, { task_id, supplement, fix_paths, at }) {
  const c = state.candidates[issueId];
  if (!c) throw new Error(`候选池里没有 ${issueId}`);
  state.candidates[issueId] = { ...c, status: 'dispatched', decision: { task_id, supplement: supplement ?? '', fix_paths: fix_paths ?? [], at } };
  state.dispatched[issueId] = { ...(state.dispatched[issueId] ?? {}), task_id };
}

function patchDecision(state, issueId, patch) {
  const c = state.candidates[issueId];
  if (c?.status !== 'dispatched') throw new Error(`${issueId} 不是已派单候选`);
  state.candidates[issueId] = { ...c, decision: { ...c.decision, ...patch } };
}

export function setFixPaths(state, issueId, paths) {
  patchDecision(state, issueId, { fix_paths: paths });
}

export function markMerged(state, issueId, at) {
  patchDecision(state, issueId, { merged_at: at });
}

export function markSedimented(state, issueId, at) {
  patchDecision(state, issueId, { sedimented_at: at });
}

// covered_by 只是归属链接，候选仍是 pending；是否因此被剔除由 pick 按归属的单是否仍未合入现算。
export function cover(state, issueId, byIssueId) {
  const c = state.candidates[issueId];
  if (!c) throw new Error(`候选池里没有 ${issueId}`);
  if (issueId === byIssueId) throw new Error(`${issueId} 不能归属到自己`);
  if (c.status !== 'pending') throw new Error(`${issueId} 不是 pending 候选`);
  if (state.candidates[byIssueId]?.status !== 'dispatched') throw new Error(`${byIssueId} 不是已派单候选`);
  state.candidates[issueId] = { ...c, covered_by: byIssueId };
}

const isInFlight = (c) => c.status === 'dispatched' && !c.decision?.merged_at;

export function flight(state) {
  const brief = (c) => ({
    issue_id: c.issue_id,
    message: c.message,
    task_id: c.decision?.task_id ?? null,
    mr_id: state.dispatched[c.issue_id]?.mr_id ?? null,
    meego_url: state.dispatched[c.issue_id]?.meego_url ?? null,
  });
  const dispatched = Object.values(state.candidates).filter((c) => c.status === 'dispatched');
  return {
    in_flight: dispatched.filter(isInFlight).map(brief),
    awaiting_recovery: dispatched.filter((c) => c.decision?.merged_at && !c.decision?.sedimented_at).map(brief),
  };
}

function mechanicalVerdict(snapshot) {
  const message = snapshot.message ?? '';
  if (message.startsWith('[warn]')) return { likelihood: '排除', summary: 'warn 级上报' };
  if (LOW_MESSAGE.test(message)) return { likelihood: '低', summary: 'message 含服务端错误码 / invalid user / APINotProvided' };
  const pages = Object.keys(snapshot.pid_dist ?? {});
  if (pages.length && pages.every((p) => p.startsWith('/webview/doubao-'))) return { likelihood: '低', summary: '页面全部在豆包宿主' };
  if (snapshot.latest_event?.raw_filename === '[native code]') return { likelihood: '低', summary: '最新帧在 [native code]' };
  // Sourcemap 没取到时 mapped_path 为空不代表帧不在仓内，留给 agent 判断。
  if (!snapshot.detail_error && !OUR_SOURCE.test(snapshot.latest_event?.mapped_path ?? '')) return { likelihood: '低', summary: '最新帧不在 vc-ai / packages 源码' };
  return null;
}

// 帧与分布只在扫描快照里，候选池不存，所以预筛要两者一起看。
export function pick(state, scanned, { skip = [] } = {}) {
  const snapshots = new Map(scanned.map((c) => [c.issue_id, c]));
  const inFlight = Object.values(state.candidates).filter(isInFlight);
  const shortlist = [];
  const covered = [];
  const filtered = [];
  for (const cand of Object.values(state.candidates)) {
    const snapshot = snapshots.get(cand.issue_id);
    if (cand.status !== 'pending' || !snapshot) continue;
    const id = cand.issue_id;
    if (cand.likelihood === '低' || cand.likelihood === '排除') {
      filtered.push({ issue_id: id, likelihood: cand.likelihood, summary: cand.summary });
      continue;
    }
    // 机械规则只看最新一帧，而同一 issue 每次扫描的最新帧会变；已记录的判档是 agent 看过全貌的结论，机械规则不得推翻。
    const verdict = cand.likelihood == null ? mechanicalVerdict(snapshot) : null;
    if (verdict) {
      state.candidates[id] = { ...cand, ...verdict };
      filtered.push({ issue_id: id, ...verdict });
      continue;
    }
    const path = snapshot.latest_event?.mapped_path;
    const owner = inFlight.find((d) => d.issue_id === cand.covered_by)
      ?? inFlight.find((d) => path && (d.decision?.fix_paths ?? []).includes(path));
    if (owner) {
      state.candidates[id] = { ...cand, covered_by: owner.issue_id };
      covered.push({ issue_id: id, covered_by: owner.issue_id });
      continue;
    }
    if (skip.includes(id)) continue;
    shortlist.push({
      issue_id: id,
      // 池里的 message 冻在首见那次，可能还带着早已换掉的 logId 之类易变量；呈现要用本次扫描的原文。
      message: snapshot.message ?? cand.message,
      issue_url: cand.issue_url,
      users: cand.users,
      count: cand.count,
      likelihood: cand.likelihood,
      detail_error: snapshot.detail_error ?? null,
      mapped_path: path ?? null,
      line: snapshot.latest_event?.line ?? null,
      function: snapshot.latest_event?.function ?? null,
      page: snapshot.latest_event?.page ?? null,
      release: snapshot.latest_event?.release ?? null,
    });
  }
  shortlist.sort((a, b) => Boolean(a.detail_error) - Boolean(b.detail_error) || (b.users ?? 0) - (a.users ?? 0));
  return { shortlist, covered, filtered, in_flight: inFlight.length };
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

// 同族已结案的新 issue 不入池（见 mergeScan），它的量级记在同族候选名下，status 取那条候选的。
// 一族可能同时留着 pending 与已结案两条，挡住新 issue 入池的是已结案那条，归属要认它。
export function ledgerRows(state, scanned, now) {
  const pool = Object.values(state.candidates);
  const ownerOf = (c) => {
    if (state.candidates[c.issue_id]) return state.candidates[c.issue_id];
    const family = pool.filter((p) => p.family_key === c.family_key);
    return family.find((p) => p.status !== 'pending') ?? family[0];
  };
  return scanned.map((c) => {
    const owner = ownerOf(c);
    return {
      at: now,
      bid: c.bid,
      issue_id: c.issue_id,
      owner_issue_id: owner?.issue_id ?? c.issue_id,
      family_key: c.family_key,
      member_issue_ids: c.member_issue_ids ?? [c.issue_id],
      family_count: c.family_count ?? c.count ?? 0,
      family_users: c.family_users ?? c.users ?? 0,
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
  const { state, removed } = mergeScan(loadState(dir), scan.candidates, scan.scanned_at);
  saveState(dir, state);
  const appended = appendLedger(dir, ledgerRows(state, scan.candidates, scan.scanned_at));
  const pending = pendingSorted(state);
  mkdirSync(join(dir, 'scans'), { recursive: true });
  writeFileSync(join(dir, 'scans', 'merge-latest.json'), `${JSON.stringify({ pending, removed }, null, 2)}\n`);
  return { pending: pending.length, removed: removed.length, ledger_appended: appended };
}

// 候选的 family_key 冻在首见那次，台账行记的是各自扫描当时算出的 key，报错文案一改两者就对不上；
// 台账行同时带着 issue 身份（issue_id / owner_issue_id / member_issue_ids），按身份认行才不会把一条单的历史截断。
function rowMatcher(cand) {
  const ids = new Set([cand.issue_id, ...(cand.member_issue_ids ?? [])]);
  return (r) => r.family_key === cand.family_key
    || ids.has(r.issue_id)
    || ids.has(r.owner_issue_id)
    || (r.member_issue_ids ?? []).some((id) => ids.has(id));
}

// 回落比拿「派单前最近一次的族次数」对「台账最新一次扫描里本族 + 被覆盖族的次数之和」：
// 报错文案改名会让原族消失、量转到新族，只看原族会把改名误判成修好了。
export function history(state, ledger, issueId) {
  const c = state.candidates[issueId];
  if (!c) throw new Error(`候选池里没有 ${issueId}`);
  const byAt = (a, b) => Date.parse(a.at) - Date.parse(b.at);
  const isOwn = rowMatcher(c);
  const coveredMatchers = Object.values(state.candidates).filter((x) => x.covered_by === issueId).map(rowMatcher);
  const rows = ledger.filter(isOwn).sort(byAt);
  // 本族的行优先算本族的，同一行不重复进 covered_rows。
  const coveredRows = ledger.filter((r) => !isOwn(r) && coveredMatchers.some((m) => m(r))).sort(byAt);

  const events = [{ type: 'first_seen', at: c.first_seen_at }];
  if (c.decision?.at) events.push({ type: c.status, at: c.decision.at });
  if (c.decision?.merged_at) events.push({ type: 'merged', at: c.decision.merged_at });
  if (c.decision?.sedimented_at) events.push({ type: 'sedimented', at: c.decision.sedimented_at });
  // 老单的派单时刻可能早于它进池的时刻（台账与候选池是分别回填的），时间序才是读的人要的顺序。
  events.sort(byAt);

  const decidedAt = Date.parse(c.decision?.at ?? '');
  // 没派过单就没有「修复前」这个参照，给出数字会被读成一次测量，基线与回落比一律留空。
  const baseline = c.status === 'dispatched' ? (rows.filter((r) => Date.parse(r.at) <= decidedAt).at(-1) ?? rows[0] ?? null) : null;
  const latestAt = ledger.reduce((max, r) => (max === null || Date.parse(r.at) > Date.parse(max) ? r.at : max), null);
  const latestByFamily = new Map();
  for (const r of [...rows, ...coveredRows]) {
    // 本族与被覆盖族可能指向同一族，每族只计一次。
    if (r.at === latestAt) latestByFamily.set(r.family_key, Math.max(latestByFamily.get(r.family_key) ?? 0, r.family_count));
  }
  const latestPresent = latestByFamily.size > 0;
  const latestCount = [...latestByFamily.values()].reduce((sum, n) => sum + n, 0);
  // 每次扫描只记前 top N 个族，所以「最新一次扫描里没有这族」不等于降到 0，只说明它低于那次记下的最小次数。
  // 回落比误判成已修复的代价（对外沉淀难以收回）远高于误判成未修复，缺席时一律按这个上限算。
  const latestFloor = ledger.reduce((min, r) => (r.at === latestAt && (min === null || r.family_count < min) ? r.family_count : min), null);
  const baselineCount = baseline?.family_count ?? null;
  return {
    issue_id: issueId,
    family_key: c.family_key,
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

const NEEDS_ISSUE_ID = new Set(['judge', 'reject', 'dispatched', 'cover', 'fix-paths', 'merged', 'sedimented', 'history']);

const USAGE = '用法: state.mjs merge|pick|pending|judge|reject|dispatched|cover|fix-paths|merged|sedimented|flight|history --dir <state> [--scan <scan.json>] [--skip <id,id>] [--issue-id <id>] [--by <id>] [--likelihood <档>] [--summary <text>] [--reason <text>] [--task-id <id>] [--supplement <text>] [--fix-paths <a,b>] [--paths <a,b>] [--at <iso>]\n';

function usageExit() {
  process.stderr.write(USAGE);
  process.exit(2);
}

// 技能目录经 symlink 安装，argv[1] 是链接路径而 import.meta.url 是真实路径，须按 realpath 比较。
if (isMain()) {
  const cmd = process.argv[2];
  const dir = arg('--dir');
  const needsScan = cmd === 'merge' || cmd === 'pick';
  const needsIssue = NEEDS_ISSUE_ID.has(cmd);
  if (!dir || (needsScan && !arg('--scan')) || (needsIssue && !arg('--issue-id')) || (cmd === 'cover' && !arg('--by'))) usageExit();
  const state = loadState(dir);
  const now = new Date().toISOString();
  try {
    if (cmd === 'merge') {
      const scan = JSON.parse(readFileSync(arg('--scan'), 'utf8'));
      process.stdout.write(`${JSON.stringify({ ok: true, ...mergeFromScan(dir, scan) })}\n`);
    } else if (cmd === 'pending') {
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
      markDispatched(state, arg('--issue-id'), { task_id: arg('--task-id'), supplement: arg('--supplement') ?? '', fix_paths: listArg('--fix-paths'), at: now });
      saveState(dir, state);
      process.stdout.write(`${JSON.stringify({ ok: true, dispatched: arg('--issue-id') })}\n`);
    } else if (cmd === 'pick') {
      const scan = JSON.parse(readFileSync(arg('--scan'), 'utf8'));
      const out = pick(state, scan.candidates, { skip: listArg('--skip') });
      saveState(dir, state);
      process.stdout.write(`${JSON.stringify({ ok: true, ...out })}\n`);
    } else if (cmd === 'cover') {
      cover(state, arg('--issue-id'), arg('--by'));
      saveState(dir, state);
      process.stdout.write(`${JSON.stringify({ ok: true, issue_id: arg('--issue-id'), covered_by: arg('--by') })}\n`);
    } else if (cmd === 'fix-paths') {
      const paths = listArg('--paths');
      setFixPaths(state, arg('--issue-id'), paths);
      saveState(dir, state);
      process.stdout.write(`${JSON.stringify({ ok: true, issue_id: arg('--issue-id'), fix_paths: paths })}\n`);
    } else if (cmd === 'merged') {
      markMerged(state, arg('--issue-id'), arg('--at') ?? now);
      saveState(dir, state);
      process.stdout.write(`${JSON.stringify({ ok: true, merged: arg('--issue-id') })}\n`);
    } else if (cmd === 'sedimented') {
      markSedimented(state, arg('--issue-id'), now);
      saveState(dir, state);
      process.stdout.write(`${JSON.stringify({ ok: true, sedimented: arg('--issue-id') })}\n`);
    } else if (cmd === 'flight') {
      process.stdout.write(`${JSON.stringify({ ok: true, ...flight(state) })}\n`);
    } else if (cmd === 'history') {
      process.stdout.write(`${JSON.stringify({ ok: true, ...history(state, readLedger(dir), arg('--issue-id')) })}\n`);
    } else {
      process.stderr.write(`未知子命令: ${cmd}\n`);
      process.exit(2);
    }
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(error.message ?? error) })}\n`);
    process.exit(1);
  }
}
