// Source-contract + wiring tests for the Twin→Worker wrap-up delegation
// feature:
//  1. twinOrchestrationService passes wrapUpSignal (opt-in) with the pinned
//     constants; orchestratorCoworkBridge exposes it as an OPTIONAL param and
//     keeps the legacy passive watchdog for every caller without it;
//  2. NO other caller anywhere in src/main references wrapUpSignal
//     (group-task daemon, A2A/private-chat bindings, metaweb study and surf
//     sessions must stay untouched);
//  3. the compiled TwinOrchestrationService actually hands wrapUpSignal to the
//     worker-turn runner and its injector delivers through the cross-session
//     seam with Twin-session attribution.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { OrchestrationStore } = require('../dist-electron/main/orchestrationStore.js');
const { TwinOrchestrationService } = require('../dist-electron/main/services/twinOrchestrationService.js');
const { CoworkCrossSessionService } = require('../dist-electron/main/services/coworkCrossSession.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const readSource = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

function listSourceFiles(dir, accumulator = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist-electron') continue;
      listSourceFiles(full, accumulator);
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) {
      accumulator.push(full);
    }
  }
  return accumulator;
}

test('source contract: twinOrchestrationService passes wrapUpSignal with the pinned constants', () => {
  const source = readSource('src/main/services/twinOrchestrationService.ts');

  // The delegation budget call site opts in…
  const wrapUpPass = source.match(/wrapUpSignal:\s*\{[\s\S]*?\},/);
  assert.ok(wrapUpPass, 'executeAttempt must pass wrapUpSignal to runWorkerTurn');
  assert.ok(wrapUpPass[0].includes('graceMs: TWIN_DELEGATION_WRAP_UP_GRACE_MS'));
  assert.ok(wrapUpPass[0].includes('extensionRatio: TWIN_DELEGATION_WRAP_UP_EXTENSION_RATIO'));
  assert.ok(wrapUpPass[0].includes('injectMessage:'));

  // …with the pinned 5-min grace and 0.5 ratio (30+5=35 / 30+10+5=45 ≤ 45).
  assert.ok(
    /TWIN_DELEGATION_WRAP_UP_GRACE_MS = 5 \* 60_000/.test(source),
    'grace constant must stay 5 minutes',
  );
  assert.ok(
    /TWIN_DELEGATION_WRAP_UP_EXTENSION_RATIO = 0\.5/.test(source),
    'extension ratio constant must stay 0.5',
  );
});

