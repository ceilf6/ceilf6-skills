// bot 本机控制端口：IM 与看板共用的停止入口。绑 127.0.0.1、无鉴权——
// 沿用 ht 看板的本机单用户姿态。本文件只做传输与参数校验，任务定位与处置
// 全在注入的 handlers 里，故可脱离 listener 单测。
import { createServer } from 'node:http';

const MAX_BODY = 64 * 1024;
// 超限与解析失败要分别处置，而 null 会和合法的 JSON 字面量 null 混淆，故用哨兵区分。
const OVERSIZE = Symbol('oversize');

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > MAX_BODY) { resolve(OVERSIZE); return; }
      chunks.push(c);
    });
    // 分片边界可能落在 UTF-8 多字节序列中间，逐块转字符串会切出替换字符，故收齐再整体解码。
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve(null); }
    });
    // 连接出错或被中断的请求同样要让 promise 落地，否则这条处理链永远挂起。
    req.on('error', () => resolve(null));
    req.on('close', () => resolve(null));
  });
}

export function startControlServer({ port, handlers, onListen }) {
  const send = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  };
  const server = createServer((req, res) => {
    (async () => {
      if (req.method === 'GET' && req.url === '/api/tasks') {
        return send(res, 200, { tasks: handlers.listTasks() });
      }
      if (req.method === 'POST' && (req.url === '/api/stop' || req.url === '/api/pause')) {
        const body = await readJson(req);
        if (body === OVERSIZE) {
          // 超限后不再收剩余请求体，但要等 413 落地再断连，否则客户端只看得到 ECONNRESET。
          res.on('finish', () => req.destroy());
          return send(res, 413, { ok: false, error: `请求体超过 ${MAX_BODY} 字节` });
        }
        if (!body) return send(res, 400, { ok: false, error: '请求体须为 JSON' });
        const out = await handlers.control(body, req.url === '/api/stop' ? 'stop' : 'pause');
        return send(res, out.ok ? 200 : 404, out);
      }
      send(res, 404, { ok: false, error: 'not found' });
      // catch 回调自身抛出会变成无人接管的 rejection 而终止常驻进程，故抛出物按非 Error 取值。
    })().catch((e) => send(res, 500, { ok: false, error: String(e?.message ?? e) }));
  });
  server.listen(port, '127.0.0.1', () => onListen?.(server));
  return server;
}
