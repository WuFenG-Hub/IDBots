import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBotBrowserBridgeService,
  HUMAN_ACCOUNT_ACTOR_ID,
  sanitizeHumanBridgeActor,
} from '../src/main/services/botBrowserBridgeService.ts';

const RESOURCE = 'metaapp://arena123i0';
const FEEDBACK_PATH = '/protocols/preference/feedback';
const FEEDBACK_TARGET_PIN = 'f'.repeat(64) + 'i0';
const OTHER_TARGET_PIN = '9'.repeat(64) + 'i0';

function createStore() {
  return {
    getMetabotById: (id) => (id === 7
      ? { id: 7, name: 'Alpha Bot', globalmetaid: 'IDQ1BOT ' }
      : null),
  };
}

function usableHuman(overrides = {}) {
  return { label: 'Sunny', globalMetaId: 'IDQ1HUMAN', signingAvailable: true, ...overrides };
}

function createService(overrides = {}) {
  const calls = { botPin: 0, humanPin: 0, resolvedPinPaths: [], humanPinOptions: [], audit: [] };
  const service = createBotBrowserBridgeService({
    metabotStore: createStore(),
    getHumanActor: () => overrides.human ?? null,
    createHumanPin: async (payload, options) => {
      calls.humanPin += 1;
      calls.humanPinOptions.push(options);
      if (overrides.humanPinOutcome) return overrides.humanPinOutcome();
      return { ok: true, pinId: `human-pin-${calls.humanPin}`, txids: [`human-tx-${calls.humanPin}`], totalCost: 2 };
    },
    createPin: async (_store, metabotId) => {
      calls.botPin += 1;
      return { pinId: `bot-pin-${calls.botPin}`, txids: [`bot-tx-${calls.botPin}`], totalCost: 1, metabotId };
    },
    resolvePinPath: async (pinId, rateLimitKey) => {
      calls.resolvedPinPaths.push(pinId);
      if (overrides.pinPathResolution) return overrides.pinPathResolution(pinId);
      if (pinId === FEEDBACK_TARGET_PIN) return { status: 'resolved', path: FEEDBACK_PATH };
      return { status: 'resolved', path: '/protocols/simplebuzz', rateLimitKey };
    },
    audit: (event) => calls.audit.push(event),
    ...overrides.deps,
  });
  return { service, calls };
}

function pinWritePayload(overrides = {}) {
  return {
    operation: 'create',
    path: FEEDBACK_PATH,
    encryption: '0',
    version: '1.0.0',
    contentType: 'application/json',
    payload: { encoding: 'utf8', value: JSON.stringify({ kind: 'comparison-batch' }) },
    ...overrides,
  };
}

test('sanitizeHumanBridgeActor exposes display fields only, with an Account marker', () => {
  const actor = sanitizeHumanBridgeActor(usableHuman());
  assert.deepEqual(actor, {
    uri: 'metaid://idq1human',
    globalMetaId: 'idq1human',
    name: 'Sunny (Account)',
    kind: 'idbots-account',
  });
  assert.equal(sanitizeHumanBridgeActor(null), null);
  assert.equal(sanitizeHumanBridgeActor({ ...usableHuman(), globalMetaId: 'nope' }), null);
});