test('source contract: the bridge exposes wrapUpSignal as an optional param with the legacy path intact', () => {
  const source = readSource('src/main/services/orchestratorCoworkBridge.ts');
  assert.ok(/wrapUpSignal\?:\s*\{/.test(source), 'wrapUpSignal must be an optional param');
  // The machine is only engaged when the caller passed the param…
  assert.ok(
    /params\.wrapUpSignal\s*\?\?\s*resolveWrapUpRuntimeConfig|const wrapUpConfig = params\.wrapUpSignal/.test(source),
    'wrap-up config must resolve from params.wrapUpSignal (undefined → null → legacy)',
  );
  // …and the legacy watchdog branch (reject + recovery) is still present for
  // every caller without it.
  assert.ok(
    source.includes('reject(new SkillTurnTimeoutError(sessionId, skillTurnTimeoutMs))'),
    'legacy watchdog rejection must remain',
  );
  assert.ok(source.includes('enterRecovery()'), 'legacy recovery parking must remain');
});

test('source contract: wrapUpSignal is referenced ONLY by the bridge and the twin service', () => {
  const offenders = listSourceFiles(path.join(repoRoot, 'src', 'main'))
    .filter((file) => fs.readFileSync(file, 'utf8').includes('wrapUpSignal'))
    .map((file) => path.relative(repoRoot, file));
  assert.deepEqual(
    offenders.sort(),
    [
      'src/main/libs/skillTurnWrapUpState.ts',
      'src/main/services/orchestratorCoworkBridge.ts',
      'src/main/services/twinOrchestrationService.ts',
    ],
    `wrapUpSignal must not leak to any other caller; found: ${offenders.join(', ')}`,
  );

  // Explicit spot checks for the callers named in the acceptance criteria.
  for (const forbidden of [
    'src/main/services/groupTaskDaemon.ts',
    'src/main/main.ts',
    'src/main/services/privateChatDaemon.ts',
    'src/main/services/openTeamGuestDaemon.ts',
  ]) {
    assert.ok(
      !fs.readFileSync(path.join(repoRoot, forbidden), 'utf8').includes('wrapUpSignal'),
      `${forbidden} must not opt into wrapUpSignal`,
    );
  }
});

test('wiring: delegateLocalWorker hands wrapUpSignal to the worker turn and the injector delivers via the cross-session seam', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-wrap-up-contract-'));
  const sqliteStore = await SqliteStore.create(tempDir);
  const orchestrationStore = new OrchestrationStore(
    sqliteStore.getDatabase(),
    sqliteStore.getSaveFunction(),
  );

  const bots = [
    { id: 1, name: 'Twin', enabled: true, metabot_type: 'twin', boss_global_metaid: 'owner-global', skills: [] },
    { id: 2, name: 'Builder', enabled: true, metabot_type: 'worker', boss_global_metaid: 'owner-global', skills: [] },
  ];
  const directory = {
    getSession: (id) => (id === 'twin-session' ? { id, metabotId: 1 } : null),
    listMetabots: () => bots,
    getOwnerGlobalMetaId: () => 'owner-global',
  };

  // Real CoworkCrossSessionService over a minimal session map so the injector
  // exercises the actual insert path (content wrap + metadata attribution).
  const sessions = new Map([
    ['twin-session', { id: 'twin-session', sessionType: 'standard' }],
    ['worker-session-2', { id: 'worker-session-2', sessionType: 'standard' }],
  ]);
  const inserted = [];
  const crossStore = {
    getSession: (id) => sessions.get(id) ?? null,
    getSessionMetadata: (id) => sessions.get(id) ?? null,
    getSessionLatestMessage: () => null,
    getSessionLatestVisibleMessage: () => null,
    addMessage: (sessionId, message) => {
      const full = { id: `m-${inserted.length + 1}`, timestamp: 1700000000000, ...message };
      inserted.push({ targetSessionId: sessionId, message: full });
      return full;
    },
  };
  const crossService = new CoworkCrossSessionService(crossStore);

  let capturedParams = null;
  const service = new TwinOrchestrationService({
    orchestrationStore,
    coworkStore: {},
    coworkRunner: { insertCrossSessionMessageAndQueue: () => { throw new Error('default path must not be used when the injector override is exercised'); } },
    directory,
    getMetabotById: (id) => bots.find((bot) => bot.id === id) ?? null,
    getWorkerWorkspace: (id) => `/tmp/idbots-worker-${id}`,
    insertCrossSessionUserMessage: (input) => crossService.insertUserMessage(input),
    runWorkerTurn: async (params) => {
      capturedParams = params;
      await params.onSessionCreated('worker-session-2');
      return 'WRAP_UP: handoff for the wiring test.';
    },
  });

  try {
    const result = await service.delegateLocalWorker('twin-session', {
      workerMetabotId: 2,
      objective: 'prove the wrap-up wiring',
      idempotencyKey: 'wrap-up-contract-key',
    });

    // executeAttempt settles asynchronously (delegateLocalWorker returns the
    // initial attempt snapshot) — poll for the completed state like the
    // existing twin-orchestration suite does.
    const deadline = Date.now() + 2000;
    let attempt = null;
    while (Date.now() < deadline) {
      attempt = orchestrationStore.getAttempt(result.attempt.id);
      if (attempt?.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(attempt?.status, 'completed', 'worker attempt must complete');
    assert.equal(attempt?.result?.replyText, 'WRAP_UP: handoff for the wiring test.');

    // The delegation opts in with the pinned twin values.
    assert.ok(capturedParams, 'runWorkerTurn must have been invoked');
    assert.ok(capturedParams.wrapUpSignal, 'wrapUpSignal must be passed on the twin delegation path');
    assert.equal(capturedParams.wrapUpSignal.graceMs, 5 * 60_000);
    assert.equal(capturedParams.wrapUpSignal.extensionRatio, 0.5);
    assert.equal(typeof capturedParams.wrapUpSignal.injectMessage, 'function');

    // The injector resolves the worker session at call time and delivers with
    // Twin-session attribution ("哪里发起哪里结束").
    await capturedParams.wrapUpSignal.injectMessage('WRAP-UP CONTRACT PROBE');
    const probe = inserted.find((entry) => entry.message.content.includes('WRAP-UP CONTRACT PROBE'));
    assert.ok(probe, 'the wrap-up message must land in the worker session');
    assert.equal(probe.targetSessionId, 'worker-session-2');
    assert.equal(probe.message.type, 'user');
    assert.equal(probe.message.metadata.sourceSessionId, 'twin-session');
    assert.equal(probe.message.metadata.sourceChannel, 'idbots_cross_session');
  } finally {
    await sqliteStore.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
