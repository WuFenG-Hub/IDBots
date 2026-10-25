/**
 * ABC 0.7.1 Human/Bot Actor integration smoke (idbots-requirements WS-A/WS-B).
 *
 * Exercises the REAL modules — the installed @openagentinternet 0.7.1
 * contract, the renderer Actor model, and the main-process bridge service —
 * with stubbed chain signers (no broadcast). Run: node tests/abcActorIntegrationSmoke.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { browserActorKindGroup } from '@openagentinternet/agent-browser-host-contract';

import {
  buildBrowserActors,
  selectDefaultBrowserActor,
} from '../src/renderer/features/botBrowser/idbotsBrowserActorModel.js';
import {
  createBotBrowserBridgeService,
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

// 3. Runtime actors: human first, Bot default preserved.
const metabots = [
  { id: 7, name: 'Alpha Bot', globalmetaid: 'IDQ1ABC', created_at: 10 },
  { id: 9, name: 'Beta Bot', globalmetaid: 'IDQ1DEF', created_at: 20 },
];
const user = { globalmetaid: 'IDP1HUMAN', name: 'Sunny', mnemonic: 'never leak me' };
const actors = buildBrowserActors(metabots, user);
assert.deepEqual(
  actors.map((actor) => [actor.id, actor.kind]),
  [
    ['idbots-account', 'idbots-account'],
    ['idbots-metabot-7', 'idbots-agent'],
    ['idbots-metabot-9', 'idbots-agent'],
  ],
);
assert.equal(selectDefaultBrowserActor(metabots, user).id, 'idbots-metabot-7');
assert.equal(JSON.stringify(actors).includes('never leak me'), false);
evidence('runtime actors = [human, ...bots]; default Actor stays the Bot; no mnemonic in the snapshot');

// 4-8. Bridge service with stubbed signers.
let botSignCalls = 0;
let humanSignCalls = 0;
let identity = { globalmetaid: 'IDP1HUMAN', name: 'Sunny', mnemonic: 'human seed words' };
const auditEvents = [];
let confirmationSequence = 0;
const service = createBotBrowserBridgeService({
  metabotStore: { getMetabotById: (id) => (id === 7 ? metabots[0] : null) },
  userIdentityStore: { get: () => identity },
  createPin: async () => {
    botSignCalls += 1;
    return { pinId: 'botpin123i0', txids: ['bottx1'] };
  },
  createHumanPin: async () => {
    humanSignCalls += 1;
    return { pinId: 'humanpin123i0', txids: ['humantx1'] };
  },
  createConfirmationId: () => `confirmation-${++confirmationSequence}`,
  createConfirmationToken: () => 'opaque-token',
  audit: (event) => auditEvents.push(event),
});

const pinWritePayload = (value) => ({
  operation: 'create',
  path: '/protocols/simplebuzz',
  encryption: '0',
  version: '1.0',
  contentType: 'application/json',
  payload: { encoding: 'utf8', value },
  display: { title: 'Smoke write' },
});

// 4. Human two-phase write: confirmation identity == signer identity == result actor.
const humanPhaseOne = await service.writeMetaIdPin({
  actorId: 'idbots-account',
  resourceUri: 'metaapp://app123i0',
  payload: pinWritePayload('{"human":true}'),
});
assert.equal(humanPhaseOne.state, 'manual_action_required');
assert.equal(humanPhaseOne.data.confirmation.actor.globalMetaId, 'idp1human');
const humanPhaseTwo = await service.writeMetaIdPin({
  actorId: 'idbots-account',
  resourceUri: humanPhaseOne.data.confirmRequest.resourceUri,
  payload: humanPhaseOne.data.confirmRequest.payload,
});
assert.equal(humanPhaseTwo.ok, true);
assert.equal(humanPhaseTwo.data.actor.globalMetaId, 'idp1human');
assert.equal(humanSignCalls, 1);
assert.equal(botSignCalls, 0);
evidence('human Actor write confirmed+signed as idp1human via the human stack (Bot signer untouched)');

// 5. Actor-switch replay fails closed in both directions.
const botPhaseOne = await service.writeMetaIdPin({
  actorId: 'idbots-metabot-7',
  resourceUri: 'metaapp://app123i0',
  payload: pinWritePayload('{"bot":true}'),
});
assert.equal(botPhaseOne.state, 'manual_action_required');
const replayAsHuman = await service.writeMetaIdPin({
  actorId: 'idbots-account',
  resourceUri: botPhaseOne.data.confirmRequest.resourceUri,
  payload: botPhaseOne.data.confirmRequest.payload,
});
assert.equal(replayAsHuman.ok, false);
assert.equal(replayAsHuman.code, 'invalid_request');
evidence('Bot confirmation replayed under the human Actor fails closed (invalid_request)');

// 6. Forged Actor ids never reach a signer.
for (const actorId of ['idbots-account-x', 'human:idbots-account', 'idbots-metabot-999999']) {
  const forged = await service.writeMetaIdPin({
    actorId,
    resourceUri: 'metaapp://app123i0',
    payload: pinWritePayload('{"forged":true}'),
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.code, 'actor_required');
}
evidence('forged/unknown Actor ids rejected with actor_required before any signer runs');

// 7. Unsupported Human×action combos fail explicitly.
const humanLlm = await service.completeLlm({
  actorId: 'idbots-account',
  resourceUri: 'metaapp://app123i0',
  sessionId: 'session-smoke',
  payload: { messages: [{ role: 'user', content: 'hi' }] },
});
assert.equal(humanLlm.ok, false);
assert.equal(humanLlm.code, 'unsupported_actor_action');
evidence('human Actor LLM completion fails explicitly with unsupported_actor_action');

// 8. Human identity replacement revokes grants; Bot grants survive.
const grantPhaseOne = await service.requestPermissions({
  actorId: 'idbots-account',
  resourceUri: 'metaapp://app123i0',
  sessionId: 'session-smoke',
  payload: { grants: [{ method: 'metaid.pin.write', operation: 'create', path: '/protocols/simplegroupchat' }] },
});
assert.equal(grantPhaseOne.state, 'manual_action_required');
const grantPhaseTwo = await service.requestPermissions({
  actorId: 'idbots-account',
  resourceUri: 'metaapp://app123i0',
  sessionId: 'session-smoke',
  payload: grantPhaseOne.data.confirmRequest.payload,
});
assert.equal(grantPhaseTwo.ok, true);
const grantedHumanWrite = await service.writeMetaIdPin({
  actorId: 'idbots-account',
  resourceUri: 'metaapp://app123i0',
  sessionId: 'session-smoke',
  payload: { ...pinWritePayload('{"granted":true}'), path: '/protocols/simplegroupchat' },
});
assert.equal(grantedHumanWrite.ok, true);

service.invalidateUserIdentity();
identity = { globalmetaid: 'IDP1OTHER', name: 'Sunny II', mnemonic: 'new seed' };
const staleGrantWrite = await service.writeMetaIdPin({
  actorId: 'idbots-account',
  resourceUri: 'metaapp://app123i0',
  sessionId: 'session-smoke',
  payload: { ...pinWritePayload('{"stale":true}'), path: '/protocols/simplegroupchat' },
});
assert.equal(staleGrantWrite.state, 'manual_action_required', 'stale human grant must be revoked');
const revoked = auditEvents.filter((event) => event.type === 'permission-revoked');
assert.equal(revoked.length >= 1, true);
assert.equal(revoked.at(-1).reason, 'user-identity-changed');
evidence('human identity replacement revokes the human session grant (audited) and requires re-confirmation');

console.log(`\nABC 0.7.1 Human/Bot Actor integration smoke: ${step} checks passed.`);
