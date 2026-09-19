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

/* ------------------------------------------------------------------------- *
 * v1.5 last mile (owner ruling 「谁发起，谁验收」): the ack channel doubles as
 * the Twin SELF-CLOSURE entrance. The board's own rules live in
 * tests/trackedTaskBoard.test.mjs; here we pin the WRAPPER contract: the
 * envelope is unchanged, a self-closure success is surfaced verbatim, and
 * self-closure refusals (owner card / non-terminal card) are errors like any
 * other refusal — never swallowed, never rewritten.
 * ------------------------------------------------------------------------- */

test('v1.5 last mile: a self-closure ack forwards the SAME envelope and surfaces the success payload verbatim', async () => {
  const { calls, byName } = makeHarness({
    ackResult: {
      ok: true,
      alreadyProcessed: false,
      processedAt: '2026-09-18T12:00:00.000Z',
      processedBy: 'twin',
      receipt: 'worker delivered; self-closed after re-checking the acceptance criteria',
    },
  });
  const result = await byName.acknowledge_card_closure.handler({
    cardId: 'card-twin-9',
    receipt: 'worker delivered; self-closed after re-checking the acceptance criteria',
    evidenceUri: 'sha256:deadbeef',
  });
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.processedBy, 'twin');
  assert.equal(payload.alreadyProcessed, false);
  // processedBy stays pinned to 'twin' on the self-closure path too — this
  // tool IS the Twin's channel, on both of its branches.
  assert.deepEqual(calls, [{
    method: 'ack',
    input: {
      taskId: 'card-twin-9',
      processedBy: 'twin',
      receipt: 'worker delivered; self-closed after re-checking the acceptance criteria',
      evidenceUri: 'sha256:deadbeef',
      confirmationRef: null,
    },
  }]);
});

test('v1.5 last mile: self-closure refusals pass through as errors, unchanged', async () => {
  const makeAck = (code, error) => ({
    ok: false,
    code,
    error,
    alreadyProcessed: false,
    processedAt: null,
    processedBy: null,
    receipt: null,
  });
  // The owner card keeps the v1.4 refusal: the Twin never writes the owner's
  // conclusion, not even from the new entrance.
  const ownerCard = makeHarness({
    ackResult: makeAck('NO_CONCLUSION', 'the card carries no closing conclusion to execute'),
  });
  const refused = await ownerCard.byName.acknowledge_card_closure.handler({
    cardId: 'card-owner-1', receipt: 'record-only, no action required',
  });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /NO_CONCLUSION/);

  // The terminal-only rule: an open twin-delegated card refuses VALIDATION.
  const openCard = makeHarness({
    ackResult: makeAck('VALIDATION', 'a twin self-closure needs a terminal card (completed/cancelled/failed), got review'),
  });
  const early = await openCard.byName.acknowledge_card_closure.handler({
    cardId: 'card-twin-open', receipt: 'premature write-off',
  });
  assert.equal(early.isError, true);
  assert.match(early.content[0].text, /VALIDATION/);
  assert.match(early.content[0].text, /terminal/);
});

test('v1.5 last mile: the tool surface is compatibility-frozen — same four params, receipt still required, self-closure documented in the description', () => {
  const { byName } = makeHarness();
  const tool = byName.acknowledge_card_closure;
  assert.deepEqual(
    Object.keys(tool.schema).sort(),
    ['cardId', 'confirmationRef', 'evidenceUri', 'receipt'],
    'no new parameter may break the host tool signature',
  );
  // The receipt IS the conclusion on the self-closure path: minLength 1 is
  // the minimum bar for a non-empty write-off.
  assert.equal(tool.schema.receipt.minLength, 1);
  // Discoverability: the model can only USE the entrance it can SEE.
  assert.match(tool.description, /self-closure/);
  assert.match(tool.description, /never write a conclusion on the owner/);
});
