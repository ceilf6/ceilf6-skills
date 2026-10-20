import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUCKETS, bucketSummary, categorize, enrich, familyKey, isBucketed } from '../scripts/lib/category.mjs';

test('categorize：服务端 / 网络 / 宿主三类按文案命中，其余归业务', () => {
  const cases = {
    server: ['[lark.api.gateway][pb]: call kite service fail', 'ClientError(LarkError { status: Some(610), code: Some(100054) })', '发生了一些问题，请重新登录。', 'EOF while parsing a value at line 1 column 0', '[InvokeServierPBFast error]: logId=2026, rate limit', 'invalid user', '业务错误，ErrorInfo: code: 220301', '[warn] CommonError:  request over limit', 'invokeAsyncWithServerPBFast timeout after 10000ms'],
    network: ['Failed to fetch', '[warn] CommonError: Load failed', 'NetError { code: -21, msg: "" }', '[warn] ServiceWorkerError: sw_fetch_manifest_error network Failed to fetch', '[warn] fetchGlobalKAConfig: Failed to fetch', '[warn] CommonError: [native-api] network proxy failed: command=7507, contextId=guide-1'],
    host: ['Failed to execute "webview_ShellAPI.app.webview.closeWebview_req_9254": {"error":true}', 'Os { code: 112, kind: StorageFull, message: "磁盘空间不足。" }', 'CustomError("db closed or not init")', 'database is locked', 'Trigger_client_command_for_user:  uid:1: user container not ready', 'FrameworkError: Sync get connection from pool timeout', 'message channel not ready in 30000 ms', 'Loading chunk 0 failed. (timeout: file:///D:/x.js)', 'APINotProvided', '[native-api] command=94003 timed out after 10000ms', 'Error invoking invokeNative: Java object is gone', 'common.getAvatarBase64_1 timeout after 60s', 'The WKWebView was deallocated before the message was delivered', '[warn] CommonError: [MeetingManager] meeting_id=7698 not found', 'Failed to execute "webview_ShellAPI.app.iron.getAvatarWithCache_req_2330": Failed!'],
    business: ["Cannot destructure property 'version' of 'Gm' as it is null.", "Cannot read properties of undefined (reading 'vc_tab_usage_config')", 'not suite url', 'get joined deviced info error', 'timeout', '[warn] ErrorBoundary: n.map is not a function', "[warn] CommonError: Cannot read properties of undefined (reading 'length')", '[warn] FishBoneError: fishBone out of screen', '[warn] ParseDiagramError: parse flow failed', 'lang is required', 'ResizeObserver loop completed with undelivered notifications.', '[warn] CommonError: empty state request timeout'],
  };
  for (const [category, messages] of Object.entries(cases)) {
    for (const m of messages) assert.equal(categorize(m), category, m);
  }
  assert.equal(isBucketed('host'), true);
  assert.equal(isBucketed('business'), false);
  assert.deepEqual(Object.keys(BUCKETS), ['server', 'network', 'host']);
});

test('familyKey：抹掉易变量与压缩标识符后同文案归同一族，不同文案不合并', () => {
  const same = (a, b) => assert.equal(familyKey(a), familyKey(b), `${a} ≠ ${b}`);
  const diff = (a, b) => assert.notEqual(familyKey(a), familyKey(b), `${a} == ${b}`);
  same('[warn] ErrorBoundary: n.map is not a function', "[warn] ErrorBoundary: o.map is not a function. (In 'o.map((e,t)=>n.createElement', 'o.map' is undefined)");
  same('[InvokeServierPBFast error]: logId=202610201047477C2235B8096157D3624B, rate limit', '[InvokeServierPBFast error]: logId=, rate limit');
  same('[MeetingManager] meeting_id=7698567084716903719 not found', '[MeetingManager] meeting_id=1 not found');
  same('common.getAvatarBase64_1 timeout after 60s', 'common.getAvatarBase64_165 timeout after 60s');
  same('[native-api] network proxy failed: command=89554, contextId=context-1792464419556-0.99', '[native-api] network proxy failed: command=89554, contextId=ctx');
  same("[warn] ErrorBoundary: Expected ',' or ']' after array element in JSON at position 173 (line 1 column 174)", "[warn] ErrorBoundary: Expected ',' or ']' after array element in JSON at position 9 (line 2 column 3)");
  same('[warn] ErrorBoundary: CompareTableJsonChart row 8 column count error: expected 4 or 5, got 3', '[warn] ErrorBoundary: CompareTableJsonChart row 3 column count error: expected 4 or 5, got 3');
  same("[warn] ErrorBoundary: undefined is not an object (evaluating 't.yAxis.top')", "[warn] ErrorBoundary: undefined is not an object (evaluating 'e.yAxis.top')");
  diff('Failed to fetch', '[warn] CommonError: Failed to fetch');
  diff("[warn] ErrorBoundary: undefined is not an object (evaluating 't.yAxis.top')", "[warn] ErrorBoundary: undefined is not an object (evaluating 't.xAxis.left')");
  diff('[native-api] command=94003 timed out after 10000ms', '[native-api] command=2312 timed out after 10000ms');
  assert.equal(familyKey('[warn] ErrorBoundary: n.map is not a function'), '[warn] ErrorBoundary: *.map is not a function');
});

test('enrich：补 category 与族合计，按族合计用户数降序、同族内按单条用户数降序', () => {
  const out = enrich([
    { issue_id: 'big', message: 'APINotProvided', users: 900, count: 1000 },
    { issue_id: 'f1', message: '[warn] ErrorBoundary: n.map is not a function', users: 400, count: 700 },
    { issue_id: 'lone', message: "[warn] CommonError: Cannot read properties of undefined (reading 'length')", users: 500, count: 600 },
    { issue_id: 'f2', message: "[warn] ErrorBoundary: o.map is not a function. (In 'o.map(...)', 'o.map' is undefined)", users: 300, count: 400 },
    { issue_id: 'f3', message: '[RECORD_SDK] [warn] ErrorBoundary: n.map is not a function', message_core: '[warn] ErrorBoundary: n.map is not a function', bid: 'minutes_record', users: 250, count: 300 },
  ]);
  assert.deepEqual(out.map((c) => c.issue_id), ['f1', 'f2', 'f3', 'big', 'lone']);
  assert.deepEqual(out.map((c) => [c.category, c.family_users, c.family_count, c.family_size]), [
    ['business', 950, 1400, 3], ['business', 950, 1400, 3], ['business', 950, 1400, 3], ['host', 900, 1000, 1], ['business', 500, 600, 1],
  ]);
  assert.equal(out[0].family_key, out[2].family_key);
  assert.deepEqual(bucketSummary([
    { source: 'bucket', category: 'host', family_key: 'a', users: 10 },
    { source: 'bucket', category: 'host', family_key: 'a', users: 5 },
    { source: 'bucket', category: 'network', family_key: 'b', users: 1 },
    { source: 'agent', category: 'host', family_key: 'c', users: 100 },
  ]), {
    host: { label: '宿主与 Native 桥', issues: 2, families: 1, users: 15 },
    network: { label: '网络', issues: 1, families: 1, users: 1 },
  });
});
