// Static wiring checks for the reasoning-effort "Default" rung fix: an
// explicit Default pick in a composer/session picker must stick in the
// display and reach the session as the 'default' sentinel (model default
// wins over the bot brain / global rungs), instead of snapping back to the
// highest fallback tier.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const readSource = (relative) => readFileSync(join(here, relative), 'utf8');

const coworkViewSource = readSource('../src/renderer/components/cowork/CoworkView.tsx');
const botBrowserPanelSource = readSource('../src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx');
const sessionDetailSource = readSource('../src/renderer/components/cowork/CoworkSessionDetail.tsx');

test('composer pickers keep an explicit Default pick instead of falling through to brain/global', () => {
  // The old `pendingModelEffort?.effort ?? …` chain treated "picked Default"
  // the same as "never picked", so the chip snapped to the highest fallback
  // rung and the choice could not be kept.
  for (const [name, source] of [['CoworkView', coworkViewSource], ['BotBrowserCoworkPanel', botBrowserPanelSource]]) {
    assert.ok(
      !source.includes('pendingModelEffort?.effort'),
      `${name}: display/submit must not conflate an explicit Default pick with a missing pick`,
    );
    assert.ok(
      source.includes('effortDisplayForPick('),
      `${name}: display effort must resolve through effortDisplayForPick`,
    );
    assert.ok(
      source.includes('effortForSessionStart('),
      `${name}: session start must map the pick through effortForSessionStart`,
    );
  }
});

test('session detail picker persists an explicit Default pick as the sentinel', () => {
  assert.ok(
    sessionDetailSource.includes('value.effort ?? LLM_EFFORT_DEFAULT_SENTINEL'),
    'setSessionModel must carry the sentinel for an explicit Default pick',
  );
  assert.ok(
    sessionDetailSource.includes('return convertLegacyEffortLevel(sessionEffortOverride)'),
    'the optimistic override read-back must convert the sentinel to a display level',
  );
});
