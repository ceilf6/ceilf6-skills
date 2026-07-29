// 主循环：consume 子进程管理 + 过滤入队 + 串行 worker。
// 用法：node listener.mjs <config.json 路径>
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { normalize } from './normalize.mjs';
import { decide } from './filter.mjs';
import { Store } from './state.mjs';
import { makeLark } from './lark.mjs';
import { runTask, killActiveChildren } from './runner.mjs';

export function nextBackoff(attempt) {
  return Math.min(1000 * 2 ** attempt, 60_000);
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
  for (const k of ['claimed', 'done', 'failed', 'escalate']) {
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

  async function pump() {
    while (!stopping && running < config.concurrency && store.size() > 0) {
      const task = store.dequeue();
      running++;
      runTask(task, config, lark)
        .catch((e) => console.error(`[listener] runTask 异常：${e.message}`))
        .finally(() => { running--; pump(); });
    }
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
      if (d.action !== 'enqueue') {
        if (d.reason !== 'other-chat') console.error(`[listener] 忽略 ${ev?.messageId ?? '?'}（${d.reason}）`);
        return;
      }
      store.markProcessed(ev.messageId); // 入队即记 processed：重放/重启不重跑
      store.enqueue({ messageId: ev.messageId, senderOpenId: ev.senderOpenId, text: ev.text, receivedAt: new Date().toISOString() });
      console.error(`[listener] 入队 ${ev.messageId}`);
      pump();
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
  startConsumer();
  pump(); // 处理重启前遗留队列
}
