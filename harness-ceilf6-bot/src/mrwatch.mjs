// MR 评论巡检（发现层，零 LLM）：枚举 harness 线程 → mr-comments.sh fetch → 门禁判定 → 主路起
// 值班任务。评论水位只由 mr-comments.sh 写，本模块对水位文件只读（auto_disabled/closed/计数门禁）。
// 全部外部依赖可注入（run/lark/launchDuty/hasCapacity/hasActiveTaskAt），单测不碰真进程。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(HERE, '..', '..', 'harness-ceilf6', 'scripts');
const DUTY_TPL = join(HERE, '..', 'duty-prompt.md');

export const DEFAULTS = { enabled: true, intervalMs: 300_000, maxTriggersPerThread: 5 };

function sh(bin, args) {
  return new Promise((res) => {
    execFile(bin, args, { timeout: 120_000 }, (err, stdout, stderr) => {
      res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

export function makeMrWatch(deps) {
  const {
    config, lark, launchDuty, hasCapacity, hasActiveTaskAt,
    scriptsDir = SCRIPTS_DIR, run = sh,
    log = (...a) => console.error('[mrwatch]', ...a),
  } = deps;
  const cfg = { ...DEFAULTS, ...(config.mrWatch ?? {}) };
  const mc = join(scriptsDir, 'mr-comments.sh');
  // 一次性提醒去重（进程生命周期内）：closed 与熔断各提醒一次即到达，反复播报是骚扰。
  // bot 重启后最多再提醒一次，可接受。
  const notified = { closed: new Set(), fused: new Set() };
  let ticking = false;

  function readWatermark(ctxDir) {
    try { return JSON.parse(readFileSync(join(ctxDir, 'mr-comments.json'), 'utf8')); } catch { return {}; }
  }

  function writeSnapshot(row, snap) {
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const dir = join(row.ctx_dir, 'mr-cr', ts);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'snapshot.json');
    writeFileSync(p, JSON.stringify(snap, null, 2));
    return p;
  }

  function renderDuty(row, snapPath, loopSuspect, task) {
    return readFileSync(DUTY_TPL, 'utf8')
      .replaceAll('{{BRANCH}}', row.branch)
      .replaceAll('{{MR_ID}}', String(row.mr_id))
      .replaceAll('{{CTX_DIR}}', row.ctx_dir)
      .replaceAll('{{SNAPSHOT_PATH}}', snapPath)
      .replaceAll('{{LOOP_SUSPECT}}', loopSuspect ? '是' : '否')
      .replaceAll('{{MESSAGE_ID}}', task.messageId)
      .replaceAll('{{TIME}}', task.receivedAt);
  }

  // 现场被占判定：分支漂移或已跟踪文件有未提交改动。占用不是错误——交互会话可能正在工作。
  async function occupied(row) {
    const b = await run('git', ['-C', row.cwd, 'symbolic-ref', '--short', '-q', 'HEAD']);
    if (b.code !== 0 || b.stdout.trim() !== row.branch) return '检出分支漂移';
    const s = await run('git', ['-C', row.cwd, 'status', '--porcelain', '-uno']);
    if (s.code !== 0) return '检出状态不可读';
    if (s.stdout.trim() !== '') return '有未提交改动';
    return null;
  }

  async function handleThread(row) {
    const wm = readWatermark(row.ctx_dir);
    if (wm.auto_disabled || wm.closed) return;
    const f = await run('bash', [mc, 'fetch', '--ctx-dir', row.ctx_dir]);
    if (f.code === 3) return; // 无 MR（防御：枚举层已滤）
    const errLine = f.stderr.trim().split('\n')[0] ?? '';
    if (f.code === 4) {
      log(`MR ${row.mr_id} fetch 拉取失败（exit 4）：${errLine}`);
      // 连败 12 轮（约 1 小时）提醒一次；计数由 fetch 落水位，成功自动清零后可再次提醒
      if ((readWatermark(row.ctx_dir).consecutive_failures ?? 0) === 12) {
        await lark.sendDm(config.dmOpenId,
          `【bot】MR ${row.mr_id} 评论巡检连续失败约 1 小时（${errLine}），请检查 bytedcli 鉴权/网络；恢复后自动继续。`);
      }
      return;
    }
    if (f.code !== 0) {
      // exit 4 之外的非零（如水位损坏 die 出的 1）不推进连败计数，连败 DM 永远不会触发——
      // log 是唯一出口，静默会把持续性故障藏到看不见
      log(`MR ${row.mr_id} fetch 异常退出（exit ${f.code}）：${errLine}`);
      return;
    }
    let snap;
    try { snap = JSON.parse(f.stdout); } catch { log(`fetch 输出不可解析（${row.ctx_dir}）`); return; }
    if (snap.closed) {
      if (!notified.closed.has(row.ctx_dir)) {
        notified.closed.add(row.ctx_dir);
        await lark.sendDm(config.dmOpenId,
          `【bot】MR ${row.mr_id} 已合入/关闭，但线程 #${row.idx} 未点「完成」——请去看板收束（人工节点不代点）。该 MR 评论巡检已停。`);
      }
      return;
    }
    if (!snap.new?.length) return;
    if ((wm.trigger_count ?? 0) >= cfg.maxTriggersPerThread) {
      await run('bash', [mc, 'disable', '--ctx-dir', row.ctx_dir]);
      if (!notified.fused.has(row.ctx_dir)) {
        notified.fused.add(row.ctx_dir);
        await lark.sendDm(config.dmOpenId,
          `【bot】MR ${row.mr_id} 评论自动处置已达 ${cfg.maxTriggersPerThread} 次上限，已熔断（疑似环路或反复返工）。人工确认后复位：bash ${mc} enable --ctx-dir ${row.ctx_dir}`);
      }
      return;
    }
    if (hasActiveTaskAt(row.cwd)) return; // 互斥：不 mark，评论并入下轮
    const why = await occupied(row);
    if (why) {
      // 通知即交付：mark（不计熔断配额）后不再重复提醒；人工经 mr-comments.sh 处理，水位同源
      const snapPath = writeSnapshot(row, snap);
      await run('bash', [mc, 'mark', '--ctx-dir', row.ctx_dir, '--from-snapshot', snapPath]);
      await lark.sendDm(config.dmOpenId,
        `【bot】MR ${row.mr_id} 有 ${snap.new.length} 条新 CR 评论，但线程检出${why}，未自动处置——请人工处理。快照：${snapPath}`);
      return;
    }
    if (!hasCapacity()) return; // 并发满：不 mark，下轮自然重试
    const anchorText = `【bot】MR ${row.mr_id} 发现 ${snap.new.length} 条新 CR 评论，自动处置中（${row.branch}）`;
    const sent = await lark.sendToChat(config.chatId, anchorText);
    if (!sent?.messageId) { log(`锚点消息发送失败（MR ${row.mr_id}），本轮放弃`); return; }
    const snapPath = writeSnapshot(row, snap);
    await run('bash', [mc, 'mark', '--ctx-dir', row.ctx_dir, '--from-snapshot', snapPath, '--count-trigger']);
    const task = {
      messageId: sent.messageId, threadId: sent.threadId ?? '', senderOpenId: config.dmOpenId,
      text: anchorText, receivedAt: new Date().toISOString(),
    };
    const ok = launchDuty(task, {
      cwd: row.cwd, branch: row.branch, title: `MR ${row.mr_id} 评论处置`,
      firstMessage: `${renderDuty(row, snapPath, Boolean(snap.loop_suspect), task)}\n\n快照：${snapPath}`,
    });
    // 已 mark 未起任务的窗口只在并发竞争时出现：不静默——这批评论不会再自动触发
    if (!ok) {
      await lark.sendDm(config.dmOpenId,
        `【bot】MR ${row.mr_id} 值班任务未能启动（并发竞争），评论已记录不再自动触发——请人工处置。快照：${snapPath}`);
    }
  }

  async function tick() {
    if (ticking) return; // 上一轮未完不叠加
    ticking = true;
    try {
      const r = await run('bash', [join(scriptsDir, 'threads.sh'), 'list', '--json']);
      if (r.code !== 0) { log(`threads.sh list 失败：${r.stderr.trim()}`); return; }
      let rows;
      try { rows = JSON.parse(r.stdout); } catch { log('threads.sh list 输出不可解析'); return; }
      for (const row of rows.filter((x) => x.mr_id && x.status !== 'done' && !x.archived)) {
        try { await handleThread(row); } catch (e) { log(`线程 #${row.idx} 巡检异常：${e.message}`); }
      }
    } finally { ticking = false; }
  }

  function start() {
    if (!cfg.enabled) { log('评论巡检已在配置停用'); return null; }
    if (!process.env.CLIENT_BITS_TOKEN && !existsSync(join(config.repoPath, '.bits_client_config.json'))) {
      log('缺 CLIENT_BITS_TOKEN 且仓库无 .bits_client_config.json，评论巡检自禁用（不影响主职）');
      return null;
    }
    const t = setInterval(() => { tick().catch((e) => log(`tick 异常：${e.message}`)); }, cfg.intervalMs);
    t.unref?.();
    log(`评论巡检启动（每 ${Math.round(cfg.intervalMs / 1000)}s，熔断上限 ${cfg.maxTriggersPerThread}）`);
    return t;
  }

  return { tick, start, cfg };
}
