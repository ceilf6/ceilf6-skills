// 过滤链：全部命中才放行。顺序即优先级，reason 供日志。
// 三态出口：ignore / reply（话题内回复，归属由 listener 查登记表定）/ enqueue（新任务候选）。
export function decide(ev, config, isProcessed) {
  if (!ev) return { action: 'ignore', reason: 'unparseable' };
  if (ev.chatId !== config.chatId) return { action: 'ignore', reason: 'other-chat' };
  if (ev.senderType !== 'user') return { action: 'ignore', reason: 'non-human' };
  // post 必须放行：话题群里真正的任务就是首帖，而首帖是 post；只放行 text 会把每个真任务
  // 都当非文本丢掉，只剩讨论回复被响应，行为完全反了（2026-07-30 实测）。
  if (ev.messageType !== 'text' && ev.messageType !== 'post') return { action: 'ignore', reason: 'non-text' };
  if (ev.text.length < config.minTextLength) return { action: 'ignore', reason: 'too-short' };
  if (isProcessed(ev.messageId)) return { action: 'ignore', reason: 'duplicate' };
  if (ev.rootId) return { action: 'reply' };
  return { action: 'enqueue' };
}
