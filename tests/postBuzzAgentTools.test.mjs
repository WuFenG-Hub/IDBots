import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = Module.createRequire(import.meta.url);
const { buildPostBuzzAgentTools, formatBuzzResult } = require('../dist-electron/main/libs/postBuzzAgentTools.js');

const SESSION_ID = 'sess-buzz-1';
const METABOT_ID = 42;

const SAMPLE_PIN_RESULT = { txids: ['tx-buzz-1'], pinId: 'tx-buzz-1i0', totalCost: 1234 };

function makeFixtureFile(name = 'note.txt', contents = 'hello') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-buzz-test-'));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function makeHarness(overrides = {}) {
  const calls = { createPin: [], upload: [], resolve: [] };
  const createPin = async (metabotId, metaidData, options) => {
    calls.createPin.push({ metabotId, metaidData, options });
    if (overrides.createPinError) throw overrides.createPinError;
    return overrides.pinResult ?? SAMPLE_PIN_RESULT;
  };
  const uploadFile = async (params) => {
    calls.upload.push(params);
    if (overrides.uploadError) throw overrides.uploadError;
    return overrides.uploadResult ?? { metafileUri: 'metafile://uploadedi0.txt' };
  };
  const resolveMetabotId = (sessionId) => {
    calls.resolve.push(sessionId);
    // Honor an explicit `metabotId` override (including undefined/null); only
    // fall back to the default when the harness did not specify one.
    return 'metabotId' in overrides ? overrides.metabotId : METABOT_ID;
  };
  const tools = buildPostBuzzAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    createPin,
    uploadFile,
    sessionId: SESSION_ID,
    resolveMetabotId,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName };
}

test('builds a single post_buzz tool', () => {
  const { byName } = makeHarness();
  assert.ok(byName.post_buzz);
  assert.equal(Object.keys(byName).length, 1);
});

test('posts a text-only buzz with the simplebuzz 7-tuple', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.post_buzz.handler({ content: 'hello metaweb' });
  assert.deepEqual(calls.resolve, [SESSION_ID]);
  assert.equal(calls.upload.length, 0);
  assert.equal(calls.createPin.length, 1);
  const call = calls.createPin[0];
  assert.equal(call.metabotId, METABOT_ID);
  assert.deepEqual(call.metaidData, {
    operation: 'create',
    path: '/protocols/simplebuzz',
    encryption: '0',
    version: '1.0',
    contentType: 'application/json',
    payload: JSON.stringify({
      content: 'hello metaweb',
      contentType: 'text/plain;utf-8',
      attachments: [],
      quotePin: '',
    }),
  });
  assert.deepEqual(call.options, { network: 'mvc' });
  const text = result.content[0].text;
  assert.equal(result.isError, undefined);
  assert.match(text, /Buzz posted on-chain\./);
  assert.match(text, /pinId: tx-buzz-1i0/);
  assert.match(text, /txids: tx-buzz-1/);
  assert.match(text, /cost: 1234 sats/);
  assert.match(text, /https:\/\/openagentinternet\.org\/browser\/pin\/tx-buzz-1i0/);
  assert.doesNotMatch(text, /attachment:/);
});

test('uploads a local attachment and passes metafile:// URIs through untouched', async () => {
  const fixture = makeFixtureFile();
  const { calls, byName } = makeHarness();
  const result = await byName.post_buzz.handler({
    content: 'with attachments',
    attachments: [fixture, 'METAFILE://existingi0.png'],
  });
  assert.equal(calls.upload.length, 1);
  assert.deepEqual(calls.upload[0], { metabotId: METABOT_ID, filePath: fixture, network: 'mvc' });
  const payload = JSON.parse(calls.createPin[0].metaidData.payload);
  // Case-insensitive metafile:// detection passes the URI through as-is.
  assert.deepEqual(payload.attachments, ['metafile://uploadedi0.txt', 'METAFILE://existingi0.png']);
  const text = result.content[0].text;
  assert.match(text, /attachment: metafile:\/\/uploadedi0\.txt/);
  assert.match(text, /attachment: METAFILE:\/\/existingi0\.png/);
});

