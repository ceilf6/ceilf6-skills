import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { familyKey } from '../scripts/lib/family.mjs';
import { summarize, flattenRows } from '../scripts/lib/stats.mjs';
import { scan } from '../scripts/scan.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

test('familyKey 去掉序号、logId、ttLogId、requestID', () => {
  assert.equal(familyKey('common.getAvatarBase64_165 timeout after 60s'), 'common.getAvatarBase64 timeout after 60s');
  assert.equal(familyKey('common.getAvatarBase64_43 timeout after 60s'), familyKey('common.getAvatarBase64_165 timeout after 60s'));
  assert.equal(
    familyKey('[InvokeServierPBFast error]: logId=20260908155207554D4C362C984C6977D8, invalid user'),
    '[InvokeServierPBFast error]: logId=<id>, invalid user',
  );
  assert.equal(
    familyKey('业务错误，ErrorInfo: code: 220301,requestID: ,ttLogId: Optional("2026")'),
    '业务错误，ErrorInfo: code: 220301,requestID: <id>,ttLogId: <id>',
  );
});

test('summarize 统计分布、宿主版本与 distinct session', () => {
  const rows = flattenRows(fx('log-query-938f8ba3.json'));
  const s = summarize(rows);
  assert.deepEqual(s.pid_dist, { '/webview/minutes-ai-layout-mobile': 2, '/webview/end-summary-mobile': 1 });
  assert.deepEqual(s.os_dist, { iOS: 3 });
  assert.deepEqual(s.source_type_dist, { onunhandledrejection: 2, manual: 1 });
  assert.deepEqual(s.host_version_dist, { '7.62.12': 2, unknown: 1 });
  assert.equal(s.distinct_sessions, 2);
});

test('scan 用注入 runner 产出候选并做族合并，某 BID 失败只记 skipped', async () => {
  const calls = [];
  const runner = (args) => {
    calls.push(args.join(' '));
    if (args.includes('vc_web')) throw new Error('errno=429004001 服务器负载高');
    if (args[0] === 'js-error' && args[1] === 'list') return fx('list-vc_ai.json');
    if (args[0] === 'log' && args[1] === 'query') return fx('log-query-938f8ba3.json');
    if (args[0] === 'log' && args[1] === 'detail') return fx('log-detail-938f8ba3.json');
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const r = await scan({ bids: ['vc_ai', 'vc_web'], hours: 24, top: 3, now: 1788853929000, runner });
  assert.deepEqual(r.skipped_bids.map((s) => s.bid), ['vc_web']);
  assert.equal(r.window.start, 1788853929 - 24 * 3600);
  const byId = Object.fromEntries(r.candidates.map((c) => [c.issue_id, c]));
  assert.equal(byId['938f8ba377ac6484ba8918b19f247350'].latest_event.mapped_path, 'vc-ai/src/utils/native.ts');
  assert.equal(byId['938f8ba377ac6484ba8918b19f247350'].latest_event.line, 196);
  assert.equal(byId['938f8ba377ac6484ba8918b19f247350'].project_dir, 'vc-ai');
  assert.equal(byId['938f8ba377ac6484ba8918b19f247350'].distinct_sessions, 2);
  assert.equal(byId['aaaed08b947f7c1730c780ec481b0cee'].family_users, 8441);
  assert.ok(calls.some((c) => c.startsWith('js-error list --bid vc_ai')));
  assert.ok(calls.some((c) => c.includes('--page-size 300')));
});
