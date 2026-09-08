import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { summarizeTask } from '../scripts/progress.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('summarizeTask 读 meta/session/stages 给出阶段序列与 MR', () => {
  const s = summarizeTask(join(here, 'fixtures', 'task-dir'));
  assert.equal(s.phase, 'completed');
  assert.equal(s.session_status, 'passed');
  assert.deepEqual(
    s.stages.map((x) => `${x.name}@${x.attempt}:${x.verdict}`),
    ['gen-test@1:passed', 'code-review@1:failed', 'code-review@2:passed', 'handoff@1:passed'],
  );
  assert.equal(s.mr_url, 'https://bits.bytedance.net/bytebus/devops/code/detail/8405910');
});

test('summarizeTask 对不存在的目录返回 unknown', () => {
  const s = summarizeTask(join(mkdtempSync(join(tmpdir(), 'pg-')), 'nope'));
  assert.deepEqual(s, { phase: 'unknown', session_status: 'unknown', stages: [], mr_url: null });
});