test('human create write routes to the human signer after confirmation showing the actual signer', async () => {
  const { service, calls } = createService({ human: usableHuman() });

  const phaseOne = await service.writeMetaIdPin({
    actorId: HUMAN_ACCOUNT_ACTOR_ID,
    resourceUri: RESOURCE,
    payload: pinWritePayload(),
  });
  assert.equal(phaseOne.state, 'manual_action_required');
  assert.equal(phaseOne.data.confirmation.actor.kind, 'idbots-account');
  assert.equal(phaseOne.data.confirmation.actor.name, 'Sunny (Account)');
  assert.equal(calls.humanPin, 0);

  const result = await service.writeMetaIdPin({
    actorId: HUMAN_ACCOUNT_ACTOR_ID,
    ...phaseOne.data.confirmRequest,
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.pinId, 'human-pin-1');
  assert.equal(result.data.actor.kind, 'idbots-account');
  assert.equal(result.data.actor.globalMetaId, 'idq1human');
  assert.equal(calls.humanPin, 1);
  assert.equal(calls.botPin, 0);
});

test('bot write keeps using the MetaBot signer when both signers are wired', async () => {
  const { service, calls } = createService({ human: usableHuman() });

  const phaseOne = await service.writeMetaIdPin({
    actorId: 'idbots-metabot-7',
    resourceUri: RESOURCE,
    payload: pinWritePayload({ path: '/protocols/simplebuzz' }),
  });
  const result = await service.writeMetaIdPin({
    actorId: 'idbots-metabot-7',
    ...phaseOne.data.confirmRequest,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.actor.kind, 'idbots-agent');
  assert.equal(calls.botPin, 1);
  assert.equal(calls.humanPin, 0);
});

test('a confirmation issued to one Actor cannot be replayed as the other Actor', async () => {
  const { service, calls } = createService({ human: usableHuman() });

  // Confirmation issued for the human Actor.
  const humanPhaseOne = await service.writeMetaIdPin({
    actorId: HUMAN_ACCOUNT_ACTOR_ID,
    resourceUri: RESOURCE,
    payload: pinWritePayload(),
  });
  // Replay it under the Bot Actor id: must fail closed without signing.
  const replayAsBot = await service.writeMetaIdPin({
    actorId: 'idbots-metabot-7',
    ...humanPhaseOne.data.confirmRequest,
  });
  assert.equal(replayAsBot.ok, false);
  assert.equal(replayAsBot.code, 'invalid_request');

  // Confirmation issued for the Bot Actor.
  const botPhaseOne = await service.writeMetaIdPin({
    actorId: 'idbots-metabot-7',
    resourceUri: RESOURCE,
    payload: pinWritePayload({ path: '/protocols/simplebuzz' }),
  });
  // Replay it under the human Actor id: must fail closed without signing.
  const replayAsHuman = await service.writeMetaIdPin({
    actorId: HUMAN_ACCOUNT_ACTOR_ID,
    ...botPhaseOne.data.confirmRequest,
  });
  assert.equal(replayAsHuman.ok, false);
  assert.equal(replayAsHuman.code, 'invalid_request');

  assert.equal(calls.humanPin, 0);
  assert.equal(calls.botPin, 0);
});

test('a locked human signer is an explicit error and never falls back to the Bot', async () => {
  const { service, calls } = createService({
    human: usableHuman({ signingAvailable: false }),
  });

  const result = await service.writeMetaIdPin({
    actorId: HUMAN_ACCOUNT_ACTOR_ID,
    resourceUri: RESOURCE,
    payload: pinWritePayload(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'signer_unavailable');
  assert.match(result.message, /account Actor cannot sign/i);
  assert.equal(calls.humanPin, 0);
  assert.equal(calls.botPin, 0);
});

test('a human signer failing mid-write reports that identity, never substitutes the Bot', async () => {
  const { service, calls } = createService({
    human: usableHuman(),
    humanPinOutcome: () => ({ ok: false, error: 'SUBSIDY_NOT_CLAIMED' }),
  });

  const phaseOne = await service.writeMetaIdPin({
    actorId: HUMAN_ACCOUNT_ACTOR_ID,
    resourceUri: RESOURCE,
    payload: pinWritePayload(),
  });
  const result = await service.writeMetaIdPin({
    actorId: HUMAN_ACCOUNT_ACTOR_ID,
    ...phaseOne.data.confirmRequest,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'signer_unavailable');
  assert.equal(calls.botPin, 0);
});

test('a removed or replaced human identity invalidates its pending confirmation', async () => {
  let human = usableHuman();
  const { service, calls } = createService({ get human() { return human; } });

  const phaseOne = await service.writeMetaIdPin({
    actorId: HUMAN_ACCOUNT_ACTOR_ID,
    resourceUri: RESOURCE,
    payload: pinWritePayload(),
  });

  // Identity replaced under the same actor id: different globalMetaId.
  human = usableHuman({ globalMetaId: 'IDQ1OTHER' });
  const replaced = await service.writeMetaIdPin({
    actorId: HUMAN_ACCOUNT_ACTOR_ID,
    ...phaseOne.data.confirmRequest,
  });
  assert.equal(replaced.ok, false);
  assert.equal(replaced.code, 'invalid_request');

  // Identity removed entirely: explicit actor_required, no Bot fallback.
  human = null;
  const removed = await service.writeMetaIdPin({
    actorId: HUMAN_ACCOUNT_ACTOR_ID,
    resourceUri: RESOURCE,
    payload: pinWritePayload(),
  });
  assert.equal(removed.ok, false);
  assert.equal(removed.code, 'actor_required');
  assert.equal(calls.botPin, 0);
});

test('invalidateHumanActorState drops pending human confirmations and grants', async () => {
  const { service, calls } = createService({ human: usableHuman() });

  const phaseOne = await service.writeMetaIdPin({
    actorId: HUMAN_ACCOUNT_ACTOR_ID,
    resourceUri: RESOURCE,
    payload: pinWritePayload(),
  });
  service.invalidateHumanActorState();
  const result = await service.writeMetaIdPin({
    actorId: HUMAN_ACCOUNT_ACTOR_ID,
    ...phaseOne.data.confirmRequest,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_request');
  assert.equal(calls.humanPin, 0);
});

test('feedback modify/revoke is rejected before signing in both detectable forms', async () => {
  const { service, calls } = createService({ human: usableHuman() });

  // Direct protocol path form.
  const direct = await service.writeMetaIdPin({
    actorId: HUMAN_ACCOUNT_ACTOR_ID,
    resourceUri: RESOURCE,
    payload: pinWritePayload({ operation: 'modify', path: FEEDBACK_PATH, originalId: FEEDBACK_TARGET_PIN }),
  });
  assert.equal(direct.ok, false);
  assert.equal(direct.code, 'invalid_params');
  assert.match(direct.message, /create only/);

  // '@<targetPinId>' form resolved via the host pin-path resolver.
  const atPin = await service.writeMetaIdPin({
    actorId: HUMAN_ACCOUNT_ACTOR_ID,
    resourceUri: RESOURCE,
    payload: pinWritePayload({
      operation: 'revoke',
      path: `@${FEEDBACK_TARGET_PIN}`,
      originalId: FEEDBACK_TARGET_PIN,
      payload: { encoding: 'utf8', value: '' },
    }),
  });
  assert.equal(atPin.ok, false);
  assert.equal(atPin.code, 'invalid_params');
  assert.match(atPin.message, /create only/);
  assert.ok(calls.resolvedPinPaths.includes(FEEDBACK_TARGET_PIN));

  // Same '@' form for an unrelated path still reaches confirmation.
  const other = await service.writeMetaIdPin({
    actorId: HUMAN_ACCOUNT_ACTOR_ID,
    resourceUri: RESOURCE,
    payload: pinWritePayload({
      operation: 'modify',
      path: `@${OTHER_TARGET_PIN}`,
      originalId: OTHER_TARGET_PIN,
    }),
  });
  assert.equal(other.state, 'manual_action_required');

  // Bot Actor faces the same guard.
  const botRejected = await service.writeMetaIdPin({
    actorId: 'idbots-metabot-7',
    resourceUri: RESOURCE,
    payload: pinWritePayload({ operation: 'modify', path: FEEDBACK_PATH, originalId: FEEDBACK_TARGET_PIN }),
  });
  assert.equal(botRejected.ok, false);
  assert.equal(botRejected.code, 'invalid_params');

  assert.equal(calls.humanPin, 0);
  assert.equal(calls.botPin, 0);
});

test('feedback create still goes through the ordinary pin write flow', async () => {
  const { service, calls } = createService({ human: usableHuman() });

  const phaseOne = await service.writeMetaIdPin({
    actorId: HUMAN_ACCOUNT_ACTOR_ID,
    resourceUri: RESOURCE,
    payload: pinWritePayload(),
  });
  assert.equal(phaseOne.state, 'manual_action_required');
  assert.equal(phaseOne.data.confirmation.path, FEEDBACK_PATH);
  const result = await service.writeMetaIdPin({
    actorId: HUMAN_ACCOUNT_ACTOR_ID,
    ...phaseOne.data.confirmRequest,
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.path, FEEDBACK_PATH);
  assert.equal(calls.humanPin, 1);
});

test('Bot-only actions reject the human Actor explicitly, without Bot fallback', async () => {
  const { service, calls } = createService({ human: usableHuman() });
  const input = {
    actorId: HUMAN_ACCOUNT_ACTOR_ID,
    resourceUri: RESOURCE,
    sessionId: 'session-1',
    payload: {},
  };

  const upload = await service.uploadMetaFile({
    ...input,
    payload: { source: { kind: 'host-picker', accept: [] } },
  });
  assert.equal(upload.ok, false);
  assert.equal(upload.code, 'unsupported_actor');

  const llm = await service.completeLlm({
    ...input,
    payload: { messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(llm.ok, false);
  assert.equal(llm.code, 'unsupported_actor');

  const permissions = await service.requestPermissions({
    ...input,
    payload: { grants: [{ method: 'metaid.pin.write', operation: 'create', path: '/protocols/simplegroupchat' }] },
  });
  assert.equal(permissions.ok, false);
  assert.equal(permissions.code, 'unsupported_actor');

  assert.equal(calls.botPin, 0);
});

test('human Actor rejects non-MVC networks explicitly', async () => {
  const { service } = createService({ human: usableHuman() });
  const result = await service.writeMetaIdPin({
    actorId: HUMAN_ACCOUNT_ACTOR_ID,
    resourceUri: RESOURCE,
    payload: pinWritePayload(),
    network: 'doge',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unsupported_actor');
});

// ---------------------------------------------------------------------------
// Rework regressions (WS2 review): queued identity replacement, fail-closed
// '@pin' guard, confirmed-write audit
// ---------------------------------------------------------------------------

test('human writes carry the confirmed identity as expectedGlobalMetaId', async () => {
  const { service, calls } = createService({ human: usableHuman({ globalMetaId: 'IDQ1HUMAN' }) });

  const phaseOne = await service.writeMetaIdPin({
    actorId: HUMAN_ACCOUNT_ACTOR_ID,
    resourceUri: RESOURCE,
    payload: pinWritePayload(),
  });
  const result = await service.writeMetaIdPin({
    actorId: HUMAN_ACCOUNT_ACTOR_ID,
    ...phaseOne.data.confirmRequest,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.humanPinOptions, [{ expectedGlobalMetaId: 'idq1human' }]);
});

test('a write that dequeues onto a replaced identity fails with signer_changed, not a B signature', async () => {
  // Simulates the shared writer's dequeue-time identity check: the
  // confirmation was consumed for identity A, the identity was replaced
  // while the write waited, and the writer rejects with IDENTITY_MISMATCH.
  const { service, calls } = createService({
    human: usableHuman({ globalMetaId: 'IDQ1HUMAN' }),
    humanPinOutcome: () => ({ ok: false, error: 'IDENTITY_MISMATCH' }),
  });

  const phaseOne = await service.writeMetaIdPin({
    actorId: HUMAN_ACCOUNT_ACTOR_ID,
    resourceUri: RESOURCE,
    payload: pinWritePayload(),
  });
  const result = await service.writeMetaIdPin({
    actorId: HUMAN_ACCOUNT_ACTOR_ID,
    ...phaseOne.data.confirmRequest,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'signer_changed');
  assert.match(result.message, /replaced while this write was in flight/);
  assert.equal(calls.botPin, 0);
});

test("modify/revoke fails closed when the '@pin' target is not in the indexer", async () => {
  const { service, calls } = createService({
    human: usableHuman(),
    pinPathResolution: (pinId) => (pinId === FEEDBACK_TARGET_PIN
      ? { status: 'not-found' }
      : { status: 'resolved', path: '/protocols/simplebuzz' }),
  });

  const result = await service.writeMetaIdPin({
    actorId: HUMAN_ACCOUNT_ACTOR_ID,
    resourceUri: RESOURCE,
    payload: pinWritePayload({
      operation: 'modify',
      path: `@${FEEDBACK_TARGET_PIN}`,
      originalId: FEEDBACK_TARGET_PIN,
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_params');
  assert.match(result.message, /not known to the indexer/);
  assert.equal(calls.humanPin, 0);
  assert.equal(calls.botPin, 0);
});

test("modify/revoke fails closed when the '@pin' lookup errors or is rate limited", async () => {
  const { service, calls } = createService({
    human: usableHuman(),
    pinPathResolution: (pinId) => (pinId === FEEDBACK_TARGET_PIN
      ? { status: 'unknown' }
      : { status: 'resolved', path: '/protocols/simplebuzz' }),
  });

  const result = await service.writeMetaIdPin({
    actorId: HUMAN_ACCOUNT_ACTOR_ID,
    resourceUri: RESOURCE,
    payload: pinWritePayload({
      operation: 'revoke',
      path: `@${FEEDBACK_TARGET_PIN}`,
      originalId: FEEDBACK_TARGET_PIN,
      payload: { encoding: 'utf8', value: '' },
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_request');
  assert.match(result.message, /could not be verified right now/);
  assert.equal(calls.humanPin, 0);
  assert.equal(calls.botPin, 0);
});

test('non-MVC modify/revoke keeps the pre-guard behavior (no MVC indexer claim)', async () => {
  const { service, calls } = createService({ human: usableHuman() });

  // The human Actor rejects non-MVC outright, so the scoping check rides on
  // the Bot Actor (whose multi-network createPin path predates the guard).
  const result = await service.writeMetaIdPin({
    actorId: 'idbots-metabot-7',
    resourceUri: RESOURCE,
    network: 'doge',
    payload: pinWritePayload({
      operation: 'modify',
      path: `@${FEEDBACK_TARGET_PIN}`,
      originalId: FEEDBACK_TARGET_PIN,
    }),
  });
  assert.equal(result.state, 'manual_action_required');
  assert.equal(calls.resolvedPinPaths.length, 0);
});

test('confirmed two-phase writes emit a pin-write audit event naming the actual signer', async () => {
  const { service, calls } = createService({ human: usableHuman() });

  const phaseOne = await service.writeMetaIdPin({
    actorId: HUMAN_ACCOUNT_ACTOR_ID,
    resourceUri: RESOURCE,
    payload: pinWritePayload(),
  });
  const result = await service.writeMetaIdPin({
    actorId: HUMAN_ACCOUNT_ACTOR_ID,
    ...phaseOne.data.confirmRequest,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.audit.length, 1);
  assert.equal(calls.audit[0].type, 'pin-write');
  assert.equal(calls.audit[0].actorId, HUMAN_ACCOUNT_ACTOR_ID);
  assert.equal(calls.audit[0].actorGlobalMetaId, 'idq1human');
  assert.equal(calls.audit[0].path, FEEDBACK_PATH);
  assert.equal(calls.audit[0].pinId, 'human-pin-1');
  // No session id on a plain two-phase write (grants are Bot-only today).
  assert.equal(calls.audit[0].sessionId, '');
});
