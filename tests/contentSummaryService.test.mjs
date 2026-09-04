import test from 'node:test';
import assert from 'node:assert/strict';

const { createNativeSqliteDatabase } = await import('../dist-electron/main/nativeSqliteDatabase.js')
  .catch(() => import('../dist-electron/nativeSqliteDatabase.js'));
const {
  ChainContentHistoryStore,
} = await import('../dist-electron/main/chainContentHistoryStore.js')
  .catch(() => import('../dist-electron/chainContentHistoryStore.js'));
const {
  ContentSummaryService,
  OrchestratorSummarizerProvider,
  CONTENT_SUMMARY_MAX_PER_TICK,
} = await import('../dist-electron/main/services/contentSummaryService.js')
  .catch(() => import('../dist-electron/services/contentSummaryService.js'));

const T_NOW = new Date(2026, 8, 3, 10, 0, 0); // local 2026-09-03 10:00
const T_NOW_MS = T_NOW.getTime();
// Well above SUMMARY_MIN_CONTENT_CHARS (800) so rows land in 'pending'.
const LONG_TEXT = 'the quick brown fox jumps over the lazy dog. '.repeat(60);

const makeWrite = (overrides = {}) => ({
  metabotId: 7,
  pinId: 'pin-w-1',
  path: '/protocols/simplebuzz',
  operation: 'create',
  contentText: LONG_TEXT,
  contentType: 'text/plain',
  origin: 'tool:post_buzz',
  occurredAtMs: T_NOW_MS - 60_000,
  ...overrides,
});

const makeRead = (overrides = {}) => ({
  metabotId: 7,
  pinId: 'pin-r-1',
  path: '/protocols/simplenote',
  protocol: 'simplenote',
  title: 'Some article',
  authorGlobalMetaId: 'gm-author',
  contentText: LONG_TEXT,
  source: 'read_metaweb_pin',
  readAtMs: T_NOW_MS - 30_000,
  ...overrides,
});

const setup = ({ config = {}, provider } = {}) => {
  const db = createNativeSqliteDatabase(':memory:');
  assert.ok(db, 'native sqlite available in test runtime');
  const store = new ChainContentHistoryStore(db, () => {});
  const configMap = new Map(Object.entries(config));
  const calls = [];
  const service = new ContentSummaryService({
    store,
    provider: provider ?? {
      summarize: async (input) => {
        calls.push(input);
        return `gist of ${input.kind} ${input.path ?? ''}`.trim();
      },
    },
    getConfigValue: (key) => (configMap.has(key) ? configMap.get(key) : null),
    now: () => T_NOW,
  });
  return { store, service, calls };
};

test('contentSummaryEnabled=0 leaves every pending row untouched', async () => {
  const { store, service, calls } = setup({ config: { contentSummaryEnabled: '0' } });
  store.recordWrite(makeWrite());
  store.recordRead(makeRead());

  const result = await service.runTick();

  assert.deepEqual(result, { done: 0, failed: 0, skipped: 0 });
  assert.equal(calls.length, 0, 'provider never called while disabled');
  assert.equal(store.getWriteByPinId('pin-w-1').summaryStatus, 'pending');
  assert.equal(store.getReadByPinId(7, 'pin-r-1').summaryStatus, 'pending');

  const off = setup({ config: { contentSummaryEnabled: 'false' } });
  off.store.recordWrite(makeWrite());
  assert.deepEqual(await off.service.runTick(), { done: 0, failed: 0, skipped: 0 });
  assert.equal(off.calls.length, 0);
});

test('success path: pending → done with summary and summarizedAtMs', async () => {
  const { store, service, calls } = setup();
  store.recordWrite(makeWrite());
  const id = store.getWriteByPinId('pin-w-1').id;

  const result = await service.runTick();

  assert.deepEqual(result, { done: 1, failed: 0, skipped: 0 });
  const row = store.getWriteByPinId('pin-w-1');
  assert.equal(row.summaryStatus, 'done');
  assert.equal(row.summary, 'gist of write /protocols/simplebuzz');
  assert.equal(row.summarizedAtMs, T_NOW_MS);
  assert.equal(row.summaryAttempts, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'write');
  assert.equal(store.listPendingSummaries('write', 10).length, 0, 'done rows leave the queue');
  assert.equal(store.countSummariesSince('write', 7, T_NOW_MS - 1), 1);
  assert.ok(id > 0);
});

