// 滞留任务发现：活跃轮次中被重启收割的任务，重启后在控制面三个来源里都不存在——
// 活表随进程清空、它从没 ask 过所以没有 awaiting 条目、队列早已出队。于是它既看不见也停不掉，
// 群里那枚接单表情永远挂着。启动时扫一遍线程登记把它们捞回来。
import { existsSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { parseResult } from './result.mjs';

// 终态判据只认这几个：ask / working 是中间态，它们的任务若还活着必有 awaiting 条目，
// 没有条目就说明进程已死、无人接管——正是要捞的形态。
const TERMINAL = new Set(['pass', 'fail', 'skip', 'stopped', 'escalate', 'fused']);
// 任务日志可达数 MB（headless claude 全量输出），只读末尾：RESULT 在最后。
const TAIL_BYTES = 256 * 1024;

function readTail(path, bytes = TAIL_BYTES) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

// 返回 {lastVerdict, sessionId}：日志是 stream-json，RESULT 行在 result 事件的 result 字段里，
// session_id 挂在每个事件上。窗口起点多半切在半行中间，坏行跳过即可。
function readLogTail(path) {
  let lastVerdict = null;
  let sessionId = '';
  for (const line of readTail(path).split('\n')) {
    if (!line.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.session_id) sessionId = ev.session_id;
    if (ev.type === 'result' && !ev.is_error) {
      const r = parseResult(String(ev.result ?? ''));
      if (r) lastVerdict = r.verdict;
    }
  }
  return { lastVerdict, sessionId };
}

// threads：线程登记表里的 info 数组（含 messageId / branch / worktree / threadId）。
// deps.isSettled 是终态记账（人工 /stop 与正常终态都会记），避免把已经处置过的任务复活。
export function scanStranded(threads, { logsDir, isSettled, findAwaiting }) {
  const out = [];
  for (const t of threads) {
    if (!t?.messageId || !t.worktree) continue;
    if (isSettled(t.messageId) || findAwaiting(t.messageId)) continue;
    if (!existsSync(t.worktree)) continue; // 现场已清，无从续跑
    const logPath = join(logsDir, `task-${t.messageId}.log`);
    if (!existsSync(logPath)) continue; // 会话从没起来，没有可 --resume 的历史
    let tail;
    try { tail = readLogTail(logPath); } catch { continue; }
    if (tail.lastVerdict && TERMINAL.has(tail.lastVerdict)) continue;
    out.push({
      messageId: t.messageId, threadId: t.threadId ?? '', branch: t.branch ?? '',
      worktree: t.worktree, sessionId: tail.sessionId, logPath,
    });
  }
  return out;
}
