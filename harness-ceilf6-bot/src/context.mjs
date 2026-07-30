// 把一条飞书消息落成任务 worktree 里的一个 harness-context `im` 条目。
// 路径与命名照抄 harness-context 的 ctx-dir.sh 约定（分支名 / 换 __、条目名 <YYMMDD-HHmm>-<类型>-<slug>.md）：
// 续入时 agent 是按该约定遍历 context/ 装载的，不一致就等于没存。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function appendContextEntry(taskInfo, ev) {
  // worktree 不在就别写：mkdirSync(recursive) 会凭空造出一个只有 context/ 的空目录，
  // 于群里回一个 📝 说「已存下」，而那个目录没有任何人会去读——宁可报错留一行 stderr。
  if (!existsSync(taskInfo.worktree)) throw new Error(`worktree 不存在（登记已失效）：${taskInfo.worktree}`);
  const dir = join(taskInfo.worktree, '.harness-ceilf6', taskInfo.branch.replaceAll('/', '__'), 'context');
  mkdirSync(dir, { recursive: true });
  // 后 6 位是消息 id 的截断，不同消息可能在同一分钟内撞名；同名直写会静默吃掉前一条。
  const base = join(dir, `${stamp()}-im-${ev.messageId.slice(-6)}`);
  let path = `${base}.md`;
  for (let i = 2; existsSync(path); i++) path = `${base}-${i}.md`;
  // provenance 必须留：条目脱离飞书后无从回溯是谁在哪条消息里说的，人工续入时无法判断可信度。
  writeFileSync(path, [
    `> 来源: 飞书群消息 chat=${ev.chatId} message=${ev.messageId} thread=${ev.threadId}`,
    `> 发送者: ${ev.senderOpenId}`,
    `> 抓取时间: ${new Date().toISOString()}`,
    '---',
    ev.text,
    '',
  ].join('\n'));
  return path;
}
