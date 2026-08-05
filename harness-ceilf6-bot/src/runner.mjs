// 任务生命周期：worktree → 长驻 claude 会话（stream-json 多轮）→ 每轮 RESULT 分发。
// 判断在 claude 会话里；这里只有机械动作与回应。进程组收割纪律在 session.mjs。
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseResult } from './result.mjs';
import { startSession, killActiveChildren } from './session.mjs';

export { killActiveChildren };

const TPL_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'bootstrap-prompt.md');

// messageId → 运行时。挂起（等私信回复）的会话也在此登记，injectReply/killSession 按它寻址。
const liveTasks = new Map();

const REPLY_FRAME = (text) => `用户对上一轮问题的私信回复如下（原文）：\n${text}\n——继续按无人值守契约执行，本轮结束仍以 RESULT 行收尾；后续拿不准的点用 verdict=ask + question 收轮提问（不要用 escalate/fused），等自己布的后台工作用 verdict=working。若上一轮的后台工作已被中断（如 cr/round-N/ 有 instructions 却无 verdict.json、后台进程已不在），先重跑该轮再继续。`;
const CORRECTION_MSG = '上一轮输出未以 RESULT 行收尾，违反无人值守契约。立即单独补发一行结果行（RESULT + 单行 JSON），不要其他内容。';

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

// 会话名 = 任务首行按 code point 截 20（slice 字节截断会撕裂 CJK/emoji）：
// /resume 列表可辨识即可；子会话过计划门后会用 custom-title 覆盖成需求短题。
function sessionName(text) {
  return [...(text.split('\n')[0] ?? '')].slice(0, 20).join('') || 'harness 任务';
}

function truncate(s, n = 300) {
  const cs = [...String(s ?? '')];
  return cs.length > n ? cs.slice(0, n).join('') + '…' : cs.join('');
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
// 三步各自有界重试而非整体重试：已成功的步骤重跑必然再失败，整体重试会让后一步永远做不成。
async function cleanupWorktree(config, worktree, branch) {
  // maxRetries 必需：本机 AI-IDE daemon 会异步往新仓写 .git/ai/，撞上时 rmSync 抛 ENOTEMPTY。
  const removed = await retrying('worktree 目录删除失败', async () => rmSync(worktree, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }));
  const pruned = await retrying('worktree 注册表 prune 失败', () => git(config.repoPath, ['worktree', 'prune']));
  const deleted = await retrying('分支删除失败', () => git(config.repoPath, ['branch', '-D', branch]));
  return removed && pruned && deleted;
}

// 状态表情不变量（2026-07-30 用户裁定）：一条被处理的消息上，本 bot 的状态表情恒为恰好一个。
// 故顺序是「先打新、再撤旧」——反过来会出现零表情窗口，而群里「没表情」等于「bot 没看见」。
// currentRid 为 null（前一动作失败）时只打新表情，不当错误处理。
async function swapReaction(lark, messageId, newKey, currentRid) {
  const rid = await lark.addReaction(messageId, newKey);
  if (currentRid) await lark.deleteReaction(messageId, currentRid);
  return rid;
}

// progress 是 RESULT 的 summary：question 常写得贫瘠（会话把上下文都放 summary），
// 只发 question 会让用户拿不到决策依据。
function askDmText(rt, question, progress) {
  const progressLine = progress ? `\n进展：${progress}` : '';
  return `⏳ ${rt.title} 需要你拍板\n问题：${question}${progressLine}\n分支：${rt.branch}\nworktree：${rt.worktree}\n直接回复本消息即可续跑；多任务在等时请引用本条回复。`;
}

