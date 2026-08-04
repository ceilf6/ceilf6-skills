// 私信斜杠命令通道：消息开头的连续 `/名 参数` 行是控制命令（不喂给会话），其余为回复正文。
// 映射表是唯一扩展点：命令名 → { flag: claude CLI 参数, argLabel: 提示里的参数占位 }；
// 表外或缺参命令整条消息拒绝注入，由调用方回执。
export const COMMANDS = {
  model: { flag: '--model', argLabel: '<名>' },
  effort: { flag: '--effort', argLabel: '<级>' },
};

// 由 COMMANDS 派生：不存在第二份需要人工同步的命令清单。
export const SUPPORTED_HINT = `当前支持：${Object.entries(COMMANDS).map(([name, c]) => `/${name} ${c.argLabel}`).join('、')}`;

export function parseDmReply(text) {
  const lines = String(text ?? '').split('\n');
  const flags = [];
  const unknown = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('/')) break;
    const [name, ...rest] = line.slice(1).split(/\s+/);
    const value = rest.join(' ');
    // hasOwn 而非直接取值：`/toString`、`/constructor` 等原型链上的名字不是命令，
    // 否则会把一个函数当 flag 名塞进 argv。
    const cmd = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null;
    if (cmd && value) flags.push([cmd.flag, value]);
    else unknown.push(`/${name}`);
  }
  return { flags, unknown, body: lines.slice(i).join('\n').trim() };
}

// resumeFlags 以扁平数组持久化（直接可拼进 spawn argv）；同名 flag 后写覆盖先写。
export function mergeFlags(oldFlat, newPairs) {
  const m = new Map();
  for (let i = 0; i + 1 < oldFlat.length; i += 2) m.set(oldFlat[i], oldFlat[i + 1]);
  for (const [f, v] of newPairs) m.set(f, v);
  return [...m].flat();
}