test('a failing item burns one attempt and never interrupts the batch', async () => {
  const calls = [];
  const { store, service } = setup({
    provider: {
      summarize: async (input) => {
        calls.push(input);
        if (input.content.startsWith('FAIL')) throw new Error('LLM exploded');
        return 'second gist';
      },
    },
  });
  store.recordWrite(makeWrite({ pinId: 'pin-first', contentText: `FAIL ${LONG_TEXT}`, occurredAtMs: T_NOW_MS - 60_000 }));
  store.recordWrite(makeWrite({ pinId: 'pin-second', occurredAtMs: T_NOW_MS - 50_000 }));

  const result = await service.runTick();

  assert.deepEqual(result, { done: 1, failed: 1, skipped: 0 });
  assert.equal(calls.length, 2, 'the second row is attempted after the first fails');
  const first = store.getWriteByPinId('pin-first');
  assert.equal(first.summaryStatus, 'pending', 'failure keeps the row retryable');
  assert.equal(first.summaryAttempts, 1);
  const second = store.getWriteByPinId('pin-second');
  assert.equal(second.summaryStatus, 'done');
  assert.equal(second.summary, 'second gist');

  // Later ticks retry the failed row until MAX_SUMMARY_ATTEMPTS.
  await service.runTick();
  await service.runTick();
  const terminal = store.getWriteByPinId('pin-first');
  assert.equal(terminal.summaryAttempts, 3);
  assert.equal(terminal.summaryStatus, 'failed');
});

test('per-tick cap: at most CONTENT_SUMMARY_MAX_PER_TICK rows per tick', async () => {
  const { store, service, calls } = setup();
  for (let index = 0; index < CONTENT_SUMMARY_MAX_PER_TICK + 2; index += 1) {
    store.recordWrite(makeWrite({ pinId: `pin-cap-${index}`, occurredAtMs: T_NOW_MS - 100_000 + index }));
  }

  const result = await service.runTick();

  assert.equal(result.done, CONTENT_SUMMARY_MAX_PER_TICK);
  assert.equal(calls.length, CONTENT_SUMMARY_MAX_PER_TICK);
  assert.equal(store.listPendingSummaries('write', 50).length, 2, 'the remainder waits for the next tick');
  // Oldest first: the two newest rows are the ones left pending.
  assert.equal(store.getWriteByPinId(`pin-cap-${CONTENT_SUMMARY_MAX_PER_TICK}`).summaryStatus, 'pending');
  assert.equal(store.getWriteByPinId('pin-cap-0').summaryStatus, 'done');
});

test('daily cap: a bot at its cap is skipped while other bots keep draining', async () => {
  const { store, service, calls } = setup({ config: { contentSummaryDailyCap: '2' } });
  store.recordWrite(makeWrite({ pinId: 'pin-b7-1', occurredAtMs: T_NOW_MS - 90_000 }));
  store.recordWrite(makeWrite({ pinId: 'pin-b7-2', occurredAtMs: T_NOW_MS - 80_000 }));
  store.recordWrite(makeWrite({ pinId: 'pin-b7-3', occurredAtMs: T_NOW_MS - 70_000 }));
  store.recordWrite(makeWrite({ pinId: 'pin-b8-1', metabotId: 8, occurredAtMs: T_NOW_MS - 60_000 }));

  const result = await service.runTick();

  assert.equal(result.done, 3, 'two from bot 7 (cap), one from bot 8');
  assert.equal(result.skipped, 1, 'bot 7 third row skipped at the cap');
  assert.equal(calls.filter((input) => input.metabotId === 7).length, 2);
  assert.equal(calls.filter((input) => input.metabotId === 8).length, 1);
  assert.equal(store.getWriteByPinId('pin-b7-3').summaryStatus, 'pending');
  assert.equal(store.getWriteByPinId('pin-b8-1').summaryStatus, 'done');
  assert.equal(store.countSummariesSince('write', 7, 0) + store.countSummariesSince('read', 7, 0), 2);

  // In-tick successes count against the cap: the leftover row stays pending.
  const second = await service.runTick();
  assert.equal(second.done, 0);
  assert.equal(second.skipped, 1);
});

