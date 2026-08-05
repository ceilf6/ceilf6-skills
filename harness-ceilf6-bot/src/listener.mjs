// 主循环：consume 子进程管理 + 过滤入队 + 串行 worker。
// 用法：node listener.mjs <config.json 路径>
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { normalize } from './normalize.mjs';
import { decide } from './filter.mjs';
import { appendContextEntry } from './context.mjs';
import { Store } from './state.mjs';
import { makeLark } from './lark.mjs';
import { runTask, resumeTask, injectReply, killSession, killActiveChildren, taskSnapshot, stopLive } from './runner.mjs';
import { parseDmReply, mergeFlags, parseControl, SUPPORTED_HINT } from './commands.mjs';
import { startControlServer } from './control.mjs';

// 控制端口出厂值：config 省略 controlPort 即用它（spec 与 runbook 以此为准）。
// 必须是个确定的数而不是留空——`listen(undefined)` 会挑一个随机端口，看板与 runbook 里的
// 命令就永远连不上，且现象是「连不上」而非「起不来」，无从排查。
export const DEFAULT_CONTROL_PORT = 7659;

export function nextBackoff(attempt) {
  return Math.min(1000 * 2 ** attempt, 60_000);
}

// 一个话题只认第一个把现场建起来的任务。首帖 worktree 就绪前到达的讨论回复会退化成第二个任务，
// 若让它覆盖登记，此后 📝 全写进那个讨论派生的 worktree，而人按 escalate 私信去的是首帖 worktree，
// 永远看不到 bot 声称已存下的补充。worktree 已不在（人工删掉）的登记是坏地址，允许被接管。
export function registerThread(store, info) {
  if (!info.threadId) return false; // 非话题群消息无从关联
  const cur = store.findThread(info.threadId);
  if (cur?.worktree && existsSync(cur.worktree)) return false;
  store.recordThread(info.threadId, info);
  return true;
}

// 只有登记的所有者才能注销：退化出来的第二个任务判 skip 时抹掉首帖那条仍然有效的登记，
// 会让该话题的下一条回复再起一个全权 claude。
export function unregisterThread(store, task) {
  if (!task.threadId) return false;
  if (store.findThread(task.threadId)?.messageId !== task.messageId) return false;
  return store.dropThread(task.threadId);
}

// 启动即全量校验：lark.mjs/runner 假定 config 合法，缺键会退化成
// `--profile undefined` 这类静默错参——必须在 boot 时一次性响亮失败，而非带病常驻。
function validateConfig(config) {
  const errs = [];
  for (const k of ['chatId', 'profile', 'repoPath', 'worktreesDir', 'stateDir', 'logsDir', 'dmOpenId', 'claudeBin', 'larkBin']) {
    if (typeof config[k] !== 'string' || config[k] === '') errs.push(`${k}（需非空字符串）`);
  }
  for (const k of ['concurrency', 'taskTimeoutMs', 'minTextLength']) {
    // 下界 > 0：concurrency=0 会收单记 processed 却永不执行，taskTimeoutMs<=0 秒杀所有任务——都是静默失败形态。
    if (typeof config[k] !== 'number' || Number.isNaN(config[k]) || config[k] <= 0) errs.push(`${k}（需正数）`);
  }
  // controlPort 可省略（省略即 DEFAULT_CONTROL_PORT）；给了就必须是合法端口号。
  // 0 会让 listen 漂成 OS 随便派的端口（静默失败），3.5 / 70000 则要等到 listen 才抛
  // ERR_SOCKET_BAD_PORT 裸栈——两者都该并进这份一次性列全的清单里。
  const port = config.controlPort;
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) {
    errs.push('controlPort（可省略；给了则需 1..65535 的整数）');
  }
  for (const k of ['claimed', 'done', 'failed', 'escalate', 'skipped', 'context', 'stopped']) {
    if (typeof config.reactions?.[k] !== 'string' || config.reactions[k] === '') errs.push(`reactions.${k}（需非空字符串）`);
  }
  return errs;
}

