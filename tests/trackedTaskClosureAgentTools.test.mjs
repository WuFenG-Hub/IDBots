import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildTrackedTaskClosureAgentTools } = require('../dist-electron/main/libs/trackedTaskClosureAgentTools.js');

/**
 * The Twin-side closure-execution channel (long-task board v1.2, task #86 §6).
 *
 * These cases pin the CONTRACT of the thin wrapper, not the board's own rules
 * (those live in tests/trackedTaskBoard.test.mjs): one delegation per tool, and
 * a refusal that is passed through instead of being swallowed.
 */

function makeHarness(overrides = {}) {
  const calls = [];
  const control = {
    listPendingClosures: (input) => {
      calls.push({ method: 'list', input });
      if (overrides.listError) throw overrides.listError;
      return overrides.listResult ?? {
        generatedAt: '2026-09-17T00:00:00.000Z',
        count: 1,
        truncated: false,
        items: [{
          cardId: 'card-1',
          title: 'long task',
          status: 'completed',
          conclusion: 'ship it',
          closureBy: 'owner',
          closureAt: '2026-09-17T00:00:00.000Z',
          closurePinId: null,
          conclusionHash: 'h',
          destructive: false,
          destructiveReasons: [],
        }],
      };
    },
    acknowledgeClosure: (input) => {
      calls.push({ method: 'ack', input });
      if (overrides.ackError) throw overrides.ackError;
      return overrides.ackResult ?? {
        ok: true,
        alreadyProcessed: false,
        processedAt: '2026-09-17T00:00:01.000Z',
        processedBy: 'twin',
        receipt: 'done',
      };
    },
  };
  const tools = buildTrackedTaskClosureAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    control,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName };
}

test('registers the two closure-execution tools', () => {
  const { byName } = makeHarness();
  assert.deepEqual(Object.keys(byName).sort(), ['acknowledge_card_closure', 'list_pending_card_closures']);
});

test('list_pending_card_closures is a pure delegation and reports the whole queue', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.list_pending_card_closures.handler({ limit: 5 });
  assert.deepEqual(calls, [{ method: 'list', input: { limit: 5 } }]);
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.count, 1);
  assert.equal(payload.items[0].cardId, 'card-1');
  // The four fields acceptance ② names must survive the wrapper verbatim.
  assert.equal(payload.items[0].conclusion, 'ship it');
  assert.equal(payload.items[0].closureBy, 'owner');
  assert.equal(payload.items[0].closureAt, '2026-09-17T00:00:00.000Z');
});

test('acknowledge_card_closure pins processedBy to "twin" and forwards the evidence', async () => {
  const { calls, byName } = makeHarness();
  await byName.acknowledge_card_closure.handler({
    cardId: 'card-1',
    receipt: 'handled it',
    evidenceUri: 'pin://evidence',
  });
  assert.deepEqual(calls, [{
    method: 'ack',
    input: {
      taskId: 'card-1',
      processedBy: 'twin',
      receipt: 'handled it',
      evidenceUri: 'pin://evidence',
      confirmationRef: null,
    },
  }]);
});

test('a refused ack is surfaced as an error, never swallowed', async () => {
  const { byName } = makeHarness({
    ackResult: {
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      error: 'this conclusion looks destructive (删除)',
      alreadyProcessed: false,
      processedAt: null,
      processedBy: null,
      receipt: null,
    },
  });
  const result = await byName.acknowledge_card_closure.handler({ cardId: 'card-1', receipt: 'did it' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /CONFIRMATION_REQUIRED/);
  assert.match(result.content[0].text, /destructive/);
});

test('a thrown delegate becomes an actionable error result, not an exception', async () => {
  const { byName } = makeHarness({ listError: new Error('db is gone') });
  const listed = await byName.list_pending_card_closures.handler({});
  assert.equal(listed.isError, true);
  assert.match(listed.content[0].text, /db is gone/);

  const ackHarness = makeHarness({ ackError: new Error('db is gone') });
  const acked = await ackHarness.byName.acknowledge_card_closure.handler({ cardId: 'card-1', receipt: 'x' });
  assert.equal(acked.isError, true);
  assert.match(acked.content[0].text, /db is gone/);
});

test('an empty cardId is rejected before the delegate is ever called', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.acknowledge_card_closure.handler({ cardId: '   ', receipt: 'x' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /cardId/);
  assert.deepEqual(calls, [], 'a malformed call must not reach the board');
});
