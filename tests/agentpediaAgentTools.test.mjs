// Tests for the Agentpedia agent tools (schema-gated protocol writers).
// Run (after `npm run compile:electron`): node --test tests/agentpediaAgentTools.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const {
  buildAgentpediaAgentTools,
  formatAgentpediaToolName,
} = require('../dist-electron/main/libs/agentpediaAgentTools.js');
const { validateAgainstSchema } = require('../dist-electron/main/libs/agentpediaSchemaValidator.js');
const {
  agentpediaSchemas,
  agentpediaGenesisParamDefaults,
} = require('../dist-electron/main/libs/agentpediaSchemas.js');

const SESSION_ID = 'sess-agentpedia-1';
const METABOT_ID = 15;

const SAMPLE_PIN_RESULT = { txids: ['tx-ap-1'], pinId: '1e7e698524bce034080119868b9bb6609d3e69362fb4a9b24f99ff66ce12750di0', totalCost: 2300 };

function makeHarness() {
  const calls = { createPin: [] };
  const tools = {};
  const tool = (name, description, schema, handler) => {
    tools[name] = { name, description, schema, handler };
    return { name };
  };
  const createPin = async (metabotId, metaidData, options) => {
    calls.createPin.push({ metabotId, metaidData, options });
    return SAMPLE_PIN_RESULT;
  };
  const deps = {
    tool,
    createPin,
    sessionId: SESSION_ID,
    resolveMetabotId: () => METABOT_ID,
  };
  buildAgentpediaAgentTools(deps);
  return { tools, calls };
}

function lastPinCall(calls) {
  return calls.createPin[calls.createPin.length - 1];
}

test('registers the seven agentpedia protocol writers', () => {
  const { tools } = makeHarness();
  for (const name of [
    'agentpedia_rev',
    'agentpedia_challenge',
    'agentpedia_ruling',
    'agentpedia_review',
    'agentpedia_editor',
    'agentpedia_constitution',
    'agentpedia_param_proposal',
  ]) {
    assert.ok(tools[name], `missing tool ${name}`);
    assert.ok(tools[name].description.length > 40, `${name} description too short`);
  }
});

test('agentpedia_rev create: full-field payload passes the composite schema and reaches createPin', async () => {
  const { tools, calls } = makeHarness();
  const result = await tools.agentpedia_rev.handler({
    action: 'create',
    lang: 'ZH', // auto-lowercased by the tool
    slug: 'Hello World', // canonicalized to hello_world
    title: '你好世界',
    content: '# Hello',
    content_hash: 'a'.repeat(64),
    claim_change_type: 'create',
    claim_refs: 2,
  });
  assert.equal(result.isError, undefined);
  assert.equal(calls.createPin.length, 1);
  const call = lastPinCall(calls);
  assert.equal(call.metabotId, METABOT_ID);
  assert.equal(call.metaidData.operation, 'create');
  assert.equal(call.metaidData.path, '/protocols/agentpedia/rev');
  assert.equal(call.metaidData.version, '1.0');
  assert.equal(call.metaidData.encryption, '0');
  const payload = JSON.parse(call.metaidData.payload);
  const validation = validateAgainstSchema(payload, agentpediaSchemas.rev);
  assert.deepEqual(validation.errors, []);
  assert.equal(payload.lang, 'zh');
  assert.equal(payload.slug, 'hello_world');
  assert.equal(payload.type, 'create');
  assert.equal(payload.parentRev, null);
  assert.equal(payload.claim.changeType, 'create');
  assert.equal(Object.keys(payload).length, 14); // full field set, additionalProperties:false
});

test('agentpedia_rev edit builds on parentRev and carries basedOn', async () => {
  const { tools, calls } = makeHarness();
  await tools.agentpedia_rev.handler({
    action: 'edit',
    lang: 'zh',
    slug: 'hello_world',
    title: '你好世界',
    content: 'new body',
    content_hash: 'b'.repeat(64),
    parent_rev: 'aa'.repeat(32) + 'i0',
    based_on: 'aa'.repeat(32) + 'i0',
  });
  const payload = JSON.parse(lastPinCall(calls).metaidData.payload);
  const validation = validateAgainstSchema(payload, agentpediaSchemas.rev);
  assert.deepEqual(validation.errors, []);
  assert.equal(payload.parentRev, 'aa'.repeat(32) + 'i0');
  assert.equal(payload.basedOn, 'aa'.repeat(32) + 'i0');
});