// 拼串 `file://${argv[1]}` 在路径含空格/中文时与 import.meta.url 的百分号编码失配；
// 且 Node 对 ESM 主入口做 realpath 解析而 argv[1] 保留 symlink 字面路径（install 脚本经 symlink 启动是常态）。
// 两者任一失配都会让守护进程静默退出 0 什么都不做（launchd KeepAlive 下即无声 crash-loop）。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  if (!process.argv[2]) {
    console.error('[listener] 用法：node listener.mjs <config.json 路径>');
    process.exit(1);
  }
  const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const configErrs = validateConfig(config);
  if (configErrs.length) {
    console.error(`[listener] config 校验失败（${process.argv[2]}）：\n  - ${configErrs.join('\n  - ')}`);
    process.exit(1);
  }
  const store = new Store(config.stateDir);
  const lark = makeLark(config);
  let running = 0;
  let stopping = false;

  const counted = new Set(); // 占着 concurrency 槽的任务：首次 ask 即释放（用户裁定：回复轮不受槽位限制）
  // 启动窗口：出队后已不在 queue.jsonl，而 liveTasks 要等 worktree 建好才登记。这段时间（巨型
  // monorepo 上是分钟级）任务对刹车不可见，正是「发错了想立刻撤」的时刻——故单列一格在册状态。
  const starting = new Map(); // messageId → 出队时的任务原文，供在册视图取标题与入队时刻
  const taskHooks = {
    onWorktreeReady: (info) => registerThread(store, info),
    onLive: (info) => starting.delete(info.messageId),
    onAsk: (info) => {
      store.recordAsk(info.messageId, info);
      if (counted.delete(info.messageId)) { running--; pump(); }
    },
  };
  function settleTask(task) {
    return (out) => {
      store.dropAwaiting(task.messageId);
      // skip 会把 worktree 与分支删掉，登记不注销的话后续回复会往已删目录写出无人读的文件。
      if (out?.verdict === 'skip') unregisterThread(store, task);
    };
  }

  async function pump() {
    while (!stopping && running < config.concurrency && store.size() > 0) {
      const task = store.dequeue();
      running++;
      counted.add(task.messageId);
      starting.set(task.messageId, task);
      runTask(task, config, lark, taskHooks)
        .then(settleTask(task))
        .catch((e) => console.error(`[listener] runTask 异常：${e.message}`))
        .finally(() => {
          // worktree 建不起来时 onLive 永不到达，这里是启动窗口的唯一出口：
          // 漏清则这条死任务会永远占着「启动中」一格，把在册视图与 /stop 钉死。
          starting.delete(task.messageId);
          if (counted.delete(task.messageId)) { running--; pump(); }
        });
    }
  }

  function admit(ev) {
    store.markProcessed(ev.messageId); // 入队即记 processed：重放/重启不重跑
    store.enqueue({
      messageId: ev.messageId, senderOpenId: ev.senderOpenId, text: ev.text,
      threadId: ev.threadId, receivedAt: new Date().toISOString(),
    });
    console.error(`[listener] 入队 ${ev.messageId}`);
    pump();
  }

  // 话题内回复并进归属任务的 context/。已在跑的会话不会中途重读上下文，
  // 语义是「存给下一次续入用」——回执文案与 runbook 不得暗示实时生效。
  async function absorbReply(taskInfo, ev) {
    let path;
    try {
      path = appendContextEntry(taskInfo, ev);
    } catch (e) {
      // 写盘失败只丢这条补充信息：退回新任务等于为一次 fs 故障凭空起一个无人值守 claude，代价更大。
      console.error(`[listener] 上下文写入失败 ${ev.messageId}：${e.message}`);
      return;
    }
    store.markProcessed(ev.messageId); // 先记后回执：addReaction 最坏要等两次 30s 超时，期间重放会重复写
    console.error(`[listener] 话题回复并入上下文 ${ev.messageId} → ${path}`);
    await lark.addReaction(ev.messageId, config.reactions.context);
  }

  // 状态字面量与看板（harness-ceilf6/scripts/web.py 的 RUN_LABEL）同一套，改动须两边同步。
  const STATE_LABEL = { active: '运行中', waiting: '等回复', starting: '启动中', queued: '排队中' };

  // 尚无 worktree 的任务（队列中 / 启动中）用消息首行当标题：按 code point 截 20，
  // 字节截断会撕裂 CJK 与 emoji。
  const rawTitle = (text) => [...(String(text ?? '').split('\n')[0])].slice(0, 20).join('');

  // 在册任务 = 活表（有运行时）+ awaiting 残留（bot 重启后无进程）+ 启动窗口 + 队列（未起进程）。
  // 按此优先级去重：同一 messageId 只取运行态最真的那份。
  function registry() {
    const out = [];
    const seen = new Set();
    for (const t of taskSnapshot()) { out.push(t); seen.add(t.messageId); }
    for (const e of store.listAwaiting()) {
      if (seen.has(e.messageId)) continue;
      seen.add(e.messageId);
      out.push({
        messageId: e.messageId, short: e.messageId.slice(-6), title: e.title ?? '', branch: e.branch ?? '',
        worktree: e.worktree ?? '', state: 'waiting', startedAt: e.askedAt ?? '', sessionId: e.sessionId ?? '',
      });
    }
    for (const [messageId, t] of starting) {
      if (seen.has(messageId)) continue;
      seen.add(messageId);
      out.push({
        messageId, short: messageId.slice(-6), title: rawTitle(t.text),
        branch: '', worktree: '', state: 'starting', startedAt: t.receivedAt ?? '', sessionId: '',
      });
    }
    for (const t of store.listQueued()) {
      if (seen.has(t.messageId)) continue;
      seen.add(t.messageId);
      out.push({
        messageId: t.messageId, short: t.messageId.slice(-6), title: rawTitle(t.text),
        branch: '', worktree: '', state: 'queued', startedAt: t.receivedAt ?? '', sessionId: '',
      });
    }
    return out.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  }

  // 启动窗口内的任务还进不了线程登记表（登记发生在 worktree 就绪时），话题里的控制命令只能靠
  // 出队时记下的 threadId 认领——否则群里最该管用的那条刹车会回「该话题没有登记的任务」。
  function startingByThread(threadId) {
    if (!threadId) return null;
    for (const [messageId, t] of starting) if (t.threadId === threadId) return { messageId };
    return null;
  }

  // 时长：列表里判断「它是不是卡住了」的唯一现成依据。取不到起始时刻就不显示这一段——
  // 编一个 0 比留空更误导。
  function elapsed(startedAt) {
    const t = Date.parse(startedAt ?? '');
    if (Number.isNaN(t)) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  }

  // 排队中/启动中的行还没起进程，计时起点是消息入队时刻，量的是等待时长。
  const ELAPSED_LABEL = { active: '已跑', waiting: '已跑', starting: '已等', queued: '已等' };

  function formatTasks(list) {
    return list.map((t, i) => {
      const ran = elapsed(t.startedAt);
      return `${i + 1}. [${STATE_LABEL[t.state]}] ${t.title || t.branch}（${t.short}）`
        + `${t.branch ? ` · ${t.branch}` : ''}${ran ? ` · ${ELAPSED_LABEL[t.state] ?? '已跑'} ${ran}` : ''}`;
    }).join('\n');
  }

  // 选择子：messageId / worktree（看板按路径定位）/ short / index（1 基，与 /tasks 当轮输出一致）；
  // 全空时仅当在册恰有一个任务才命中——多个时必须显式指名，避免停错。
  function resolveTarget(sel, list) {
    if (sel.messageId) return list.find((t) => t.messageId === sel.messageId) ?? null;
    if (sel.worktree) return list.find((t) => t.worktree === sel.worktree) ?? null;
    if (sel.short) return list.find((t) => t.short === sel.short) ?? null;
    if (sel.index) return list[Number(sel.index) - 1] ?? null;
    return list.length === 1 ? list[0] : null;
  }

  // 成功回执由处置路径自身发出（settle / goWaiting / 本函数内的非活表分支），
  // 调用方只在失败时回执——同一动作发两条私信会让人以为发生了两件事。
  async function controlTask(sel, mode) {
    const list = registry();
    if (list.length === 0) return { ok: false, error: '当前没有在册任务。' };
    const t = resolveTarget(sel, list);
    if (!t) {
      return {
        ok: false,
        error: list.length > 1
          ? `有 ${list.length} 个任务在册，请带序号或 short（如 /${mode} 2）：\n${formatTasks(list)}`
          : '未找到匹配的任务。',
      };
    }
    // 启动中：worktree 还没建完，既没有进程可杀也没有队列条目可撤。回执必须说清「稍候再来」，
    // 而不是含糊成「没有在册任务」——后者会让人以为刹车没生效而重复发命令。
    if (t.state === 'starting') {
      return { ok: false, error: `该任务正在建 worktree（尚未起进程），稍候数十秒后重试 /${mode}。` };
    }
    if (t.state === 'queued') {
      if (mode === 'pause') return { ok: false, error: '排队中的任务尚未起进程，请改用 /stop。' };
      store.removeQueued(t.messageId);
      await lark.addReaction(t.messageId, config.reactions.stopped);
      await lark.sendDm(config.dmOpenId, `🛑 已出队（未起进程）：${t.title}`);
      return { ok: true, was: 'queued', title: t.title, messageId: t.messageId };
    }
    const was = await stopLive(t.messageId, mode);
    if (was) return { ok: true, was, title: t.title, messageId: t.messageId };
    // 活表没有 → bot 重启后遗留的等待态：进程早已不在，只需处置登记与表情。
    const entry = store.findAwaiting(t.messageId);
    if (!entry) return { ok: false, error: '该任务已结束。' };
    if (mode === 'pause') {
      await lark.sendDm(config.dmOpenId, `⏸ ${entry.title} 本就无进程在跑，等待态保留，回复即续跑。`);
      return { ok: true, was: 'waiting', title: entry.title, messageId: t.messageId };
    }
    store.dropAwaiting(t.messageId);
    await lark.addReaction(t.messageId, config.reactions.stopped);
    if (entry.statusRid) await lark.deleteReaction(t.messageId, entry.statusRid);
    const takeover = entry.sessionId
      ? `cd ${entry.worktree} && claude --resume ${entry.sessionId}`
      : `cd ${entry.worktree} && claude`;
    await lark.sendDm(config.dmOpenId,
      `🛑 任务已停止（等待态作废，进程不在）\n${entry.title}\nworktree：${entry.worktree}\n如需接管：${takeover}`);
    return { ok: true, was: 'waiting', title: entry.title, messageId: t.messageId };
  }

  async function sendTaskList() {
    const list = registry();
    await lark.sendDm(config.dmOpenId, list.length ? `在册任务：\n${formatTasks(list)}` : '当前没有在册任务。');
  }

  // 控制命令与会话输入互斥：多出来的正文若静默丢弃，用户会以为它也送进去了。
  // 两个入口（私信、话题回复）行为必须一致——差异会让人按在哪发过而记两套规则。
  async function noticeExtraBody(text) {
    if (String(text ?? '').split('\n').length > 1) {
      await lark.sendDm(config.dmOpenId, '（控制命令之后的正文未注入会话：控制命令独占一条消息）');
    }
  }

  async function runControl(sel, ctl) {
    if (ctl.name === 'tasks') { console.error('[listener] 控制命令 /tasks'); return sendTaskList(); }
    const out = await controlTask(sel, ctl.name);
    // 用户按下刹车后的唯一现场证据：这条命令有没有进来、落到了哪个任务上。
    console.error(`[listener] 控制命令 /${ctl.name} ${out.ok
      ? `→ ${out.messageId.slice(-6)}（原状态 ${out.was}）`
      : `未执行：${out.error.split('\n')[0]}`}`);
    if (!out.ok) await lark.sendDm(config.dmOpenId, out.error);
  }

  // 私信回路：路由（引用精确 > 单任务直发）→ 斜杠命令 → 注入活会话或懒续跑。
  // 懒续跑轮不占 concurrency 槽（用户裁定实时优先）。
  async function handleDm(ev) {
    store.markProcessed(ev.messageId);
    // 控制命令先于路由：/stop 必须能作用于活跃任务，而活跃任务不在 listWaiting 里。
    const ctl = parseControl(ev.text);
    if (ctl) {
      const sel = ctl.arg ? (/^\d+$/.test(ctl.arg) ? { index: ctl.arg } : { short: ctl.arg }) : {};
      await runControl(sel, ctl);
      await noticeExtraBody(ev.text);
      return;
    }
    let target = ev.rootId ? store.findAwaitingByQuestionMsg(ev.rootId) : null;
    if (target && !target.waiting) {
      await lark.sendDm(config.dmOpenId, '该任务正在跑本轮，暂未等待回复。');
      return;
    }
    if (!target) {
      const waitingList = store.listWaiting();
      if (waitingList.length === 0) { await lark.sendDm(config.dmOpenId, '当前没有等待回复的任务。'); return; }
      if (waitingList.length > 1) { await lark.sendDm(config.dmOpenId, `有 ${waitingList.length} 个任务在等回复，请引用对应提问消息回复。`); return; }
      target = waitingList[0];
    }
    const parsed = parseDmReply(ev.text);
    if (parsed.unknown.length) {
      await lark.sendDm(config.dmOpenId, `无法执行的命令：${parsed.unknown.join(' ')}；${SUPPORTED_HINT}。整条消息未注入。`);
      return;
    }
    if (parsed.flags.length) {
      const merged = mergeFlags(target.resumeFlags ?? [], parsed.flags);
      store.patchAwaiting(target.messageId, { resumeFlags: merged });
      killSession(target.messageId); // 新参数只能在重建进程时生效；挂起态收割无损
      if (!parsed.body) {
        await lark.sendDm(config.dmOpenId, `已记录 ${merged.join(' ')}，下一轮续跑生效。`);
        return;
      }
      target = store.findAwaiting(target.messageId) ?? target;
    }
    store.patchAwaiting(target.messageId, { waiting: false }); // 防同一轮被二次注入
    // 注入/懒续跑异常时必须回滚 waiting=true：不回滚则条目永久失联——引用回复恒得「正在跑」、
    // 直发恒得「没有等待」、重启后 listWaiting 也不选中，只能手改 awaiting.jsonl。
    // 回滚只恢复可路由性，用户重发一条回复即可再触发注入/懒续跑。
    if (!parsed.flags.length) {
      // 换过参数（flags）必走懒续跑：新参数只在 spawn 生效，且旧进程正在被收割、注入必死于半路。
      try {
        if (await injectReply(target.messageId, parsed.body)) return;
      } catch (e) {
        console.error(`[listener] 注入异常：${e.message}`);
        store.patchAwaiting(target.messageId, { waiting: true });
        return; // 注入异常后旧进程状态未知，不得再叠一个懒续跑进程
      }
    }
    const info = store.findAwaiting(target.messageId) ?? target;
    resumeTask(info, parsed.body, config, lark, { onAsk: taskHooks.onAsk })
      .then(settleTask({ messageId: info.messageId, threadId: info.threadId }))
      .catch((e) => {
        console.error(`[listener] 懒续跑异常：${e.message}`);
        store.patchAwaiting(info.messageId, { waiting: true });
      });
  }

  let attempt = 0;
  function startConsumer() {
    if (stopping) return;
    const child = spawn(config.larkBin,
      ['event', 'consume', 'im.message.receive_v1', '--profile', config.profile, '--as', 'bot'],
      { stdio: ['pipe', 'pipe', 'pipe'] }); // stdin 保活：保持 pipe 打开、永不关闭
    // 与 runner 同类：无监听时 spawn 失败（launchd 下 PATH 差异常见）是未处理 'error' 事件，
    // 会整个炸掉常驻进程并绕过 SIGTERM 收割路径；挂上后 'close' 照常触发、走退避重启。
    child.on('error', (e) => console.error(`[listener] 事件流 spawn 失败：${e.message}`));
    child.stderr.on('data', (b) => {
      const s = b.toString();
      if (s.includes('[event] ready')) { attempt = 0; console.error('[listener] 事件流就绪'); }
      else process.stderr.write(s);
    });
    createInterface({ input: child.stdout }).on('line', (line) => {
      let raw;
      try { raw = JSON.parse(line); } catch { return; }
      const ev = normalize(raw);
      let d = decide(ev, config, (id) => store.isProcessed(id));
      // 最小长度门槛防的是闲聊起任务，而控制命令天生短（`/stop` 才 5 个字符），会被它一并拦掉——
      // 刹车拦不住等于没有刹车。只豁免长度，processed 去重照旧：重放的 /stop 不得再停一次。
      if (d.action === 'ignore' && d.reason === 'too-short' && ev.rootId
        && parseControl(ev.text) && !store.isProcessed(ev.messageId)) d = { action: 'reply' };
      if (d.action === 'ignore') {
        if (d.reason !== 'other-chat' && d.reason !== 'other-dm') console.error(`[listener] 忽略 ${ev?.messageId ?? '?'}（${d.reason}）`);
        return;
      }
      if (d.action === 'dm') {
        // 本回调是同步的，未捕获的 rejection 会按默认策略掀掉常驻进程。
        handleDm(ev).catch((e) => console.error(`[listener] 私信处理异常：${e.message}`));
        return;
      }
      // 归属任务已登记 → 并进它的上下文；未登记（bot 启动前的老话题）→ 退化为新任务候选。
      if (d.action === 'reply') {
        const taskInfo = store.findThread(ev.threadId);
        const ctl = parseControl(ev.text);
        if (ctl) {
          // 控制命令是对任务的操作，不是给会话的补充信息：不写 context 条目、不打 📝。
          store.markProcessed(ev.messageId);
          const sel = (taskInfo ? { messageId: taskInfo.messageId } : startingByThread(ev.threadId)) ?? {};
          const act = ctl.name === 'tasks' || sel.messageId
            ? runControl(sel, ctl)
            : lark.sendDm(config.dmOpenId, `该话题没有登记的任务，无法执行 /${ctl.name}。`);
          Promise.resolve(act)
            .then(() => noticeExtraBody(ev.text))
            .catch((e) => console.error(`[listener] 话题控制异常：${e.message}`));
          return;
        }
        if (taskInfo) {
          // 本回调是同步的，未捕获的 rejection 会按默认策略掀掉常驻进程。
          absorbReply(taskInfo, ev).catch((e) => console.error(`[listener] 回复处理异常：${e.message}`));
          return;
        }
      }
      admit(ev);
    });
    child.on('close', (code) => {
      if (stopping) return;
      const delay = nextBackoff(attempt++);
      console.error(`[listener] 事件流退出（code=${code}），${delay}ms 后重启`);
      setTimeout(startConsumer, delay);
    });
  }

  // detached 的 claude 进程组不随本进程退出而终止，必须显式收割，否则关停即孤儿任务。
  process.on('SIGTERM', () => { stopping = true; killActiveChildren(); process.exit(0); });
  process.on('SIGINT', () => { stopping = true; killActiveChildren(); process.exit(0); });
  // 崩溃路径的最后一道收割：默认行为直接退出，会把 detached 的 claude 会话组长留成孤儿，
  // 而它已脱离本进程组，launchd 重启新实例时也够不到它——只能人工 kill。
  process.on('uncaughtException', (e) => {
    console.error('[listener] 未捕获异常：', e);
    try { killActiveChildren(); } catch { /* 收割本身失败也要退出 */ }
    process.exit(1);
  });
  const controlPort = config.controlPort ?? DEFAULT_CONTROL_PORT;
  const control = startControlServer({
    port: controlPort,
    handlers: { listTasks: () => registry(), control: (body, mode) => controlTask(body ?? {}, mode) },
  });
  // 端口占用必须响亮失败：静默降级会让看板的停止按钮一直连不上却无从排查。
  // listen 失败是异步事件，此刻 pump() 可能已把遗留队列起成 detached claude——
  // 直接 exit 会把它留成脱离本进程组、重启后也够不到的孤儿。
  control.on('error', (e) => {
    console.error(`[listener] 控制端口 ${controlPort} 启动失败：${e.message}`);
    stopping = true;
    killActiveChildren();
    process.exit(1);
  });
  startConsumer();
  pump(); // 处理重启前遗留队列
}
