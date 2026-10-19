#!/usr/bin/env node
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_BIDS, PROJECTS, UNRESOLVED_FILTER, coreMessage, makeRunner, makeTextRunner, normalizeSourcePath, parseShareLink, resolveBin, resolveRepo } from './lib/cli.mjs';
import { flattenRows, summarize } from './lib/stats.mjs';

const SAMPLE_SIZE = 300;

function commonArgs(bid, window) {
  return ['--bid', bid, '--env', PROJECTS[bid].env, '--site-type', 'web', '--start-time', String(window.start), '--end-time', String(window.end)];
}

function chunkName(filename) {
  const m = /\/([^/?#]+\.js)(?:[?#]|$)/.exec(String(filename ?? ''));
  return m ? m[1] : null;
}

function latestFrame(logDetail, project) {
  const projectDir = project.directory;
  let event = null;
  try {
    event = typeof logDetail?.data?.json === 'string' ? JSON.parse(logDetail.data.json) : logDetail?.data?.json;
  } catch {
    event = null;
  }
  const values = event?.stack?.values ?? [];
  const frames = values.flatMap((v) => v?.raw_stacktrace?.frames ?? []);
  const inProject = (f) => Boolean(normalizeSourcePath(f.filename, projectDir)) || (project.cdnMarker ? String(f.filename ?? '').includes(project.cdnMarker) : false);
  const frame = frames.find((f) => normalizeSourcePath(f.filename, projectDir)) ?? frames.find(inProject) ?? frames[0] ?? null;
  const metric = logDetail?.data?.metric_map ?? {};
  const mv = (k) => (metric[k] && typeof metric[k] === 'object' ? metric[k].value : metric[k]) ?? '';
  return {
    page: event?.pid ?? mv('pid'),
    release: event?.release ?? mv('release'),
    source_type: mv('source_type'),
    raw_filename: frame?.filename ?? null,
    mapped_path: frame ? normalizeSourcePath(frame.filename, projectDir) : null,
    line: frame?.lineno ?? null,
    function: frame?.function ?? null,
    // 帧停在 CDN chunk 上时（sourcemap 未绑在这个 bid），靠这两项判断栈是否落在本项目、以及要去哪个 bundle 对位。
    sourcemap_missing: frames.length > 0 && frames.every((f) => /sourcemap miss/i.test(String(f.parse_msg ?? ''))),
    project_frames: frames.filter(inProject).length,
    chunk_files: [...new Set(frames.filter(inProject).map((f) => chunkName(f.filename)).filter(Boolean))],
  };
}

// 最新几条事件常处于 Slardar 的处理队列里，log detail 会报「正在处理」，逐条往前试到成功为止。
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
  return `https://slardar.bytedance.net/node/web/js/detail?${params.toString()}`;
}

async function scanBid(bid, window, page, pageSize, runner, textRunner) {
  const project = PROJECTS[bid];
  const list = await runner(['js-error', 'list', ...commonArgs(bid, window), '--filter', UNRESOLVED_FILTER, '--order-by', 'user_descend', '--page-num', String(page), '--page-size', String(pageSize)]);
  const issues = list?.data?.result ?? [];
  const candidates = [];
  for (const issue of issues) {
    const query = await runner(['log', 'query', ...commonArgs(bid, window), '--ev-type', 'js_error', '--filter', JSON.stringify([{ filter_name: 'issue_id', op: 'in', values: [issue.issue_id] }]), '--columns', 'pid,release,os,source_type,session_id,user_agent,dh_key', '--page-size', String(SAMPLE_SIZE), '--order-by', 'timestamp', '--order', 'desc', '--no-share']);
    const rows = flattenRows(query);
    const { detail, detail_error } = await fetchDetail(rows, bid, window, runner);
    const latest = latestFrame(detail, project);
    candidates.push({
      detail_error,
      issue_url: issueDetailUrl(bid, window, issue.issue_id, latest.release),
      issue_id: issue.issue_id,
      bid,
      project_dir: project.directory,
      scm_repos: project.scmRepos,
      message: issue.message,
      message_core: coreMessage(issue.message),
      error_name: issue.name,
      filename: issue.filename,
      count: issue.count,
      users: issue.user,
      first_seen: issue.min_crash_time,
      status: issue.issue_status,
      slardar_url: await shareLink(bid, window, issue.issue_id, textRunner),
      ...summarize(rows),
      latest_event: latest,
    });
  }
  return candidates;
}

export async function scan({ bids, hours, page = 1, pageSize = 20, repo, now = Date.now(), runner, textRunner }) {
  const end = Math.floor(now / 1000);
  const window = { start: end - hours * 3600, end };
  const bin = resolveBin(resolveRepo(repo));
  const run = runner ?? makeRunner(bin);
  const runText = textRunner ?? (runner ? null : makeTextRunner(bin));
  const skipped = [];
  const bidCounts = {};
  // 各 bid 互不依赖，同时起跑；一个 bid 失败只记 skipped，不拖累其他 bid。
  const perBid = await Promise.all(bids.map(async (bid) => {
    if (!PROJECTS[bid]) {
      skipped.push({ bid, reason: '不支持的 BID' });
      return [];
    }
    try {
      const found = await scanBid(bid, window, page, pageSize, run, runText);
      bidCounts[bid] = found.length;
      return found;
    } catch (error) {
      skipped.push({ bid, reason: String(error.message ?? error).slice(0, 300) });
      return [];
    }
  }));
  // 候选以 Slardar issue 为单位、不合并：同文案的 issue 是 Slardar 按堆栈拆开的，合并会让一个判定盖住多条调用链。
  // 列表已按用户数降序，贪心走查的第一条能修即全局影响最大；多个 BID 拼接时重排一次。
  const candidates = perBid.flat().sort((a, b) => b.users - a.users);
  return { scanned_at: new Date(now).toISOString(), window, page, page_size: pageSize, bids: bidCounts, skipped_bids: skipped, candidates };
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
    hours: Number(arg('--hours', '24')),
    page: Number(arg('--page', '1')),
    pageSize: Number(arg('--page-size', '20')),
    repo: arg('--repo'),
  });
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, out: out ?? null, page: result.page, candidates: result.candidates.length, bids: result.bids, skipped_bids: result.skipped_bids })}\n`);
}
