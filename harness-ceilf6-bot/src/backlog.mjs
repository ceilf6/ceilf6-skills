// 接单水位的口径：harness 线程台账 ∪ bot 运行时在册表。
// 台账是人工积压的唯一真源——任务跑到「MR 已建、等人工 CR」就终态销账，从运行时在册表里
// 整条消失，只有台账还记着它没走完。台账读走 threads.sh list --json（与 mrwatch 同一条路），
// 本模块不碰 threads.jsonl：单点读写约束由 threads.sh 保证。
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
// 已装与仓库直跑两种布局同构，故按相对路径定位。
export const THREADS_SH = join(HERE, '..', '..', 'harness-ceilf6', 'scripts', 'threads.sh');

// 台账一次要秒级（逐个线程读 meta.json），故超时给足；超时即降级，不会挂住接单判定。
function sh(bin, args) {
  return new Promise((res) => {
    execFile(bin, args, { timeout: 30_000 }, (err, stdout, stderr) => {
      res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

// 未完成线程的判据与 mrwatch 同一套：archived 只是看板视图开关，status=done 才是完成。
export function openThreads(rows) {
  return rows.filter((r) => !r.archived && r.status !== 'done');
}

// 两本账按分支去重：一个任务从起会话到点完人工节点，会先后同时出现在两边。
// 队列中 / 启动中的任务还没有分支，各记一笔——它们本来也还没进台账。
export function countOpen(rows, runtimeTasks) {
  const open = openThreads(rows);
  const branches = new Set(open.map((r) => r.branch).filter(Boolean));
  return open.length + runtimeTasks.filter((t) => !t.branch || !branches.has(t.branch)).length;
}

// HARNESS_THREADS_SH 覆盖脚本位置：测试替身与非常规布局的唯一入口，取值在每次构造时读，
// 不在模块装载时定死。
export function makeBacklog({
  threadsSh = process.env.HARNESS_THREADS_SH || THREADS_SH,
  run = sh,
  log = (...a) => console.error('[backlog]', ...a),
} = {}) {
  // 台账读不出来时降级为运行时在册数（水位的老口径）而非放行：接单限流失效比少接一单严重，
  // 但也不该因为一次脚本故障就让 bot 一单不接。degraded 交调用方决定要不要额外提醒。
  async function count(runtimeTasks) {
    let r;
    try {
      r = await run('bash', [threadsSh, 'list', '--json']);
    } catch (e) {
      log(`台账读取异常（${e.message}），本次按运行时在册数计`);
      return { open: runtimeTasks.length, degraded: true };
    }
    if (r.code !== 0) {
      log(`threads.sh list 失败（exit ${r.code}：${r.stderr.trim().split('\n')[0] ?? ''}），本次按运行时在册数计`);
      return { open: runtimeTasks.length, degraded: true };
    }
    let rows;
    try { rows = JSON.parse(r.stdout); } catch {
      log('threads.sh list 输出不可解析，本次按运行时在册数计');
      return { open: runtimeTasks.length, degraded: true };
    }
    return { open: countOpen(rows, runtimeTasks), degraded: false };
  }
  return { count };
}