test('uploads doge-network attachments on mvc while writing the buzz on doge', async () => {
  const fixture = makeFixtureFile();
  const { calls, byName } = makeHarness();
  await byName.post_buzz.handler({ content: 'doge buzz', attachments: [fixture], network: 'doge' });
  assert.equal(calls.upload[0].network, 'mvc');
  assert.deepEqual(calls.createPin[0].options, { network: 'doge' });
});

test('forwards content_type and quote_pin into the buzz payload', async () => {
  const { calls, byName } = makeHarness();
  await byName.post_buzz.handler({
    content: '# dev journal',
    content_type: 'text/markdown',
    quote_pin: 'quotedPinIdi0',
  });
  const payload = JSON.parse(calls.createPin[0].metaidData.payload);
  assert.equal(payload.contentType, 'text/markdown');
  assert.equal(payload.quotePin, 'quotedPinIdi0');
});

test('rejects empty content before resolving the metabotId', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.post_buzz.handler({ content: '   ' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /content/);
  assert.equal(calls.resolve.length, 0);
  assert.equal(calls.createPin.length, 0);
});

test('errors when no MetaBot owns the session', async () => {
  const { calls, byName } = makeHarness({ metabotId: undefined });
  const result = await byName.post_buzz.handler({ content: 'hello' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /which MetaBot owns this session/);
  assert.equal(calls.createPin.length, 0);
});

test('rejects a relative attachment path', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.post_buzz.handler({ content: 'x', attachments: ['relative/pic.png'] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ABSOLUTE local file paths/);
  assert.match(result.content[0].text, /relative\/pic\.png/);
  assert.equal(calls.upload.length, 0);
  assert.equal(calls.createPin.length, 0);
});

test('rejects a missing attachment file', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.post_buzz.handler({ content: 'x', attachments: ['/abs/missing.png'] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /attachment file not found: \/abs\/missing\.png/);
  assert.equal(calls.upload.length, 0);
});

test('errors when the upload result has no metafileUri', async () => {
  const fixture = makeFixtureFile();
  const { calls, byName } = makeHarness({ uploadResult: { success: true } });
  const result = await byName.post_buzz.handler({ content: 'x', attachments: [fixture] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /metafile URI/);
  assert.equal(calls.createPin.length, 0);
});

test('surfaces upload failures without posting the buzz', async () => {
  const fixture = makeFixtureFile();
  const { calls, byName } = makeHarness({ uploadError: new Error('sponsor balance low') });
  const result = await byName.post_buzz.handler({ content: 'x', attachments: [fixture] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Buzz post failed: sponsor balance low/);
  assert.equal(calls.createPin.length, 0);
});

test('surfaces createPin failures as an error result without throwing', async () => {
  const { byName } = makeHarness({ createPinError: new Error('not enough balance') });
  const result = await byName.post_buzz.handler({ content: 'hello' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Buzz post failed: not enough balance/);
});

test('formatBuzzResult lists txids, cost, attachments, and the public link', () => {
  const text = formatBuzzResult({
    pinId: 'abci0',
    txids: ['tx-1', 'tx-2'],
    totalCost: 546,
    attachments: ['metafile://ai0.png'],
  });
  assert.match(text, /pinId: abci0/);
  assert.match(text, /txids: tx-1, tx-2/);
  assert.match(text, /cost: 546 sats/);
  assert.match(text, /attachment: metafile:\/\/ai0\.png/);
  assert.match(text, /public link: https:\/\/openagentinternet\.org\/browser\/pin\/abci0/);

  const minimal = formatBuzzResult({ pinId: '', txids: [], totalCost: 0, attachments: [] });
  assert.equal(minimal, 'Buzz posted on-chain.\n- cost: 0 sats');
});
