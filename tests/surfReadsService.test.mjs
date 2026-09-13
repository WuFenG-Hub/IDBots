import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DEFAULT_METAWEB_SURF_READS_BASE_URL,
  METAWEB_PINS_BATCH_MAX,
  MetawebPinVersionsNotFoundError,
  metawebFresh,
  metawebPinsBatch,
  metawebInteractions,
  metawebPinVersions,
  metawebProtocols,
  isBatchErrorEntry,
} = await import('../dist-electron/main/services/metawebSurfReadsService.js');

/** Minimal envelope responder: records the request, returns the given envelope. */
const makeFetch = (envelope, calls = []) => async (url, init = {}) => {
  calls.push({ url: String(url), init });
  if (envelope instanceof Error) throw envelope;
  return {
    status: 200,
    json: async () => envelope,
  };
};

// ---------------------------------------------------------------------------
// R1: metawebFresh
// ---------------------------------------------------------------------------

test('metawebFresh builds the query and normalizes the page', async () => {
  const calls = [];
  const fetchImpl = makeFetch({
    code: 0,
    message: '',
    data: {
      items: [
        {
          pinId: 'pin-1', currentPinId: 'pin-1c', protocol: 'simplebuzz', path: '/protocols/simplebuzz',
          chainName: 'mvc', createdAt: 1789000000,
          author: { address: '0xA', metaid: 'mid', globalMetaId: 'gmid', name: 'Alice' },
          title: '', summary: 'hello chain', likeCount: 3, commentCount: 1, duplicates: 4,
        },
        { pinId: 'pin-2', createdAt: 1788990000, author: {} },
      ],
      hasMore: true,
      nextCursor: 'cursor-xyz',
      suppressed: { duplicates: 7, throttled: 2 },
    },
  }, calls);
  const page = await metawebFresh(
    { protocols: ['simplebuzz'], since: 1788900000, size: 50, cursor: 'cursor-abc', dedupe: 'identical', maxPerAuthor: 3 },
    { fetchImpl, timeoutMs: 5000 },
  );
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, `${DEFAULT_METAWEB_SURF_READS_BASE_URL}/api/metaweb/fresh`);
  assert.equal(url.searchParams.get('protocols'), 'simplebuzz');
  assert.equal(url.searchParams.get('since'), '1788900000', 'since is passed through (inclusive server-side)');
  assert.equal(url.searchParams.get('size'), '50');
  assert.equal(url.searchParams.get('cursor'), 'cursor-abc');
  assert.equal(url.searchParams.get('dedupe'), 'identical');
  assert.equal(url.searchParams.get('maxPerAuthor'), '3');
  assert.equal(page.items.length, 2);
  assert.equal(page.items[0].currentPinId, 'pin-1c');
  assert.equal(page.items[0].author.name, 'Alice');
  assert.equal(page.items[0].duplicates, 4);
  assert.equal(page.items[1].duplicates, null, 'missing duplicates → null');
  assert.equal(page.items[1].author.name, '', 'missing author → empty strings');
  assert.equal(page.hasMore, true);
  assert.equal(page.nextCursor, 'cursor-xyz');
  assert.deepEqual(page.suppressed, { duplicates: 7, throttled: 2 });
});

test('metawebFresh validates input and maps envelope errors', async () => {
  await assert.rejects(() => metawebFresh({ protocols: [] }, { fetchImpl: makeFetch({ code: 0, data: {} }) }), /at least one protocol/);
  await assert.rejects(
    () => metawebFresh({ protocols: ['simplebuzz'] }, { fetchImpl: makeFetch({ code: 40000, message: 'bad protocols', data: null }) }),
    /MetaWeb surf-reads API error 40000: bad protocols/,
  );
});

// ---------------------------------------------------------------------------
// R2: metawebPinsBatch
// ---------------------------------------------------------------------------

