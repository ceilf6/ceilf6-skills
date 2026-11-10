import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const skill = readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8');
const judging = readFileSync(new URL('../references/judging.md', import.meta.url), 'utf8');

test('退役会中笔记同时覆盖两条来源与已缓存候选', () => {
  for (const text of [skill, judging]) {
    assert.match(text, /GET_USER_GUIDE_REQUEST/);
    assert.match(text, /7507/);
    assert.match(text, /Slardar.*Lark|Lark.*Slardar/);
  }
  assert.match(skill, /已缓存为 agent `fixable`/);
  assert.match(skill, /先 `rejudge`/);
});

test('退役规则不误伤仍存续的近邻能力', () => {
  for (const text of [skill, judging]) {
    assert.match(text, /不得只凭/);
    assert.match(text, /妙记/);
    assert.match(text, /AI 纪要/);
    assert.match(text, /会后纪要/);
    assert.match(text, /录音页/);
  }
});
