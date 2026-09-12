import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';

const require = Module.createRequire(import.meta.url);
const { buildCommentPinAgentTools, formatCommentPinResult } = require('../dist-electron/main/libs/commentPinAgentTools.js');

const SESSION_ID = 'sess-comment-1';
const METABOT_ID = 42;
const TARGET_PIN_ID = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12i0';

const SAMPLE_PIN_RESULT = { txids: ['tx-comment-1'], pinId: 'tx-comment-1i0', totalCost: 620 };

function makeHarness(overrides = {}) {
  const calls = { createPin: [] };
  const createPin = async (metabotId, metaidData, options) => {
    calls.createPin.push({ metabotId, metaidData, options });
    if (overrides.createPinError) throw overrides.createPinError;
    return overrides.pinResult ?? SAMPLE_PIN_RESULT;
  };
  const resolveMetabotId = (sessionId) => ('metabotId' in overrides ? overrides.metabotId : METABOT_ID);
  const tools = buildCommentPinAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    createPin,
    sessionId: SESSION_ID,
    resolveMetabotId,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName };
}

test('registers exactly one comment_pin tool', () => {
  const { byName } = makeHarness();
  assert.deepEqual(Object.keys(byName), ['comment_pin']);
});

test('writes the paycomment payload {commentTo, content, contentType} for any target pin', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.comment_pin.handler({ pin_id: TARGET_PIN_ID, content: 'Great write-up — the retry section helped us too.' });
  assert.equal(result.isError, undefined);
  assert.equal(calls.createPin.length, 1);
  const { metabotId, metaidData, options } = calls.createPin[0];
  assert.equal(metabotId, METABOT_ID);
  assert.deepEqual(options, { network: 'mvc', origin: 'tool:comment_pin' });
  assert.equal(metaidData.operation, 'create');
  assert.equal(metaidData.path, '/protocols/paycomment');
  assert.equal(metaidData.version, '1.0.0');
  assert.equal(metaidData.contentType, 'application/json');
  const payload = JSON.parse(metaidData.payload);
  assert.equal(payload.commentTo, TARGET_PIN_ID);
  assert.equal(payload.content, 'Great write-up — the retry section helped us too.');
  assert.equal(payload.contentType, 'text/markdown');
  assert.match(result.content[0].text, /Commented on pin ab12cd34/);
  assert.match(result.content[0].text, /pin:\/\/tx-comment-1i0/);
});

test('rejects empty pin_id and empty content without a chain write', async () => {
  const { calls, byName } = makeHarness();
  const noPin = await byName.comment_pin.handler({ pin_id: '  ', content: 'hi' });
  assert.equal(noPin.isError, true);
  const noContent = await byName.comment_pin.handler({ pin_id: TARGET_PIN_ID, content: '  ' });
  assert.equal(noContent.isError, true);
  assert.equal(calls.createPin.length, 0);
});

test('fails loudly when the acting MetaBot cannot be resolved', async () => {
  const { calls, byName } = makeHarness({ metabotId: undefined });
  const result = await byName.comment_pin.handler({ pin_id: TARGET_PIN_ID, content: 'hi' });
  assert.equal(result.isError, true);
  assert.equal(calls.createPin.length, 0);
});

test('surfaces chain-write failures as tool errors', async () => {
  const { byName } = makeHarness({ createPinError: new Error('insufficient funds') });
  const result = await byName.comment_pin.handler({ pin_id: TARGET_PIN_ID, content: 'hi' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Comment publish failed: insufficient funds/);
});

test('formatCommentPinResult renders the receipt with view link', () => {
  const text = formatCommentPinResult({
    commentPinId: 'tx-comment-1i0',
    txids: ['tx-comment-1'],
    totalCost: 620,
    targetPinId: TARGET_PIN_ID,
  });
  assert.match(text, /comment pinId: tx-comment-1i0/);
  assert.match(text, /cost: 620 sats/);
  assert.match(text, /pin:\/\/tx-comment-1i0/);
});
