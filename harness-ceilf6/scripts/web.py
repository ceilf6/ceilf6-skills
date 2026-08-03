#!/usr/bin/env python3
"""harness 线程本地看板（ht web 启动）。

薄壳原则：读走 threads.sh list --json、写走 threads.sh mark / set-node，本文件
不碰 threads.jsonl / meta.json——单点写入约束由 threads.sh 保证。
仅绑 127.0.0.1，无鉴权；/api/mark 只放行人工节点，/api/set-node 是看板手控的
绝对定位入口（推进/回退，目标校验仍在 threads.sh）。
"""
import argparse
import json
import os
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer

THREADS_SH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "threads.sh")
MANUAL_NODES = ("human_cr_done", "selftest_done")
SET_TARGETS = ("plan_gate", "dev_done", "cr_passed", "mr_created",
               "human_cr_done", "selftest_done", "delivered")

PAGE = """<!doctype html>
<meta charset="utf-8">
<title>harness 线程看板</title>
<style>
 body{font:14px/1.6 -apple-system,"PingFang SC",sans-serif;max-width:860px;margin:24px auto;padding:0 16px}
 .card{border:1px solid #ddd;border-radius:8px;padding:12px 16px;margin:12px 0}
 .nodes{margin:10px 0;display:flex;flex-wrap:wrap;gap:2px;align-items:center}
 .chip{cursor:pointer;border:1px solid transparent;border-radius:6px;padding:2px 8px;user-select:none}
 .chip:hover{border-color:#999}
 .n-done{color:#16a34a}
 .n-cur{color:#ca8a04;font-weight:700}
 .n-todo{color:#dc2626}
 .n-final{color:#111}
 .arrow{color:#bbb}
 .node{font-weight:600}
 .cmd{display:flex;gap:8px;align-items:center;margin-top:6px}
 .cmd code{background:#f5f5f5;border-radius:4px;padding:2px 6px;font-size:12px;overflow-x:auto;white-space:nowrap;flex:1}
 button{cursor:pointer;flex-shrink:0}
</style>
<h1>harness 线程看板</h1>
<label><input type="checkbox" id="all"> 显示已完成</label>
<div id="list"></div>
<script>
const ORDER = ['plan_gate','dev_done','cr_passed','mr_created','human_cr_done','selftest_done'];
const LABEL = {plan_gate:'计划门', dev_done:'开发', cr_passed:'机审CR', mr_created:'建MR',
               human_cr_done:'人工CR', selftest_done:'自测'};
async function setNode(ctx, target){
  await fetch('/api/set-node', {method:'POST', body: JSON.stringify({ctx_dir: ctx, target: target})});
  load();
}
function chip(text, cls, tip, onclick){
  const s = document.createElement('span');
  s.className = 'chip ' + cls; s.textContent = text; s.title = tip; s.onclick = onclick;
  return s;
}
function arrow(){
  const s = document.createElement('span');
  s.className = 'arrow'; s.textContent = '→';
  return s;
}
function renderNodes(t){
  const wrap = document.createElement('div');
  wrap.className = 'nodes';
  let cur = ORDER.indexOf(t.current);
  if (t.current === '') cur = ORDER.length;   // 全齐：停在可交付
  if (t.current === '-') cur = 0;             // 未知：按全未完成
  ORDER.forEach((n, j) => {
    let label = LABEL[n];
    if (n === 'cr_passed' && t.cr_rounds > 0) label += '(' + t.cr_rounds + '轮)';
    const next = j === ORDER.length - 1 ? 'delivered' : ORDER[j + 1];
    let cls, mark, tip, act;
    if (j < cur){
      cls = 'n-done'; mark = '● '; tip = '点击回退到「' + LABEL[n] + '」（其后完成记录将清除）';
      act = () => { if (confirm('回退到「' + LABEL[n] + '」？该节点及之后的完成记录将清除')) setNode(t.ctx_dir, n); };
    } else if (j === cur){
      cls = 'n-cur'; mark = '◉ '; tip = '点击标记「' + LABEL[n] + '」完成';
      act = () => setNode(t.ctx_dir, next);
    } else {
      cls = 'n-todo'; mark = '○ '; tip = '点击完成到「' + LABEL[n] + '」（含前序节点）';
      act = () => setNode(t.ctx_dir, next);
    }
    wrap.appendChild(chip(mark + label, cls, tip, act));
    wrap.appendChild(arrow());
  });
  const done = cur >= ORDER.length;
  wrap.appendChild(chip((done ? '● ' : '○ ') + '可交付', 'n-final',
    done ? '点击撤销可交付（自测回到未完成）' : '点击全部完成',
    done ? () => { if (confirm('撤销可交付？自测节点将回到未完成')) setNode(t.ctx_dir, 'selftest_done'); }
         : () => setNode(t.ctx_dir, 'delivered')));
  return wrap;
}
async function load(){
  const all = document.getElementById('all').checked ? '?all=1' : '';
  const rows = await (await fetch('/api/threads' + all)).json();
  const el = document.getElementById('list');
  el.innerHTML = '';
  for(const t of rows){
    const d = document.createElement('div');
    d.className = 'card';
    const h = document.createElement('div');
    const b = document.createElement('b'); b.textContent = t.title || t.branch;
    h.appendChild(b);
    d.appendChild(h);
    d.appendChild(renderNodes(t));
    if (t.resume){
      const c = document.createElement('div'); c.className = 'cmd';
      const code = document.createElement('code'); code.textContent = t.resume;
      const cp = document.createElement('button'); cp.textContent = '复制启动命令';
      cp.onclick = () => { navigator.clipboard.writeText(t.resume).then(() => {
        cp.textContent = '已复制'; setTimeout(() => { cp.textContent = '复制启动命令'; }, 1500);
      }); };
      c.appendChild(code); c.appendChild(cp);
      d.appendChild(c);
    }
    el.appendChild(d);
  }
}
document.getElementById('all').onchange = load;
load();
setInterval(load, 3000);
</script>
"""


