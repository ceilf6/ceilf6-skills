// 原始事件 → 规整对象。事件字段路径的唯一集中地：
// 若 lark-cli event schema 的实际字段名与此不符，只改本文件。
export function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const messageId = raw.message_id ?? raw.message?.message_id ?? '';
  if (!messageId) return null;
  return {
    chatId: raw.chat_id ?? raw.message?.chat_id ?? '',
    senderType: raw.sender_type ?? raw.sender?.sender_type ?? '',
    // lark-cli 已把 sender 拍平成 sender_id 字符串；后一路径兜飞书原始 webhook 的嵌套形状。
    senderOpenId: raw.sender_id ?? raw.sender?.sender_id?.open_id ?? '',
    messageId,
    messageType: raw.message_type ?? raw.message?.message_type ?? '',
    text: typeof raw.content === 'string' ? raw.content.trim() : '',
  };
}
