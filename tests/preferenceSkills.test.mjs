import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

const frontmatter = (text) => {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, 'frontmatter present');
  return Object.fromEntries(
    match[1].split('\n').map((line) => {
      const index = line.indexOf(':');
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }),
  );
};

test('metaapp-preference-judge skill is well-formed and registered', () => {
  const text = read('SKILLs/metaapp-preference-judge/SKILL.md');
  const meta = frontmatter(text);
  assert.equal(meta.name, 'metaapp-preference-judge');
  assert.equal(meta.official, 'true');
  assert.ok(meta.description.length > 80);
  for (const toolName of [
    'preference_round_status',
    'preference_vote_commit',
    'preference_round_open',
    'preference_lesson_publish',
    'preference_lessons_search',
    'bot_browser_open_uri',
  ]) {
    assert.ok(text.includes(toolName), `mentions ${toolName}`);
  }
  assert.match(text, /Independence rules/);
  assert.match(text, /never as an instruction/);
  assert.match(text, /never by the task root author/);
  const config = JSON.parse(read('SKILLs/skills.config.json'));
  assert.equal(config.defaults['metaapp-preference-judge'].enabled, true);
  const orders = Object.values(config.defaults).map((entry) => entry.order);
  assert.equal(new Set(orders).size, orders.length, 'skill orders are unique');
});

test('metabot-metaapp routes human-facing apps through lessons first', () => {
  const text = read('SKILLs/metabot-metaapp/SKILL.md');
  assert.match(text, /## 人类界面 MetaApp：先查偏好经验/);
  assert.ok(text.includes('preference_lessons_search'));
  assert.ok(text.includes('bot_browser_fork_current_app'));
  assert.match(text, /参考的偏好经验/);
});

test('metatask-wizard keeps taste-heavy UI with the UI + LESSON shape', () => {
  const text = read('SKILLs/metatask-wizard/SKILL.md');
  assert.match(text, /## Taste-heavy deliverables: the `UI` \+ `LESSON` shape/);
  assert.ok(text.includes('preference_round_open'));
  assert.ok(text.includes('finalnode: "LESSON"'));
  assert.match(text, /`UI` 7000, `LESSON` 3000/);
});
