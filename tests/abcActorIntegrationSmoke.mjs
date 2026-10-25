/**
 * ABC 0.7.1 Human/Bot Actor integration smoke (idbots-requirements WS-A/WS-B).
 *
 * Exercises the REAL modules — the installed @openagentinternet 0.7.1
 * contract, the renderer Actor model, and the main-process bridge service
 * (motion-video host implementation) — with stubbed chain signers (no
 * broadcast). Run: node tests/abcActorIntegrationSmoke.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { browserActorKindGroup } from '@openagentinternet/agent-browser-host-contract';

import {
  resolveBrowserRuntimeActors,
} from '../src/renderer/features/botBrowser/idbotsBrowserActorModel.js';
import {
  createBotBrowserBridgeService,
  HUMAN_ACCOUNT_ACTOR_ID,
} from '../src/main/services/botBrowserBridgeService.ts';

const contractPkg = JSON.parse(readFileSync(
  new URL('../node_modules/@openagentinternet/agent-browser-host-contract/package.json', import.meta.url),
  'utf8',
));
const uiPkgPath = new URL('../node_modules/@openagentinternet/agent-browser-ui/dist/renderers.js', import.meta.url);

let step = 0;
function evidence(message) {
  step += 1;
  console.log(`  [smoke ${String(step).padStart(2, '0')}] PASS  ${message}`);
}

// 1. Released contract version + kind grouping.
assert.equal(contractPkg.version, '0.7.1');
assert.equal(browserActorKindGroup('idbots-account'), 'human');
assert.equal(browserActorKindGroup('idbots-agent'), 'bot');
assert.equal(browserActorKindGroup('constructor'), 'unknown');
assert.equal(browserActorKindGroup('__proto__'), 'unknown');
evidence(`contract @openagentinternet/agent-browser-host-contract@${contractPkg.version} groups idbots-account=human / idbots-agent=bot / prototype keys=unknown`);

// 2. Installed UI tree carries the regenerated allow-forms patch.
const renderersSource = readFileSync(uiPkgPath, 'utf8');
assert.equal(renderersSource.includes("'allow-scripts allow-downloads allow-forms'"), true);
evidence('installed agent-browser-ui 0.7.1 tree carries the regenerated allow-forms sandbox patch');

// 3. Runtime actors: human first, Bot default preserved, same-identity Bots deduped.
const metabots = [
  { id: 7, name: 'Alpha Bot', globalmetaid: 'IDQ1ABC', created_at: 10 },
  { id: 9, name: 'Twin', globalmetaid: 'IDP1HUMAN', created_at: 20 },
  { id: 11, name: 'Beta Bot', globalmetaid: 'IDQ1DEF', created_at: 30 },
];
const human = {
  label: 'Sunny',
  globalMetaId: 'IDP1HUMAN',
  avatar: 'data:image/png;base64,AAAA',
  signingAvailable: true,
  // Secret-bearing fields that must never surface in a runtime Actor.
  mnemonic: 'never leak me',
  path: "m/44'/10001'/0'/0/0",
};
const { actors, defaultActor } = resolveBrowserRuntimeActors(metabots, human);
assert.deepEqual(
  actors.map((actor) => [actor.id, actor.kind]),
  [
    [HUMAN_ACCOUNT_ACTOR_ID, 'idbots-account'],
    ['idbots-metabot-7', 'idbots-agent'],
    ['idbots-metabot-11', 'idbots-agent'],
  ],
);
assert.equal(defaultActor.id, 'idbots-metabot-7', 'existing Bot default is preserved');
assert.equal(JSON.stringify(actors).includes('never leak me'), false);
assert.equal(JSON.stringify(actors).includes("m/44'/10001"), false);
assert.equal(actors.find((actor) => actor.id === 'idbots-metabot-9'), undefined, 'the Bot sharing the human GlobalMetaId is deduped');
const botOnly = resolveBrowserRuntimeActors([], human);
assert.equal(botOnly.defaultActor.id, HUMAN_ACCOUNT_ACTOR_ID, 'no-Bot fallback: usable human becomes default');
evidence('runtime actors = [human, ...deduped bots]; default stays the default Bot; no secrets in the snapshot');

// 4-9. Bridge service with stubbed signers.
let botSignCalls = 0;
let humanSignCalls = 0;
let humanSignCallsExpectedGlobalMetaId = [];
let currentHuman = { ...human };
const auditEvents = [];
let confirmationSequence = 0;
const service = createBotBrowserBridgeService({
  metabotStore: { getMetabotById: (id) => (id === 7 ? metabots[0] : id === 9 ? metabots[1] : null) },
  createPin: async () => {
    botSignCalls += 1;
    return { pinId: 'botpin123i0', txids: ['bottx1'], totalCost: 1 };
  },
  getHumanActor: () => currentHuman,
  createHumanPin: async (metaidPayload, options) => {
    humanSignCalls += 1;
    humanSignCallsExpectedGlobalMetaId.push(options?.expectedGlobalMetaId ?? null);
    return { ok: true, pinId: 'humanpin123i0', txids: ['humantx1'], totalCost: 2 };
  },
  createConfirmationId: () => `confirmation-${++confirmationSequence}`,
  createConfirmationToken: () => 'opaque-token',
  audit: (event) => auditEvents.push(event),
});

const pinWritePayload = (value, overrides = {}) => ({
  operation: 'create',
  path: '/protocols/simplebuzz',
  encryption: '0',
  version: '1.0',
  contentType: 'application/json',
  payload: { encoding: 'utf8', value },
  display: { title: 'Smoke write' },
  ...overrides,
});

// 4. Human two-phase write: confirmation identity == signer identity == result actor.
const humanPhaseOne = await service.writeMetaIdPin({
  actorId: HUMAN_ACCOUNT_ACTOR_ID,
  resourceUri: 'metaapp://app123i0',
  payload: pinWritePayload('{"human":true}'),
});
assert.equal(humanPhaseOne.state, 'manual_action_required');
assert.equal(humanPhaseOne.data.confirmation.actor.kind, 'idbots-account');
assert.equal(humanPhaseOne.data.confirmation.actor.globalMetaId, 'idp1human');
const humanPhaseTwo = await service.writeMetaIdPin({
  actorId: HUMAN_ACCOUNT_ACTOR_ID,
  resourceUri: humanPhaseOne.data.confirmRequest.resourceUri,
  payload: humanPhaseOne.data.confirmRequest.payload,
});
assert.equal(humanPhaseTwo.ok, true);
assert.equal(humanPhaseTwo.data.actor.globalMetaId, 'idp1human');
assert.equal(humanSignCalls, 1);
assert.equal(humanSignCallsExpectedGlobalMetaId[0], 'idp1human');
assert.equal(botSignCalls, 0);
evidence('human Actor write confirmed+signed as idp1human via the human stack with expectedGlobalMetaId re-check (Bot signer untouched)');

// 5. Actor-switch replay fails closed in both directions.
const botPhaseOne = await service.writeMetaIdPin({
  actorId: 'idbots-metabot-7',
  resourceUri: 'metaapp://app123i0',
  payload: pinWritePayload('{"bot":true}'),
});
assert.equal(botPhaseOne.state, 'manual_action_required');
const replayAsHuman = await service.writeMetaIdPin({
  actorId: HUMAN_ACCOUNT_ACTOR_ID,
  resourceUri: botPhaseOne.data.confirmRequest.resourceUri,
  payload: botPhaseOne.data.confirmRequest.payload,
});
assert.equal(replayAsHuman.ok, false);
assert.equal(replayAsHuman.code, 'invalid_request');
const humanPhaseOne2 = await service.writeMetaIdPin({
  actorId: HUMAN_ACCOUNT_ACTOR_ID,
  resourceUri: 'metaapp://app123i0',
  payload: pinWritePayload('{"human2":true}'),
});
const replayAsBot = await service.writeMetaIdPin({
  actorId: 'idbots-metabot-7',
  resourceUri: humanPhaseOne2.data.confirmRequest.resourceUri,
  payload: humanPhaseOne2.data.confirmRequest.payload,
});
assert.equal(replayAsBot.ok, false);
assert.equal(replayAsBot.code, 'invalid_request');
evidence('cross-Actor confirmation replay fails closed in both directions');

// 6. Forged Actor ids never reach a signer.
for (const actorId of ['idbots-account', 'idbots-account-2', 'human:idbots-account-1', 'idbots-metabot-999999']) {
  const forged = await service.writeMetaIdPin({
    actorId,
    resourceUri: 'metaapp://app123i0',
    payload: pinWritePayload('{"forged":true}'),
  });
  assert.equal(forged.ok, false, actorId);
  assert.equal(forged.code, 'actor_required', actorId);
}
assert.equal(botSignCalls, 0);
assert.equal(humanSignCalls, 1);
evidence('forged/unknown Actor ids rejected with actor_required before any signer runs');

// 7. Unsupported Human×action combos fail explicitly.
const humanLlm = await service.completeLlm({
  actorId: HUMAN_ACCOUNT_ACTOR_ID,
  resourceUri: 'metaapp://app123i0',
  sessionId: 'session-smoke',
  payload: { messages: [{ role: 'user', content: 'hi' }] },
});
assert.equal(humanLlm.ok, false);
assert.equal(humanLlm.code, 'unsupported_actor');
const humanUpload = await service.uploadMetaFile({
  actorId: HUMAN_ACCOUNT_ACTOR_ID,
  resourceUri: 'metaapp://app123i0',
  payload: { source: { kind: 'host-picker', accept: ['image/png'] } },
});
assert.equal(humanUpload.ok, false);
assert.equal(humanUpload.code, 'unsupported_actor');
const humanPermissions = await service.requestPermissions({
  actorId: HUMAN_ACCOUNT_ACTOR_ID,
  resourceUri: 'metaapp://app123i0',
  sessionId: 'session-smoke',
  payload: { grants: [{ method: 'metaid.pin.write', operation: 'create', path: '/protocols/simplegroupchat' }] },
});
assert.equal(humanPermissions.ok, false);
assert.equal(humanPermissions.code, 'unsupported_actor');
evidence('human Actor llm-complete / metafile-upload / permissions-request fail explicitly (unsupported_actor)');

// 8. A locked human signer is an explicit error, never a Bot fallback.
currentHuman = { ...human, signingAvailable: false };
const lockedWrite = await service.writeMetaIdPin({
  actorId: HUMAN_ACCOUNT_ACTOR_ID,
  resourceUri: 'metaapp://app123i0',
  payload: pinWritePayload('{"locked":true}'),
});
assert.equal(lockedWrite.ok, false);
assert.equal(lockedWrite.code, 'signer_unavailable');
assert.equal(botSignCalls, 0);
currentHuman = { ...human };
evidence('locked human signer returns signer_unavailable instead of substituting a Bot');

// 9. Human identity state invalidation clears pending human confirmations.
const pendingHuman = await service.writeMetaIdPin({
  actorId: HUMAN_ACCOUNT_ACTOR_ID,
  resourceUri: 'metaapp://app123i0',
  payload: pinWritePayload('{"pending":true}'),
});
assert.equal(pendingHuman.state, 'manual_action_required');
service.invalidateHumanActorState();
const replayAfterInvalidation = await service.writeMetaIdPin({
  actorId: HUMAN_ACCOUNT_ACTOR_ID,
  resourceUri: pendingHuman.data.confirmRequest.resourceUri,
  payload: pendingHuman.data.confirmRequest.payload,
});
assert.equal(replayAfterInvalidation.ok, false);
assert.equal(replayAfterInvalidation.code, 'invalid_request');
evidence('human Actor state invalidation (identity lifecycle) kills pending human confirmations');

console.log(`\nABC 0.7.1 Human/Bot Actor integration smoke: ${step} checks passed.`);
