#!/usr/bin/env python3
"""harness 线程本地看板（ht web 启动）。

薄壳原则：读走 threads.sh list --json、写走 threads.sh mark / set-node /
archive / clean，本文件不碰 threads.jsonl / meta.json——单点写入约束由
threads.sh 保证。写一律用 --ctx-dir 直指：序号与关键词定位只认默认视图，
已归档的线程按那两种方式再也找不回来。
仅绑 127.0.0.1，无鉴权；/api/mark 只放行人工节点，/api/set-node 是看板手控的
绝对定位入口（推进/回退，目标校验仍在 threads.sh）。
运行态与停止不经 threads.sh：转调 bot 控制端口，bot 不在时看板照常渲染静态进度。
"""
import argparse
import json
import os
import subprocess
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

THREADS_SH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "threads.sh")
MANUAL_NODES = ("human_cr_done", "selftest_done")
SET_TARGETS = ("plan_gate", "dev_done", "cr_passed", "mr_created",
               "human_cr_done", "selftest_done", "delivered")

# bot 控制端口：看板的停止按钮转调它。bot 未运行时看板只是少了运行态信息，不是错误。
BOT_CONTROL = os.environ.get("HARNESS_BOT_CONTROL", "http://127.0.0.1:7659")


def bot_request(path, payload=None, timeout=5):
    """转调 bot 控制端口，返回 (状态码, 响应体)。

    控制端口按 req.url 全等匹配路由，path 不能带 query 或尾斜杠。
    非 2xx（如「没有这个任务」的 404）是有效答复，一并返回交调用方判读；
    只有拒连 / 超时 / 响应非 JSON 才抛。
    """
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        BOT_CONTROL.rstrip("/") + path, data=data,
        method="POST" if data is not None else "GET",
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8") or "{}")


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
 .badge{margin-left:8px;font-size:12px;border-radius:10px;padding:1px 8px;background:#eef;color:#334}
 .badge.run{background:#dcfce7;color:#166534}
 .acts{display:flex;gap:8px;margin-top:8px}
</style>
<h1>harness 线程看板</h1>
<label><input type="checkbox" id="all"> 显示已完成/已归档</label>
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
// 状态字面量与 bot 的在册视图（harness-ceilf6-bot/src/listener.mjs 的 STATE_LABEL）同一套，
// 改动须两边同步；漏一个状态徽标就渲染成裸英文。
const RUN_LABEL = {active:'运行中', waiting:'等回复', background:'后台运行中', stranded:'已滞留', starting:'启动中', queued:'排队中'};
let RUN = {tasks: [], offline: true};
async function loadRunning(){
  try { RUN = await (await fetch('/api/running')).json(); }
  catch(e){ RUN = {tasks: [], offline: true}; }
}
function runningOf(t){ return (RUN.tasks || []).find(x => x.worktree && x.worktree === t.cwd); }
async function post(path, body){
  const r = await fetch(path, {method:'POST', body: JSON.stringify(body)});
  const out = await r.json().catch(() => ({}));
  if (!r.ok) alert(out.error || '操作失败');
  load();
}
function actions(t){
  const wrap = document.createElement('div');
  wrap.className = 'acts';
  const r = runningOf(t);
  const stop = document.createElement('button');
  stop.textContent = '停止';
  if (r){
    stop.onclick = () => { if (confirm('停止「' + (t.title || t.branch) + '」？现场保留，可手工续跑')) post('/api/stop', {cwd: t.cwd}); };
  } else {
    stop.disabled = true;
    stop.title = RUN.offline ? 'bot 未运行' : '该线程当前没有在跑的任务';
  }
  wrap.appendChild(stop);
  const arch = document.createElement('button');
  arch.textContent = t.archived ? '取消归档' : '归档';
  arch.onclick = () => post('/api/archive', {ctx_dir: t.ctx_dir, archived: !t.archived});
  wrap.appendChild(arch);
  const clean = document.createElement('button');
  clean.textContent = '清理';
  if (r){
    // 清理是对着整棵工作树 rm -rf。任务还在里面跑时按下去 = 无人值守 claude 未提交的工作全没，
    // 且两道 confirm 只讲删除范围、讲不出「现在有人在用」——所以这里直接不给按。
    clean.disabled = true;
    clean.title = '有任务正在这棵工作树里跑，请先停止该任务';
  } else {
    clean.onclick = () => {
      if (!confirm('清理「' + (t.title || t.branch) + '」？将删除 worktree 目录与分支，不可撤销')) return;
      // 登记的 cwd 可能落在工作树的子目录里，而 threads.sh 删的是整棵工作树：
      // 措辞不敢宣称精确路径，否则这道闸给的是比实际删除范围更窄的承诺
      if (!confirm('再确认一次：删除 ' + t.cwd + ' 所在的整棵工作树，以及分支 ' + t.branch)) return;
      post('/api/clean', {ctx_dir: t.ctx_dir});
    };
  }
  wrap.appendChild(clean);
  return wrap;
}
async function load(){
  await loadRunning();
  const all = document.getElementById('all').checked ? '?all=1' : '';
  let rows;
  // 取不到列表就留着上一次的渲染：轮询会自己接上，清空反而只剩白屏。
  // 后端出错时回的是 {error} 这种合法 JSON，故解析成功也要认一次数组。
  try { rows = await (await fetch('/api/threads' + all)).json(); }
  catch(e){ return; }
  if (!Array.isArray(rows)) return;
  const el = document.getElementById('list');
  el.innerHTML = '';
  for(const t of rows){
    const d = document.createElement('div');
    d.className = 'card';
    const h = document.createElement('div');
    const b = document.createElement('b'); b.textContent = t.title || t.branch;
    h.appendChild(b);
    const r = runningOf(t);
    if (r){
      const badge = document.createElement('span');
      badge.className = 'badge run';
      badge.textContent = RUN_LABEL[r.state] || r.state;
      h.appendChild(badge);
    }
    if (t.archived){
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '已归档';
      h.appendChild(badge);
    }
    d.appendChild(h);
    d.appendChild(renderNodes(t));
    d.appendChild(actions(t));
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
        elif self.path == "/api/running":
            # 取不到运行态是「没有这条信息」而非错误：看板照常渲染静态节点进度
            try:
                code, out = bot_request("/api/tasks")
            except Exception:
                code, out = 0, None
            if code == 200 and isinstance(out, dict) and isinstance(out.get("tasks"), list):
                self._send(200, json.dumps(out))
            else:
                self._send(200, json.dumps({"tasks": [], "offline": True}))
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
        elif self.path == "/api/stop":
            got = self._post_body(("cwd",))
            if got is None:
                self._send(400, json.dumps({"error": "需要 JSON：{cwd}"}))
                return
            (cwd,) = got
            # 空选择子发到 bot 会退回「在册只有一个就停它」，把定向停止变成停别人
            if not isinstance(cwd, str) or not cwd.strip():
                self._send(400, json.dumps({"error": "cwd 须为非空路径"}))
                return
            try:
                _, out = bot_request("/api/stop", {"worktree": cwd})
            except Exception as e:
                self._send(503, json.dumps({"error": f"bot 控制端口不可达：{e}"}))
                return
            ok = isinstance(out, dict) and out.get("ok")
            self._send(200 if ok else 400, json.dumps(out))
            return
        elif self.path == "/api/archive":
            got = self._post_body(("ctx_dir", "archived"))
            if got is None:
                self._send(400, json.dumps({"error": "需要 JSON：{ctx_dir, archived}"}))
                return
            ctx, archived = got
            r = run_threads("archive" if archived else "unarchive", "--ctx-dir", ctx)
        elif self.path == "/api/clean":
            got = self._post_body(("ctx_dir",))
            if got is None:
                self._send(400, json.dumps({"error": "需要 JSON：{ctx_dir}"}))
                return
            (ctx,) = got
            r = run_threads("clean", "--ctx-dir", ctx)
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
