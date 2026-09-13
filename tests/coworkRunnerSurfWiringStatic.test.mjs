import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * Source-anchor regression test for the round-3 field-trial wiring bug:
 * CoworkRunner declared `private metawebSurf?: MetawebSurfControl` and used it
 * in three places (surf createPin guard ledger reads, self-interaction block,
 * metaweb_surf_* tool registration) but the constructor NEVER ASSIGNED it —
 * `this.metawebSurf` was undefined in every production surf run, so the
 * cross-run duplicate-interaction check and the own-pin block silently never
 * fired (a duplicate like on pin 4b2b7dee… slipped through in 小昆's second
 * live surf), and the surf chat tools never registered. One-line fix; this
 * anchor keeps the assignment from ever being dropped again.
 */

const source = readFileSync(
  new URL('../src/main/libs/coworkRunner.ts', import.meta.url),
  'utf8',
);

test('the CoworkRunner constructor assigns options.metawebSurf (round-3 wiring regression)', () => {
  assert.match(
    source,
    /this\.metawebSurf = options\?\.metawebSurf;/,
    'constructor must assign options.metawebSurf — without it the surf guard ledger checks and the metaweb_surf_* tools are silently dead',
  );
});

test('the assignment lands in the constructor next to the sibling controls', () => {
  const studyIdx = source.indexOf('this.metawebStudy = options?.metawebStudy;');
  const surfIdx = source.indexOf('this.metawebSurf = options?.metawebSurf;');
  const uploadIdx = source.indexOf('this.metaFileUpload = options?.metaFileUpload;');
  assert.ok(studyIdx !== -1 && surfIdx !== -1 && uploadIdx !== -1);
  assert.ok(
    studyIdx < surfIdx && surfIdx < uploadIdx,
    'metawebSurf assignment should sit with the other control assignments in the constructor',
  );
});

test('the surf guard reads the seen ledger and own-pin check through the control', () => {
  assert.match(source, /this\.metawebSurf\?\.getSurfSeenAction\?\.\(metabotId, pinId\)/);
  assert.match(source, /this\.metawebSurf\?\.isOwnPin\?\.\(metabotId, pinId\)/);
});

test('runtime: a runner built with options.metawebSurf actually carries the control', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { CoworkRunner } = require('../dist-electron/main/libs/coworkRunner.js');
  // The constructor only touches the store lazily; a method-absorbing proxy
  // is enough for this wiring assertion.
  const fakeStore = new Proxy({}, { get: () => () => undefined });
  const control = { getSurfSeenAction: () => 'liked' };
  const runner = new CoworkRunner(fakeStore, { metawebSurf: control });
  assert.equal(
    runner.metawebSurf,
    control,
    'options.metawebSurf must reach the instance — the field was silently unassigned in production',
  );
});

/**
 * Step-1 broadcast-collaboration wiring (create_scheduled_task — the
 * surf→work handoff). Same failure mode as the round-3 bug above: declaring
 * the option without assigning/registering it would silently kill the
 * handoff, so every link gets a source anchor here.
 */

test('the CoworkRunner constructor assigns options.scheduledTaskTools', () => {
  assert.match(
    source,
    /this\.scheduledTaskTools = options\?\.scheduledTaskTools;/,
    'constructor must assign options.scheduledTaskTools — without it create_scheduled_task never registers',
  );
});

test('create_scheduled_task is registered only for surf sessions, off the session marker', () => {
  assert.match(source, /const surfSessionMarker = this\.activeSessions\.get\(sessionId\)\?\.metawebSurfSession;/);
  assert.match(
    source,
    /if \(this\.scheduledTaskTools && surfSessionMarker\) \{[\s\S]*?buildScheduledTaskAgentTools\(\{/,
    'the tool must be gated on BOTH the control and the surf session marker',
  );
});

test('create_scheduled_task survives the surf allowlist filter', () => {
  const allowlistIdx = source.indexOf('const METAWEB_SURF_TOOL_ALLOWLIST = new Set([');
  const toolIdx = source.indexOf("'create_scheduled_task',", allowlistIdx);
  assert.ok(allowlistIdx !== -1 && toolIdx > allowlistIdx, 'create_scheduled_task must be inside METAWEB_SURF_TOOL_ALLOWLIST');
});