def run_threads(*args):
    return subprocess.run(["bash", THREADS_SH, *args],
                          capture_output=True, text=True, timeout=30)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/":
            self._send(200, PAGE, "text/html; charset=utf-8")
        elif self.path.split("?")[0] == "/api/threads":
            args = ["list", "--json"]
            if "all=1" in self.path:
                args.append("--all")
            r = run_threads(*args)
            if r.returncode != 0:
                self._send(500, json.dumps({"error": r.stderr}))
            else:
                self._send(200, r.stdout)
        else:
            self._send(404, json.dumps({"error": "not found"}))

    def _post_body(self, keys):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n))
            return tuple(req[k] for k in keys)
        except (ValueError, KeyError, TypeError):
            return None

    def do_POST(self):
        if self.path == "/api/mark":
            got = self._post_body(("ctx_dir", "node"))
            if got is None:
                self._send(400, json.dumps({"error": "需要 JSON：{ctx_dir, node}"}))
                return
            ctx, node = got
            if node not in MANUAL_NODES:
                self._send(400, json.dumps({"error": "看板只允许人工节点：human_cr_done | selftest_done"}))
                return
            r = run_threads("mark", "--ctx-dir", ctx, node)
        elif self.path == "/api/set-node":
            got = self._post_body(("ctx_dir", "target"))
            if got is None:
                self._send(400, json.dumps({"error": "需要 JSON：{ctx_dir, target}"}))
                return
            ctx, target = got
            if target not in SET_TARGETS:
                self._send(400, json.dumps({"error": "target 须为六节点名或 delivered"}))
                return
            r = run_threads("set-node", "--ctx-dir", ctx, target)
        else:
            self._send(404, json.dumps({"error": "not found"}))
            return
        if r.returncode != 0:
            self._send(500, json.dumps({"error": r.stderr}))
        else:
            self._send(200, json.dumps({"ok": True, "output": r.stdout}))

    def log_message(self, *args):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=7657)
    args = ap.parse_args()
    srv = HTTPServer(("127.0.0.1", args.port), Handler)
    print(f"harness 看板: http://127.0.0.1:{args.port}  (Ctrl-C 退出)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
