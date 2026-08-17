// 任务生命周期：worktree → 长驻 claude 会话（stream-json 多轮）→ 每轮 RESULT 分发。
// 判断在 claude 会话里；这里只有机械动作与回应。进程组收割纪律在 session.mjs。
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseResult } from './result.mjs';
import { mergeFlat } from './commands.mjs';
import { startSession, killActiveChildren } from './session.mjs';

export { killActiveChildren };

const TPL_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'bootstrap-prompt.md');
const ERRAND_TPL_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'errand-prompt.md');

// 办事会话的起点：不配就是家目录。会话自己能 cd 出去，这只定起点与默认加载哪份 CLAUDE.md。
export const errandCwd = (config) => config.errandCwd || homedir();

// messageId → 运行时。挂起（等私信回复）的会话也在此登记，injectReply/killSession 按它寻址。
const liveTasks = new Map();

const REPLY_FRAME = (text) => `用户对上一轮问题的私信回复如下（原文）：\n${text}\n——继续按无人值守契约执行，本轮结束仍以 RESULT 行收尾；后续拿不准的点用 verdict=ask + question 收轮提问（不要用 escalate/fused），等自己布的后台工作用 verdict=working。若上一轮的后台工作已被中断（如 cr/round-N/ 有 instructions 却无 verdict.json、后台进程已不在），先重跑该轮再继续。`;
const ERRAND_REPLY_FRAME = (text) => `用户对上一轮问题的私信回复如下（原文）：\n${text}\n——接着把这件事办完，本轮结束仍以 RESULT 行收尾；拿不准的点与不可逆动作用 verdict=ask + question 收轮确认，等自己布的后台工作用 verdict=working。`;
// 办事会话读不懂也不该照做 harness 那套契约（机审轮次、MR、沉淀），续跑框必须按标记分叉。
const replyFrame = (target, text) => (target?.errand ? ERRAND_REPLY_FRAME(text) : REPLY_FRAME(text));
const CORRECTION_MSG = '上一轮输出未以 RESULT 行收尾，违反无人值守契约。立即单独补发一行结果行（RESULT + 单行 JSON），不要其他内容。';
// 办事的合法 verdict：事情办完了（pass）、办不成（fail）、等你拍板（ask）、等自己布的后台工作（working）。
// 用户直接吩咐的事不存在「这不是任务」，故没有 skip；escalate/fused 是 harness 旧契约，与办事无关。
const ERRAND_VERDICTS = new Set(['ask', 'working', 'pass', 'fail']);
const errandCorrection = (why) => `上一轮的结果行不符合办事契约：${why}。verdict 只接受 ask / working / pass / fail（办事没有 skip），pass 的 summary 必须写清办成什么样——用户只看得到那句话。立即单独补发一行合法的结果行（RESULT + 单行 JSON），不要其他内容。`;

