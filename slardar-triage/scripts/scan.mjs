#!/usr/bin/env node
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROJECTS, UNRESOLVED_FILTER, makeRunner, normalizeSourcePath, resolveBin, resolveRepo } from './lib/cli.mjs';
import { familyKey } from './lib/family.mjs';
import { flattenRows, summarize } from './lib/stats.mjs';

const SAMPLE_SIZE = 300;

function commonArgs(bid, window) {
  return ['--bid', bid, '--env', 'online', '--site-type', 'web', '--start-time', String(window.start), '--end-time', String(window.end)];
}

function latestFrame(logDetail, projectDir) {
  let event = null;
  try {
    event = typeof logDetail?.data?.json === 'string' ? JSON.parse(logDetail.data.json) : logDetail?.data?.json;
  } catch {
    event = null;
  }
  const values = event?.stack?.values ?? [];
  const frames = values.flatMap((v) => v?.raw_stacktrace?.frames ?? []);
  const frame = frames.find((f) => normalizeSourcePath(f.filename, projectDir)) ?? frames[0] ?? null;
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
  };
}

async function scanBid(bid, window, top, runner) {
  const project = PROJECTS[bid];
  const list = runner(['js-error', 'list', ...commonArgs(bid, window), '--filter', UNRESOLVED_FILTER, '--order-by', 'count_descend', '--page-size', String(top)]);
  const issues = list?.data?.result ?? [];
  const candidates = [];
  for (const issue of issues) {
    const query = runner(['log', 'query', ...commonArgs(bid, window), '--ev-type', 'js_error', '--filter', JSON.stringify([{ filter_name: 'issue_id', op: 'in', values: [issue.issue_id] }]), '--columns', 'pid,release,os,source_type,session_id,user_agent,dh_key', '--page-size', String(SAMPLE_SIZE), '--order-by', 'timestamp', '--order', 'desc', '--no-share']);
    const rows = flattenRows(query);
    const dhKey = rows[0]?.dh_key;
    const detail = dhKey ? runner(['log', 'detail', ...commonArgs(bid, window), '--ev-type', 'js_error', '--dh-key', dhKey, '--no-share']) : null;
    candidates.push({
      issue_id: issue.issue_id,
      family_key: familyKey(issue.message),
      member_issue_ids: [issue.issue_id],
      bid,
      project_dir: project.directory,
      scm_repos: project.scmRepos,
      message: issue.message,
      error_name: issue.name,
      filename: issue.filename,
      count: issue.count,
      users: issue.user,
      family_count: issue.count,
      family_users: issue.user,
      first_seen: issue.min_crash_time,
      status: issue.issue_status,
      ...summarize(rows),
      latest_event: latestFrame(detail, project.directory),
    });
  }
  return candidates;
}

function mergeFamilies(candidates) {
  const byKey = new Map();
  for (const c of candidates) {
    const key = `${c.bid}::${c.family_key}`;
    const head = byKey.get(key);
    if (!head) {
      byKey.set(key, c);
      continue;
    }
    head.member_issue_ids.push(c.issue_id);
    head.family_count += c.count;
    head.family_users += c.users;
  }
  return [...byKey.values()];
}

export async function scan({ bids, hours, top, repo, now = Date.now(), runner }) {
  const end = Math.floor(now / 1000);
  const window = { start: end - hours * 3600, end };
  const run = runner ?? makeRunner(resolveBin(resolveRepo(repo)));
  const skipped = [];
  let all = [];
  for (const bid of bids) {
    if (!PROJECTS[bid]) {
      skipped.push({ bid, reason: '不支持的 BID' });
      continue;
    }
    try {
      all = all.concat(await scanBid(bid, window, top, run));
    } catch (error) {
      skipped.push({ bid, reason: String(error.message ?? error).slice(0, 300) });
    }
  }
  return { scanned_at: new Date(now).toISOString(), window, skipped_bids: skipped, candidates: mergeFamilies(all) };
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
    bids: arg('--bid', 'vc_ai,vc_web,vc_pages').split(',').map((s) => s.trim()).filter(Boolean),
    hours: Number(arg('--hours', '24')),
    top: Number(arg('--top', '10')),
    repo: arg('--repo'),
  });
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, out: out ?? null, candidates: result.candidates.length, skipped_bids: result.skipped_bids })}\n`);
}
