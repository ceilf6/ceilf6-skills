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
import { runTask, resumeTask, injectReply, killSession, killActiveChildren } from './runner.mjs';
import { parseDmReply, mergeFlags, SUPPORTED_HINT } from './commands.mjs';

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
  for (const k of ['claimed', 'done', 'failed', 'escalate', 'skipped', 'context']) {
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
  const taskHooks = {
    onWorktreeReady: (info) => registerThread(store, info),
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
      runTask(task, config, lark, taskHooks)
        .then(settleTask(task))
        .catch((e) => console.error(`[listener] runTask 异常：${e.message}`))
        .finally(() => {
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

  // 私信回路：路由（引用精确 > 单任务直发）→ 斜杠命令 → 注入活会话或懒续跑。
  // 懒续跑轮不占 concurrency 槽（用户裁定实时优先）。
  async function handleDm(ev) {
    store.markProcessed(ev.messageId);
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
      const d = decide(ev, config, (id) => store.isProcessed(id));
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
  startConsumer();
  pump(); // 处理重启前遗留队列
}
