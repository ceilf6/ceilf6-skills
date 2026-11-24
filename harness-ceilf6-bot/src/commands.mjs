// 私信斜杠命令通道：消息开头的连续 `/名 参数` 行是控制命令（不喂给会话），其余为回复正文。
// 映射表是唯一扩展点：命令名 → { flag: claude CLI 参数, argLabel: 提示里的参数占位 }；
// 表外或缺参命令整条消息拒绝注入，由调用方回执。
export const COMMANDS = {
  model: { flag: '--model', argLabel: '<名>' },
  effort: { flag: '--effort', argLabel: '<级>' },
};

// 由 COMMANDS 派生：不存在第二份需要人工同步的命令清单。
export const SUPPORTED_HINT = `当前支持：${Object.entries(COMMANDS).map(([name, c]) => `/${name} ${c.argLabel}`).join('、')}`;

// 控制命令：由 listener 直接执行（杀进程 / 置终态 / 列表），不进会话也不转 spawn 参数。
// 与 COMMANDS 分属两类——刹车必须在 listener 层立即生效，等会话读到就晚了。
export const CONTROL = new Set(['stop', 'pause', 'tasks', 'resume']);

// 办事命令与它的用法提示：私信路由不到任务时的回执要把这条出口指出来，与解析同源一份文案。
export const ERRAND = 'do';
export const ERRAND_HINT = `/${ERRAND} <要做的事>`;

// 只认首行：正文里出现的斜杠行是普通文本，误判会凭空杀掉一个任务。
// 飞书 mention 在 content 里就是字面文本（`@名字 ` 原样留在正文），而群里的人习惯
// 先 @ 机器人再发命令；只剥首行开头的连续 mention，中段的 @ 属正文。
function firstLineCommand(text) {
  const lines = String(text ?? '').split('\n');
  const first = lines[0].trim().replace(/^(?:@\S+\s+)+/, '');
  if (!first.startsWith('/')) return null;
  const name = first.slice(1).split(/\s+/)[0];
  return { name, rest: first.slice(1 + name.length).replace(/^\s+/, ''), tail: lines.slice(1) };
}

export function parseControl(text) {
  const c = firstLineCommand(text);
  if (!c || !CONTROL.has(c.name)) return null;
  return { name: c.name, arg: c.rest.trim() };
}

// 办事正文：`/do <要做的事>`，第二行起原样带上——用户写的步骤、路径、粘贴的报错都在那里，
// 按控制命令那样只取首行会把它们悄悄丢掉。返回 null 表示这条不是办事，空串表示只发了命令没带正文。
// 「原样」的边界在整条消息之内：事件层（normalize）已统一去掉消息首尾空白，本函数不再另做修剪，
// 故行首缩进、制表符与中间空行都完整保留，末尾空行则在到达这里之前就没了。
// 不进 CONTROL：那是刹车通道，成员会连带吃到「控制命令独占一条消息」的语义（对办事正好说反），
// 且群话题里的同名命令会被当成对任务的操作走进 controlTask。
export function parseErrand(text) {
  const c = firstLineCommand(text);
  if (!c || c.name !== ERRAND) return null;
  // 只去掉命令那一行本身，正文一律原样：粘进来的 shell / YAML / 列表靠缩进表意，
  // 对拼接结果做全局 trim 会把第二行开头的缩进连同空行一起吃掉。
  const body = c.rest ? [c.rest, ...c.tail].join('\n') : c.tail.join('\n');
  return body.trim() ? body : '';
}

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

// 两个扁平数组的同名覆盖合并（出厂参数 ← 会话已记的 resumeFlags）：同名 flag 出现两次时
// CLI 取哪个不由这里说了算，合并成一份才有确定行为。
export function mergeFlat(baseFlat, overrideFlat) {
  const pairs = [];
  for (let i = 0; i + 1 < overrideFlat.length; i += 2) pairs.push([overrideFlat[i], overrideFlat[i + 1]]);
  return mergeFlags(baseFlat, pairs);
}
