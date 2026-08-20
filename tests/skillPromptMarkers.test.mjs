/**
 * Regression test for the skills-catalog suppression bug: the default cowork
 * system prompt (AGENT_SYSTEM_PROMPT.md) MENTIONS the skills catalog in its
 * web-search rule. A bare-tag detector misclassified every default session as
 * 'legacy', so neither the rules section nor the volatile catalog was ever
 * injected — bots saw zero skills. The detector must only fire on actually
 * embedded skill content (paired blocks or the mandatory heading).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { hasEmbeddedSkillCatalog } = await import('../dist-electron/main/libs/skillPromptMarkers.js');

const repoRoot = path.resolve(import.meta.dirname, '..');

test('a prose mention of the skills catalog is NOT an embedded catalog', () => {
  const defaultPrompt = fs.readFileSync(
    path.join(repoRoot, 'sandbox', 'agent-runner', 'AGENT_SYSTEM_PROMPT.md'),
    'utf-8'
  );
  assert.equal(hasEmbeddedSkillCatalog(defaultPrompt), false);

  const mention = 'Check whether `web-search` exists in <available_skills> before using curl.';
  assert.equal(hasEmbeddedSkillCatalog(mention), false);
});

test('an embedded <available_skills> block IS detected', () => {
  const embedded = [
    'Some prompt head.',
    '<available_skills>',
    '  <skill><id>x</id><name>X</name><description>d</description><location>/p</location></skill>',
    '</available_skills>',
  ].join('\n');
  assert.equal(hasEmbeddedSkillCatalog(embedded), true);
});

test('the mandatory heading and a paired skill_context block are detected', () => {
  assert.equal(hasEmbeddedSkillCatalog('## Skills (mandatory)\n- rules'), true);
  assert.equal(hasEmbeddedSkillCatalog('<skill_context>\n## Skill: foo\n</skill_context>'), true);
  assert.equal(hasEmbeddedSkillCatalog('mentions <skill_context> without closing'), false);
});

test('empty and nullish prompts are not legacy', () => {
  assert.equal(hasEmbeddedSkillCatalog(''), false);
  assert.equal(hasEmbeddedSkillCatalog(null), false);
  assert.equal(hasEmbeddedSkillCatalog(undefined), false);
});
