// 过滤链：全部命中才放行。顺序即优先级，reason 供日志。
// 四态出口：ignore / dm（私信回复，归属由 listener 查等待表定）/ reply（话题内回复，归属由 listener 查登记表定）/ enqueue（新任务候选）。
export function decide(ev, config, isProcessed) {
  if (!ev) return { action: 'ignore', reason: 'unparseable' };
  if (ev.chatType === 'p2p') {
    // 私聊只认配置用户本人：bot 自发的提问回执、他人私聊一律静默忽略（reason 同 other-chat 不落日志）。
    if (ev.senderOpenId !== config.dmOpenId || ev.senderType !== 'user') return { action: 'ignore', reason: 'other-dm' };
    if (ev.messageType !== 'text' && ev.messageType !== 'post') return { action: 'ignore', reason: 'non-text' };
    // 回复不设长度门槛：「好的」「用A」都是合法拍板输入。
    if (ev.text.length === 0) return { action: 'ignore', reason: 'too-short' };
    if (isProcessed(ev.messageId)) return { action: 'ignore', reason: 'duplicate' };
    return { action: 'dm' };
  }
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

// 正文里 @ 了 bot：接单水位满时的放行凭据（明确的人工指派，不该被限流拦掉）。
// 事件里没有结构化的 mention 字段，飞书把 mention 渲染成字面 `@<显示名>` 留在正文里
// （lark-cli 拍平后同样如此），只能按字面匹配——bot 一改名，config.botName 必须跟着改。
export function mentionsBot(text, botName) {
  if (!botName) return false;
  return String(text ?? '').includes(`@${botName}`);
}