// kind='background'：会话在等自己布的后台工作（钩子、机审 CR），不是在等人——
// 不发私信、不换表情（群里保持接单态：它确实还在干活）。登记照落：后台工作随 bot 重启
// 一并被杀时，自唤醒信号永不到来，这条登记是回复「继续」能把它捞回来的唯一凭据。
async function goWaiting(rt, question, progress, kind = 'user') {
  rt.state = kind === 'background' ? 'background' : 'waiting';
  rt.correctionUsed = false;
  let qMsgId = '';
  if (kind !== 'background') {
    qMsgId = await rt.lark.sendDm(rt.config.dmOpenId, askDmText(rt, question, progress));
    rt.statusRid = await swapReaction(rt.lark, rt.task.messageId, rt.config.reactions.escalate, rt.statusRid);
  }
  try {
    rt.hooks.onAsk?.({
      messageId: rt.task.messageId, threadId: rt.task.threadId ?? '', branch: rt.branch,
      worktree: rt.worktree, sessionId: rt.sessionId, question,
      questionMsgId: qMsgId || '', statusRid: rt.statusRid, title: rt.title, kind,
    });
  } catch (e) {
    // 登记只决定「回复能否路由回来」，不该连带杀掉活着的会话。
    console.error(`[runner] onAsk 回调失败：${e.message}`);
  }
}

async function settle(rt, verdict, { why, result } = {}) {
  if (rt.settled) return;
  rt.settled = true;
  // 只删指向自己的登记：懒续跑可能已用新运行时覆盖同 key，误删会让后续回复重复起会话。
  if (liveTasks.get(rt.task.messageId) === rt) liveTasks.delete(rt.task.messageId);
  // stopped 是人工叫停：必须立刻断掉进程组，不能等它把当前轮跑完。
  if (verdict === 'stopped') rt.session?.kill(); else rt.session?.endInput();
  const { config, lark, task } = rt;
  if (verdict === 'skip') {
    await cleanupWorktree(config, rt.worktree, rt.branch);
    rt.statusRid = await swapReaction(lark, task.messageId, config.reactions.skipped, rt.statusRid);
  } else if (verdict === 'stopped') {
    rt.statusRid = await swapReaction(lark, task.messageId, config.reactions.stopped, rt.statusRid);
    const takeover = rt.sessionId
      ? `cd ${rt.worktree} && claude --resume ${rt.sessionId}`
      : `cd ${rt.worktree} && claude`;
    await lark.sendDm(config.dmOpenId,
      `🛑 任务已停止（${why}）\n${rt.title}\n分支：${rt.branch}\nworktree：${rt.worktree}\n如需接管：${takeover}`);
  } else if (verdict === 'pass') {
    rt.statusRid = await swapReaction(lark, task.messageId, config.reactions.done, rt.statusRid);
    await lark.sendDm(config.dmOpenId,
      `✅ 任务完成\nMR：${result?.mr_url || '（RESULT 未带链接）'}\n分支：${rt.branch}\n摘要：${result?.summary || ''}`);
  } else {
    rt.statusRid = await swapReaction(lark, task.messageId, config.reactions.failed, rt.statusRid);
    await lark.sendDm(config.dmOpenId,
      `❌ 任务未完成（${why}）\nworktree：${rt.worktree}\n日志：${rt.logPath}\nreason：${result?.reason || ''}`);
  }
  rt.finish({ verdict, branch: rt.branch, worktree: rt.worktree, logPath: rt.logPath });
}

// 挂起中的会话进程退出（被收割 / 崩溃 / OOM / 被外部 kill）：任务不终态——等待态留给懒续跑
// 接管——只移出活表并通告调用方。通告是必需的：此刻没有任何进程在烧 CPU，而 startTurnLoop 的
// promise 在这条分支永不 resolve，调用方若把 concurrency 记账绑在它的生命周期上，槽位就随进程
// 死亡永久泄漏。槽位记账跟的是「有没有进程在烧 CPU」，不是 promise 的生命周期。
function suspendClose(rt) {
  // 只删指向自己的登记：懒续跑可能已抢先用新运行时覆盖同 key。
  if (liveTasks.get(rt.task.messageId) === rt) liveTasks.delete(rt.task.messageId);
  try {
    rt.hooks?.onSuspendClose?.({ messageId: rt.task.messageId });
  } catch (e) {
    console.error(`[runner] onSuspendClose 回调失败：${e.message}`);
  }
}