test('metawebPinsBatch posts the ids and isolates per-pin error entries', async () => {
  const calls = [];
  const fetchImpl = makeFetch({
    code: 0,
    message: '',
    data: {
      pins: {
        'pin-ok': {
          pinId: 'pin-ok', currentPinId: 'pin-okc', protocol: 'simplenote', path: '/protocols/simplenote',
          chainName: 'mvc', operation: 'create',
          creator: { globalMetaId: 'gmid', metaid: 'mid', name: 'Alice', address: '0xA' },
          createdAt: 1789000000, contentType: 'application/json',
          payload: { content: 'full body never truncated' },
          text: 'normalized body', truncated: false, totalLength: 14,
          meta: { title: 'T', summary: 'S', tags: ['a'] },
          attachments: [], source: 'local',
          version: { latest: 'pin-okc', count: 2 },
        },
        'pin-bad': { error: 'indexer has no such pin' },
      },
    },
  }, calls);
  const entries = await metawebPinsBatch(['pin-ok', 'pin-bad'], { fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { pinIds: ['pin-ok', 'pin-bad'] });
  assert.equal(entries['pin-ok'].protocol, 'simplenote');
  assert.equal(entries['pin-ok'].version.latest, 'pin-okc');
  assert.equal(entries['pin-ok'].version.count, 2);
  assert.equal(entries['pin-ok'].payload.content, 'full body never truncated');
  assert.ok(isBatchErrorEntry(entries['pin-bad']));
  assert.equal((entries['pin-bad']).error, 'indexer has no such pin');
});

test('metawebPinsBatch validates input client-side and keys missing entries as errors', async () => {
  const fetchImpl = makeFetch({ code: 0, message: '', data: { pins: {} } });
  await assert.rejects(() => metawebPinsBatch([], { fetchImpl }), /at least one pinId/);
  await assert.rejects(
    () => metawebPinsBatch(Array.from({ length: METAWEB_PINS_BATCH_MAX + 1 }, (_, i) => `p${i}`), { fetchImpl }),
    new RegExp(`at most ${METAWEB_PINS_BATCH_MAX} pinIds`),
  );
  const entries = await metawebPinsBatch(['pin-missing'], { fetchImpl });
  assert.ok(isBatchErrorEntry(entries['pin-missing']));
  assert.match(entries['pin-missing'].error, /missing from batch response/);
});

// ---------------------------------------------------------------------------
// R3: metawebInteractions
// ---------------------------------------------------------------------------

test('metawebInteractions builds the query and normalizes items', async () => {
  const calls = [];
  const fetchImpl = makeFetch({
    code: 0,
    message: '',
    data: {
      items: [
        {
          type: 'simpleanswer', pinId: 'ans-1', chainName: 'mvc', targetPinId: 'q-1',
          actor: { address: '0xB', metaid: 'mid2', globalMetaId: 'gmid2', name: 'Bob' },
          createdAt: 1789000000, excerpt: 'try the pipeline route',
        },
      ],
      hasMore: false,
      nextCursor: null,
    },
  }, calls);
  const page = await metawebInteractions(
    { owner: 'IDQTESTER', since: 1788900000, types: 'simplebuzz_like,simplebuzz_comment,simpleanswer', size: 50, cursor: 'c-1' },
    { fetchImpl },
  );
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/metaweb/interactions');
  assert.equal(url.searchParams.get('owner'), 'IDQTESTER', 'owner passed verbatim (any case accepted server-side)');
  assert.equal(url.searchParams.get('since'), '1788900000');
  assert.equal(url.searchParams.get('types'), 'simplebuzz_like,simplebuzz_comment,simpleanswer');
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].type, 'simpleanswer');
  assert.equal(page.items[0].targetPinId, 'q-1');
  assert.equal(page.items[0].actor.name, 'Bob');
  assert.equal(page.items[0].excerpt, 'try the pipeline route');
  assert.equal(page.hasMore, false);
});

test('metawebInteractions validates the owner', async () => {
  await assert.rejects(
    () => metawebInteractions({ owner: '  ' }, { fetchImpl: makeFetch({ code: 0, data: {} }) }),
    /requires an owner/,
  );
});

// ---------------------------------------------------------------------------
// R4: metawebPinVersions
// ---------------------------------------------------------------------------

test('metawebPinVersions normalizes the chain and maps 40400 to the NotFound class', async () => {
  const calls = [];
  const fetchImpl = makeFetch({
    code: 0,
    message: '',
    data: {
      pinId: 'pin-v', latest: 'pin-v3', attribution: 'chain',
      versions: [
        { pinId: 'pin-v1', version: '1', createdAt: 1788000000, operation: 'create', author: { name: 'Alice' } },
        { pinId: 'pin-v3', version: '3', createdAt: 1789000000, operation: 'modify', author: { name: 'Bob' } },
      ],
    },
  }, calls);
  const versions = await metawebPinVersions('pin-v', { fetchImpl });
  assert.equal(calls[0].url, `${DEFAULT_METAWEB_SURF_READS_BASE_URL}/api/metaweb/pin/pin-v/versions`);
  assert.equal(versions.attribution, 'chain');
  assert.equal(versions.latest, 'pin-v3');
  assert.equal(versions.versions.length, 2, 'oldest → newest');
  assert.equal(versions.versions[0].version, '1');
  assert.equal(versions.versions[1].author.name, 'Bob');

  const notFound = makeFetch({ code: 40400, message: 'unknown pin', data: null });
  await assert.rejects(
    () => metawebPinVersions('nope', { fetchImpl: notFound }),
    (error) => error instanceof MetawebPinVersionsNotFoundError && /unknown pin/.test(error.message),
  );
  await assert.rejects(() => metawebPinVersions('   ', { fetchImpl }), /pinId is required/);
});

