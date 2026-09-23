// Renderer/main quota-constant sync.
//
// The renderer keeps "keep in sync" COPIES of the main-process quota
// constants (components cannot import from src/main). The quota audit
// 2026-09-17 raised the main constants (surf 20/100 → 50/500, A2A default
// turns 30 → 50) and both copies lagged: the surf editor clamped users to a
// phantom ceiling of 100 and displayed 20 while the bot could spend 50, and
// the A2A edit form silently downgraded every edited bot back to 30 turns
// (NULL-stored defaults resolve to 50 at runtime, but the form seeds 30 and
// the save payload always carries the form value). This suite regex-pins the
// copies to the main constants so the next bump cannot land half-applied.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

const extractDeclaration = (source, name, label) => {
  // Tolerates an optional TS type annotation between the name and `=`.
  const match = source.match(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*(?::[^=]+)?=[^;\\n]+`));
  assert.ok(match, `${label}: expected a \`${name}\` declaration`);
  return match[0];
};

const extractNumber = (source, name, label) => {
  const declaration = extractDeclaration(source, name, label);
  const value = declaration.match(/=\s*(-?\d+(?:_\d+)*)\s*;?$/);
  assert.ok(value, `${label}: \`${name}\` is not a plain numeric constant`);
  return Number(value[1].replace(/_/g, ''));
};

const extractNumberArray = (source, name, label) => {
  // Multi-line array literals with trailing `// …` comments are fine.
  const match = source.match(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*(?::[^=]+)?=\\s*\\[([\\s\\S]*?)\\]`));
  assert.ok(match, `${label}: \`${name}\` is not an array literal`);
  return match[1]
    .replace(/\/\/[^\n]*/g, '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .map((item) => Number(item.replace(/_/g, '')))
    .filter((item) => Number.isFinite(item));
};

test('surf budget constants: the SurfSection copy matches surfSettings.ts', () => {
  const main = read('src/main/services/surfSettings.ts');
  const renderer = read('src/renderer/components/metabots/SurfSection.tsx');
  assert.equal(
    extractNumber(renderer, 'DEFAULT_SURF_INTERACTION_BUDGET', 'SurfSection'),
    extractNumber(main, 'DEFAULT_SURF_INTERACTION_BUDGET', 'surfSettings'),
    'SurfSection DEFAULT_SURF_INTERACTION_BUDGET must match the main default the runtime actually enforces',
  );
  assert.equal(
    extractNumber(renderer, 'MAX_SURF_INTERACTION_BUDGET', 'SurfSection'),
    extractNumber(main, 'MAX_SURF_INTERACTION_BUDGET', 'surfSettings'),
    'SurfSection MAX_SURF_INTERACTION_BUDGET must match, or the editor clamps users to a phantom ceiling',
  );
  assert.equal(
    extractNumber(renderer, 'MIN_SURF_INTERACTION_BUDGET', 'SurfSection'),
    0,
    'the surf budget floor is 0 by contract',
  );
});

test('A2A limit constants: the MetaBotEditTabs copy matches a2aChatLimits.ts', () => {
  const main = read('src/main/services/a2aChatLimits.ts');
  const renderer = read('src/renderer/components/metabots/MetaBotEditTabs.tsx');
  assert.equal(
    extractNumber(renderer, 'DEFAULT_A2A_MAX_INCOMING_TURNS', 'MetaBotEditTabs'),
    extractNumber(main, 'DEFAULT_A2A_MAX_INCOMING_TURNS', 'a2aChatLimits'),
    'MetaBotEditTabs DEFAULT_A2A_MAX_INCOMING_TURNS must match, or saving the edit form silently rewrites the stored NULL default to a stale cap',
  );
  assert.deepEqual(
    extractNumberArray(renderer, 'A2A_MAX_INCOMING_TURNS_OPTIONS', 'MetaBotEditTabs'),
    extractNumberArray(main, 'A2A_MAX_INCOMING_TURNS_OPTIONS', 'a2aChatLimits'),
    'the selectable turns options must match',
  );
  assert.equal(
    extractNumber(renderer, 'DEFAULT_A2A_BYE_COOLDOWN_MS', 'MetaBotEditTabs'),
    extractNumber(main, 'DEFAULT_A2A_BYE_COOLDOWN_MS', 'a2aChatLimits'),
    'MetaBotEditTabs DEFAULT_A2A_BYE_COOLDOWN_MS must match',
  );
  assert.deepEqual(
    extractNumberArray(renderer, 'A2A_BYE_COOLDOWN_MS_OPTIONS', 'MetaBotEditTabs'),
    extractNumberArray(main, 'A2A_BYE_COOLDOWN_MS_OPTIONS', 'a2aChatLimits'),
    'the selectable cooldown options must match',
  );
});