function git(repo, args) {
  return new Promise((res, rej) => {
    execFile('git', ['-C', repo, ...args], (err, stdout, stderr) => (err ? rej(new Error(stderr || err.message)) : res(stdout)));
  });
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function renderErrandPrompt(task, cwd) {
  return readFileSync(ERRAND_TPL_PATH, 'utf8')
    .replaceAll('{{SENDER}}', task.senderOpenId ?? '')
    .replaceAll('{{TIME}}', task.receivedAt ?? '')
    .replaceAll('{{MESSAGE_ID}}', task.messageId)
    .replaceAll('{{CWD}}', cwd)
    // 函数形式 + 最后替换：与 renderPrompt 同理，办事正文是任意用户文本
    .replaceAll('{{TASK_TEXT}}', () => task.text);
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
  // 办事没有分支与现场，报的是它在哪个目录办——报一个空分支只会让人以为出了错。
  const where = rt.errand ? `目录：${rt.worktree}` : `分支：${rt.branch}\nworktree：${rt.worktree}`;
  return `⏳ ${rt.title} 需要你拍板\n问题：${question}${progressLine}\n${where}\n直接回复本消息即可续跑；多任务在等时请引用本条回复。`;
}

// kind='background'：会话在等自己布的后台工作（钩子、机审 CR），不是在等人——
// 不发私信、不换表情（群里保持接单态：它确实还在干活）。登记照落：后台工作随 bot 重启
// 一并被杀时，自唤醒信号永不到来，这条登记是回复「继续」能把它捞回来的唯一凭据。
// 等待态转换要能被终态处置等到：它中间隔着两次飞书往返，而 /stop 随时可能在这期间落定。
// 记下在途的那一次，settle 的回执排在它后面——已经发出去的提问收不回来，至少不能让
// 「已停止」抢在它前面到达，那读起来就是「停完了还在问」。
function goWaiting(rt, question, progress, kind = 'user') {
  const p = waitingTransition(rt, question, progress, kind)
    .finally(() => { if (rt.transition === p) rt.transition = null; });
  rt.transition = p;
  return p;
}

async function waitingTransition(rt, question, progress, kind) {
  rt.state = kind === 'background' ? 'background' : 'waiting';
  rt.correctionUsed = false;
  let qMsgId = '';
  if (kind !== 'background') {
    // 换表情排在发问之前：问题一旦可见，回复随时可能到达，而下面这次 onAsk 才是回复能路由
    // 回来的唯一凭据。夹在两者之间的表情调用失败要等两次 30s 超时，那段窗口里到达的回复
    // 找不到 awaiting 条目，会被判成「当前没有等待回复的任务」并记 processed——就此永久丢失。
    const rid = await swapReaction(rt.lark, rt.task.messageId, rt.config.reactions.escalate, rt.statusRid);
    // 这两次飞书往返期间控制面可能把任务停掉（/stop 走 settle：终态表情已打、awaiting 条目已删）。
    // 停止是终态，迟到的这半程必须整个作废——继续发问会让人在停止回执之后又收到一条提问，
    // 继续 onAsk 会把刚收拾干净的条目以「等回复」复活。rt.statusRid 也不回写：它已指向终态表情。
    // pause 只置 stopping、不置 settled，它本就要借这条路径补一个等待态，故判据只看 settled。
    if (rt.settled) {
      if (rid) await rt.lark.deleteReaction(rt.task.messageId, rid); // 撤掉刚打上的过期 ⚠️
      return;
    }
    rt.statusRid = rid;
    qMsgId = await rt.lark.sendDm(rt.config.dmOpenId, askDmText(rt, question, progress));
    if (rt.settled) return;
  }
  try {
    rt.hooks.onAsk?.({
      messageId: rt.task.messageId, threadId: rt.task.threadId ?? '', branch: rt.branch,
      worktree: rt.worktree, sessionId: rt.sessionId, question,
      questionMsgId: qMsgId || '', statusRid: rt.statusRid, title: rt.title, kind,
      // 办事标记与 kind 正交（办事同样会 user / background 地等）：懒续跑与在册视图靠它
      // 认出这条不是需求任务——丢了它，重启后续跑的办事会话会收到 harness 契约的续跑框。
      errand: rt.errand ?? false,
      // 免清场标记必须随登记条目持久化：bot 重启后经懒续跑重建的值班会话丢了它，一个 skip 就会清掉用户检出。
      preserveWorktree: rt.preserveWorktree ?? false,
    });
  } catch (e) {
    // 登记只决定「回复能否路由回来」，不该连带杀掉活着的会话。
    console.error(`[runner] onAsk 回调失败：${e.message}`);
  }
}

// 办事的终态私信不是通知而是交付：任务失手了还有 worktree 与 MR 可事后翻，办事的产物只有这一句话。
// 故不吃 lark 那套「尽力而为、失败即算了」——多试几次；彻底送不出去就把原文整段写进 stderr
// （launchd.err.log 是它最后的落点），连同会话日志路径一并给出，人还能捞回来。
// sendDm 成功时可能回空串（应答缺 message_id），只有 null 才是失败，判据不能用真值。
async function deliverErrand(rt, text) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1000 * attempt));
    const id = await rt.lark.sendDm(rt.config.dmOpenId, text);
    if (id !== null && id !== undefined) return true;
  }
  console.error(`[runner] 办事结论投递失败（私信三次均未送出），日志 ${rt.logPath}，原文：\n${text}`);
  return false;
}

