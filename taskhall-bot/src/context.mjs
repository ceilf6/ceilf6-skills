// 把一条飞书消息落成任务 worktree 里的一个 harness-context `im` 条目。
// 路径与命名照抄 harness-context 的 ctx-dir.sh 约定（分支名 / 换 __、条目名 <YYMMDD-HHmm>-<类型>-<slug>.md）：
// 续入时 agent 是按该约定遍历 context/ 装载的，不一致就等于没存。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function appendContextEntry(taskInfo, ev) {
  const dir = join(taskInfo.worktree, '.harness-ceilf6', taskInfo.branch.replaceAll('/', '__'), 'context');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${stamp()}-im-${ev.messageId.slice(-6)}.md`);
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
