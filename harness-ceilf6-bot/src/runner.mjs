// 单任务生命周期：worktree → claude 无人值守 → RESULT → 回应分发。
// 判断在 claude 会话里；这里只有机械动作与回应。
import { spawn, execFile } from 'node:child_process';
import { mkdirSync, readFileSync, createWriteStream, rmSync } from 'node:fs';
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

// 不用 `git worktree remove --force`：它要遍历校验整棵工作树，在 byteview-web 这类巨型 monorepo 上
// 实测耗时数分钟，而 skip 是最常见路径——串行队列被它占死、终态表情迟迟不落地。`--force` 本已放弃
// 那些保护，语义上无损失，于是拆成「删目录 + prune 注册表 + 删分支」三步，各自秒级。
// prune 必须在 branch -D 之前：注册表还挂着该 worktree 时 git 认为分支仍被检出，拒绝删除。
// 三步各自有界重试而非整体重试：已成功的步骤重跑必然再失败（rm 落在已删路径、branch -D 落在已删分支），
// 整体重试会让后一步永远做不成。
async function cleanupWorktree(config, worktree, branch) {
  // maxRetries 必需：本机 AI-IDE daemon 会异步往新仓写 .git/ai/，撞上时 rmSync 抛 ENOTEMPTY。
  const removed = await retrying('worktree 目录删除失败', async () => rmSync(worktree, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }));
  const pruned = await retrying('worktree 注册表 prune 失败', () => git(config.repoPath, ['worktree', 'prune']));
  const deleted = await retrying('分支删除失败', () => git(config.repoPath, ['branch', '-D', branch]));
  return removed && pruned && deleted;
}

// 状态表情不变量（2026-07-30 用户裁定）：一条被处理的消息上，本 bot 的状态表情恒为恰好一个。
// 故顺序是「先打终态、再撤接单」——反过来会出现零表情窗口，而群里「没表情」等于「bot 没看见」，
// 是比短暂两个表情更坏的误读。claimedRid 为 null（接单调用失败）时只打终态，不当错误处理。
async function settleReaction(lark, messageId, terminalKey, claimedRid) {
  await lark.addReaction(messageId, terminalKey);
  if (claimedRid) await lark.deleteReaction(messageId, claimedRid);
}

export async function runTask(task, config, lark, hooks = {}) {
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
  // 现场一就绪就通告，早于任何飞书往返：话题内回复要能立刻找到归属任务的 worktree，
  // 而 addReaction 最坏要等两次 30s 超时，这段窗口内到达的回复会被判成新任务。
  try {
    hooks.onWorktreeReady?.({ threadId: task.threadId ?? '', branch, worktree, messageId: task.messageId });
  } catch (e) {
    // 登记只决定「后续回复能否并入上下文」，不该连带丢掉已经建好现场的任务。
    console.error(`[runner] onWorktreeReady 回调失败：${e.message}`);
  }
  const logPath = join(config.logsDir, `task-${task.messageId}.log`);
  const claimedRid = await lark.addReaction(task.messageId, config.reactions.claimed);

  const { tail, timedOut } = await runClaude(config, worktree, renderPrompt(task, branch, config.chatId), logPath);
  const result = parseResult(tail);
  const verdict = timedOut ? 'fail' : (result?.verdict ?? 'fail');

  if (verdict === 'skip') {
    await cleanupWorktree(config, worktree, branch);
    await settleReaction(lark, task.messageId, config.reactions.skipped, claimedRid);
  } else if (verdict === 'escalate') {
    await settleReaction(lark, task.messageId, config.reactions.escalate, claimedRid);
    const text = `该任务需要人工规划，请用命令 \`cd ${worktree} && claude "载入 /harness-context 上下文，走计划门完整路径"\` 进行 spec。`;
    await lark.replyInThread(task.messageId, text);
    await lark.sendDm(config.dmOpenId, text);
  } else if (verdict === 'pass') {
    await settleReaction(lark, task.messageId, config.reactions.done, claimedRid);
    await lark.sendDm(config.dmOpenId,
      `✅ 任务完成\nMR：${result?.mr_url || '（RESULT 未带链接）'}\n分支：${branch}\n摘要：${result?.summary || ''}`);
  } else {
    await settleReaction(lark, task.messageId, config.reactions.failed, claimedRid);
    const why = timedOut ? '超时强杀' : (result ? `verdict=${verdict}` : '无有效 RESULT 行');
    await lark.sendDm(config.dmOpenId,
      `❌ 任务未完成（${why}）\nworktree：${worktree}\n日志：${logPath}\nreason：${result?.reason || ''}`);
  }
  return { verdict, branch, worktree, logPath };
}
