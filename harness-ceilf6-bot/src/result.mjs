// RESULT 契约解析：stdout 中最后一个 `RESULT ` 前缀行；坏 JSON / 非法 verdict → null（按 fail 处理）。
// ask 是中间态（等用户私信回复），其余为终态；escalate/fused 仅旧会话兼容。
const VERDICTS = new Set(['skip', 'ask', 'escalate', 'pass', 'fail', 'fused']);

export function parseResult(stdout) {
  const lines = String(stdout ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('RESULT ')) continue;
    try {
      const obj = JSON.parse(line.slice('RESULT '.length));
      return VERDICTS.has(obj.verdict) ? obj : null;
    } catch {
      return null;
    }
  }
  return null;
}
