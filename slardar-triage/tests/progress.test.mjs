import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { writeFileSync, readFileSync } from 'node:fs';
import { summarizeTask, backfillMrId } from '../scripts/progress.mjs';

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

test('backfillMrId 只在 meta 缺 mr_id 时写入，不覆盖已有值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bf-'));
  const meta = join(dir, 'meta.json');
  writeFileSync(meta, JSON.stringify({ branch: 'x', milestones: {} }));
  assert.deepEqual(backfillMrId(meta, 'https://bits.bytedance.net/bytebus/devops/code/detail/8405910'), { updated: true, mr_id: '8405910' });
  assert.equal(JSON.parse(readFileSync(meta, 'utf8')).mr_id, '8405910');
  assert.deepEqual(backfillMrId(meta, 'https://bits.bytedance.net/bytebus/devops/code/detail/1'), { updated: false, mr_id: '8405910' });
  assert.deepEqual(backfillMrId(meta, null), { updated: false, mr_id: null });
  assert.deepEqual(backfillMrId(join(dir, 'nope.json'), 'https://x/detail/2'), { updated: false, mr_id: '2' });
});

test('summarizeTask 对不存在的目录返回 unknown', () => {
  const s = summarizeTask(join(mkdtempSync(join(tmpdir(), 'pg-')), 'nope'));
  assert.deepEqual(s, { phase: 'unknown', session_status: 'unknown', stages: [], mr_url: null });
});
