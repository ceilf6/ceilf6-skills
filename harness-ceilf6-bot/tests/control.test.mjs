import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startControlServer } from '../src/control.mjs';

function boot(handlers) {
  return new Promise((resolve) => {
    const server = startControlServer({
      port: 0, handlers,
      onListen: (s) => resolve({ server: s, base: `http://127.0.0.1:${s.address().port}` }),
    });
    server.on('error', () => {});
  });
}

// fetch 控不了分片边界，逐块发送的用例走裸 http.request。
function postChunks(base, path, chunks) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = request({ host: u.hostname, port: u.port, path, method: 'POST' }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    let i = 0;
    const pump = () => {
      if (i >= chunks.length) { req.end(); return; }
      req.write(chunks[i++], () => setTimeout(pump, 25));
    };
    pump();
  });
}

test('GET /api/tasks 返回注入的快照', async (t) => {
  const { server, base } = await boot({ listTasks: () => [{ messageId: 'om_1', short: '000001', state: 'active' }], control: async () => ({ ok: true }) });
  t.after(() => server.close());
  const r = await fetch(`${base}/api/tasks`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.tasks[0].short, '000001');
});

test('POST /api/stop 与 /api/pause 透传 mode，ok 决定状态码', async (t) => {
  const seen = [];
  const { server, base } = await boot({
    listTasks: () => [],
    control: async (body, mode) => { seen.push([body, mode]); return body.messageId === 'om_1' ? { ok: true, was: 'active', title: 'T' } : { ok: false, error: '未找到匹配的任务' }; },
  });
  t.after(() => server.close());
  const ok = await fetch(`${base}/api/stop`, { method: 'POST', body: JSON.stringify({ messageId: 'om_1' }) });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).was, 'active');
  const miss = await fetch(`${base}/api/pause`, { method: 'POST', body: JSON.stringify({ messageId: 'om_x' }) });
  assert.equal(miss.status, 404);
  assert.deepEqual(seen.map((s) => s[1]), ['stop', 'pause']);
  assert.equal(seen[0][0].messageId, 'om_1');
});

test('坏 JSON 返回 400，未知路径与方法返回 404', async (t) => {
  const { server, base } = await boot({ listTasks: () => [], control: async () => ({ ok: true }) });
  t.after(() => server.close());
  const bad = await fetch(`${base}/api/stop`, { method: 'POST', body: '{不是json' });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  assert.equal((await fetch(`${base}/api/tasks`, { method: 'POST', body: '{}' })).status, 404);
});

test('handlers 抛错不炸进程，返回 500', async (t) => {
  const { server, base } = await boot({ listTasks: () => [], control: async () => { throw new Error('炸了'); } });
  t.after(() => server.close());
  const r = await fetch(`${base}/api/stop`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(r.status, 500);
  assert.ok((await r.json()).error.includes('炸了'));
});

test('handlers 抛出非 Error 同样 500，不炸进程', async (t) => {
  const { server, base } = await boot({ listTasks: () => [], control: async () => { throw null; } });
  t.after(() => server.close());
  const r = await fetch(`${base}/api/stop`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(r.status, 500);
  assert.equal((await r.json()).ok, false);
  assert.equal((await fetch(`${base}/api/tasks`)).status, 200);
});

test('多字节请求体被 chunk 边界劈开：handlers 收到完整文本', async (t) => {
  let got = null;
  const { server, base } = await boot({ listTasks: () => [], control: async (body) => { got = body; return { ok: true }; } });
  t.after(() => server.close());
  const payload = Buffer.from(JSON.stringify({ messageId: 'om_1', reason: '停止跑飞的会话' }), 'utf8');
  const cut = payload.indexOf(Buffer.from('停', 'utf8')) + 1;
  const r = await postChunks(base, '/api/stop', [payload.subarray(0, cut), payload.subarray(cut)]);
  assert.equal(r.status, 200);
  assert.equal(got.reason, '停止跑飞的会话');
});

test('请求体超限返回 413（而非静默断连），端口继续可用', async (t) => {
  const { server, base } = await boot({ listTasks: () => [], control: async () => ({ ok: true }) });
  t.after(() => server.close());
  const r = await postChunks(base, '/api/stop', [Buffer.alloc(200 * 1024, 'x')]);
  assert.equal(r.status, 413);
  assert.equal((await fetch(`${base}/api/tasks`)).status, 200);
});