test('metawebPinVersions stringifies NUMERIC version fields (production wire shape)', async () => {
  // Live production sends "version": 1 as a JSON number — a string-only
  // normalizer blanks it and the tool renders "v?" (caught in review).
  const fetchImpl = makeFetch({
    code: 0,
    message: '',
    data: {
      pinId: 'pin-v', latest: 'pin-v2', attribution: 'local',
      versions: [
        { pinId: 'pin-v1', version: 1, createdAt: 1788000000, operation: 'create', author: {} },
        { pinId: 'pin-v2', version: 2, createdAt: 1789000000, operation: 'modify', author: {} },
      ],
    },
  });
  const versions = await metawebPinVersions('pin-v', { fetchImpl });
  assert.equal(versions.attribution, 'local');
  assert.deepEqual(versions.versions.map((entry) => entry.version), ['1', '2']);
});

// ---------------------------------------------------------------------------
// R6: metawebProtocols
// ---------------------------------------------------------------------------

test('metawebProtocols normalizes items and the rejected list', async () => {
  const calls = [];
  const fetchImpl = makeFetch({
    code: 0,
    message: '',
    data: {
      items: [
        {
          pinId: 'decl-1', currentPinId: 'decl-1', chainName: 'mvc', createdAt: 1789000000,
          author: { name: 'Cara' }, path: '/protocols/newproto', title: 'New Proto',
          protocolName: 'newproto', intro: 'does things', version: '1',
        },
      ],
      rejected: [{ pinId: 'decl-bad', reason: 'missing protocolName' }],
      hasMore: false,
      nextCursor: null,
    },
  }, calls);
  const page = await metawebProtocols({ size: 50 }, { fetchImpl });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/metaweb/protocols');
  assert.equal(url.searchParams.get('size'), '50');
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].protocolName, 'newproto');
  assert.equal(page.items[0].author.name, 'Cara');
  assert.deepEqual(page.rejected, [{ pinId: 'decl-bad', reason: 'missing protocolName' }]);
});

// ---------------------------------------------------------------------------
// Timeout mapping + invalid response body
// ---------------------------------------------------------------------------

test('an abort maps to the actionable timeout message; a non-envelope body is an error', async () => {
  const abortError = new Error('aborted');
  abortError.name = 'AbortError';
  await assert.rejects(
    () => metawebFresh({ protocols: ['simplebuzz'] }, { fetchImpl: makeFetch(abortError), timeoutMs: 2000 }),
    /MetaWeb surf-reads API timed out after 2s — try again later/,
  );
  await assert.rejects(
    () => metawebProtocols({}, { fetchImpl: async () => ({ status: 200, json: async () => null }) }),
    /invalid response/,
  );
});

// ---------------------------------------------------------------------------
// Batch + versions learning tools (read_metaweb_pins_batch / metaweb_pin_versions)
// ---------------------------------------------------------------------------

const { buildMetawebLearningAgentTools } = require('../dist-electron/main/libs/metawebLearningAgentTools.js');

const makePin = (pinId, overrides = {}) => ({
  pinId,
  currentPinId: `${pinId}c`,
  protocol: 'simplenote',
  path: '/protocols/simplenote',
  chainName: 'mvc',
  operation: 'create',
  creator: { globalMetaId: 'gmid', metaid: 'mid', name: 'Alice', address: '0xA' },
  createdAt: 1789000000,
  contentType: 'application/json',
  payload: { content: 'full body' },
  text: 'normalized body',
  truncated: false,
  totalLength: 14,
  meta: { title: `Title ${pinId}`, summary: 'S', tags: [] },
  attachments: [],
  source: 'local',
  ...overrides,
});

