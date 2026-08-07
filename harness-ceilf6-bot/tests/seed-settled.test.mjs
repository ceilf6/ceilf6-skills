import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dirname, '../scripts/seed-settled.mjs');

// 盘面：threads.jsonl（线程登记）+ logs/task-<id>.log（任务日志）+ 现场目录。
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'thb-seed-'));
  const stateDir = join(root, 'state');
  const logsDir = join(root, 'logs');
  const wt = join(root, 'wt-a');
  for (const d of [stateDir, logsDir, wt]) mkdirSync(d, { recursive: true });
  const threads = [];
  const add = (id, over = {}) => threads.push({
    threadId: `omt_${id}`,
    info: { threadId: `omt_${id}`, messageId: `om_${id}`, branch: `bot/${id}`, worktree: wt, ...over },
  });
  const log = (id, body) => writeFileSync(join(logsDir, `task-om_${id}.log`), body);
  const flush = () => writeFileSync(join(stateDir, 'threads.jsonl'),
    threads.map((t) => JSON.stringify(t)).join('\n') + '\n');
  const cfgPath = join(root, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({ stateDir, logsDir }));
  const run = () => execFileSync(process.execPath, [SCRIPT, cfgPath], { encoding: 'utf8' });
  const settled = () => (existsSync(join(stateDir, 'settled.jsonl'))
    ? readFileSync(join(stateDir, 'settled.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).id)
    : []);
  return { root, wt, add, log, flush, run, settled, rm: () => rmSync(root, { recursive: true, force: true }) };
}

const evLine = (o) => JSON.stringify(o) + '\n';

test('播种：能判出终态的历史任务写进 settled，旧格式纯文本日志同样算数', () => {
  const f = fixture();
  // 旧格式（stream-json 之前）：整份日志是纯文本，RESULT 是裸行，一个 result 事件都没有
  f.add('old');
  f.log('old', 'Warning: no stdin data received in 3s\n干了很多活\nRESULT {"verdict":"pass","mr_url":"https://mr/8293690"}\n');
  // 新格式：RESULT 藏在 result 事件里
  f.add('json');
  f.log('json', evLine({ type: 'system', subtype: 'init', session_id: 's1' })
    + evLine({ type: 'result', is_error: false, result: 'RESULT {"verdict":"skip","reason":"闲聊"}', session_id: 's1' }));
  // 日志尾没有终态、又有会话 id：这才是启动扫描要捞的滞留形态，不得播种
  f.add('live');
  f.log('live', evLine({ type: 'system', subtype: 'init', session_id: 's2' }));
  // 现场已清：扫描本就不会捞它，播种也不必掺和
  f.add('gone', { worktree: join(f.root, 'no-such-wt') });
  f.log('gone', evLine({ type: 'system', subtype: 'init', session_id: 's3' }));
  f.flush();

  const out = f.run();
  assert.deepEqual(f.settled().sort(), ['om_json', 'om_old']);
  // 人要能照着输出核对它凭什么这么判
  assert.match(out, /om_old.*pass/);
  assert.match(out, /om_json.*skip/);
  assert.match(out, /om_live/);
  assert.match(out, /om_gone/);

  // 幂等：再跑一遍不重复写，也不把 live 改判
  const again = f.run();
  assert.deepEqual(f.settled().sort(), ['om_json', 'om_old']);
  assert.match(again, /om_old/);
  f.rm();
});

test('播种：已记账的不重复播，无 threads.jsonl 时安静收场', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'state', 'settled.jsonl'), JSON.stringify({ id: 'om_pre', at: '2026-08-01T00:00:00Z' }) + '\n');
  f.add('pre');
  f.log('pre', 'RESULT {"verdict":"fail","reason":"跑挂了"}\n');
  f.flush();
  f.run();
  assert.deepEqual(f.settled(), ['om_pre'], '已记账的 id 不得重复追加');
  rmSync(join(f.root, 'state', 'threads.jsonl'));
  assert.doesNotThrow(() => f.run(), '没有线程登记表时不该炸');
  f.rm();
});
