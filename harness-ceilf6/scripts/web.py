#!/usr/bin/env python3
"""harness 线程本地看板（ht web 启动）。

薄壳原则：读走 threads.sh list --json、写走 threads.sh mark，本文件不碰
threads.jsonl / meta.json——单点写入约束由 threads.sh 保证。
仅绑 127.0.0.1，无鉴权；mark 只放行人工节点，自动节点属流程写入。
"""
import argparse
import json
import os
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer

THREADS_SH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "threads.sh")
MANUAL_NODES = ("human_cr_done", "selftest_done")

PAGE = """<!doctype html>
<meta charset="utf-8">
<title>harness 线程看板</title>
<style>
 body{font:14px/1.6 -apple-system,"PingFang SC",sans-serif;max-width:760px;margin:24px auto;padding:0 16px}
 .card{border:1px solid #ddd;border-radius:8px;padding:12px 16px;margin:12px 0}
 .prog{font-family:ui-monospace,Menlo,monospace;white-space:pre-wrap;margin:8px 0}
 .node{font-weight:600}
 button{margin-right:8px}
</style>
<h1>harness 线程看板</h1>
<label><input type="checkbox" id="all"> 显示已完成</label>
<div id="list"></div>
<script>
async function mark(ctx, node){
  await fetch('/api/mark', {method:'POST', body: JSON.stringify({ctx_dir: ctx, node: node})});
  load();
}
async function load(){
  const all = document.getElementById('all').checked ? '?all=1' : '';
  const rows = await (await fetch('/api/threads' + all)).json();
  const el = document.getElementById('list');
  el.innerHTML = '';
  for(const t of rows){
    const d = document.createElement('div');
    d.className = 'card';
    d.innerHTML = '<div><b></b> [' + t.status + '] <span class="node">' + t.node + '</span></div>'
      + '<div class="prog">' + (t.progress || '（无里程碑数据）') + '</div>';
    d.querySelector('b').textContent = t.title || t.branch;
    if(t.milestones.mr_created && !t.milestones.human_cr_done){
      const b = document.createElement('button');
      b.textContent = '人工CR 完成'; b.onclick = () => mark(t.ctx_dir, 'human_cr_done');
      d.appendChild(b);
    }
    if(t.milestones.mr_created && !t.milestones.selftest_done){
      const b = document.createElement('button');
      b.textContent = '自测完成'; b.onclick = () => mark(t.ctx_dir, 'selftest_done');
      d.appendChild(b);
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

    def do_POST(self):
        if self.path != "/api/mark":
            self._send(404, json.dumps({"error": "not found"}))
            return
        n = int(self.headers.get("Content-Length") or 0)
        try:
            req = json.loads(self.rfile.read(n))
            ctx, node = req["ctx_dir"], req["node"]
        except (ValueError, KeyError):
            self._send(400, json.dumps({"error": "需要 JSON：{ctx_dir, node}"}))
            return
        if node not in MANUAL_NODES:
            self._send(400, json.dumps({"error": "看板只允许人工节点：human_cr_done | selftest_done"}))
            return
        r = run_threads("mark", "--ctx-dir", ctx, node)
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
