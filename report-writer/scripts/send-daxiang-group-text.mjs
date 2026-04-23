#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

function parseArgs(argv) {
  const args = {
    gid: '',
    botId: '',
    text: '',
    dryRun: false,
    skipAddBot: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--skip-add-bot') {
      args.skipAddBot = true;
    } else if (arg === '--gid') {
      args.gid = argv[++i] || '';
    } else if (arg === '--bot-id') {
      args.botId = argv[++i] || '';
    } else if (arg === '--text') {
      args.text = argv[++i] || '';
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/send-daxiang-group-text.mjs --gid <groupId> --bot-id <botId> --text <message> [--dry-run] [--skip-add-bot]',
    '',
    'This wraps oa-skills daxiang-group with safe JSON construction.',
  ].join('\n');
}

function runOaSkills(args, dryRun) {
  const command = 'oa-skills';
  if (dryRun) {
    return {
      command,
      args,
      status: 0,
      stdout: '',
      stderr: '',
      dryRun: true,
    };
  }

  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return {
    command,
    args,
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    error: result.error?.message,
    dryRun: false,
  };
}

function assertStepOk(step) {
  if (step.status !== 0) {
    const detail = step.stderr || step.stdout || step.error || 'unknown error';
    throw new Error(`${step.command} ${step.args.join(' ')} failed: ${detail}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  if (!args.gid) throw new Error('Missing --gid');
  if (!args.text) throw new Error('Missing --text');
  if (!args.skipAddBot && !args.botId) throw new Error('Missing --bot-id');

  const steps = [];

  if (!args.skipAddBot) {
    steps.push(runOaSkills([
      'daxiang-group',
      'addGroupMember',
      '--gid',
      args.gid,
      '--bots',
      JSON.stringify([args.botId]),
    ], args.dryRun));
    assertStepOk(steps.at(-1));
  }

  const sendMsgInfo = {
    type: 'text',
    body: JSON.stringify({ text: args.text }),
    extension: JSON.stringify({ fileType: 'markdown' }),
  };

  steps.push(runOaSkills([
    'daxiang-group',
    'sendGroupMsg',
    '--gid',
    args.gid,
    '--sendMsgInfo',
    JSON.stringify(sendMsgInfo),
  ], args.dryRun));
  assertStepOk(steps.at(-1));

  console.log(JSON.stringify({
    ok: true,
    gid: args.gid,
    botId: args.skipAddBot ? null : args.botId,
    sendMsgInfo,
    steps,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
}
