#!/usr/bin/env node
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_BIDS, PROJECTS, UNRESOLVED_FILTER, coreMessage, makeRunner, makeTextRunner, normalizeSourcePath, parseShareLink, resolveBin, resolveProjectRepo, resolveRepo } from './lib/cli.mjs';
import { flattenRows, summarize } from './lib/stats.mjs';
import { enrich, familyKey } from './lib/category.mjs';

const SAMPLE_SIZE = 300;
// web-monitor 列表接口单页上限，更大的 page-size 也只返回 100 条。
const LIST_PAGE_MAX = 100;
// newMinUsers：24h 内只有 1 个用户的 issue 多是单人环境问题，且在小 bid 里每天成批出现又消失，默认不当新增看。
export const NEW_DEFAULTS = { newHours: 48, newDepth: 300, baselineDays: 7, newMinUsers: 2 };

function commonArgs(bid, window) {
  return ['--bid', bid, '--env', PROJECTS[bid].env, '--site-type', 'web', '--start-time', String(window.start), '--end-time', String(window.end)];
}

function listArgs(bid, window, { page = 1, pageSize, filter = UNRESOLVED_FILTER }) {
  return ['js-error', 'list', ...commonArgs(bid, window), '--filter', filter, '--order-by', 'user_descend', '--page-num', String(page), '--page-size', String(pageSize)];
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// 列表接口的 min_crash_time 是「查询窗口内的最早事件」，不是 issue 的首次出现：24h 窗口里它几乎总等于窗口起点。
// 判「新出现」要拿同一批 issue 在更长的基线窗口里的最早事件，落在最近 newHours 内才算新；基线窗口里查不到的不算新。
// 新 issue 常只是老文案在新版本下换了堆栈（web-monitor 按堆栈拆 issue），所以同时记下它的文案族是否在非新 issue 里出现过。
async function detectNew(bid, window, { newHours, newDepth, baselineDays, newMinUsers }, runner) {
  const pageCount = Math.ceil(newDepth / LIST_PAGE_MAX);
  const pages = await Promise.all(Array.from({ length: pageCount }, (_, i) => runner(listArgs(bid, window, { page: i + 1, pageSize: LIST_PAGE_MAX }))));
  // 低于用户数门槛的 issue 不查基线、新旧未知；它们也不参与「族是否已知」——一次回归常是一批 1–2 人的新堆栈，
  // 把其中 1 人的那些当成老族会把整批压回量级排序。
  const issues = pages.flatMap((p) => p?.data?.result ?? []).slice(0, newDepth);
  const eligible = new Set(issues.filter((i) => (i.user ?? 0) >= newMinUsers).map((i) => i.issue_id));
  const baseline = { start: window.end - baselineDays * 86400, end: window.end };
  const firstSeen = new Map();
  const lookups = chunks([...eligible], LIST_PAGE_MAX).map(async (ids) => {
    const filter = JSON.stringify([...JSON.parse(UNRESOLVED_FILTER), { filter_name: 'issue_id', op: 'in', values: ids }]);
    const res = await runner(listArgs(bid, baseline, { pageSize: ids.length, filter }));
    for (const r of res?.data?.result ?? []) firstSeen.set(r.issue_id, Number(r.min_crash_time));
  });
  await Promise.all(lookups);
  const threshold = (window.end - newHours * 3600) * 1000;
  const isNew = (issue) => firstSeen.has(issue.issue_id) && firstSeen.get(issue.issue_id) >= threshold;
  const family = (issue) => familyKey(coreMessage(issue.message));
  const knownFamilies = new Set(issues.filter((i) => eligible.has(i.issue_id) && !isNew(i)).map(family));
  const fresh = new Map(issues.filter(isNew).map((i) => [i.issue_id, { issue: i, new_family: !knownFamilies.has(family(i)) }]));
  return { firstSeen, fresh };
}

function chunkName(filename) {
  const m = /\/([^/?#]+\.js)(?:[?#]|$)/.exec(String(filename ?? ''));
  return m ? m[1] : null;
}

function latestFrame(logDetail, project) {
  let event = null;
  try {
    event = typeof logDetail?.data?.json === 'string' ? JSON.parse(logDetail.data.json) : logDetail?.data?.json;
  } catch {
    event = null;
  }
  const values = event?.stack?.values ?? [];
  const frames = values.flatMap((v) => v?.raw_stacktrace?.frames ?? []);
  const inProject = (f) => Boolean(normalizeSourcePath(f.filename, project)) || (project.cdnMarker ? String(f.filename ?? '').includes(project.cdnMarker) : false);
  const frame = frames.find((f) => normalizeSourcePath(f.filename, project)) ?? frames.find(inProject) ?? frames[0] ?? null;
  const metric = logDetail?.data?.metric_map ?? {};
  const mv = (k) => (metric[k] && typeof metric[k] === 'object' ? metric[k].value : metric[k]) ?? '';
  return {
    page: event?.pid ?? mv('pid'),
    release: event?.release ?? mv('release'),
    source_type: mv('source_type'),
    raw_filename: frame?.filename ?? null,
    mapped_path: frame ? normalizeSourcePath(frame.filename, project) : null,
    line: frame?.lineno ?? null,
    function: frame?.function ?? null,
    // 帧停在 CDN chunk 上时（sourcemap 未绑在这个 bid），靠这两项判断栈是否落在本项目、以及要去哪个 bundle 对位。
    sourcemap_missing: frames.length > 0 && frames.every((f) => /sourcemap miss/i.test(String(f.parse_msg ?? ''))),
    project_frames: frames.filter(inProject).length,
    chunk_files: [...new Set(frames.filter(inProject).map((f) => chunkName(f.filename)).filter(Boolean))],
  };
}

// 最新几条事件常处于 web-monitor 的处理队列里，log detail 会报「正在处理」，逐条往前试到成功为止。
const DETAIL_ATTEMPTS = 5;

async function fetchDetail(rows, bid, window, runner) {
  let lastError = null;
  for (const row of rows.slice(0, DETAIL_ATTEMPTS)) {
    if (!row.dh_key) continue;
    try {
      return { detail: await runner(['log', 'detail', ...commonArgs(bid, window), '--ev-type', 'js_error', '--dh-key', row.dh_key, '--no-share']), detail_error: null };
    } catch (error) {
      lastError = String(error.message ?? error).slice(0, 200);
    }
  }
  return { detail: null, detail_error: lastError ?? (rows.length ? '样本无 dh_key' : '无事件样本') };
}

// 分享链接给 CR 评审看上下文，评审可能在派单几天后才看，窗口取 7 天而不是扫描窗口。
const SHARE_WINDOW_SECONDS = 7 * 24 * 3600;

async function shareLink(bid, window, issueId, textRunner) {
  if (!textRunner) return null;
  try {
    const text = await textRunner(['log', 'query', '--bid', bid, '--env', PROJECTS[bid].env, '--site-type', 'web', '--start-time', String(window.end - SHARE_WINDOW_SECONDS), '--end-time', String(window.end), '--ev-type', 'js_error', '--filter', JSON.stringify([{ filter_name: 'issue_id', op: 'in', values: [issueId] }]), '--page-size', '1']);
    return parseShareLink(text);
  } catch {
    return null;
  }
}

// Issue 详情页是用户与 native 同学看上下文的入口；release 参数让页面直接定位到最新事件所在版本。
function issueDetailUrl(bid, window, issueId, release) {
  const params = new URLSearchParams({
    env: PROJECTS[bid].env, bid, lang: 'zh', start_time: String(window.start), end_time: String(window.end),
    site_type: 'web', region: 'cn', issue_id: issueId, layout: 'normal',
  });
  if (release) params.set('release', release);
  return `<internal-url>)}`;
}

async function scanBid(bid, window, page, pageSize, newOpts, runner, textRunner, repoDir) {
  const project = PROJECTS[bid];
  // 新增检测只在第 1 页做一次：它看的是前 newDepth 条，与翻页无关。
  const [list, detected] = await Promise.all([
    runner(listArgs(bid, window, { page, pageSize })),
    page === 1 && newOpts.newDepth > 0 ? detectNew(bid, window, newOpts, runner) : { firstSeen: new Map(), fresh: new Map() },
  ]);
  const issues = list?.data?.result ?? [];
  // 新 issue 不在本页时追加进候选，按用户数取前 pageSize 条；其余只计数。
  const inPage = new Set(issues.map((i) => i.issue_id));
  const extra = [...detected.fresh.values()].filter((f) => !inPage.has(f.issue.issue_id)).map((f) => f.issue).sort((a, b) => (b.user ?? 0) - (a.user ?? 0)).slice(0, pageSize);
  const candidates = [];
  for (const issue of [...issues, ...extra]) {
    const fresh = detected.fresh.get(issue.issue_id) ?? null;
    const query = await runner(['log', 'query', ...commonArgs(bid, window), '--ev-type', 'js_error', '--filter', JSON.stringify([{ filter_name: 'issue_id', op: 'in', values: [issue.issue_id] }]), '--columns', 'pid,release,os,source_type,session_id,user_agent,dh_key', '--page-size', String(SAMPLE_SIZE), '--order-by', 'timestamp', '--order', 'desc', '--no-share']);
    const rows = flattenRows(query);
    const { detail, detail_error } = await fetchDetail(rows, bid, window, runner);
    const latest = latestFrame(detail, project);
    candidates.push({
      detail_error,
      issue_url: issueDetailUrl(bid, window, issue.issue_id, latest.release),
      issue_id: issue.issue_id,
      bid,
      repo: project.repo,
      repo_dir: repoDir,
      project_dir: project.directory,
      pkg-platform_repos: project.pkg-platformRepos,
      message: issue.message,
      message_core: coreMessage(issue.message),
      error_name: issue.name,
      filename: issue.filename,
      count: issue.count,
      users: issue.user,
      // first_seen 是扫描窗口内的最早事件；baseline_first_seen 才是基线窗口内的最早事件（毫秒），不在新增检测范围内时为 null。
      first_seen: issue.min_crash_time,
      baseline_first_seen: detected.firstSeen.get(issue.issue_id) ?? null,
      is_new: fresh !== null,
      new_family: fresh?.new_family ?? false,
      status: issue.issue_status,
      web-monitor_url: await shareLink(bid, window, issue.issue_id, textRunner),
      ...summarize(rows),
      latest_event: latest,
    });
  }
  return { candidates, new_total: detected.fresh.size };
}

export async function scan({ bids, hours, page = 1, pageSize = 20, newHours = NEW_DEFAULTS.newHours, newDepth = NEW_DEFAULTS.newDepth, baselineDays = NEW_DEFAULTS.baselineDays, newMinUsers = NEW_DEFAULTS.newMinUsers, repo, now = Date.now(), runner, textRunner }) {
  const end = Math.floor(now / 1000);
  const window = { start: Math.floor(end - hours * 3600), end };
  const newOpts = { newHours, newDepth, baselineDays, newMinUsers };
  const bin = resolveBin(resolveRepo(repo));
  const run = runner ?? makeRunner(bin);
  const runText = textRunner ?? (runner ? null : makeTextRunner(bin));
  const skipped = [];
  const bidCounts = {};
  const newCounts = {};
  // 各 bid 互不依赖，同时起跑；一个 bid 失败只记 skipped，不拖累其他 bid。
  const perBid = await Promise.all(bids.map(async (bid) => {
    if (!PROJECTS[bid]) {
      skipped.push({ bid, reason: '不支持的 BID' });
      return [];
    }
    try {
      const found = await scanBid(bid, window, page, pageSize, newOpts, run, runText, resolveProjectRepo(bid, repo));
      bidCounts[bid] = found.candidates.length;
      newCounts[bid] = found.new_total;
      return found.candidates;
    } catch (error) {
      skipped.push({ bid, reason: String(error.message ?? error).slice(0, 300) });
      return [];
    }
  }));
  // 候选以 web-monitor issue 为单位、不合并：同文案的 issue 是 web-monitor 按堆栈拆开的，合并会让一个判定盖住多条调用链。
  // 排序按同文案聚合后的合计用户数：单条按堆栈拆开后量级被摊薄，聚合后贪心走查的第一条能修才是全局影响最大。
  const candidates = enrich(perBid.flat());
  return { scanned_at: new Date(now).toISOString(), window, page, page_size: pageSize, new_hours: newHours, new_depth: newDepth, baseline_days: baselineDays, new_min_users: newMinUsers, bids: bidCounts, new_issues: newCounts, skipped_bids: skipped, candidates };
}

function isMain() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

// 技能目录经 symlink 安装，argv[1] 是链接路径而 import.meta.url 是真实路径，须按 realpath 比较。
if (isMain()) {
  const out = arg('--out');
  const result = await scan({
    bids: arg('--bid', DEFAULT_BIDS.join(',')).split(',').map((s) => s.trim()).filter(Boolean),
    // --minutes 给缩窗扫描用（如 10 分钟），给了就覆盖 --hours。
    hours: arg('--minutes') !== undefined ? Number(arg('--minutes')) / 60 : Number(arg('--hours', '24')),
    page: Number(arg('--page', '1')),
    pageSize: Number(arg('--page-size', '20')),
    newHours: Number(arg('--new-hours', String(NEW_DEFAULTS.newHours))),
    newDepth: Number(arg('--new-depth', String(NEW_DEFAULTS.newDepth))),
    baselineDays: Number(arg('--baseline-days', String(NEW_DEFAULTS.baselineDays))),
    newMinUsers: Number(arg('--new-min-users', String(NEW_DEFAULTS.newMinUsers))),
    repo: arg('--repo'),
  });
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, out: out ?? null, page: result.page, candidates: result.candidates.length, bids: result.bids, new_issues: result.new_issues, skipped_bids: result.skipped_bids })}\n`);
}