async function settle(rt, verdict, { why, result } = {}) {
  if (rt.settled) return;
  rt.settled = true;
  // 只删指向自己的登记：懒续跑可能已用新运行时覆盖同 key，误删会让后续回复重复起会话。
  if (liveTasks.get(rt.task.messageId) === rt) liveTasks.delete(rt.task.messageId);
  // 落盘的等待条目必须在这里、在任何外部 await 之前一并销掉。下面的终态表情与回执要走几次
  // 飞书往返（办事的回执还带退避重试），而运行时此刻已不在活表：这段时间里 /tasks 会从那条
  // 旧条目把它重新显示成「等回复」，/stop 走「无进程的残留态」分支照样回一句「已停止」，
  // 而本函数仍会继续把「已完成」投出去——同一件事两条互相打脸的回执。
  try {
    rt.hooks?.onSettling?.({ messageId: rt.task.messageId });
  } catch (e) {
    console.error(`[runner] onSettling 回调失败：${e.message}`);
  }
  // stopped 是人工叫停：必须立刻断掉进程组，不能等它把当前轮跑完。
  if (verdict === 'stopped') rt.session?.kill(); else rt.session?.endInput();
  // 刹车本身（上面那一下）不等任何东西；等的只是回执。在途的等待态转换可能正卡在飞书往返里，
  // 它自己会复核 settled 并整体作废（不登记、撤掉过期表情），这里只等它退出，好让终态回执
  // 排在那条已经发出的提问后面。
  if (rt.transition) { try { await rt.transition; } catch { /* 转换内部已自行记录 */ } }
  const { config, lark, task } = rt;
  if (verdict === 'skip') {
    // 值班任务跑在线程既有检出上：skip 也不得清场——cleanupWorktree 会删掉用户的检出与需求分支。
    if (!rt.preserveWorktree) await cleanupWorktree(config, rt.worktree, rt.branch);
    rt.statusRid = await swapReaction(lark, task.messageId, config.reactions.skipped, rt.statusRid);
  } else if (verdict === 'stopped') {
    rt.statusRid = await swapReaction(lark, task.messageId, config.reactions.stopped, rt.statusRid);
    const takeover = rt.sessionId
      ? `cd ${rt.worktree} && claude --resume ${rt.sessionId}`
      : `cd ${rt.worktree} && claude`;
    await lark.sendDm(config.dmOpenId, rt.errand
      ? `🛑 办事已停止（${why}）\n${rt.title}\n目录：${rt.worktree}\n如需接管：${takeover}`
      : `🛑 任务已停止（${why}）\n${rt.title}\n分支：${rt.branch}\nworktree：${rt.worktree}\n如需接管：${takeover}`);
  } else if (verdict === 'pass') {
    rt.statusRid = await swapReaction(lark, task.messageId, config.reactions.done, rt.statusRid);
    // 办事的交付物就是 summary 那句话：它没有 MR 也没有分支，报出来只会是两行空字段。
    // 空 summary 到不了这里——handleEvent 的办事契约先纠偏、再按 fail 收束。
    if (rt.errand) await deliverErrand(rt, `✅ 办事完成\n${rt.title}\n目录：${rt.worktree}\n${result?.summary || ''}`);
    else {
      await lark.sendDm(config.dmOpenId,
        `✅ 任务完成\nMR：${result?.mr_url || '（RESULT 未带链接）'}\n分支：${rt.branch}\n摘要：${result?.summary || ''}`);
    }
  } else {
    rt.statusRid = await swapReaction(lark, task.messageId, config.reactions.failed, rt.statusRid);
    if (rt.errand) {
      await deliverErrand(rt,
        `❌ 办事未完成（${why}）\n${rt.title}\n目录：${rt.worktree}\n日志：${rt.logPath}\nreason：${result?.reason || ''}`);
    } else {
      await lark.sendDm(config.dmOpenId,
        `❌ 任务未完成（${why}）\nworktree：${rt.worktree}\n日志：${rt.logPath}\nreason：${result?.reason || ''}`);
    }
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
  // 解析器是任务与办事共用的，办事那两条契约只能在这里收：
  // 一、verdict 白名单。落进 skip 分支就是「只换个表情、一句回音都没有」，落进 escalate/fused
  //     则会把 harness 的接管文案发给一件杂活。
  // 二、pass 必须带 summary。办事没有 MR 这种能自己说话的产物，那句话就是交付物本身；
  //     空 summary 的 pass 是一条「办完了，但不告诉你办成什么样」的回执。
  const breach = rt.errand && result && (
    !ERRAND_VERDICTS.has(result.verdict) ? `办事契约不接受 verdict=${result.verdict}`
      : (result.verdict === 'pass' && !String(result.summary ?? '').trim()) ? '办事的 pass 缺 summary（结论就是交付物）'
        : '');
  if (!result || breach) {
    if (rt.correctionUsed) {
      return settle(rt, 'fail', { why: breach || '连续两轮无有效 RESULT 行' });
    }
    rt.correctionUsed = true;
    return rt.session.send(breach ? errandCorrection(breach) : CORRECTION_MSG);
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

// 无人值守的活按 opus 起，且每次 spawn 都显式写进 argv：不写就吃 CLI 侧默认，那份随本机
// `/model` 配置漂，同一个 bot 在不同机器上会跑出不同模型。
// config.model 覆盖出厂值；置空串表示「不带 flag，交回 CLI 默认」。
const DEFAULT_MODEL = 'opus';

// 私信 /model、/effort 记进 resumeFlags 的值压过出厂参数——那是人对着具体任务下的判断。
function sessionFlags(config, resumeFlags = []) {
  const model = config.model ?? DEFAULT_MODEL;
  return mergeFlat(model ? ['--model', model] : [], resumeFlags);
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
    resumeSessionId: init.resumeSessionId, extraFlags: sessionFlags(rt.config, init.resumeFlags ?? []),
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
    branch: rt.branch, worktree: rt.worktree, state: rt.state, errand: !!rt.errand,
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
  rt.session.send(replyFrame(rt, replyText));
  return true;
}

// 斜杠命令改参数后收割挂起进程：等待态不动（close 分流对 waiting 不终态），后续回复走懒续跑。
export function killSession(messageId) {
  const rt = liveTasks.get(messageId);
  if (!rt || (rt.state !== 'waiting' && rt.state !== 'background')) return false;
  rt.session?.kill();
  return true;
}

// awaiting 条目里 statusRid 指向接单表情（而非某个换过的状态表情）的那几类。
const CLAIMED_STATUS_KINDS = new Set(['background', 'stranded']);

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
  // 这两类条目的 statusRid 就是群里那枚接单表情本身（background 从不换表情，stranded 由启动扫描
  // 把它补回来），此时无表情可换：飞书 reaction 按 (user, emoji) 唯一，再 add 一次拿不到第二枚，
  // 随后的 del 撤掉的正是它自己，于是从续跑到终态（可能数小时）群消息上零表情——而「没表情」
  // 等于「bot 没看见」。
  const reusedRid = CLAIMED_STATUS_KINDS.has(info.kind);
  const claimedRid = reusedRid
    ? info.statusRid
    : await swapReaction(lark, info.messageId, config.reactions.claimed, info.statusRid);
  // 上面那次表情往返（失败时最坏两次 30s 超时）里控制面可能把这条停掉：新运行时还没进活表，
  // /stop 走的是「无进程的残留态」分支——删条目、发 🛑 回执。此刻再 spawn 就是「已停止」之后
  // 凭空多出一个跑着的会话，它不在任何在册视图里，也再没有刹车能停它。
  if (hooks.stillWanted && !hooks.stillWanted()) {
    // 只撤本次打上去的那枚：background / stranded 复用的是群里那枚接单表情，/stop 已经收拾过了。
    if (!reusedRid && claimedRid) await lark.deleteReaction(info.messageId, claimedRid);
    console.error(`[runner] 懒续跑期间被叫停，不再起会话：${info.messageId}`);
    return { verdict: 'stopped', branch: info.branch, worktree: info.worktree, logPath: '' };
  }
  // 回执时机落在上面两道关之后：worktree 或 sessionId 缺一，这条路径发的就是 ❌，
  // 调用方若在调用之初先乐观报一句「已续跑」，同一个动作会变成两条相互矛盾的私信。
  try {
    hooks.onResumed?.({ messageId: info.messageId });
  } catch (e) {
    console.error(`[runner] onResumed 回调失败：${e.message}`);
  }
  return startTurnLoop({
    task, config, lark, hooks, branch: info.branch, worktree: info.worktree, logPath,
    statusRid: claimedRid, sessionId: info.sessionId ?? '',
    title: info.title || (info.errand ? '办事' : 'harness 任务'),
    resumeSessionId: info.sessionId, resumeFlags: info.resumeFlags ?? [],
    preserveWorktree: info.preserveWorktree ?? false, errand: info.errand ?? false,
    firstMessage: replyFrame(info, replyText),
  });
}

// 办事任务：在用户自己的目录（缺省家目录）起会话，不建 worktree、不建分支、任何终态都不清场。
// 与值班任务同形，区别只在 prompt 与全程的对外文案——它不产 MR，交付物是那句 summary。
export async function runErrandTask(task, config, lark, hooks = {}) {
  mkdirSync(config.logsDir, { recursive: true });
  const cwd = errandCwd(config);
  const logPath = join(config.logsDir, `task-${task.messageId}.log`);
  if (!existsSync(cwd)) {
    // 起点不在就别 spawn：ENOENT 只会以「会话进程退出且无有效 RESULT 行」的面目落地，
    // 而真正该修的是 config.errandCwd。
    await lark.addReaction(task.messageId, config.reactions.failed);
    await lark.sendDm(config.dmOpenId,
      `❌ 办事未启动：目录不存在（尚未运行，无会话日志）\n目录：${cwd}\n检查 config.json 的 errandCwd`);
    return { verdict: 'fail', branch: '', worktree: cwd, logPath: '' };
  }
  const claimedRid = await lark.addReaction(task.messageId, config.reactions.claimed);
  return startTurnLoop({
    task, config, lark, hooks, branch: '', worktree: cwd, logPath,
    statusRid: claimedRid, sessionId: '', title: sessionName(task.text),
    errand: true, preserveWorktree: true,
    firstMessage: renderErrandPrompt(task, cwd),
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

// 值班任务：在线程既有检出上起会话（MR 评论自动处置）。不建 worktree、任何终态都不清场；
// prompt 由调用方渲染好整段传入。
export async function runDutyTask(task, config, lark, hooks = {}, opts) {
  mkdirSync(config.logsDir, { recursive: true });
  const logPath = join(config.logsDir, `task-${task.messageId}.log`);
  try {
    // preserveWorktree 随线程登记落盘：滞留扫描凭它重建的登记才带免清场保护，缺了它
    // 「从未 ask 过、活跃轮次中被收割」的值班任务经 /resume + skip 会删掉用户检出。
    hooks.onWorktreeReady?.({ threadId: task.threadId ?? '', branch: opts.branch, worktree: opts.cwd, messageId: task.messageId, preserveWorktree: true });
  } catch (e) {
    console.error(`[runner] onWorktreeReady 回调失败：${e.message}`);
  }
  const claimedRid = await lark.addReaction(task.messageId, config.reactions.claimed);
  return startTurnLoop({
    task, config, lark, hooks, branch: opts.branch, worktree: opts.cwd, logPath,
    statusRid: claimedRid, sessionId: '', title: opts.title, preserveWorktree: true,
    firstMessage: opts.firstMessage,
  });
}
