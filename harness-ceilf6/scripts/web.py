#!/usr/bin/env python3
"""harness 线程本地看板（ht web 启动）。

薄壳原则：读走 threads.sh list --json、写走 threads.sh mark / set-node /
archive / clean，本文件不碰 threads.jsonl / meta.json——单点写入约束由
threads.sh 保证。写一律用 --ctx-dir 直指：序号与关键词定位只认默认视图，
已归档的线程按那两种方式再也找不回来。
仅绑 127.0.0.1，无鉴权；/api/mark 只放行人工节点，/api/set-node 是看板手控的
绝对定位入口（推进/回退，目标校验仍在 threads.sh）。
看板页本体在 board/index.html（本地/对外共用单文件），本文件只注入 local 模式配置后返回。
拉群求CR 与 WIP 走 cr-group.sh：bytedcli / lark-cli 一律不在本文件直调。
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
BOARD_HTML = os.path.join(os.path.dirname(os.path.abspath(__file__)), "board", "index.html")
CR_GROUP_SH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cr-group.sh")
MANUAL_NODES = ("human_cr_done", "selftest_done")
SET_TARGETS = ("plan_gate", "dev_done", "cr_passed", "mr_created",
               "human_cr_done", "selftest_done", "cr_group_created", "done")

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


def board_page():
    with open(BOARD_HTML, encoding="utf-8") as f:
        html = f.read()
    return html.replace("<!--BOARD_CONFIG-->",
                        '<script>window.BOARD = {"mode": "local"}</script>')


def run_threads(*args):
    return subprocess.run(["bash", THREADS_SH, *args],
                          capture_output=True, text=True, timeout=30)


def run_cr_group(*args, timeout=120):
    return subprocess.run(["bash", CR_GROUP_SH, *args],
                          capture_output=True, text=True, timeout=timeout)


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
            self._send(200, board_page(), "text/html; charset=utf-8")
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
                self._send(400, json.dumps({"error": "target 须为七节点名或 done"}))
                return
            r = run_threads("set-node", "--ctx-dir", ctx, target)
            # 返工自动挂 WIP：方向标记是 threads.sh 的契约输出。wip 失败不改变节点写入结果，
            # 只以 warning 提示——MR 可能已合入（此时挂 WIP 本就该失败）。
            if r.returncode == 0 and "方向：回退" in r.stdout:
                w = run_cr_group("wip", "--ctx-dir", ctx, timeout=60)
                if w.returncode != 0 and "跳过 WIP" not in (w.stdout or ""):
                    self._send(200, json.dumps({
                        "ok": True, "output": r.stdout,
                        "warning": "节点已回退，但 WIP 标记失败：" + (w.stderr or w.stdout).strip()}))
                    return
        elif self.path == "/api/undone":
            got = self._post_body(("ctx_dir",))
            if got is None:
                self._send(400, json.dumps({"error": "需要 JSON：{ctx_dir}"}))
                return
            (ctx,) = got
            r = run_threads("undone", "--ctx-dir", ctx)
        elif self.path == "/api/cr-group":
            got = self._post_body(("ctx_dir",))
            if got is None:
                self._send(400, json.dumps({"error": "需要 JSON：{ctx_dir}"}))
                return
            (ctx,) = got
            r = run_cr_group("request", "--ctx-dir", ctx)
            if r.returncode == 3:
                self._send(400, json.dumps({"error": "无 MR，未拉群"}))
            elif r.returncode != 0:
                self._send(500, json.dumps({"error": (r.stderr or r.stdout).strip()}))
            else:
                # 拉群是分级容错的：建群/拉人/发消息任一失败都只在 stderr 告警并继续，
                # 退出码仍是 0。不带上 stderr 前端就不 alert，节点照绿，半成功被当成成功。
                out = {"ok": True, "output": r.stdout}
                if r.stderr.strip():
                    out["warning"] = r.stderr.strip()
                self._send(200, json.dumps(out))
            return
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