async function handleEvent(rt, ev) {
  if (rt.settled) return;
  // 控制面动作期间到达的事件不得再驱动状态机：pause 的「补挂起态 → 杀进程」之间若放行
  // 一个带 RESULT 的 turn，会把刚建立的等待态又推回活跃。close 仍走挂起收尾。
  if (rt.stopping) {
    if (ev.kind === 'close') suspendClose(rt);
    return;
  }
  if (ev.kind === 'timeout') return settle(rt, 'fail', { why: '超时强杀' });
  if (ev.kind === 'close') {
    if (rt.state === 'waiting' || rt.state === 'background') return suspendClose(rt);
    return settle(rt, 'fail', { why: '会话进程退出且无有效 RESULT 行' });
  }
  // 挂起中会话可自唤醒：它自己布的后台任务（pre-commit 钩子、机审 CR）完成通知会触发新轮次，
  // 带有效 RESULT 的轮是真实续跑，必须照常分发——吞掉会让最终 ✅ 永远到不了用户。
  // 无有效 RESULT / API 错误的 turn 仍按杂音忽略：纠偏与终态化在等人拍板时误动状态。
  if (rt.state === 'waiting' || rt.state === 'background') {
    if (ev.isError || !parseResult(ev.text)) {
      console.error(`[runner] 挂起中收到无有效 RESULT 的 turn 事件，忽略：${truncate(ev.text, 120)}`);
      return;
    }
    rt.state = 'active';
  }
  if (ev.sessionId) rt.sessionId = ev.sessionId;
  if (ev.isError) {
    return goWaiting(rt, `本轮以 API 错误收场：${truncate(ev.text)}\n（回复任意内容即重试；可先用 /model <名> 或 /effort <级> 调整后再回复）`);
  }
  const result = parseResult(ev.text);
  if (!result) {
    if (rt.correctionUsed) return settle(rt, 'fail', { why: '连续两轮无有效 RESULT 行' });
    rt.correctionUsed = true;
    return rt.session.send(CORRECTION_MSG);
  }
  rt.correctionUsed = false;
  if (result.verdict === 'ask') {
    return goWaiting(rt, result.question || result.reason || '（会话未给出具体问题，请回复指示）', result.summary || '');
  }
  // working：会话在等自己布的后台工作，不需要人。进展写进登记的 question 供 /tasks 与懒续跑读取。
  if (result.verdict === 'working') {
    return goWaiting(rt, result.summary || result.reason || '（会话未给出进展）', '', 'background');
  }
  // 旧会话（ask 契约之前启动、经懒续跑续起的）仍会产出 escalate/fused：一律映射为挂起等回复——
  // 终态化会把 RESULT 里的真实阻塞原因丢成固定文案，用户无从作答；接管命令保留在问题文本里作逃生口。
  if (result.verdict === 'escalate' || result.verdict === 'fused') {
    const why = result.question || result.reason || result.summary || '（旧会话未给出原因）';
    return goWaiting(rt, `${why}\n（旧契约 ${result.verdict}；如需人工接管：cd ${rt.worktree} && claude "载入 /harness-context 上下文，走计划门完整路径"）`,
      result.summary && result.summary !== why ? result.summary : '');
  }
  return settle(rt, result.verdict, { why: `verdict=${result.verdict}`, result });
}

function startTurnLoop(init) {
  const rt = { ...init, state: 'active', settled: false, stopping: false, correctionUsed: false, session: null, startedAt: new Date().toISOString() };
  liveTasks.set(rt.task.messageId, rt);
  // 登记完成即离开启动窗口：调用方的在册视图据此把「启动中」交棒给活表实态，
  // 两边同时列出会让同一个任务在 /tasks 里出现两行。
  try {
    init.hooks?.onLive?.({ messageId: rt.task.messageId });
  } catch (e) {
    console.error(`[runner] onLive 回调失败：${e.message}`);
  }
  const done = new Promise((res) => { rt.finish = res; });
  rt.session = startSession({
    bin: rt.config.claudeBin, cwd: rt.worktree, name: rt.title, logPath: rt.logPath,
    timeoutMs: rt.config.taskTimeoutMs, killGraceMs: rt.config.killGraceMs,
    resumeSessionId: init.resumeSessionId, extraFlags: init.resumeFlags ?? [],
    onEvent: (ev) => { handleEvent(rt, ev).catch((e) => console.error(`[runner] 轮次处理异常：${e.message}`)); },
  });
  rt.session.send(init.firstMessage);
  return done;
}

