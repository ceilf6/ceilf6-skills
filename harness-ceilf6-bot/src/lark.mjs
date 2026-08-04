// 飞书回应适配：全部尽力而为——失败重试一次，仍失败返回空值并记 stderr，不抛。
// 回应不是真相，任务产物（worktree/MR）才是；回应失败不阻塞队列。
import { execFile } from 'node:child_process';

function exec(bin, args) {
  return new Promise((resolveP) => {
    execFile(bin, args, { timeout: 30_000 }, (err, stdout) => {
      if (err) return resolveP(null);
      try { resolveP(JSON.parse(stdout)); } catch { resolveP(null); }
    });
  });
}

export function makeLark(config) {
  const base = ['--profile', config.profile, '--as', 'bot'];
  async function call(args) {
    const full = [...args, ...base];
    return (await exec(config.larkBin, full)) ?? (await exec(config.larkBin, full));
  }
  return {
    async addReaction(messageId, emojiKey) {
      const res = await call(['api', 'POST', `/open-apis/im/v1/messages/${messageId}/reactions`,
        '--data', JSON.stringify({ reaction_type: { emoji_type: emojiKey } })]);
      if (!res?.ok) { console.error(`[lark] addReaction 失败 ${messageId}`); return null; }
      return res.data?.reaction_id ?? null;
    },
    async deleteReaction(messageId, reactionId) {
      const res = await call(['api', 'DELETE', `/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`]);
      if (!res?.ok) { console.error(`[lark] deleteReaction 失败 ${messageId}`); return false; }
      return true;
    },
    async replyInThread(messageId, text) {
      // --content 必须是 JSON（lark-cli 校验），裸文本会被 invalid_argument 拒绝。
      const res = await call(['im', '+messages-reply', '--message-id', messageId,
        '--msg-type', 'text', '--content', JSON.stringify({ text }), '--reply-in-thread']);
      if (!res?.ok) { console.error(`[lark] replyInThread 失败 ${messageId}`); return false; }
      return true;
    },
    async sendDm(openId, text) {
      const res = await call(['im', '+messages-send', '--user-id', openId,
        '--msg-type', 'text', '--content', JSON.stringify({ text })]);
      if (!res?.ok) { console.error(`[lark] sendDm 失败 ${openId}`); return null; }
      // message_id 供 awaiting 登记做「引用回复」匹配；调用方不关心时忽略即可。
      return res.data?.message_id ?? '';
    },
  };
}
