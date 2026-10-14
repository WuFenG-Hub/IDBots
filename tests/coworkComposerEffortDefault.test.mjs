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
const modelCatalogSource = readSource('../src/renderer/services/modelCatalog.ts');
const mainSource = readSource('../src/main/main.ts');
const coworkRunnerSource = readSource('../src/main/libs/coworkRunner.ts');

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

test('a configured bot brain outranks the persisted global effort', () => {
  // Session start must NOT seed the persisted global effort into
  // effortOverride — that would shadow the bot brain rung for every
  // bot-bound session and pin the UI's "max" onto brains set to Default.
  assert.ok(
    !mainSource.includes(': getPersistedCoworkEffortLevel(),'),
    'main.ts: startSession must leave effort unset when the composer sent no pick',
  );
  // The per-turn runtime tiering gates the global rung on brain absence
  // (primary brain and fallback-brain takeover alike).
  const gatedRung = 'automationBrain ? null : getPersistedCoworkEffortLevel()';
  assert.ok(
    coworkRunnerSource.split(gatedRung).length - 1 >= 2,
    'coworkRunner: primary and fallback effort chains must skip the global rung when a bot brain exists',
  );
  // The composer/session pickers mirror the same rule in the display layer.
  assert.ok(
    coworkViewSource.includes('selectedMetabotBrain?.fallback_llm_id'),
    'CoworkView: the global effort display fallback must be gated on the bot having no configured brain',
  );
  assert.ok(
    sessionDetailSource.includes('sessionMetabot?.fallback_llm_id'),
    'CoworkSessionDetail: the global effort display fallback must be gated on the bot having no configured brain',
  );
});

test('assistant chat-experience mode defaults reasoning off behind the auto rung; a session override wins', () => {
  // Both per-turn chains (primary route and GT-02 fallback-brain route) hoist
  // the explicit session override AHEAD of everything — a user pick in the
  // session picker must stick at runtime. Without an override the cerebellum
  // AUTO rung comes next (autoEffortRung — resolved by the per-turn JEV
  // selector; null keeps the legacy behavior), then assistant mode pins 'off'
  // and skips the bot brain / persisted global / per-model tail (any reasoning
  // pass would delay the first visible token the mode promises). The
  // professional-mode chain (asserted above) stays intact behind the same
  // expression.
  assert.ok(
    coworkRunnerSource.includes('getPersistedChatExperienceMode'),
    'coworkRunner: effort resolution must read the persisted chat experience mode',
  );
  const overrideFirstChains = coworkRunnerSource.match(
    /sessionEffortPicked\s*\?\s*toLlmEffortLevel\(effectiveEffortRung\)\s*:\s*autoEffortRung\s*\?\?/g,
  ) ?? [];
  assert.ok(
    overrideFirstChains.length >= 2,
    'coworkRunner: primary and fallback effort chains must hoist the session override ahead of the auto rung',
  );
  const autoAheadOfOff = coworkRunnerSource.match(
    /autoEffortRung\s*\?\?\s*\(assistantMode\s*\?\s*'off'/g,
  ) ?? [];
  assert.ok(
    autoAheadOfOff.length >= 2,
    'coworkRunner: the auto rung must resolve ahead of the assistant-mode off rung on both chains',
  );
  const assistantSkipsTail = coworkRunnerSource.match(
    /assistantMode\s*\?\s*'off'\s*:\s*toLlmEffortLevel\(\s*automationBrain/g,
  ) ?? [];
  assert.ok(
    assistantSkipsTail.length >= 2,
    'coworkRunner: without a session override, assistant mode must skip the brain/global/model tail',
  );
});

test('assistant mode displays the Auto rung when the session has no explicit pick', () => {
  // The unpicked display is the Auto rung (null): the turn resolves its effort
  // through the cerebellum auto selector when configured and falls back to the
  // legacy default chain (off in assistant mode) otherwise.
  assert.ok(
    modelCatalogSource.includes('if (options?.assistantMode) return null;'),
    'modelCatalog: effortDisplayForPick must display the Auto rung for a missing pick in assistant mode',
  );
  assert.ok(
    sessionDetailSource.includes('if (isAssistantMode) return null;'),
    'CoworkSessionDetail: the session picker must display the Auto rung in assistant mode when no override exists',
  );
  // The composer display chains must receive the mode flag.
  assert.ok(
    coworkViewSource.includes('{ assistantMode: isAssistantMode }'),
    'CoworkView: the composer display chain must receive the assistant-mode flag',
  );
  assert.ok(
    botBrowserPanelSource.includes('{ assistantMode: isAssistantMode }'),
    'BotBrowserCoworkPanel: the panel display chain must receive the assistant-mode flag',
  );
});