// 控制面只读视图：状态取内存真源（store 的 waiting 标志在自唤醒后不更新，不可作为运行态依据）。
// sessionId 与 stopLive 同一套兜底——rt.sessionId 要等首轮 result 才回填，而看板与列表拼的接管/
// 续跑命令没了它就是一条无 --resume 的裸命令。
export function taskSnapshot() {
  return [...liveTasks.values()].filter((rt) => !rt.settled && !rt.stopping).map((rt) => ({
    messageId: rt.task.messageId, short: rt.task.messageId.slice(-6), title: rt.title,
    branch: rt.branch, worktree: rt.worktree, state: rt.state,
    startedAt: rt.startedAt, sessionId: rt.sessionId || rt.session?.sessionId || '',
  }));
}

// 停止回执里的原状态：与 /tasks、看板的状态标签同一套三分（运行中 / 等回复 / 后台运行中），
// 各自成词——同一个状态在列表里叫「后台运行中」、在回执里叫「挂起中」会读成两回事。
const STOPPED_FROM = { active: '活跃轮次人工停止', waiting: '挂起中人工停止', background: '后台运行中人工停止' };

// stop：走 stopped 终态（杀进程组、终态表情、私信回执、promise resolve）。
// pause：补一个等待态再杀进程——顺序反了会让 close 先到并按活跃轮次判 fail 终态。
// 返回处置前的状态；活表未命中返回 null（调用方据此转去处理无进程的残留态）。
export async function stopLive(messageId, mode) {
  const rt = liveTasks.get(messageId);
  if (!rt || rt.settled || rt.stopping) return null;
  const was = rt.state;
  // rt.sessionId 靠轮次事件回填，而人工叫停多半落在首个长轮次里，此刻会话 id 只在进程句柄上。
  // 少了这一步：pause 登记的等待条目缺 sessionId，懒续跑只会回一条 ❌；stop 的接管命令也丢 --resume。
  rt.sessionId ||= rt.session?.sessionId || '';
  if (mode === 'pause') {
    rt.stopping = true;
    // background 已有登记，只是没发过私信；补一次 user 态 goWaiting 让你拿到「回复即续跑」的凭据。
    if (was !== 'waiting') await goWaiting(rt, '人工暂停，回复任意内容即续跑。');
    rt.session?.kill();
    return was;
  }
  await settle(rt, 'stopped', { why: STOPPED_FROM[was] ?? '人工停止' });
  return was;
}

// 私信回复注入活会话：仅挂起态可注入；返回 false 表示需走懒续跑（进程已死或任务不在活表）。
// swap 必须先于 send：send 后的极速 turn（is_error 重试环：回复即触发 429 秒退）会与本次 swap
// 竞争 statusRid——下一次 goWaiting 读到未回写的旧 rid，双删同一枚 WARN、残留双表情。
// state 同步置位于 swap 之前：此窗口内进程死亡要走 close 的 active 分流（可见 fail），不得被 waiting 分支吞掉。
export async function injectReply(messageId, replyText) {
  const rt = liveTasks.get(messageId);
  if (!rt || rt.stopping || !rt.session?.alive) return false;
  if (rt.state === 'waiting') {
    rt.state = 'active';
    rt.statusRid = await swapReaction(rt.lark, rt.task.messageId, rt.config.reactions.claimed, rt.statusRid);
  } else if (rt.state === 'background') {
    rt.state = 'active'; // 群里一直是接单态，无表情可换
  }
  // 活跃态注入直接进 stdin（stream-json 输入按序排队，成为下一轮输入）：自唤醒转活跃与
  // 用户回复并发的窗口里若退回懒续跑，会对同一 worktree 起第二个进程。
  rt.session.send(REPLY_FRAME(replyText));
  return true;
}