test('write and read queues are both drained, capped across kinds combined', async () => {
  const { store, service, calls } = setup();
  store.recordWrite(makeWrite());
  store.recordRead(makeRead());

  const result = await service.runTick();

  assert.deepEqual(result, { done: 2, failed: 0, skipped: 0 });
  assert.deepEqual(calls.map((input) => input.kind), ['write', 'read']);
  assert.equal(store.getWriteByPinId('pin-w-1').summaryStatus, 'done');
  assert.equal(store.getReadByPinId(7, 'pin-r-1').summaryStatus, 'done');
});

test('provider receives kind/title/path/content mapped from the stored row', async () => {
  const { store, service, calls } = setup();
  store.recordWrite(makeWrite({ pinId: 'pin-w-in', path: '/protocols/simplebuzz' }));
  store.recordRead(makeRead({ pinId: 'pin-r-in', path: '/protocols/simplenote', title: 'Chain Weekly' }));

  await service.runTick();

  assert.equal(calls.length, 2);
  const writeInput = calls.find((input) => input.kind === 'write');
  assert.deepEqual(writeInput, {
    kind: 'write',
    metabotId: 7,
    title: null,
    path: '/protocols/simplebuzz',
    content: LONG_TEXT,
  });
  const readInput = calls.find((input) => input.kind === 'read');
  assert.deepEqual(readInput, {
    kind: 'read',
    metabotId: 7,
    title: 'Chain Weekly',
    path: '/protocols/simplenote',
    content: LONG_TEXT,
  });
});

test('OrchestratorSummarizerProvider: llm resolution, call shape, truncation', async () => {
  const llmCalls = [];
  const makeProvider = (configMap) => new OrchestratorSummarizerProvider({
    performChat: async (system, user, llmId, options) => {
      llmCalls.push({ system, user, llmId, options });
      return 'a'.repeat(600);
    },
    getConfigValue: (key) => (configMap.has(key) ? configMap.get(key) : null),
    resolveBotLlm: () => ({ llmId: 'bot-llm', llmProvider: 'bot-provider', fallbackLlmId: 'bot-fallback', fallbackLlmProvider: 'bot-fallback-provider' }),
  });
  const input = { kind: 'write', metabotId: 7, title: null, path: '/p', content: 'body text' };

  // Bot brain pair is used when no global override is configured.
  const plain = makeProvider(new Map());
  const summary = await plain.summarize(input);
  assert.equal(summary.length, 500, 'summary is capped at 500 chars');
  assert.equal(llmCalls[0].llmId, 'bot-llm');
  assert.equal(llmCalls[0].options.llmProvider, 'bot-provider');
  assert.equal(llmCalls[0].options.fallbackLlmId, 'bot-fallback');
  assert.equal(llmCalls[0].options.fallbackLlmProvider, 'bot-fallback-provider');
  assert.equal(llmCalls[0].options.maxTokens, 512);
  assert.equal(llmCalls[0].options.thinking, 'disabled');
  assert.equal(llmCalls[0].options.webSearch, false);
  assert.equal(llmCalls[0].options.throwOnEmptyContent, true);
  // Per-attempt timeout window replaces the old shared abort signal, so a
  // primary timeout leaves the fallback brain a fresh budget.
  assert.equal(llmCalls[0].options.attemptTimeoutMs, 60_000);
  assert.match(llmCalls[0].user, /You published the following content on-chain/);

  // cowork_config.contentSummaryLlmId overrides the bot brain and suppresses its fallback.
  const overridden = makeProvider(new Map([['contentSummaryLlmId', 'official-small-model']]));
  await overridden.summarize({ ...input, kind: 'read', title: 'T' });
  assert.equal(llmCalls[1].llmId, 'official-small-model');
  assert.equal(llmCalls[1].options.llmProvider, null);
  assert.equal(llmCalls[1].options.fallbackLlmId, null);
  assert.equal(llmCalls[1].options.fallbackLlmProvider, null);
  assert.match(llmCalls[1].user, /You read the following on-chain content/);
  assert.match(llmCalls[1].user, /title: T/);

  // An empty completion is a failure, not a stored blank summary.
  const empty = new OrchestratorSummarizerProvider({
    performChat: async () => '   ',
    getConfigValue: () => null,
    resolveBotLlm: () => null,
  });
  await assert.rejects(() => empty.summarize(input), /empty summary/i);
});