test('agentpedia_rev schema gate: zh-Hans style lang never reaches the wallet', async () => {
  const { tools, calls } = makeHarness();
  const result = await tools.agentpedia_rev.handler({
    action: 'create',
    lang: 'zh-Hans',
    slug: 'a',
    title: 'A',
    content: 'x',
    content_hash: 'c'.repeat(64),
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /composite protocol schema/);
  assert.equal(calls.createPin.length, 0);
});

test('agentpedia_rev friendly pre-checks: create without content, edit without parent_rev', async () => {
  const { tools, calls } = makeHarness();
  const noContent = await tools.agentpedia_rev.handler({
    action: 'create', lang: 'zh', slug: 'a', title: 'A', content_hash: 'c'.repeat(64),
  });
  assert.equal(noContent.isError, true);
  assert.match(noContent.content[0].text, /content \(inline\) or content_ref/);
  const noParent = await tools.agentpedia_rev.handler({
    action: 'edit', lang: 'zh', slug: 'a', title: 'A', content: 'x', content_hash: 'c'.repeat(64),
  });
  assert.equal(noParent.isError, true);
  assert.match(noParent.content[0].text, /parent_rev/);
  assert.equal(calls.createPin.length, 0);
});

test('agentpedia_rev revert: hash content carries null slots per if/then branch', async () => {
  const { tools, calls } = makeHarness();
  await tools.agentpedia_rev.handler({
    action: 'revert',
    lang: 'zh',
    slug: 'a',
    title: 'A',
    parent_rev: 'ab'.repeat(32) + 'i0',
    revert_to: 'cd'.repeat(32) + 'i0',
    content_hash: 'e'.repeat(64),
  });
  const payload = JSON.parse(lastPinCall(calls).metaidData.payload);
  const validation = validateAgainstSchema(payload, agentpediaSchemas.rev);
  assert.deepEqual(validation.errors, []);
  assert.equal(payload.content, null);
  assert.equal(payload.contentRef, null);
  assert.equal(payload.redirectTo, null);
  assert.equal(payload.revertTo, 'cd'.repeat(32) + 'i0');
});

test('agentpedia_ruling proposal: seed auto-equals challengePin, params full-slot', async () => {
  const { tools, calls } = makeHarness();
  const challengePin = '12'.repeat(32) + 'i0';
  await tools.agentpedia_ruling.handler({
    action: 'proposal',
    challenge_pin: challengePin,
    outcome: 'revert-to',
    revert_to: '34'.repeat(32) + 'i0',
    rationale: 'restoring the last good version',
  });
  const payload = JSON.parse(lastPinCall(calls).metaidData.payload);
  const validation = validateAgainstSchema(payload, agentpediaSchemas.ruling);
  assert.deepEqual(validation.errors, []);
  assert.equal(payload.seed, challengePin);
  assert.equal(payload.params.revertTo, '34'.repeat(32) + 'i0');
  assert.equal(payload.proposalPin, null);
  assert.equal(payload.approve, null);
});

test('agentpedia_ruling vote: null slots everywhere except proposalPin/approve', async () => {
  const { tools, calls } = makeHarness();
  await tools.agentpedia_ruling.handler({
    action: 'vote',
    proposal_pin: '56'.repeat(32) + 'i0',
    approve: true,
  });
  const payload = JSON.parse(lastPinCall(calls).metaidData.payload);
  const validation = validateAgainstSchema(payload, agentpediaSchemas.ruling);
  assert.deepEqual(validation.errors, []);
  assert.equal(payload.challengePin, null);
  assert.equal(payload.seed, null);
  assert.equal(payload.outcome, null);
  assert.equal(payload.params, null);
  assert.equal(payload.approve, true);
});

test('agentpedia_constitution genesis: 21 spec params, founders preserved, revision 0', async () => {
  const { tools, calls } = makeHarness();
  const founders = ['idq1d5m392ahkhp79wsy9ur79e3vhak7tg729dwdr5', 'idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz', 'idq15a3wj5wsddk30vml6jqyetpvlqt2dky3a9869n'];
  await tools.agentpedia_constitution.handler({ founders });
  const payload = JSON.parse(lastPinCall(calls).metaidData.payload);
  const validation = validateAgainstSchema(payload, agentpediaSchemas.constitution);
  assert.deepEqual(validation.errors, []);
  assert.equal(payload.revision, 0);
  assert.equal(payload.prevConstitution, null);
  assert.equal(payload.proposalPin, null);
  assert.deepEqual(payload.founders, founders);
  assert.equal(Object.keys(payload.params).length, Object.keys(agentpediaGenesisParamDefaults).length);
  assert.equal(payload.algoVersions.adoption, 'adoption-algo-v1');
});

test('agentpedia_constitution: single founder is rejected by schema gate (minItems 2)', async () => {
  const { tools, calls } = makeHarness();
  const result = await tools.agentpedia_constitution.handler({ founders: ['idq1d5m392ahkhp79wsy9ur79e3vhak7tg729dwdr5'] });
  assert.equal(result.isError, true);
  assert.equal(calls.createPin.length, 0);
});

test('agentpedia_editor register without stake txid is rejected before write', async () => {
  const { tools, calls } = makeHarness();
  const result = await tools.agentpedia_editor.handler({
    action: 'register',
    editor: 'idq1d5m392ahkhp79wsy9ur79e3vhak7tg729dwdr5',
    challenge_pin: '78'.repeat(32) + 'i0',
    response_pin: '9a'.repeat(32) + 'i0',
  });
  assert.equal(result.isError, true);
  assert.equal(calls.createPin.length, 0);
});

test('agentpedia_editor challenge auto-generates a 16-hex nonce', async () => {
  const { tools, calls } = makeHarness();
  await tools.agentpedia_editor.handler({
    action: 'challenge',
    editor: 'idq15a3wj5wsddk30vml6jqyetpvlqt2dky3a9869n',
  });
  const payload = JSON.parse(lastPinCall(calls).metaidData.payload);
  const validation = validateAgainstSchema(payload, agentpediaSchemas.editor);
  assert.deepEqual(validation.errors, []);
  assert.match(payload.nonce, /^[0-9a-f]{16}$/);
});

test('agentpedia_review and agentpedia_challenge payloads validate', async () => {
  const { tools, calls } = makeHarness();
  await tools.agentpedia_review.handler({
    target_rev: 'bc'.repeat(32) + 'i0',
    score: 4,
    accuracy: 5,
    citation: 3,
    neutrality: 4,
    comment: 'solid',
  });
  const review = JSON.parse(lastPinCall(calls).metaidData.payload);
  assert.deepEqual(validateAgainstSchema(review, agentpediaSchemas.review).errors, []);

  await tools.agentpedia_challenge.handler({
    target_rev: 'bc'.repeat(32) + 'i0',
    reason: 'factual',
    detail: 'the claim lacks an on-chain citation',
  });
  const challenge = JSON.parse(lastPinCall(calls).metaidData.payload);
  assert.deepEqual(validateAgainstSchema(challenge, agentpediaSchemas.challenge).errors, []);
  assert.equal(challenge.proposed, null);
});

test('validator directly: additional properties and bad enums are caught', () => {
  const good = {
    v: 1, slug: 'a', lang: 'zh', title: 'A', type: 'create',
    parentRev: null, basedOn: null, content: 'x', contentRef: null,
    contentHash: 'f'.repeat(64), revertTo: null, redirectTo: null,
    summary: null, claim: { changeType: 'create', refs: 0 },
  };
  assert.equal(validateAgainstSchema(good, agentpediaSchemas.rev).ok, true);

  const extra = { ...good, sneaky: 1 };
  assert.equal(validateAgainstSchema(extra, agentpediaSchemas.rev).ok, false);

  const badEnum = { ...good, type: 'delete' };
  assert.equal(validateAgainstSchema(badEnum, agentpediaSchemas.rev).ok, false);

  const badPattern = { ...good, lang: 'zh-Hans' };
  assert.equal(validateAgainstSchema(badPattern, agentpediaSchemas.rev).ok, false);
});

test('built payloads drive the replay engine end to end (genesis + rev create)', async () => {
  const { replay } = await import('../src/agentpedia-core/adoption-algo-v1.mjs');
  const { tools, calls } = makeHarness();
  const founders = ['idq1d5m392ahkhp79wsy9ur79e3vhak7tg729dwdr5', 'idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz'];
  await tools.agentpedia_constitution.handler({ founders });
  await tools.agentpedia_rev.handler({
    action: 'create', lang: 'zh', slug: 'a', title: 'A', content: 'body', content_hash: 'ab'.repeat(32),
  });
  const events = calls.createPin.map((call, i) => ({
    pin: call.metaidData.path.endsWith('constitution') ? 'con' : `t${i}`,
    path: call.metaidData.path,
    sender: founders[0],
    height: 10 + i,
    txIndex: 0,
    payload: JSON.parse(call.metaidData.payload),
  }));
  const view = replay(events, { arbiterOverrides: {}, frozenArbiterOverrides: {} });
  assert.equal(view.entries['zh:a'].head, 't1');
  assert.equal(view.entries['zh:a'].status, 'normal');
  assert.equal(view.graveyard.length, 0);
  assert.equal(view.founders.length, 2);
});

test('formatAgentpediaToolName maps protocol paths to tool names', () => {
  assert.equal(formatAgentpediaToolName('/protocols/agentpedia/rev'), 'agentpedia_rev');
  assert.equal(formatAgentpediaToolName('/protocols/agentpedia/param-proposal'), 'agentpedia_paramProposal');
});