// 斜杠命令改参数后收割挂起进程：等待态不动（close 分流对 waiting 不终态），后续回复走懒续跑。
export function killSession(messageId) {
  const rt = liveTasks.get(messageId);
  if (!rt || (rt.state !== 'waiting' && rt.state !== 'background')) return false;
  rt.session?.kill();
  return true;
}

// 懒续跑：bot 重启 / 进程被收割 / 挂起进程意外死亡后，用户回复到达时按 awaiting 条目重建会话。
// info 即 awaiting.jsonl 条目；replyText 是本次要注入的回复正文。
export async function resumeTask(info, replyText, config, lark, hooks = {}) {
  if (!existsSync(info.worktree)) {
    // 现场已被人工删除：无从续跑，终态化交人工（调用方随之删 awaiting 条目）。
    await lark.addReaction(info.messageId, config.reactions.failed);
    if (info.statusRid) await lark.deleteReaction(info.messageId, info.statusRid);
    await lark.sendDm(config.dmOpenId, `❌ 无法续跑：worktree 已不存在\n${info.worktree}\n该任务等待状态已作废，请在群里重新发起。`);
    return { verdict: 'fail', branch: info.branch, worktree: info.worktree, logPath: '' };
  }
  if (!info.sessionId) {
    // 没有 sessionId 就没有可 --resume 的上文：startSession 会退化成 --name 起一个
    // 无上文的全权新 agent，比失败更糟。显式终态化交人工（调用方随之删 awaiting 条目）。
    await lark.addReaction(info.messageId, config.reactions.failed);
    if (info.statusRid) await lark.deleteReaction(info.messageId, info.statusRid);
    await lark.sendDm(config.dmOpenId, `❌ 无法续跑：awaiting 条目缺 sessionId，无法接续原会话\nworktree：${info.worktree}\n该任务等待状态已作废，请在群里重新发起。`);
    return { verdict: 'fail', branch: info.branch, worktree: info.worktree, logPath: '' };
  }
  const task = { messageId: info.messageId, threadId: info.threadId ?? '', text: info.title ?? '' };
  const logPath = join(config.logsDir, `task-${info.messageId}.log`);
  // background 条目的 statusRid 就是群里那枚接单表情（后台运行中从不换表情），此时无表情可换：
  // 飞书 reaction 按 (user, emoji) 唯一，再 add 一次拿不到第二枚，随后的 del 撤掉的正是它自己，
  // 于是从续跑到终态（可能数小时）群消息上零表情——而「没表情」等于「bot 没看见」。
  const claimedRid = info.kind === 'background'
    ? info.statusRid
    : await swapReaction(lark, info.messageId, config.reactions.claimed, info.statusRid);
  // 回执时机落在上面两道关之后：worktree 或 sessionId 缺一，这条路径发的就是 ❌，
  // 调用方若在调用之初先乐观报一句「已续跑」，同一个动作会变成两条相互矛盾的私信。
  try {
    hooks.onResumed?.({ messageId: info.messageId });
  } catch (e) {
    console.error(`[runner] onResumed 回调失败：${e.message}`);
  }
  return startTurnLoop({
    task, config, lark, hooks, branch: info.branch, worktree: info.worktree, logPath,
    statusRid: claimedRid, sessionId: info.sessionId ?? '', title: info.title || 'harness 任务',
    resumeSessionId: info.sessionId, resumeFlags: info.resumeFlags ?? [],
    firstMessage: REPLY_FRAME(replyText),
  });
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
  return startTurnLoop({
    task, config, lark, hooks, branch, worktree, logPath,
    statusRid: claimedRid, sessionId: '', title: sessionName(task.text),
    firstMessage: renderPrompt(task, branch, config.chatId),
  });
}
