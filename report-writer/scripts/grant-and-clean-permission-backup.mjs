#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

function parseArgs(argv) {
  const args = {
    url: '',
    mis: '',
    xmGroupIds: '',
    perm: '',
    cleanup: true,
    backupSpaceId: '',
    backupTitlePrefix: '权限备份-grant-',
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url') {
      args.url = argv[++i] || '';
    } else if (arg === '--mis') {
      args.mis = argv[++i] || '';
    } else if (arg === '--xm-group-ids') {
      args.xmGroupIds = argv[++i] || '';
    } else if (arg === '--perm') {
      args.perm = argv[++i] || '';
    } else if (arg === '--backup-space-id') {
      args.backupSpaceId = argv[++i] || '';
    } else if (arg === '--backup-title-prefix') {
      args.backupTitlePrefix = argv[++i] || '';
    } else if (arg === '--no-cleanup') {
      args.cleanup = false;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
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
    '  node scripts/grant-and-clean-permission-backup.mjs --url <documentUrl> --mis <mis> --xm-group-ids <groupIds> --perm <permission> [options]',
    '',
    'Options:',
    '  --backup-space-id <spaceId>          Only delete backup docs in this space',
    '  --backup-title-prefix <prefix>       Only delete docs whose title starts with this prefix',
    '  --no-cleanup                         Run grant but keep generated backup docs',
    '  --dry-run                            Print intended commands without changing Citadel',
    '',
    'This wrapper only deletes backup documents linked from the current grant output.',
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

function extractDocumentIds(text) {
  const ids = new Set();
  const linkPattern = /km\.sankuai\.com\/(?:collabpage|page)\/(\d{6,})/g;
  for (const match of text.matchAll(linkPattern)) {
    ids.add(match[1]);
  }
  return [...ids];
}

function readMetaValue(metaText, label) {
  const pattern = new RegExp(`${label}[：:]\\s*([^\\n\\r]+)`);
  return metaText.match(pattern)?.[1]?.trim() || '';
}

function parseMeta(metaText) {
  const title = readMetaValue(metaText, '标题');
  const spaceText = readMetaValue(metaText, '所属空间');
  return {
    title,
    creator: readMetaValue(metaText, '创建者'),
    owner: readMetaValue(metaText, '所有者'),
    spaceId: spaceText.match(/\d+/)?.[0] || '',
  };
}

function validateBackupDoc(meta, args) {
  const reasons = [];

  if (!meta.title.startsWith(args.backupTitlePrefix)) {
    reasons.push(`title does not start with ${args.backupTitlePrefix}`);
  }
  if (meta.creator !== args.mis) {
    reasons.push(`creator ${meta.creator || '<empty>'} is not ${args.mis}`);
  }
  if (meta.owner !== args.mis) {
    reasons.push(`owner ${meta.owner || '<empty>'} is not ${args.mis}`);
  }
  if (args.backupSpaceId && meta.spaceId !== args.backupSpaceId) {
    reasons.push(`space ${meta.spaceId || '<empty>'} is not ${args.backupSpaceId}`);
  }

  return reasons;
}

function cleanupBackups(candidateIds, args) {
  const cleanup = {
    candidateIds,
    deleted: [],
    skipped: [],
    failed: [],
  };

  for (const contentId of candidateIds) {
    const metaStep = runOaSkills([
      'citadel',
      'getDocumentMetaInfo',
      '--contentId',
      contentId,
      '--mis',
      args.mis,
    ], args.dryRun);

    if (metaStep.status !== 0) {
      cleanup.failed.push({
        contentId,
        stage: 'getDocumentMetaInfo',
        error: metaStep.stderr || metaStep.stdout || metaStep.error || 'unknown error',
      });
      continue;
    }

    const meta = args.dryRun
      ? {
          title: `${args.backupTitlePrefix}<dry-run>`,
          creator: args.mis,
          owner: args.mis,
          spaceId: args.backupSpaceId,
        }
      : parseMeta(metaStep.stdout);
    const rejectionReasons = validateBackupDoc(meta, args);

    if (rejectionReasons.length > 0) {
      cleanup.skipped.push({
        contentId,
        meta,
        reasons: rejectionReasons,
      });
      continue;
    }

    const deleteStep = runOaSkills([
      'citadel',
      'deleteDocument',
      '--contentId',
      contentId,
      '--mis',
      args.mis,
    ], args.dryRun);

    if (deleteStep.status === 0) {
      cleanup.deleted.push({
        contentId,
        title: meta.title,
        output: deleteStep.stdout,
        dryRun: args.dryRun,
      });
    } else {
      cleanup.failed.push({
        contentId,
        title: meta.title,
        stage: 'deleteDocument',
        error: deleteStep.stderr || deleteStep.stdout || deleteStep.error || 'unknown error',
      });
    }
  }

  return cleanup;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  if (!args.url) throw new Error('Missing --url');
  if (!args.mis) throw new Error('Missing --mis');
  if (!args.xmGroupIds) throw new Error('Missing --xm-group-ids');
  if (!args.perm) throw new Error('Missing --perm');
  if (!args.backupTitlePrefix) throw new Error('Missing --backup-title-prefix');

  const grantStep = runOaSkills([
    'citadel',
    'grant',
    '--url',
    args.url,
    '--xm-group-ids',
    args.xmGroupIds,
    '--perm',
    args.perm,
    '--mis',
    args.mis,
  ], args.dryRun);
  assertStepOk(grantStep);

  const candidateIds = args.dryRun
    ? []
    : extractDocumentIds(`${grantStep.stdout}\n${grantStep.stderr}`);
  const cleanup = args.cleanup
    ? cleanupBackups(candidateIds, args)
    : {
        candidateIds,
        deleted: [],
        skipped: candidateIds.map((contentId) => ({
          contentId,
          reasons: ['cleanup disabled'],
        })),
        failed: [],
      };

  console.log(JSON.stringify({
    ok: true,
    grant: grantStep,
    cleanup,
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
