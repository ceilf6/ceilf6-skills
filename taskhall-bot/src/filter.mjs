// 过滤链：全部命中才入队。顺序即优先级，reason 供日志。
export function decide(ev, config, isProcessed) {
  if (!ev) return { action: 'ignore', reason: 'unparseable' };
  if (ev.chatId !== config.chatId) return { action: 'ignore', reason: 'other-chat' };
  if (ev.senderType !== 'user') return { action: 'ignore', reason: 'non-human' };
  if (ev.messageType !== 'text') return { action: 'ignore', reason: 'non-text' };
  if (ev.text.length < config.minTextLength) return { action: 'ignore', reason: 'too-short' };
  if (isProcessed(ev.messageId)) return { action: 'ignore', reason: 'duplicate' };
  return { action: 'enqueue' };
}
