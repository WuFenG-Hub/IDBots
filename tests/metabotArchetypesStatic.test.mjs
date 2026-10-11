// Static guard for the creator persona archetypes (P1d).
//
// The archetype module is renderer-side TS (not importable from node:test
// directly), so this suite pins the SOURCE: every non-custom archetype must
// carry a non-empty role/soul/goal (an archetype with an empty soul would
// silently create another persona-less assistant), the picker must be wired
// into the create form and pass persona through to the create call, the
// WelcomeFlow twin soul must carry the citizen clause, and both i18n
// dictionaries must define the archetype labels.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

test('every non-custom archetype carries a full persona (role/soul/goal)', () => {
  const source = read('src/renderer/components/metabots/metabotArchetypes.ts');
  const ids = [...source.matchAll(/^\s+id: '([a-z]+)',$/gm)].map((match) => match[1]);
  assert.deepEqual(ids, ['custom', 'builder', 'researcher', 'curator', 'organizer', 'companion']);
  // Split into archetype blocks and check each non-custom block's fields.
  const blocks = source.split(/\n  \{\n/).slice(1).map((block) => block.split(/\n  \},/)[0]);
  assert.equal(blocks.length, 6);
  for (const block of blocks) {
    const id = block.match(/id: '([a-z]+)'/)[1];
    if (id === 'custom') continue;
    for (const field of ['role', 'soul', 'goal']) {
      // Fields may be single-line or multi-line string concatenations — take
      // everything from the field to the block end and require a substantial
      // quoted segment somewhere in it.
      const fieldStart = block.indexOf(`${field}:`);
      assert.ok(fieldStart >= 0, `${id}: missing ${field}`);
      const segment = block.slice(fieldStart);
      const firstString = segment.match(/'([^']{10,})'/);
      assert.ok(firstString, `${id}: expected a non-trivial ${field}`);
    }
  }
});

test('the create form wires the archetype picker and passes persona to the create call', () => {
  const form = read('src/renderer/components/metabots/MetaBotCreateForm.tsx');
  assert.match(form, /from '\.\/metabotArchetypes'/);
  assert.match(form, /metabot-archetype-select/);
  assert.match(form, /handleArchetypeChange/);
  const manager = read('src/renderer/components/metabots/MetabotsManager.tsx');
  assert.match(manager, /role: values\.role\.trim\(\) \|\| null/);
  assert.match(manager, /soul: values\.soul\.trim\(\) \|\| null/);
  assert.match(manager, /hasPersonaPreseed/);
});

test('the WelcomeFlow twin soul carries the AI-internet citizen clause', () => {
  const flow = read('src/renderer/components/onboarding/WelcomeFlow.tsx');
  assert.match(flow, /citizen of the AI internet/);
  assert.match(flow, /publish it on-chain so other bots benefit/);
});

test('both i18n dictionaries define the archetype labels', () => {
  const i18n = read('src/renderer/services/i18n.ts');
  for (const key of [
    'metabotArchetypeLabel',
    'metabotArchetypeHint',
    'metabotArchetypeCustom',
    'metabotArchetypeBuilder',
    'metabotArchetypeResearcher',
    'metabotArchetypeCurator',
    'metabotArchetypeOrganizer',
    'metabotArchetypeCompanion',
  ]) {
    const occurrences = i18n.split(`${key}:`).length - 1;
    assert.ok(occurrences >= 2, `${key}: expected in both the zh and en dictionaries (found ${occurrences})`);
  }
});
