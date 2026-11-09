import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize, flattenRows } from '../scripts/lib/stats.mjs';
import { scan } from '../scripts/scan.mjs';
import { coreMessage, normalizeSourcePath, resolveProjectRepo, PROJECTS } from '../scripts/lib/cli.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

test('summarize 统计分布、宿主版本与 distinct session', () => {
  const rows = flattenRows(fx('log-query-938f8ba3.json'));
  const s = summarize(rows);
  assert.deepEqual(s.pid_dist, { '/webview/minutes-ai-layout-mobile': 2, '/webview/end-summary-mobile': 1 });
  assert.deepEqual(s.os_dist, { iOS: 3 });
  assert.deepEqual(s.source_type_dist, { onunhandledrejection: 2, manual: 1 });
  assert.deepEqual(s.host_version_dist, { '7.62.12': 2, unknown: 1 });
  assert.equal(s.distinct_sessions, 2);
});

test('scan 用注入 runner 以 issue 为单位产出候选，按用户数降序，某 BID 失败只记 skipped', async () => {
  const calls = [];
  const runner = (args) => {
    calls.push(args.join(' '));
    if (args.includes('vc_web')) throw new Error('errno=429004001 服务器负载高');
    if (args[0] === 'js-error' && args[1] === 'list') return fx('list-vc_ai.json');
    if (args[0] === 'log' && args[1] === 'query') return fx('log-query-938f8ba3.json');
    if (args[0] === 'log' && args[1] === 'detail') return fx('log-detail-938f8ba3.json');
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const textRunner = (args) => {
    calls.push(`TEXT ${args.join(' ')}`);
    const id = JSON.parse(args[args.indexOf('--filter') + 1])[0].values[0];
    return `正在查询...\n平台链接: https://slardar.bytedance.net/node/web/data_search?bid=vc_ai&filter_id=f-${id.slice(0, 8)}\n`;
  };
  const r = await scan({ bids: ['vc_ai', 'vc_web'], hours: 24, pageSize: 3, newDepth: 0, now: 1788853929000, runner, textRunner });
  assert.deepEqual(r.skipped_bids.map((s) => s.bid), ['vc_web']);
  assert.equal(r.candidates.find((c) => c.issue_id === '938f8ba377ac6484ba8918b19f247350').slardar_url, 'https://slardar.bytedance.net/node/web/data_search?bid=vc_ai&filter_id=f-938f8ba3');
  assert.ok(calls.some((c) => c.startsWith('TEXT log query') && c.includes(`--start-time ${1788853929 - 7 * 86400}`) && !c.includes('--raw') && !c.includes('--no-share')));
  assert.equal(r.window.start, 1788853929 - 24 * 3600);
  const byId = Object.fromEntries(r.candidates.map((c) => [c.issue_id, c]));
  assert.equal(
    byId['938f8ba377ac6484ba8918b19f247350'].issue_url,
    `https://slardar.bytedance.net/node/web/js/detail?env=online&bid=vc_ai&lang=zh&start_time=${1788853929 - 24 * 3600}&end_time=1788853929&site_type=web&region=cn&issue_id=938f8ba377ac6484ba8918b19f247350&layout=normal&release=7.76.0.234`,
  );
  assert.equal(byId['938f8ba377ac6484ba8918b19f247350'].latest_event.mapped_path, 'vc-ai/src/utils/native.ts');
  assert.equal(byId['938f8ba377ac6484ba8918b19f247350'].latest_event.line, 196);
  assert.equal(byId['938f8ba377ac6484ba8918b19f247350'].project_dir, 'vc-ai');
  assert.equal(byId['938f8ba377ac6484ba8918b19f247350'].distinct_sessions, 2);
  assert.equal(byId['aaaed08b947f7c1730c780ec481b0cee'].users, 8441);
  assert.ok(calls.some((c) => c.startsWith('js-error list --bid vc_ai')));
  assert.ok(calls.some((c) => c.includes('--page-size 300')));
  assert.ok(calls.some((c) => c.startsWith('js-error list --bid vc_ai') && c.includes('--order-by user_descend --page-num 1 --page-size 3')));
  assert.deepEqual(r.candidates.map((c) => c.users), [21740, 11391, 8441]);
  assert.deepEqual(r.candidates.map((c) => [c.category, c.family_size, c.family_users]), [['host', 1, 21740], ['server', 1, 11391], ['server', 1, 8441]]);
  assert.equal(byId['938f8ba377ac6484ba8918b19f247350'].family_key, 'common.getAvatarBase64_* timeout after 60s');
  assert.equal(r.page, 1);
  assert.equal(r.page_size, 3);
});

test('scan 最新事件 detail 报「正在处理」时退到下一条 dh_key，全失败只记 detail_error', async () => {
  const detailKeys = [];
  const runner = (args) => {
    if (args[0] === 'js-error') {
      const top = Number(args[args.indexOf('--page-size') + 1]);
      const list = fx('list-vc_ai.json');
      return { ...list, data: { ...list.data, result: list.data.result.slice(0, top) } };
    }
    if (args[0] === 'log' && args[1] === 'query') return fx('log-query-938f8ba3.json');
    if (args[0] === 'log' && args[1] === 'detail') {
      const key = args[args.indexOf('--dh-key') + 1];
      detailKeys.push(key);
      if (key === 'k1') throw new Error('Slardar的log服务可能正在处理这条log');
      if (key === 'k2') return fx('log-detail-938f8ba3.json');
      throw new Error('boom');
    }
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const r = await scan({ bids: ['vc_ai'], hours: 24, pageSize: 1, newDepth: 0, now: 1788853929000, runner });
  assert.deepEqual(r.skipped_bids, []);
  assert.equal(r.candidates[0].latest_event.line, 196);
  assert.equal(r.candidates[0].detail_error, null);
  assert.deepEqual(detailKeys, ['k1', 'k2']);

  const allFail = (args) => (args[0] === 'log' && args[1] === 'detail' ? (() => { throw new Error('处理中'); })() : runner(args));
  const r2 = await scan({ bids: ['vc_ai'], hours: 24, pageSize: 1, newDepth: 0, now: 1788853929000, runner: allFail });
  assert.equal(r2.candidates[0].latest_event.mapped_path, null);
  assert.match(r2.candidates[0].detail_error, /处理中/);
  assert.equal(
    r2.candidates[0].issue_url,
    `https://slardar.bytedance.net/node/web/js/detail?env=online&bid=vc_ai&lang=zh&start_time=${1788853929 - 24 * 3600}&end_time=1788853929&site_type=web&region=cn&issue_id=aaaed08b947f7c1730c780ec481b0cee&layout=normal`,
  );
});

test('scan 按页取：--page-num 透传，输出带页码', async () => {
  const calls = [];
  const runner = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'js-error') return { data: { result: [] } };
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const r = await scan({ bids: ['vc_ai'], hours: 24, page: 3, pageSize: 20, now: 1788853929000, runner });
  assert.deepEqual(r.candidates, []);
  assert.equal(r.page, 3);
  assert.equal(r.page_size, 20);
  assert.ok(calls[0].includes('--order-by user_descend --page-num 3 --page-size 20'));
});

test('scan 不合并文案相同的 issue：Slardar 按堆栈拆开的各自成为候选', async () => {
  const runner = (args) => {
    if (args[0] === 'js-error') {
      return { data: { result: [
        { issue_id: 'a', message: 'APINotProvided', name: 'Error', filename: 'f', count: 10, user: 9, min_crash_time: 0, issue_status: 'unassigned' },
        { issue_id: 'b', message: 'APINotProvided', name: 'Error', filename: 'f', count: 30, user: 20, min_crash_time: 0, issue_status: 'unassigned' },
      ] } };
    }
    if (args[0] === 'log' && args[1] === 'query') return { data: { table_list: [] } };
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const r = await scan({ bids: ['vc_ai'], hours: 24, newDepth: 0, now: 1788853929000, runner });
  assert.deepEqual(r.candidates.map((c) => [c.issue_id, c.users, c.count]), [['b', 20, 30], ['a', 9, 10]]);
  // 同文案只共享族合计用于排序，候选本身仍一条一个 issue。
  assert.deepEqual(r.candidates.map((c) => [c.family_key, c.family_users, c.family_size]), [['APINotProvided', 29, 2], ['APINotProvided', 29, 2]]);
});

const recordDetail = {
  data: {
    metric_map: { pid: { value: 'record-page' }, release: { value: '8.2.14' }, source_type: { value: 'manual' } },
    json: JSON.stringify({
      pid: 'record-page',
      release: '8.2.14',
      stack: { values: [{ raw_stacktrace: { frames: [
        { filename: 'https://sf1-scmcdn-cn.feishucdn.com/obj/feishu-static/byteview/vc-ai/static/js/9824-220d04167504d12f073c-ai.js', lineno: 1, colno: 104742, function: 'HTMLDivElement.u', parse_code: 201, parse_msg: 'Sourcemap Miss' },
        { filename: 'https://sf1-scmcdn-cn.feishucdn.com/obj/feishu-static/byteview/vc-ai/static/js/5213-dfa7789d408dae604ef1-ai.js', lineno: 1, colno: 39145, function: 'v', parse_code: 201, parse_msg: 'Sourcemap Miss' },
      ] } }] },
    }),
  },
};

test('scan minutes_record 走 production 环境，帧停在 vc-ai CDN chunk 时给出 sourcemap 缺失与 chunk 线索', async () => {
  const calls = [];
  const runner = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'js-error') {
      return { data: { result: [
        { issue_id: 'r1', message: '[RECORD_SDK] [warn] FishBoneError: track fish_move when hidden', name: 'Error', filename: 'https://sf1-scmcdn-cn.feishucdn.com/obj/feishu-static/byteview/vc-ai/static/js/5213-dfa7789d408dae604ef1-ai.js', count: 40, user: 12, min_crash_time: 0, issue_status: 'unassigned' },
      ] } };
    }
    if (args[0] === 'log' && args[1] === 'query') return { data: { table_list: [{ metric_map: { dh_key: { value: 'k1' }, pid: { value: 'record-page' }, release: { value: '8.2.14' }, session_id: { value: 's1' }, user_agent: { value: 'Mozilla/5.0 Lark/8.2.14' } } }] } };
    if (args[0] === 'log' && args[1] === 'detail') return recordDetail;
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const r = await scan({ bids: ['minutes_record'], hours: 24, newDepth: 0, now: 1788853929000, runner });
  assert.deepEqual(r.skipped_bids, []);
  assert.deepEqual(r.bids, { minutes_record: 1 });
  assert.ok(calls.every((c) => c.includes('--bid minutes_record --env production')), calls.join('\n'));
  const c = r.candidates[0];
  assert.equal(c.project_dir, 'vc-ai');
  assert.equal(c.message_core, 'FishBoneError: track fish_move when hidden');
  assert.equal(c.latest_event.mapped_path, null);
  assert.equal(c.latest_event.sourcemap_missing, true);
  assert.equal(c.latest_event.project_frames, 2);
  assert.deepEqual(c.latest_event.chunk_files, ['9824-220d04167504d12f073c-ai.js', '5213-dfa7789d408dae604ef1-ai.js']);
  assert.equal(c.latest_event.release, '8.2.14');
  assert.deepEqual(c.host_version_dist, { '8.2.14': 1 });
  assert.match(c.issue_url, /^https:\/\/slardar\.bytedance\.net\/node\/web\/js\/detail\?env=production&bid=minutes_record&/);
});

test('scan 多个 bid 并行起跑：异步 runner 下两个 bid 的列表请求都先于任何样本请求发出', async () => {
  const calls = [];
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  const runner = async (args) => {
    calls.push(args.slice(0, 2).join(' '));
    await tick();
    if (args[0] === 'js-error') return fx('list-vc_ai.json');
    if (args[0] === 'log' && args[1] === 'query') return fx('log-query-938f8ba3.json');
    if (args[0] === 'log' && args[1] === 'detail') return fx('log-detail-938f8ba3.json');
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const r = await scan({ bids: ['vc_ai', 'minutes_record'], hours: 24, pageSize: 2, newDepth: 0, now: 1788853929000, runner });
  assert.deepEqual(calls.slice(0, 2), ['js-error list', 'js-error list']);
  assert.deepEqual(r.bids, { vc_ai: 3, minutes_record: 3 });
  assert.equal(r.candidates.length, 6);
  assert.deepEqual(r.candidates.map((c) => c.users), [21740, 21740, 11391, 11391, 8441, 8441]);
  assert.equal(r.candidates.filter((c) => c.bid === 'minutes_record').length, 3);
});

test('scan vc_ai 常规事件不受帧线索影响：webpack 帧已解析，sourcemap_missing 为 false', async () => {
  const runner = (args) => {
    if (args[0] === 'js-error') { const l = fx('list-vc_ai.json'); return { ...l, data: { ...l.data, result: l.data.result.slice(0, 1) } }; }
    if (args[0] === 'log' && args[1] === 'query') return fx('log-query-938f8ba3.json');
    if (args[0] === 'log' && args[1] === 'detail') return fx('log-detail-938f8ba3.json');
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const r = await scan({ bids: ['vc_ai'], hours: 24, pageSize: 1, newDepth: 0, now: 1788853929000, runner });
  const e = r.candidates[0].latest_event;
  assert.equal(e.sourcemap_missing, false);
  assert.equal(e.project_frames >= 1, true);
  assert.equal(r.candidates[0].message_core, r.candidates[0].message);
});

test('normalizeSourcePath 对 <anonymous> 与 CDN / blob 地址返回 null，webpack 路径归到项目目录', () => {
  assert.equal(normalizeSourcePath('<anonymous>', 'vc-ai'), null);
  assert.equal(normalizeSourcePath('https://sf1-scmcdn-cn.feishucdn.com/obj/feishu-static/byteview/vc-ai/static/js/1-a-ai.js', 'vc-ai'), null);
  assert.equal(normalizeSourcePath('webpack://@byteview-web/vc-ai/./src/utils/native.ts', 'vc-ai'), 'vc-ai/src/utils/native.ts');
});

test('normalizeSourcePath 对 byteview-pc 的 webpack 作用域帧映射到 packages/byteview-<包>，node_modules / file / native-resource 帧为 null', () => {
  const pc = PROJECTS.lark_vc_pc;
  assert.equal(normalizeSourcePath('webpack://@byteview/calls-and-meetings/./src/hooks/settings.ts', pc), 'packages/byteview-calls-and-meetings/src/hooks/settings.ts');
  assert.equal(normalizeSourcePath('webpack://@byteview/page/./src/index.tsx', pc), 'packages/byteview-page/src/index.tsx');
  assert.equal(normalizeSourcePath('webpack://@byteview/calls-and-meetings/../../node_modules/@lark/services/index.js', pc), null);
  assert.equal(normalizeSourcePath('file:///Applications/Lark.app/Contents/Resources/webcontent/video-conference-native/extensions-page/static/js/native-invite.js', pc), null);
  assert.equal(normalizeSourcePath('native-resource://sandbox_fs/neotix/lark-api-core.js', pc), null);
  assert.equal(normalizeSourcePath('index 216', pc), null);
  assert.equal(normalizeSourcePath('webpack://@byteview-web/vc-ai/./src/utils/native.ts', PROJECTS.vc_ai), 'vc-ai/src/utils/native.ts');
});

test('resolveProjectRepo：byteview-web 系 bid 用 --repo，byteview-pc 取同级目录，环境变量可覆盖', () => {
  assert.equal(resolveProjectRepo('vc_ai', '/ws/byteview-web'), '/ws/byteview-web');
  assert.equal(resolveProjectRepo('minutes_record', '/ws/byteview-web'), '/ws/byteview-web');
  assert.equal(resolveProjectRepo('lark_vc_pc', '/ws/byteview-web'), '/ws/byteview-pc');
  process.env.SLARDAR_TRIAGE_REPO_BYTEVIEW_PC = '/elsewhere/pc';
  try {
    assert.equal(resolveProjectRepo('lark_vc_pc', '/ws/byteview-web'), '/elsewhere/pc');
  } finally {
    delete process.env.SLARDAR_TRIAGE_REPO_BYTEVIEW_PC;
  }
});

const pcDetail = {
  data: {
    metric_map: { pid: { value: 'video-conference-page' }, release: { value: '8.2.3_2026_9_23_16_51_41_288' }, source_type: { value: 'manual' } },
    json: JSON.stringify({
      pid: 'video-conference-page',
      release: '8.2.3_2026_9_23_16_51_41_288',
      stack: { values: [{ raw_stacktrace: { frames: [
        { filename: 'native-resource://sandbox_fs/neotix/lark-api-core.js', lineno: 1, colno: 10, function: 'invoke' },
        { filename: 'webpack://@byteview/calls-and-meetings/../../node_modules/@lark/services/index.js', lineno: 3, colno: 4, function: 'call' },
        { filename: 'webpack://@byteview/calls-and-meetings/./src/hooks/settings.ts', lineno: 12, colno: 7, function: 'key' },
      ] } }] },
    }),
  },
};

test('scan lark_vc_pc 走 production、归 byteview-pc 仓，帧映射到 packages/byteview-<包>/src', async () => {
  const calls = [];
  const runner = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'js-error') {
      return { data: { result: [
        { issue_id: 'p1', message: "Cannot read properties of undefined (reading 'vc_tab_usage_config')", name: 'TypeError', filename: 'webpack://@byteview/calls-and-meetings/./src/hooks/settings.ts', count: 3, user: 2, min_crash_time: 0, issue_status: 'unassigned' },
      ] } };
    }
    if (args[0] === 'log' && args[1] === 'query') return { data: { table_list: [{ metric_map: { dh_key: { value: 'k1' }, pid: { value: 'video-conference-page' }, release: { value: '8.2.3_2026_9_23_16_51_41_288' }, os: { value: 'Windows' }, session_id: { value: 's1' }, user_agent: { value: 'Mozilla/5.0 (Windows NT 10.0)' } } }] } };
    if (args[0] === 'log' && args[1] === 'detail') return pcDetail;
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const r = await scan({ bids: ['lark_vc_pc'], hours: 24, newDepth: 0, now: 1788853929000, repo: '/ws/byteview-web', runner });
  assert.deepEqual(r.skipped_bids, []);
  assert.ok(calls.every((c) => c.includes('--bid lark_vc_pc --env production')), calls.join('\n'));
  const c = r.candidates[0];
  assert.equal(c.repo, 'byteview-pc');
  assert.equal(c.repo_dir, '/ws/byteview-pc');
  assert.equal(c.project_dir, 'packages');
  assert.deepEqual(c.scm_repos, []);
  assert.equal(c.category, 'business');
  assert.equal(c.latest_event.mapped_path, 'packages/byteview-calls-and-meetings/src/hooks/settings.ts');
  assert.equal(c.latest_event.line, 12);
  assert.equal(c.latest_event.sourcemap_missing, false);
  assert.equal(c.latest_event.project_frames, 1);
  assert.equal(c.latest_event.page, 'video-conference-page');
  assert.match(c.issue_url, /env=production&bid=lark_vc_pc&/);
});

// 新增检测的桩：24h 列表按 page-size 区分常规页（20）与深度页（100）；基线窗口（7 天）的调用带 issue_id 过滤，
// 返回的 min_crash_time 决定新旧：old 在基线起点、fresh / variant 在 48h 内、unknown 基线里查不到。
const NOW = 1788853929000;
const END = Math.floor(NOW / 1000);
const BASELINE_START = END - 7 * 86400;
const issue = (id, message, user, min) => ({ issue_id: id, message, name: 'Error', filename: 'f', count: user * 3, user, min_crash_time: min, issue_status: 'unassigned' });
const DAY_LIST = [
  issue('old', 'APINotProvided', 900, (END - 86400) * 1000),
  issue('variant', '[warn] ErrorBoundary: n.map is not a function', 120, (END - 86400) * 1000),
  issue('oldfam', '[warn] ErrorBoundary: o.map is not a function', 80, (END - 86400) * 1000),
  issue('fresh', "Cannot read properties of null (reading 'meetingId')", 7, (END - 3000) * 1000),
  issue('unknown', 'something odd', 3, (END - 2000) * 1000),
  issue('solo', 'Cannot destructure property version of null', 1, (END - 1000) * 1000),
  issue('solosib', "Cannot read properties of null (reading 'meetingId')", 1, (END - 86400) * 1000),
];
const BASELINE_MIN = {
  old: BASELINE_START * 1000,
  variant: (END - 20 * 3600) * 1000,
  oldfam: BASELINE_START * 1000,
  fresh: (END - 30 * 3600) * 1000,
  solo: (END - 1000) * 1000,
  solosib: BASELINE_START * 1000,
};
function newRunner(calls) {
  return (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'js-error') {
      const filter = JSON.parse(args[args.indexOf('--filter') + 1]);
      const start = Number(args[args.indexOf('--start-time') + 1]);
      const pageSize = Number(args[args.indexOf('--page-size') + 1]);
      const page = Number(args[args.indexOf('--page-num') + 1]);
      const idFilter = filter.find((f) => f.filter_name === 'issue_id');
      if (idFilter) {
        assert.equal(start, BASELINE_START);
        return { data: { result: idFilter.values.filter((id) => id in BASELINE_MIN).map((id) => ({ ...DAY_LIST.find((i) => i.issue_id === id), min_crash_time: BASELINE_MIN[id] })) } };
      }
      assert.equal(start, END - 86400);
      return { data: { result: page === 1 ? DAY_LIST.slice(0, pageSize) : [] } };
    }
    if (args[0] === 'log' && args[1] === 'query') return { data: { table_list: [] } };
    throw new Error(`unexpected ${args.join(' ')}`);
  };
}

test('scan 新增检测：基线窗口里首次出现在 48h 内的 issue 标 is_new 并追加进候选，老文案换堆栈的不算新族，新族排最前', async () => {
  const calls = [];
  const r = await scan({ bids: ['vc_ai'], hours: 24, pageSize: 2, now: NOW, runner: newRunner(calls) });
  assert.deepEqual(r.bids, { vc_ai: 3 });
  assert.deepEqual(r.new_issues, { vc_ai: 2 });
  assert.equal(r.new_hours, 48);
  assert.equal(r.baseline_days, 7);
  const byId = Object.fromEntries(r.candidates.map((c) => [c.issue_id, c]));
  // 常规页取前 2 条，新 issue 不在页内的追加；unknown 在基线里查不到不算新，oldfam 既不新也不在页内，
  // solo 只有 1 个用户不进新增检测（基线查询也不带它），都不进候选。
  assert.deepEqual(r.candidates.map((c) => c.issue_id), ['fresh', 'old', 'variant']);
  assert.ok(!calls.some((c) => c.startsWith('js-error list') && (c.includes('"solo"') || c.includes('"solosib"'))), calls.join('\n'));
  // solosib 与 fresh 同文案但只有 1 个用户、新旧未知，不能让 fresh 变成「老族换堆栈」。
  assert.deepEqual([byId.fresh.is_new, byId.fresh.new_family, byId.fresh.baseline_first_seen], [true, true, BASELINE_MIN.fresh]);
  assert.deepEqual([byId.variant.is_new, byId.variant.new_family, byId.variant.baseline_first_seen], [true, false, BASELINE_MIN.variant]);
  assert.deepEqual([byId.old.is_new, byId.old.new_family, byId.old.baseline_first_seen], [false, false, BASELINE_MIN.old]);
  // 深度页按 100 条一页拉 3 页；基线查询带 issue_id 过滤、窗口 7 天。
  assert.equal(calls.filter((c) => c.startsWith('js-error list') && c.includes('--page-size 100')).length, 3, calls.join('\n'));
  const baselineCalls = calls.filter((c) => c.startsWith('js-error list') && c.includes('"filter_name":"issue_id"'));
  assert.equal(baselineCalls.length, 1, calls.join('\n'));
  assert.ok(baselineCalls[0].includes(`--start-time ${BASELINE_START} --end-time ${END}`));
  assert.ok(baselineCalls[0].includes('"issue_status"'), '基线查询沿用未处理 / 处理中过滤，id 才对得上');
  // 常规页的调用形状不变。
  assert.ok(calls.some((c) => c.includes('--order-by user_descend --page-num 1 --page-size 2')));
});

test('scan 新增检测只在第 1 页做，--new-depth 0 关闭；新 issue 追加数不超过 page-size', async () => {
  const calls = [];
  const r2 = await scan({ bids: ['vc_ai'], hours: 24, pageSize: 2, page: 2, now: NOW, runner: newRunner(calls) });
  assert.deepEqual(r2.new_issues, { vc_ai: 0 });
  assert.ok(!calls.some((c) => c.startsWith('js-error list') && c.includes('"filter_name":"issue_id"')));
  assert.ok(!calls.some((c) => c.includes('--page-size 100')));

  calls.length = 0;
  const off = await scan({ bids: ['vc_ai'], hours: 24, pageSize: 2, newDepth: 0, now: NOW, runner: newRunner(calls) });
  assert.deepEqual(off.candidates.map((c) => [c.issue_id, c.is_new, c.baseline_first_seen]), [['old', false, null], ['variant', false, null]]);
  assert.equal(calls.filter((c) => c.startsWith('js-error list')).length, 1);

  calls.length = 0;
  const loose = await scan({ bids: ['vc_ai'], hours: 24, pageSize: 20, newMinUsers: 1, now: NOW, runner: newRunner(calls) });
  assert.deepEqual(loose.new_issues, { vc_ai: 3 });
  assert.deepEqual(loose.candidates.filter((c) => c.is_new).map((c) => c.issue_id).sort(), ['fresh', 'solo', 'variant']);
  // 门槛放到 1 后 solosib 进入检测并判为老，fresh 的文案族就成了已知族。
  const looseById = Object.fromEntries(loose.candidates.map((c) => [c.issue_id, c]));
  assert.deepEqual([looseById.fresh.new_family, looseById.solo.new_family, looseById.solosib.is_new], [false, true, false]);
  assert.equal(loose.candidates[0].issue_id, 'solo');

  calls.length = 0;
  const capped = await scan({ bids: ['vc_ai'], hours: 24, pageSize: 1, now: NOW, runner: newRunner(calls) });
  // 页内只有 old；新 issue 按用户数追加 1 条，variant（120）胜过 fresh（7），追加后仍按量级排。
  assert.deepEqual(capped.candidates.map((c) => [c.issue_id, c.is_new]), [['old', false], ['variant', true]]);
  assert.deepEqual(capped.new_issues, { vc_ai: 2 });
});

test('coreMessage 只剥录音 SDK 前缀，其他文案原样', () => {
  assert.equal(coreMessage('[RECORD_SDK] [warn] FishBoneError: x'), 'FishBoneError: x');
  assert.equal(coreMessage('[RECORD_SDK] CommonError: y'), 'CommonError: y');
  assert.equal(coreMessage('[warn] FishBoneError: z'), '[warn] FishBoneError: z');
  assert.equal(coreMessage(undefined), '');
});
