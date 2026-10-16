// Static wiring checks + behavioral coverage for the unattended-automation
// reasoning-effort policy: machine-driven turns (delegated/scheduled/long-term
// tasks, group tasks, Meta-to-Meta A2A chats, orchestration runs) never
// consult the cerebellum per-message effort selector — their "auto" rung
// resolves straight to the bot edit page's brain pick, else max — while
// human-sent messages (cowork UI chats, IM/Telegram conversations) keep the
// per-message cerebellum classification.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const coworkRunnerSource = readFileSync(join(here, '../src/main/libs/coworkRunner.ts'), 'utf8');

test('the cerebellum effort selector never fires for unattended automation turns', () => {
  // The auto-selector kick must be gated on the unattended classification —
  // machine-driven turns resolve locally and pay no JEV round-trip.
  assert.ok(
    coworkRunnerSource.includes(
      'effectiveEffortRung == null && !unattendedTurn && this.cerebellumEffortSelector',
    ),
    'coworkRunner: the effort selector kick must skip unattended automation sessions',
  );
});

test('the unattended classifier keys off auto-origin, session type, and source channel', () => {
  const classifier = coworkRunnerSource.match(
    /private isUnattendedAutomationSession\(sessionId: string\): boolean \{[\s\S]*?\n  \}/,
  );
  assert.ok(classifier, 'isUnattendedAutomationSession must exist');
  const body = classifier[0];
  assert.ok(
    body.includes('session.autoOrigin'),
    'the classifier must treat auto-created runs (schedule/longterm/orchestration) as unattended',
  );
  assert.ok(
    body.includes("startsWith('im:')"),
    'the classifier must keep human IM conversations (im:<platform>[:direct|:group]) on the interactive path',
  );
  assert.ok(
    body.includes("sessionType ?? 'standard') !== 'standard'"),
    'the classifier must treat non-standard session types (A2A metaweb/browser/group) as unattended',
  );
  assert.ok(
    body.includes("sourceChannel !== 'cowork_ui'"),
    'the classifier must keep cowork UI chats interactive and treat other channels as unattended',
  );
});

test('both per-turn effort chains route unattended turns through resolveUnattendedAutoEffort', () => {
  // Primary route reads the brain effort, the GT-02 fallback-brain route the
  // fallback brain effort — both must take the unattended branch before the
  // interactive auto rung.
  const unattendedBranches = coworkRunnerSource.match(
    /unattendedTurn\s*\?\s*resolveUnattendedAutoEffort\(\{/g,
  ) ?? [];
  assert.ok(
    unattendedBranches.length >= 2,
    'coworkRunner: primary and fallback effort chains must resolve unattended auto effort locally',
  );
  const brainFeeds = coworkRunnerSource.match(
    /unattendedTurn\s*\?\s*resolveUnattendedAutoEffort\(\{\s*\n\s*brainEffort: automationBrain\?\.(?:effort|fallbackEffort),/g,
  ) ?? [];
  assert.ok(
    brainFeeds.length >= 2,
    'coworkRunner: the unattended branches must feed the primary and fallback brain efforts respectively',
  );
});

// --- behavioral: the pure resolver (compiled runner) ---

test('resolveUnattendedAutoEffort: brain pick first, auto means max, explicit global honored for brain-less bots', async () => {
  const { resolveUnattendedAutoEffort } = await import('../dist-electron/main/libs/coworkRunner.js');
  // THE core policy: a bot pinned in the edit page runs its exact rung on
  // every unattended call — the cerebellum may no longer downgrade it.
  assert.equal(
    resolveUnattendedAutoEffort({ brainEffort: 'high', hasBrain: true, globalEffort: 'off' }),
    'high',
  );
  assert.equal(
    resolveUnattendedAutoEffort({ brainEffort: 'max', hasBrain: true, globalEffort: null }),
    'max',
  );
  // A brain left on Auto ('' / null / sentinel token) resolves to max.
  assert.equal(
    resolveUnattendedAutoEffort({ brainEffort: null, hasBrain: true, globalEffort: 'off' }),
    'max',
  );
  assert.equal(
    resolveUnattendedAutoEffort({ brainEffort: '', hasBrain: true, globalEffort: null }),
    'max',
  );
  assert.equal(
    resolveUnattendedAutoEffort({ brainEffort: 'default', hasBrain: true, globalEffort: null }),
    'max',
  );
  // Legacy leftover tokens convert at the read boundary like everywhere else.
  assert.equal(
    resolveUnattendedAutoEffort({ brainEffort: 'xhigh', hasBrain: true, globalEffort: null }),
    'max',
  );
  assert.equal(
    resolveUnattendedAutoEffort({ brainEffort: 'medium', hasBrain: true, globalEffort: null }),
    'low',
  );
  // Brain-less sessions honor an explicit persisted global pick...
  assert.equal(
    resolveUnattendedAutoEffort({ brainEffort: null, hasBrain: false, globalEffort: 'low' }),
    'low',
  );
  // ...and default to max when the global is also auto/unset.
  assert.equal(
    resolveUnattendedAutoEffort({ brainEffort: null, hasBrain: false, globalEffort: null }),
    'max',
  );
  assert.equal(
    resolveUnattendedAutoEffort({ brainEffort: undefined, hasBrain: false, globalEffort: undefined }),
    'max',
  );
});