const makeLearningHarness = (controlOverrides = {}) => {
  const calls = { batch: [], versions: [] };
  const metawebLearning = {
    search: async () => ({ items: [], hasMore: false, nextCursor: null }),
    readPin: async () => { throw new Error('not used in this test'); },
    readPinsBatch: async (pinIds) => {
      calls.batch.push(pinIds);
      return controlOverrides.batchResult ?? {};
    },
    pinVersions: async (pinId) => {
      calls.versions.push(pinId);
      if (controlOverrides.versionsError) throw controlOverrides.versionsError;
      return controlOverrides.versionsResult ?? { pinId, latest: pinId, attribution: 'chain', versions: [] };
    },
  };
  const tools = buildMetawebLearningAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    metawebLearning,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName, tools };
};

test('learning tools register the batch reader and the versions tool', () => {
  const { tools } = makeLearningHarness();
  const names = tools.map((tool) => tool.name);
  assert.deepEqual(names, ['search_metaweb', 'read_metaweb_pin', 'read_metaweb_pins_batch', 'metaweb_pin_versions']);
  const batchTool = tools.find((tool) => tool.name === 'read_metaweb_pins_batch');
  assert.match(batchTool.description, /prefer this over looping read_metaweb_pin/i);
  assert.match(batchTool.description, /payload field is NEVER truncated/i);
  const versionsTool = tools.find((tool) => tool.name === 'metaweb_pin_versions');
  assert.match(versionsTool.description, /"chain" is evidence-grade/i);
  assert.match(versionsTool.description, /may be partial after indexer gaps/i);
});

test('read_metaweb_pins_batch returns per-pin details and verbatim error entries', async () => {
  const { calls, byName } = makeLearningHarness({
    batchResult: {
      'pin-ok': { ...makePin('pin-ok'), version: { latest: 'pin-okc', count: 1 } },
      'pin-bad': { pinId: 'pin-bad', error: 'indexer has no such pin' },
      'pin-empty': { ...makePin('pin-empty', { text: null, truncated: null, totalLength: null }), version: { latest: 'pin-empty', count: 1 } },
    },
  });
  const result = await byName.read_metaweb_pins_batch.handler({ pinIds: ['pin-ok', 'pin-bad', 'pin-empty'] });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.batch, [['pin-ok', 'pin-bad', 'pin-empty']]);
  const text = result.content[0].text;
  assert.match(text, /1\/3 pin\(s\) readable in this batch/);
  assert.match(text, /Title pin-ok/);
  assert.match(text, /error: indexer has no such pin/);
  assert.match(text, /no readable text content/);
});

test('read_metaweb_pins_batch validates the pinIds array', async () => {
  const { byName } = makeLearningHarness();
  const empty = await byName.read_metaweb_pins_batch.handler({ pinIds: [] });
  assert.equal(empty.isError, true);
  assert.match(empty.content[0].text, /at least one pinId/);
  const tooMany = await byName.read_metaweb_pins_batch.handler({ pinIds: Array.from({ length: 51 }, (_, i) => `p${i}`) });
  assert.equal(tooMany.isError, true);
  assert.match(tooMany.content[0].text, /at most 50 pinIds/);
});

test('metaweb_pin_versions renders the chain with attribution guidance and maps NotFound', async () => {
  const { byName } = makeLearningHarness({
    versionsResult: {
      pinId: 'pin-v', latest: 'pin-v2', attribution: 'local',
      versions: [
        { pinId: 'pin-v1', version: '1', createdAt: 1788000000, operation: 'create', author: { name: 'Alice' } },
        { pinId: 'pin-v2', version: '2', createdAt: 1789000000, operation: 'modify', author: { name: 'Bob' } },
      ],
    },
  });
  const result = await byName.metaweb_pin_versions.handler({ pinId: 'pin-v' });
  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  assert.match(text, /attribution: local \(from the local index — may be partial after indexer gaps/);
  assert.match(text, /v1 pin-v1 — create by Alice/);
  assert.match(text, /v2 pin-v2 — modify by Bob/);

  const notFound = new Error('unknown pin');
  notFound.name = 'MetawebPinVersionsNotFoundError';
  const { byName: byNameMissing } = makeLearningHarness({ versionsError: notFound });
  const missing = await byNameMissing.metaweb_pin_versions.handler({ pinId: 'nope' });
  assert.equal(missing.isError, undefined, 'a missing pin is a normal answer, not a tool error');
  assert.match(missing.content[0].text, /No MetaWeb pin matches "nope"/);
});
