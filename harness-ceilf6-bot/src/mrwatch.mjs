// MR 评论巡检（发现层，零 LLM）：枚举 harness 线程 → mr-comments skill 的 fetch → 按作者分流 →
// 人工评论只私信开发者并推进水位；机器人评论过门禁后起值班任务。评论水位只由 mr-comments.sh 写，
// 本模块对水位文件只读（auto_disabled/closed/计数门禁）。
// 值班的对外出口不开新话题：线程若源自任务大厅某个话题（bot 线程登记按 worktree 反查），就在该话题
// 里回帖并以回帖当任务锚点；没有话题的线程（交互会话开的）走私信。值班不受接单水位限制——处置 MR
// 评论是在清积压，不是接新单。
// 全部外部依赖可注入（run/lark/launchDuty/hasCapacity/hasActiveTaskAt/findTopic），单测不碰真进程。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(HERE, '..', '..', 'harness-ceilf6', 'scripts');
const MR_COMMENTS_DIR = join(HERE, '..', '..', 'mr-comments', 'scripts');
const DUTY_TPL = join(HERE, '..', 'duty-prompt.md');

// 出厂关闭：MR 评论默认由开发者在 harness 会话里主动调 mr-comments skill 处理；要 bot 轮询就在
// config.mrWatch 打开 enabled。
export const DEFAULTS = { enabled: false, intervalMs: 300_000, maxTriggersPerThread: 5 };

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
    // findTopic(row) → { rootMessageId, threadId } | null：该 harness 线程在任务大厅的话题（无则 null）
    findTopic = () => null,
    scriptsDir = SCRIPTS_DIR, mrCommentsDir = MR_COMMENTS_DIR, run = sh,
    log = (...a) => console.error('[mrwatch]', ...a),
  } = deps;
  const cfg = { ...DEFAULTS, ...(config.mrWatch ?? {}) };
  const mc = join(mrCommentsDir, 'mr-comments.sh');
  // 一次性提醒去重（进程生命周期内）：closed 与熔断各提醒一次即到达，反复播报是骚扰。
  // bot 重启后最多再提醒一次，可接受。
  const notified = { closed: new Set(), fused: new Set() };
  let ticking = false;

  function readWatermark(ctxDir) {
    try { return JSON.parse(readFileSync(join(ctxDir, 'mr-comments.json'), 'utf8')); } catch { return {}; }
  }

  // 同一轮的机器人快照（snapshot.json，值班任务输入）与人工快照（human.json，只留档）落同一时间戳目录
  function writeSnapshot(row, snap, name = 'snapshot.json') {
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const dir = join(row.ctx_dir, 'mr-cr', ts);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(snap, null, 2));
    return p;
  }

  // 人工评论私信：作者 / 文件:行 / 首条新增回复摘要，最多列 10 条，其余指向快照文件
  function renderHumanDm(row, snap, items, snapPath) {
    const excerpt = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const lines = items.slice(0, 10).map((n, i) => {
      const r = n.new_replies?.[0] ?? {};
      const where = n.path ? `${n.path}${n.line != null ? `:${n.line}` : ''}` : (n.source === 'codebase_review_note' ? 'Review 附言' : '总评');
      return `${i + 1}. ${r.author ?? '?'}｜${where}｜${excerpt(r.body)}`;
    });
    const more = items.length > 10 ? `\n…另 ${items.length - 10} 条见快照 ${snapPath}` : '';
    return `【bot】MR ${row.mr_id} 有 ${items.length} 条人工 CR 评论待你处理（人工评论不自动回复、不自动修复）：\n${lines.join('\n')}${more}\nMR：${snap.mr_url || row.mr_id}`;
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
    if (wm.auto_disabled) return; // 熔断跨 MR 重建生效：复位只走人工 enable
    // closed 只对同一个 MR 静默：meta.mr_id 已变说明 MR 重建过，须放行 fetch 让脚本重置水位
    if (wm.closed && String(wm.mr_id) === String(row.mr_id)) return;
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
      // 键带 mr_id：同一线程重建出的新 MR 到达 closed 时要能再提醒一次
      const closedKey = `${row.ctx_dir}|${row.mr_id}`;
      if (!notified.closed.has(closedKey)) {
        notified.closed.add(closedKey);
        await lark.sendDm(config.dmOpenId,
          `【bot】MR ${row.mr_id} 已合入/关闭，但线程 #${row.idx} 未点「完成」——请去看板收束（人工节点不代点）。该 MR 评论巡检已停。`);
      }
      return;
    }
    if (!snap.new?.length) return;
    const humanNew = snap.new.filter((n) => n.kind === 'human');
    const botNew = snap.new.filter((n) => n.kind !== 'human');
    if (humanNew.length) {
      // 人工评论：不起任务、不回复，私信开发者一次。只推这些线程的水位——机器人线程留给下面的主路
      // 决定（并发满/被占时不 mark，并入下轮），否则这里一并推掉就再也触发不了。
      const humanIds = new Set(humanNew.map((n) => n.id));
      const humanSnap = { ...snap, threads: (snap.threads ?? []).filter((t) => humanIds.has(t.id)), new: humanNew, loop_suspect: false };
      const hp = writeSnapshot(row, humanSnap, 'human.json');
      const hm = await run('bash', [mc, 'mark', '--ctx-dir', row.ctx_dir, '--from-snapshot', hp]);
      if (hm.code !== 0) log(`MR ${row.mr_id} 人工评论 mark 失败（exit ${hm.code}）：${hm.stderr.trim().split('\n')[0] ?? ''}`);
      await lark.sendDm(config.dmOpenId, renderHumanDm(row, snap, humanNew, hp));
    }
    if (!botNew.length) return;
    // 机器人快照：threads 仍全量（人工线程再推一遍是幂等的），new 只含机器人条目
    snap = { ...snap, new: botNew };
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
      const m = await run('bash', [mc, 'mark', '--ctx-dir', row.ctx_dir, '--from-snapshot', snapPath]);
      // mark 失败即水位未推进，同批评论下轮会再次提醒——log 留因，流程照走
      if (m.code !== 0) log(`MR ${row.mr_id} mark 失败（exit ${m.code}）：${m.stderr.trim().split('\n')[0] ?? ''}`);
      await lark.sendDm(config.dmOpenId,
        `【bot】MR ${row.mr_id} 有 ${snap.new.length} 条新机器人 CR 评论，但线程检出${why}，未自动处置——请人工处理。快照：${snapPath}`);
      return;
    }
    if (!hasCapacity()) return; // 并发满：不 mark，下轮自然重试
    const snapPath = writeSnapshot(row, snap);
    const anchor = await announce(row, findTopic(row), `MR ${row.mr_id} 发现 ${snap.new.length} 条新机器人 CR 评论，自动处置中`);
    if (!anchor) { log(`值班锚点发送失败（MR ${row.mr_id}），本轮放弃`); return; }
    const mk = await run('bash', [mc, 'mark', '--ctx-dir', row.ctx_dir, '--from-snapshot', snapPath, '--count-trigger']);
    if (mk.code !== 0) log(`MR ${row.mr_id} mark 失败（exit ${mk.code}）：${mk.stderr.trim().split('\n')[0] ?? ''}`);
    const task = { messageId: anchor.messageId, threadId: anchor.threadId, senderOpenId: config.dmOpenId,
      text: anchor.text, receivedAt: new Date().toISOString() };
    const ok = launchDuty(task, dutyOpts(row, snapPath, Boolean(snap.loop_suspect), task));
    // 已 mark 未起任务的窗口只在并发竞争时出现：不静默——这批评论不会再自动触发
    if (!ok) {
      await lark.sendDm(config.dmOpenId,
        `【bot】MR ${row.mr_id} 值班任务未能启动（并发竞争），评论已记录不再自动触发——请人工处置。快照：${snapPath}`);
    }
  }

  // 值班的对外出口：有话题回帖到话题（回帖当锚点），没有就私信（私信当锚点）。绝不开新话题。
  async function announce(row, topic, text) {
    if (topic) {
      const r = await lark.replyInThread(topic.rootMessageId, text);
      return r?.messageId ? { messageId: r.messageId, threadId: topic.threadId, text } : null;
    }
    const full = `【bot】${text}（${row.branch}）`;
    const id = await lark.sendDm(config.dmOpenId, full);
    return id ? { messageId: id, threadId: '', text: full } : null;
  }

  function dutyOpts(row, snapPath, loopSuspect, task) {
    return {
      cwd: row.cwd, branch: row.branch, title: `MR ${row.mr_id} 评论处置`,
      firstMessage: `${renderDuty(row, snapPath, loopSuspect, task)}\n\n快照：${snapPath}`,
    };
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

  // 鉴权不设开机门禁：bytedcli 走 ByteCloud 登录态，过期与否只有真拉一次才知道——fetch 的 exit 4 与
  // 连败私信就是那条通知路径。
  function start() {
    if (!cfg.enabled) { log('评论巡检已在配置停用'); return null; }
    const t = setInterval(() => { tick().catch((e) => log(`tick 异常：${e.message}`)); }, cfg.intervalMs);
    t.unref?.();
    log(`评论巡检启动（每 ${Math.round(cfg.intervalMs / 1000)}s，熔断上限 ${cfg.maxTriggersPerThread}）`);
    return t;
  }

  return { tick, start, cfg };
}
