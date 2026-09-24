#!/usr/bin/env node
// 起单后核验 omh 实际跑的模型。omh 起每个 stage 的 claude 子进程不带 --model，模型来自进程 env
// （ANTHROPIC_MODEL）或执行机的 ~/.claude/settings.json；唯一可靠的事后证据是 stage 会话首条
// system/init 记录里的 model。本脚本只读，不 cancel、不写文件。
// 默认 540 秒：调用它的 Bash 工具单次上限 600 秒，脚本必须先于它退出，否则调用方拿不到 JSON。
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 只钉 opus 族：派单纪律要求固定 opus，其它族没有被接受的理由。
const FAMILIES = { opus: /^claude-opus-/ };

function byStageNumber(a, b) {
  return (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0) || a.localeCompare(b);
}

function initModel(eventsFile) {
  if (!existsSync(eventsFile)) return null;
  for (const line of readFileSync(eventsFile, 'utf8').split('\n')) {
    if (!line.includes('system/init')) continue;
    try {
      const record = JSON.parse(line);
      const model = record?.provider?.event === 'system/init' ? record.provider.data?.model : undefined;
      if (typeof model === 'string' && model) return model;
    } catch {
      // 半写入的行留给下一轮重读
    }
  }
  return null;
}

export function firstStageModel(taskDir) {
  const sessionsDir = join(taskDir, 'sessions');
  if (!existsSync(sessionsDir)) return null;
  for (const session of readdirSync(sessionsDir).sort()) {
    const stagesDir = join(sessionsDir, session, 'stages');
    if (!existsSync(stagesDir)) continue;
    for (const stage of readdirSync(stagesDir).sort(byStageNumber)) {
      const model = initModel(join(stagesDir, stage, 'system', 'runtime', 'raw', 'events.jsonl'));
      if (model) return { model, stage, session };
    }
  }
  return null;
}

export function matchesFamily(model, family) {
  const re = FAMILIES[family];
  if (!re) throw new Error(`--expect 只接受 ${Object.keys(FAMILIES).join('|')}`);
  return re.test(model);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  return value?.startsWith('--') ? undefined : value;
}

function isMain() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

const USAGE = '用法: task-model.mjs --workspace <abs> --task-id <id> --expect opus [--wait <秒，默认 540>]\n';

if (isMain()) {
  const workspace = arg('--workspace');
  const taskId = arg('--task-id');
  const family = arg('--expect');
  const wait = Number(arg('--wait') ?? 540);
  if (!workspace || !taskId || !FAMILIES[family] || !Number.isFinite(wait) || wait < 0) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const taskDir = join(workspace, '.omh', 'tasks', taskId);
  const deadline = Date.now() + wait * 1000;
  let found = firstStageModel(taskDir);
  while (!found && Date.now() < deadline) {
    const sleepMs = Math.min(10_000, deadline - Date.now());
    if (sleepMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
    found = firstStageModel(taskDir);
  }
  if (!found) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: `${wait} 秒内未见 stage 启动记录：${taskDir}` })}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, ...found, matches: matchesFamily(found.model, family) })}\n`);
}
