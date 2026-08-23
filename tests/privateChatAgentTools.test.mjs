import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { buildPrivateChatAgentTools } = require('../dist-electron/main/libs/privateChatAgentTools.js');

const SESSION_ID = 'sess-private-1';
const METABOT_ID = 7;

const SAMPLE_RESULT = {
  txids: ['tx-1', 'tx-2'],
  pinId: 'abc123i0',
};

function makeHarness(overrides = {}) {
  const calls = { send: [], resolve: [] };
  const control = {
    send: async (input) => {
      calls.send.push(input);
      if (overrides.sendError) throw overrides.sendError;
      return overrides.sendResult ?? SAMPLE_RESULT;
    },
  };
  const resolveMetabotId = (sessionId) => {
    calls.resolve.push(sessionId);
    // Honor an explicit `metabotId` override (including undefined); only fall
    // back to the default when the harness did not specify one.
    return 'metabotId' in overrides ? overrides.metabotId : METABOT_ID;
  };
  const tools = buildPrivateChatAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    control,
    sessionId: SESSION_ID,
    resolveMetabotId,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName };
}

test('builds a single send_private_chat tool', () => {
  const { byName } = makeHarness();
  assert.ok(byName.send_private_chat);
  assert.equal(Object.keys(byName).length, 1);
});

test('resolves the session metabotId and forwards to/content/replyPin to control.send', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.send_private_chat.handler({
    to: '  idq1target  ',
    content: '  hello there  ',
    reply_pin: '  prevPin1i0  ',
  });
  assert.deepEqual(calls.resolve, [SESSION_ID]);
  assert.equal(calls.send.length, 1);
  assert.deepEqual(calls.send[0], {
    metabotId: METABOT_ID,
    toGlobalMetaId: 'idq1target',
    content: 'hello there',
    replyPin: 'prevPin1i0',
  });
  const text = result.content[0].text;
  assert.equal(result.isError, undefined);
  assert.match(text, /Private message sent\./);
  assert.match(text, /pinId: abc123i0/);
  assert.match(text, /txids: tx-1, tx-2/);
  assert.match(text, /pin link: \[pin:\/\/abc123i0\]\(pin:\/\/abc123i0\)/);
  assert.doesNotMatch(text, /openagentinternet|metaid\.io/);
});

test('omits replyPin when reply_pin is not provided', async () => {
  const { calls, byName } = makeHarness();
  await byName.send_private_chat.handler({ to: 'idq1target', content: 'hi' });
  assert.equal(calls.send[0].replyPin, undefined);
});

test('rejects an empty `to` before resolving the metabotId', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.send_private_chat.handler({ to: '   ', content: 'hi' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /requires `to`/);
  assert.equal(calls.send.length, 0);
  assert.equal(calls.resolve.length, 0);
});

test('rejects an empty `content` without reaching control.send', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.send_private_chat.handler({ to: 'idq1target', content: '  ' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /requires `content`/);
  assert.equal(calls.send.length, 0);
});

test('errors gracefully when no MetaBot owns the session', async () => {
  const { calls, byName } = makeHarness({ metabotId: undefined });
  const result = await byName.send_private_chat.handler({ to: 'idq1target', content: 'hi' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /which MetaBot owns this session/);
  assert.equal(calls.send.length, 0);
});

test('surfaces control.send failures as an error result without throwing', async () => {
  const { byName } = makeHarness({
    sendError: new Error('target has no chatPublicKey on chain (/info/chatpubkey missing)'),
  });
  const result = await byName.send_private_chat.handler({ to: 'idq1target', content: 'hi' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Private message send failed: target has no chatPublicKey on chain/);
});
