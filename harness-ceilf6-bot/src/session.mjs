// claude 长驻会话进程封装：stream-json 多轮输入输出。
// 事件形状（2026-08-04 对真 CLI 冒烟钉死）：
//   init  {"type":"system","subtype":"init","session_id":"…"}
//   轮末  {"type":"result","is_error":<bool>,"result":"<本轮最终文本>","session_id":"…"}
//   注入  stdin 一行 {"type":"user","message":{"role":"user","content":"…"}}
// 超时是每轮墙钟：send() 起臂，收到 result 事件停表；等待人工回复期间无计时。
// detached 子进程自成会话组长：bot 关停时必须显式对各活跃进程组补刀，否则孤儿一个跑着的 claude。
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const activePids = new Set();
export function killActiveChildren() {
  for (const pid of activePids) {
    try { process.kill(-pid, 'SIGTERM'); } catch { /* 进程组已消失 */ }
  }
}

export function startSession({ bin, cwd, name, logPath, timeoutMs, killGraceMs, resumeSessionId, extraFlags = [], onEvent }) {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  if (resumeSessionId) args.push('--resume', resumeSessionId); // 续跑会话已有名字，--name 不再适用
  else if (name) args.push('--name', name);
  args.push(...extraFlags);
  const child = spawn(bin, args, { cwd, detached: true });
  if (child.pid) activePids.add(child.pid); // spawn 失败时 pid 为 undefined，不登记
  const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { /* 进程组已消失 */ } };
  const log = createWriteStream(logPath, { flags: 'a' });
  // 写流无监听时 ENOSPC 等写错误会以未处理 'error' 事件崩掉常驻进程。
  log.on('error', (e) => console.error(`[session] 日志写入失败：${e.message}`));
  // 子进程死亡与 close 事件之间的窗口内写 stdin，EPIPE 等是在流上异步 emit 的，
  // send() 的 try/catch 接不住；无监听同样以未处理 'error' 崩掉常驻进程。
  child.stdin.on('error', (e) => log.write(`[session] stdin 写入失败：${e.message}\n`));
  let killer = null;
  let sigkill = null;
  const disarm = () => { clearTimeout(killer); clearTimeout(sigkill); killer = sigkill = null; };
  const handle = {
    alive: true,
    sessionId: resumeSessionId ?? '',
    pid: child.pid,
    send(text) {
      try { child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'); } catch { /* 进程已死：close 事件走分发 */ }
      disarm();
      killer = setTimeout(() => {
        killGroup('SIGTERM');
        sigkill = setTimeout(() => killGroup('SIGKILL'), killGraceMs ?? 10_000);
        sigkill.unref();
        onEvent({ kind: 'timeout' });
      }, timeoutMs);
    },
    endInput() { try { child.stdin.end(); } catch { /* 已关闭 */ } },
    kill() { killGroup('SIGTERM'); },
  };
  // chunk 边界可能落在多字节 UTF-8 字符中间，直接 toString 会在两侧产生 U+FFFD；
  // StringDecoder 缓冲残字节到下一个 chunk。日志仍写原始 buffer，字节级保真。
  const decoder = new StringDecoder('utf8');
  let buf = '';
  child.stdout.on('data', (b) => {
    log.write(b);
    buf += decoder.write(b);
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let ev;
      try { ev = JSON.parse(line); } catch { continue; } // 非 JSON 行只进日志
      if (ev?.type === 'system' && ev.subtype === 'init') handle.sessionId = ev.session_id ?? handle.sessionId;
      if (ev?.type === 'result') {
        disarm();
        onEvent({ kind: 'turn', isError: !!ev.is_error, text: String(ev.result ?? ''), sessionId: handle.sessionId });
      }
    }
  });
  child.stderr.on('data', (b) => log.write(b));
  // 不挂 error 监听时 spawn 失败会以未处理 'error' 事件炸掉整个进程；挂上后 'close' 仍会触发。
  child.on('error', (e) => log.write(`[session] spawn 失败：${e.message}\n`));
  child.on('close', (code) => {
    activePids.delete(child.pid);
    handle.alive = false;
    disarm();
    log.end();
    onEvent({ kind: 'close', code });
  });
  return handle;
}
