// 单任务生命周期：worktree → claude 无人值守 → RESULT → 回应分发。
// 判断在 claude 会话里；这里只有机械动作与回应。
import { spawn, execFile } from 'node:child_process';
import { mkdirSync, readFileSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseResult } from './result.mjs';

const TPL_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'bootstrap-prompt.md');

// detached 子进程自成会话组长：launchd 与默认信号传播都够不到它，
// bot 关停时必须显式对各活跃进程组补刀，否则会孤儿一个跑着的 claude。
const activePids = new Set();
export function killActiveChildren() {
  for (const pid of activePids) {
    try { process.kill(-pid, 'SIGTERM'); } catch { /* 进程组已消失 */ }
  }
}

function git(repo, args) {
  return new Promise((res, rej) => {
    execFile('git', ['-C', repo, ...args], (err, stdout, stderr) => (err ? rej(new Error(stderr || err.message)) : res(stdout)));
  });
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function renderPrompt(task, branch, chatId) {
  return readFileSync(TPL_PATH, 'utf8')
    .replaceAll('{{BRANCH}}', branch)
    .replaceAll('{{SENDER}}', task.senderOpenId)
    .replaceAll('{{TIME}}', task.receivedAt)
    .replaceAll('{{CHAT_ID}}', chatId ?? '')
    .replaceAll('{{MESSAGE_ID}}', task.messageId)
    // 函数形式：任务原文是任意用户文本，字符串形式会把其中的 $&/$'/$` 当替换模式吃掉。
    // TASK_TEXT 必须最后替换——防任务文本中的 {{...}} 被二次展开。
    .replaceAll('{{TASK_TEXT}}', () => task.text);
}

function runClaude(config, cwd, prompt, logPath) {
  return new Promise((resolveP) => {
    // detached：claude 自成进程组，超时对整组发信号。只杀直接子进程时，其残留孙进程
    // 会握住 stdout 管道使 'close' 无限推迟，超时机制形同虚设（实测 30s vs 1s）。
    const child = spawn(config.claudeBin, ['-p', prompt, '--dangerously-skip-permissions'], { cwd, detached: true });
    if (child.pid) activePids.add(child.pid); // spawn 失败时 pid 为 undefined，不登记
    const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { /* 进程组已消失 */ } };
    const log = createWriteStream(logPath, { flags: 'a' });
    // 写流与 R2 同类：无监听时 ENOSPC 等写错误会以未处理 'error' 事件崩掉常驻进程。
    log.on('error', (e) => console.error(`[runner] 日志写入失败：${e.message}`));
    let tail = '';
    let timedOut = false;
    const onData = (buf) => {
      log.write(buf);
      tail = (tail + buf.toString()).slice(-1_000_000); // 只留末尾 1MB，RESULT 在最后
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (b) => log.write(b));
    let sigkill;
    const killer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      sigkill = setTimeout(() => killGroup('SIGKILL'), config.killGraceMs ?? 10_000);
      sigkill.unref();
    }, config.taskTimeoutMs);
    // 不挂 error 监听时 spawn 失败（如 claudeBin 缺失）会以未处理 'error' 事件炸掉整个进程；
    // 挂上后 'close' 仍会触发（实测），走 tail 为空 → 无 RESULT → fail 的正常分发。
    child.on('error', (e) => log.write(`[runner] spawn 失败：${e.message}\n`));
    child.on('close', () => {
      activePids.delete(child.pid);
      clearTimeout(killer);
      clearTimeout(sigkill);
      log.end();
      resolveP({ tail, timedOut });
    });
  });
}

async function retrying(label, fn) {
  for (let i = 0; i < 3; i++) {
    try { await fn(); return true; } catch (e) {
      if (i === 2) { console.error(`[runner] ${label}（留人工）：${e.message}`); return false; }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}

// 两步各自重试而非整体重试：remove 成功、branch -D 失败时，整体重试会把 remove 重跑在
// 已删路径上并必然再失败，于是分支永远删不掉。已成功的步骤不得重跑。
async function cleanupWorktree(config, worktree, branch) {
  const removed = await retrying('worktree 清理失败', () => git(config.repoPath, ['worktree', 'remove', '--force', worktree]));
  const deleted = await retrying('分支删除失败', () => git(config.repoPath, ['branch', '-D', branch]));
  return removed && deleted;
}

export async function runTask(task, config, lark) {
  mkdirSync(config.worktreesDir, { recursive: true });
  mkdirSync(config.logsDir, { recursive: true });
  const base = `bot/${stamp(new Date(task.receivedAt || Date.now()))}-${task.messageId.slice(-6)}`;
  let branch = base;
  let worktree = join(config.worktreesDir, branch.replaceAll('/', '__'));
  try {
    await git(config.repoPath, ['worktree', 'add', worktree, '-b', branch]);
  } catch (firstErr) {
    branch = `${base}-2`; // 同名冲突追加序号重试一次
    worktree = join(config.worktreesDir, branch.replaceAll('/', '__'));
    try {
      await git(config.repoPath, ['worktree', 'add', worktree, '-b', branch]);
    } catch {
      // 这里抛出去等于静默丢单：listener 的 pump 只会 catch 成一行 stderr，而 message_id
      // 在入队时就已 markProcessed，群里既无 ❌ 也无私信、且永不重试。走 fail 通道让它可见。
      // 首次错误才是根因（第二次多半只是「路径已存在」的派生噪声）。
      await lark.addReaction(task.messageId, config.reactions.failed);
      await lark.sendDm(config.dmOpenId,
        `❌ 任务未启动：worktree 创建失败（尚未运行，无任务日志）\nmessage_id：${task.messageId}\n仓库：${config.repoPath}\n首次错误：${firstErr.message}`);
      return { verdict: 'fail', branch, worktree, logPath: '' };
    }
  }
  const logPath = join(config.logsDir, `task-${task.messageId}.log`);
  const claimedRid = await lark.addReaction(task.messageId, config.reactions.claimed);

  const { tail, timedOut } = await runClaude(config, worktree, renderPrompt(task, branch, config.chatId), logPath);
  const result = parseResult(tail);
  const verdict = timedOut ? 'fail' : (result?.verdict ?? 'fail');

  if (verdict === 'skip') {
    await cleanupWorktree(config, worktree, branch);
    if (claimedRid) await lark.deleteReaction(task.messageId, claimedRid);
  } else if (verdict === 'escalate') {
    await lark.addReaction(task.messageId, config.reactions.escalate);
    const text = `该任务需要人工规划，请用命令 \`cd ${worktree} && claude "载入 /harness-context 上下文，走计划门完整路径"\` 进行 spec。`;
    await lark.replyInThread(task.messageId, text);
    await lark.sendDm(config.dmOpenId, text);
  } else if (verdict === 'pass') {
    await lark.addReaction(task.messageId, config.reactions.done);
    await lark.sendDm(config.dmOpenId,
      `✅ 任务完成\nMR：${result?.mr_url || '（RESULT 未带链接）'}\n分支：${branch}\n摘要：${result?.summary || ''}`);
  } else {
    await lark.addReaction(task.messageId, config.reactions.failed);
    const why = timedOut ? '超时强杀' : (result ? `verdict=${verdict}` : '无有效 RESULT 行');
    await lark.sendDm(config.dmOpenId,
      `❌ 任务未完成（${why}）\nworktree：${worktree}\n日志：${logPath}\nreason：${result?.reason || ''}`);
  }
  return { verdict, branch, worktree, logPath };
}
