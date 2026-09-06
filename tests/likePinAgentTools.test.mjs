import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';

const require = Module.createRequire(import.meta.url);
const { buildLikePinAgentTools, formatLikePinResult } = require('../dist-electron/main/libs/likePinAgentTools.js');

const SESSION_ID = 'sess-like-1';
const METABOT_ID = 42;
const TARGET_PIN_ID = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12i0';

const SAMPLE_PIN_RESULT = { txids: ['tx-like-1'], pinId: 'tx-like-1i0', totalCost: 550 };

function makeHarness(overrides = {}) {
  const calls = { createPin: [] };
  const createPin = async (metabotId, metaidData, options) => {
    calls.createPin.push({ metabotId, metaidData, options });
    if (overrides.createPinError) throw overrides.createPinError;
    return overrides.pinResult ?? SAMPLE_PIN_RESULT;
  };
  const resolveMetabotId = (sessionId) => {
    return 'metabotId' in overrides ? overrides.metabotId : METABOT_ID;
  };
  const tools = buildLikePinAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    createPin,
    sessionId: SESSION_ID,
    resolveMetabotId,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName };
}

test('registers exactly one like_pin tool', () => {
  const { byName } = makeHarness();
  assert.deepEqual(Object.keys(byName), ['like_pin']);
});

test('like (1) writes the paylike 1.0.0 payload {isLike, likeTo} for any target pin', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.like_pin.handler({ pin_id: TARGET_PIN_ID, is_like: 1 });
  assert.equal(result.isError, undefined);
  assert.equal(calls.createPin.length, 1);
  const { metabotId, metaidData, options } = calls.createPin[0];
  assert.equal(metabotId, METABOT_ID);
  assert.deepEqual(options, { network: 'mvc', origin: 'tool:like_pin' });
  assert.equal(metaidData.operation, 'create');
  assert.equal(metaidData.path, '/protocols/paylike');
  assert.equal(metaidData.version, '1.0.0');
  assert.equal(metaidData.contentType, 'application/json');
  assert.equal(metaidData.encryption, '0');
  const payload = JSON.parse(metaidData.payload);
  assert.deepEqual(Object.keys(payload).sort(), ['isLike', 'likeTo']);
  assert.equal(payload.isLike, 1);
  assert.equal(payload.likeTo, TARGET_PIN_ID);
  assert.match(result.content[0].text, /Liked pin ab12cd34/);
});

test('dislike (-1) and cancel (0) round-trip their reaction value', async () => {
  const { calls, byName } = makeHarness();
  const dislike = await byName.like_pin.handler({ pin_id: TARGET_PIN_ID, is_like: -1 });
  assert.equal(dislike.isError, undefined);
  assert.match(dislike.content[0].text, /Disliked pin/);
  const cancel = await byName.like_pin.handler({
    pin_id: TARGET_PIN_ID,
    is_like: 0,
    network: 'doge',
  });
  assert.equal(cancel.isError, undefined);
  assert.match(cancel.content[0].text, /Canceled your reaction on pin/);
  assert.equal(calls.createPin.length, 2);
  assert.equal(JSON.parse(calls.createPin[0].metaidData.payload).isLike, -1);
  assert.equal(JSON.parse(calls.createPin[1].metaidData.payload).isLike, 0);
  assert.equal(calls.createPin[1].options.network, 'doge');
});

test('invalid is_like values and empty pin_id are rejected without a chain write', async () => {
  const { calls, byName } = makeHarness();
  const bad = await byName.like_pin.handler({ pin_id: TARGET_PIN_ID, is_like: 2 });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /must be exactly 1/);
  const empty = await byName.like_pin.handler({ pin_id: '  ', is_like: 1 });
  assert.equal(empty.isError, true);
  assert.match(empty.content[0].text, /requires `pin_id`/);
  assert.equal(calls.createPin.length, 0);
});

test('reports honestly when no MetaBot owns the session or the write fails', async () => {
  const noBot = makeHarness({ metabotId: undefined });
  const noBotResult = await noBot.byName.like_pin.handler({ pin_id: TARGET_PIN_ID, is_like: 1 });
  assert.equal(noBotResult.isError, true);
  assert.match(noBotResult.content[0].text, /could not determine which MetaBot/);

  const failed = makeHarness({ createPinError: new Error('insufficient balance') });
  const failedResult = await failed.byName.like_pin.handler({ pin_id: TARGET_PIN_ID, is_like: 1 });
  assert.equal(failedResult.isError, true);
  assert.match(failedResult.content[0].text, /Reaction publish failed: insufficient balance/);
});

test('formatLikePinResult sheets: action wording, target pinId, pin:// link, no Web2 URLs', () => {
  const like = formatLikePinResult({
    reactionPinId: 'ri0',
    txids: ['t1'],
    totalCost: 7,
    targetPinId: 'xi0',
    isLike: 1,
  });
  assert.match(like, /Liked pin xi0 — reaction published on-chain\./);
  assert.match(like, /view link: \[pin:\/\/ri0\]\(pin:\/\/ri0\)/);
  assert.doesNotMatch(like, /https?:\/\//);
  const dislike = formatLikePinResult({
    reactionPinId: 'ri0',
    txids: ['t1'],
    totalCost: 7,
    targetPinId: 'xi0',
    isLike: -1,
  });
  assert.match(dislike, /Disliked pin xi0/);
  const cancel = formatLikePinResult({
    reactionPinId: 'ri0',
    txids: ['t1'],
    totalCost: 7,
    targetPinId: 'xi0',
    isLike: 0,
  });
  assert.match(cancel, /Canceled your reaction on pin xi0/);
  const minimal = formatLikePinResult({
    reactionPinId: '',
    txids: [],
    totalCost: 0,
    targetPinId: 'xi0',
    isLike: 1,
  });
  assert.equal(minimal, 'Liked pin xi0 — reaction published on-chain.\n- target pinId: xi0\n- cost: 0 sats');
});
