#!/usr/bin/env node
// 一次性播种 state/settled.jsonl：把历史任务里已经跑到终态的那些记进账，免得启动扫描把它们
// 当成「活跃轮次中被重启收割」重新捞进控制面（判据看日志尾，判不出来时朝复活失手）。
// 迁移动作，不是常驻逻辑：跑一次即可，可重复执行（settled 按 id 幂等、只增）。
//
// 用法：node harness-ceilf6-bot/scripts/seed-settled.mjs [config.json 路径]
// 只写 config 里 stateDir 指向的 settled.jsonl，不碰 worktree、分支、群消息与任何其他状态文件。
// 每条线程登记都打印判定与依据，人工照着核对；判成「待滞留」的那些就是上线后会出现在 /tasks 里
// 的任务，觉得不该出现就先在群里 /stop 掉或手工补进 settled.jsonl。
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/state.mjs';
import { readLogTail, TERMINAL } from '../src/stranded.mjs';

const cfgPath = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'config.json');
const config = JSON.parse(readFileSync(cfgPath, 'utf8'));
for (const k of ['stateDir', 'logsDir']) {
  if (typeof config[k] !== 'string' || !config[k]) {
    console.error(`[seed] config 缺 ${k}（${cfgPath}）`);
    process.exit(1);
  }
}

// 判定与启动扫描同一套判据（TERMINAL / readLogTail 都从 stranded.mjs 取），两边不会各说各话。
function verdictOf(store, info) {
  if (!info?.messageId || !info.worktree) return { tag: '跳过', why: '登记不完整' };
  if (store.isSettled(info.messageId)) return { tag: '已记账', why: '此前已判终态' };
  if (store.findAwaiting(info.messageId)) return { tag: '在控制面', why: '有等待条目，扫描本就不碰' };
  if (!existsSync(info.worktree)) return { tag: '跳过', why: '现场已清，无从续跑' };
  const logPath = join(config.logsDir, `task-${info.messageId}.log`);
  if (!existsSync(logPath)) return { tag: '跳过', why: '没有任务日志' };
  let tail;
  try { tail = readLogTail(logPath); } catch (e) { return { tag: '跳过', why: `日志读不了：${e.message}` }; }
  if (tail.lastVerdict && TERMINAL.has(tail.lastVerdict)) {
    return { tag: '播种', why: `日志尾 verdict=${tail.lastVerdict}` };
  }
  if (!tail.sessionId) return { tag: '跳过', why: '日志里没有会话 id，无从 --resume' };
  return { tag: '待滞留', why: `日志尾无终态 RESULT，会话 ${tail.sessionId}` };
}

const store = new Store(config.stateDir);
const counts = {};
for (const info of store.threads.values()) {
  const { tag, why } = verdictOf(store, info);
  counts[tag] = (counts[tag] ?? 0) + 1;
  if (tag === '播种') store.markSettled(info.messageId);
  console.log(`${tag}\t${info?.messageId ?? '(无 messageId)'}\t${info?.branch ?? ''}\t${why}`);
}
console.log(`[seed] 线程登记 ${store.threads.size} 条：`
  + (Object.entries(counts).map(([k, v]) => `${k} ${v}`).join('、') || '无')
  + `；settled.jsonl → ${join(config.stateDir, 'settled.jsonl')}`);
