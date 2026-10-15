import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CEREBELLUM_REMOTE_SERVICE_SHORTLIST_TIMEOUT_MS,
  CEREBELLUM_REMOTE_SERVICE_SHORTLIST_TOP_K,
  CEREBELLUM_REMOTE_SERVICE_SHORTLIST_MIN_POOL,
  CEREBELLUM_REMOTE_SERVICE_MAX_OPTIONS,
  CEREBELLUM_REMOTE_SERVICE_OPTION_MAX_DESCRIPTION_CHARS,
  CEREBELLUM_REMOTE_SERVICE_RANK_QUESTION_ID,
  buildRemoteServiceOptionLabel,
  buildRemoteServiceShortlistRequest,
  buildRemoteServiceShortlistBlock,
  parseRemoteServiceShortlistAnswers,
  rankRemoteServicesWithCerebellum,
} from '../src/main/cerebellum/remoteServiceShortlist.ts';

const { CoworkRunner } = await import('../dist-electron/main/libs/coworkRunner.js');

const TEST_CONFIG = {
  provider: 'typesafe-jev',
  apiKey: 'sk-jev-test',
  baseUrl: 'https://jev.example.com',
  model: 'jev-latest',
};

function okFetch(payload, captured = []) {
  return async (url, init) => {
    captured.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    };
  };
}

function probabilitiesPayload(probabilities, choice) {
  const answer = { type: 'choice', probabilities };
  if (choice !== undefined) answer.choice = choice;
  return {
    model: 'jev-latest',
    answers: { [CEREBELLUM_REMOTE_SERVICE_RANK_QUESTION_ID]: answer },
    usage: { input_tokens: 900 },
  };
}

const SERVICES = [
  { id: 'svc-weather-i0', name: 'Weather Query', description: 'Query live weather by city with forecasts.' },
  { id: 'svc-translate-i0', name: 'Pro Translation', description: '专业文档翻译：术语表、双语对照。' },
  { id: 'svc-image-i0', name: 'Image Gen', description: 'Text-to-image generation for posters and avatars.' },
];

function buildPool(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `svc-${index}-i0`,
    name: `service-${index}`,
    description: `On-chain capability number ${index}: fulfills request family ${index} end to end.`,
  }));
}

const RANK_INPUT = {
  config: TEST_CONFIG,
  currentUserText: '帮我查一下上海明天的天气',
  services: buildPool(CEREBELLUM_REMOTE_SERVICE_SHORTLIST_MIN_POOL + 3),
};

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

test('buildRemoteServiceShortlistRequest: user message in state, services as choice criteria keyed by pin id', () => {
  const request = buildRemoteServiceShortlistRequest({
    currentUserText: '帮我查上海天气',
    services: SERVICES,
    model: 'jev-fast',
  });
  assert.deepEqual(request.state, { current_message: '帮我查上海天气' });
  assert.equal(request.model, 'jev-fast');
  assert.deepEqual(Object.keys(request.questions), [CEREBELLUM_REMOTE_SERVICE_RANK_QUESTION_ID]);
  const question = request.questions[CEREBELLUM_REMOTE_SERVICE_RANK_QUESTION_ID];
  assert.equal(question.type, 'choice');
  assert.deepEqual(Object.keys(question.criteria), SERVICES.map((service) => service.id));
  assert.equal(question.criteria['svc-weather-i0'], 'Weather Query: Query live weather by city with forecasts.');
});

test('buildRemoteServiceShortlistRequest: blank user text still builds (module-level blank guard is in the rank call)', () => {
  const request = buildRemoteServiceShortlistRequest({
    currentUserText: '   ',
    services: SERVICES,
    model: 'jev-latest',
  });
  assert.equal(request.state.current_message, '');
});

test('buildRemoteServiceShortlistRequest: criteria label collapses description whitespace', () => {
  const label = buildRemoteServiceOptionLabel({
    id: 'svc-x-i0',
    name: 'Noisy',
    description: '  line one\n\tline   two  ',
  });
  assert.equal(label, 'Noisy: line one line two');
});

test('buildRemoteServiceShortlistRequest: description capped at the option char limit, name-only fallback', () => {
  const long = 'x'.repeat(CEREBELLUM_REMOTE_SERVICE_OPTION_MAX_DESCRIPTION_CHARS + 50);
  const label = buildRemoteServiceOptionLabel({ id: 'svc-long-i0', name: 'Long', description: long });
  assert.equal(label.length, `Long: `.length + CEREBELLUM_REMOTE_SERVICE_OPTION_MAX_DESCRIPTION_CHARS);
  assert.equal(
    buildRemoteServiceOptionLabel({ id: 'svc-empty-i0', name: 'Silent', description: '   ' }),
    'Silent',
    'empty description degrades to the bare name',
  );
});

test('buildRemoteServiceShortlistRequest: pool capped at the JEV choice limit', () => {
  const oversized = Array.from({ length: CEREBELLUM_REMOTE_SERVICE_MAX_OPTIONS + 20 }, (_, index) => ({
    id: `svc-${index}-i0`,
    name: `service-${index}`,
    description: `Capability ${index}`,
  }));
  const request = buildRemoteServiceShortlistRequest({
    currentUserText: 'anything',
    services: oversized,
    model: 'jev-latest',
  });
  assert.equal(
    Object.keys(request.questions[CEREBELLUM_REMOTE_SERVICE_RANK_QUESTION_ID].criteria).length,
    CEREBELLUM_REMOTE_SERVICE_MAX_OPTIONS,
  );
});

// ---------------------------------------------------------------------------
// Answer parsing
// ---------------------------------------------------------------------------

test('parseRemoteServiceShortlistAnswers: probabilities sorted desc with stable id tie-break', () => {
  const parsed = parseRemoteServiceShortlistAnswers(
    probabilitiesPayload({ 'svc-a-i0': 0.2, 'svc-b-i0': 0.9, 'svc-c-i0': 0.9 }),
    [...SERVICES, { id: 'svc-a-i0', name: 'a', description: '' }, { id: 'svc-b-i0', name: 'b', description: '' }, { id: 'svc-c-i0', name: 'c', description: '' }],
  );
  assert.deepEqual(parsed, [
    { id: 'svc-b-i0', probability: 0.9 },
    { id: 'svc-c-i0', probability: 0.9 },
    { id: 'svc-a-i0', probability: 0.2 },
  ]);
});

test('parseRemoteServiceShortlistAnswers: unknown option ids skipped, values clamped to [0,1]', () => {
  const parsed = parseRemoteServiceShortlistAnswers(
    probabilitiesPayload({ 'svc-weather-i0': 1.7, 'ghost-i0': 0.8, 'svc-translate-i0': -0.4 }),
    SERVICES,
  );
  assert.deepEqual(parsed, [
    { id: 'svc-weather-i0', probability: 1 },
    { id: 'svc-translate-i0', probability: 0 },
  ]);
});

test('parseRemoteServiceShortlistAnswers: top-level choice fallback when probabilities unusable', () => {
  const parsed = parseRemoteServiceShortlistAnswers(
    probabilitiesPayload('not-a-map', 'svc-image-i0'),
    SERVICES,
  );
  assert.deepEqual(parsed, [{ id: 'svc-image-i0', probability: 1 }]);
  const unknownChoice = parseRemoteServiceShortlistAnswers(
    probabilitiesPayload(null, 'ghost-i0'),
    SERVICES,
  );
  assert.equal(unknownChoice, null);
});

test('parseRemoteServiceShortlistAnswers: null on every unusable shape', () => {
  assert.equal(parseRemoteServiceShortlistAnswers(null, SERVICES), null);
  assert.equal(parseRemoteServiceShortlistAnswers('nope', SERVICES), null);
  assert.equal(parseRemoteServiceShortlistAnswers({}, SERVICES), null);
  assert.equal(parseRemoteServiceShortlistAnswers({ answers: {} }, SERVICES), null);
  assert.equal(
    parseRemoteServiceShortlistAnswers({ answers: { [CEREBELLUM_REMOTE_SERVICE_RANK_QUESTION_ID]: 'bad' } }, SERVICES),
    null,
  );
  assert.equal(
    parseRemoteServiceShortlistAnswers(probabilitiesPayload({ ghost: 1 }), SERVICES),
    null,
    'a probabilities map with zero known ids is unusable',
  );
});

// ---------------------------------------------------------------------------
// rankRemoteServicesWithCerebellum (fail-open contract)
// ---------------------------------------------------------------------------

test('rankRemoteServicesWithCerebellum: happy path posts the built request and returns the sorted ranking', async () => {
  const captured = [];
  const ranking = await rankRemoteServicesWithCerebellum({
    ...RANK_INPUT,
    fetchImpl: okFetch(probabilitiesPayload({ 'svc-2-i0': 0.3, 'svc-0-i0': 0.8 }), captured),
  });
  assert.deepEqual(ranking, [{ id: 'svc-0-i0', probability: 0.8 }, { id: 'svc-2-i0', probability: 0.3 }]);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, `${TEST_CONFIG.baseUrl}/v1/systemone`);
  assert.equal(captured[0].init.headers.Authorization, `Bearer ${TEST_CONFIG.apiKey}`);
  assert.equal(
    captured[0].body.questions[CEREBELLUM_REMOTE_SERVICE_RANK_QUESTION_ID].instructions.length > 0,
    true,
  );
  assert.equal(
    Object.keys(captured[0].body.questions[CEREBELLUM_REMOTE_SERVICE_RANK_QUESTION_ID].criteria).length,
    RANK_INPUT.services.length,
  );
});

test('rankRemoteServicesWithCerebellum: blank user text never calls', async () => {
  let called = 0;
  const ranking = await rankRemoteServicesWithCerebellum({
    ...RANK_INPUT,
    currentUserText: '   ',
    fetchImpl: async () => {
      called += 1;
      throw new Error('must not be called');
    },
  });
  assert.equal(ranking, null);
  assert.equal(called, 0);
});

test('rankRemoteServicesWithCerebellum: pools below the minimum never call', async () => {
  let called = 0;
  const ranking = await rankRemoteServicesWithCerebellum({
    ...RANK_INPUT,
    services: buildPool(CEREBELLUM_REMOTE_SERVICE_SHORTLIST_MIN_POOL - 1),
    fetchImpl: async () => {
      called += 1;
      throw new Error('must not be called');
    },
  });
  assert.equal(ranking, null);
  assert.equal(called, 0);
});

test('rankRemoteServicesWithCerebellum: HTTP error, network error, malformed payload all resolve null', async () => {
  const httpError = await rankRemoteServicesWithCerebellum({
    ...RANK_INPUT,
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  assert.equal(httpError, null);

  const networkError = await rankRemoteServicesWithCerebellum({
    ...RANK_INPUT,
    fetchImpl: async () => {
      throw new Error('ECONNRESET');
    },
  });
  assert.equal(networkError, null);

  const malformed = await rankRemoteServicesWithCerebellum({
    ...RANK_INPUT,
    fetchImpl: okFetch({ unexpected: true }),
  });
  assert.equal(malformed, null);
});

test('rankRemoteServicesWithCerebellum: timeout aborts to null', async () => {
  const ranking = await rankRemoteServicesWithCerebellum({
    ...RANK_INPUT,
    timeoutMs: 5,
    fetchImpl: (url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  });
  assert.equal(ranking, null);
});

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

test('buildRemoteServiceShortlistBlock: renders only the top-K with a suggestion line and no probabilities', () => {
  const pool = buildPool(8).map((service, index) => ({ ...service, probability: 1 - index * 0.1 }));
  const block = buildRemoteServiceShortlistBlock(pool);
  const lines = block.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(lines.length, CEREBELLUM_REMOTE_SERVICE_SHORTLIST_TOP_K);
  assert.ok(block.startsWith('<remote_service_shortlist>'));
  assert.ok(block.endsWith('</remote_service_shortlist>'));
  assert.match(block, /Suggested service: `service-0`\./);
  assert.ok(!block.includes('0.9'), 'probabilities are never rendered');
  assert.ok(!block.includes('0.8'), 'probabilities are never rendered');
});

test('buildRemoteServiceShortlistBlock: empty entries degrade to an empty block shell', () => {
  const block = buildRemoteServiceShortlistBlock([]);
  assert.ok(block.includes('<remote_service_shortlist>'));
  assert.ok(!block.includes('Suggested service'));
});

// ---------------------------------------------------------------------------
// CoworkRunner integration (compiled dist; lightweight DI harness)
// ---------------------------------------------------------------------------

const DIRECTORY_TEXT = ['<available_remote_services>',
  '  <remote_service><service_name>svc-a</service_name></remote_service>',
  '  <remote_service><service_name>svc-b</service_name></remote_service>',
  '</available_remote_services>'].join('\n');

function createShortlistHarness({
  ranker,
  gate,
  disableRemoteServicesPrompt = false,
} = {}) {
  const rankerCalls = [];
  const gateCalls = [];
  const store = {
    getMetabotIdForSession() {
      return 7;
    },
    getSessionWithoutMessages() {
      return {};
    },
  };
  const runner = new CoworkRunner(store, {
    getRemoteServicesPrompt: () => DIRECTORY_TEXT,
    // Merged turn-decision bundle (mock of the main.ts caller): the service
    // ranking is consulted only when the directory rides this turn, exactly
    // like the real caller honors remoteServicesEnabled; the block gate
    // verdicts ride the same single callback.
    cerebellumTurnDecisions: ranker || gate
      ? async (input) => {
          if (gate) {
            gateCalls.push(input);
          }
          let serviceRanking = null;
          if (ranker && input.remoteServicesEnabled) {
            rankerCalls.push(input);
            serviceRanking = await ranker(input);
          }
          return {
            memoryScores: null,
            knowledgeScores: null,
            skillRanking: null,
            serviceRanking,
            gateVerdicts: gate ? await gate(input) : null,
          };
        }
      : undefined,
  });
  runner.activeSessions.set('session-1', {
    skillsCatalogMode: 'volatile',
    claudeSessionId: 'sdk-gen-1',
  });
  const buildVolatile = (prompt) =>
    runner.buildVolatileContextPrompt('session-1', prompt, false, { includeMemoryPromptBlocks: false }, disableRemoteServicesPrompt);
  return { runner, rankerCalls, gateCalls, buildVolatile };
}

const SHORTLIST_QUERY = '帮我查一下上海明天的天气';

test('runner: the shortlist block rides next to the untouched directory block', async () => {
  const { rankerCalls, buildVolatile } = createShortlistHarness({
    ranker: () => [
      { id: 'svc-a-i0', name: 'svc-a', description: 'handles family A', probability: 0.9 },
      { id: 'svc-b-i0', name: 'svc-b', description: 'handles family B', probability: 0.3 },
    ],
  });
  const output = await buildVolatile(SHORTLIST_QUERY);

  assert.equal(rankerCalls.length, 1, 'the ranker is consulted once per turn');
  assert.equal(rankerCalls[0].currentUserText, SHORTLIST_QUERY);
  assert.ok(output.includes(DIRECTORY_TEXT), 'the directory block is untouched');
  assert.match(output, /<remote_service_shortlist>/);
  assert.match(output, /- `svc-a`: handles family A/);
  assert.match(output, /Suggested service: `svc-a`\./);
});

test('runner: a null ranking reproduces the no-ranker output byte-for-byte', async () => {
  const withNull = createShortlistHarness({ ranker: () => null });
  const without = createShortlistHarness({ ranker: null });

  const outputNull = await withNull.buildVolatile(SHORTLIST_QUERY);
  const outputNone = await without.buildVolatile(SHORTLIST_QUERY);

  assert.equal(outputNull, outputNone, 'null ranking must reproduce the ungated baseline exactly');
  assert.ok(outputNull.includes(DIRECTORY_TEXT));
  assert.ok(!outputNull.includes('<remote_service_shortlist>'));
});

test('runner: a throwing ranker falls back silently', async () => {
  const { rankerCalls, buildVolatile } = createShortlistHarness({
    ranker: () => {
      throw new Error('cerebellum exploded');
    },
  });
  const baseline = createShortlistHarness({ ranker: null });

  const output = await buildVolatile(SHORTLIST_QUERY);
  const outputBaseline = await baseline.buildVolatile(SHORTLIST_QUERY);

  assert.equal(rankerCalls.length, 1);
  assert.equal(output, outputBaseline, 'a throwing callback must never break the turn');
});

test('runner: a blank prompt never calls the ranker', async () => {
  const { rankerCalls, buildVolatile } = createShortlistHarness({
    ranker: () => [{ id: 'svc-a-i0', name: 'svc-a', description: 'x', probability: 1 }],
  });
  await buildVolatile('   ');
  assert.equal(rankerCalls.length, 0);
});

test('runner: sessions with the remote-services prompt disabled skip the ranker and the block entirely', async () => {
  const { rankerCalls, buildVolatile } = createShortlistHarness({
    disableRemoteServicesPrompt: true,
    ranker: () => [{ id: 'svc-a-i0', name: 'svc-a', description: 'x', probability: 1 }],
  });
  const output = await buildVolatile(SHORTLIST_QUERY);
  assert.equal(rankerCalls.length, 0, 'no directory block means no shortlist surface');
  assert.ok(!output.includes('<available_remote_services>'));
  assert.ok(!output.includes('<remote_service_shortlist>'));
});

test('runner: a block-gate skip drops the shortlist with the directory block', async () => {
  const { rankerCalls, buildVolatile } = createShortlistHarness({
    ranker: () => [{ id: 'svc-a-i0', name: 'svc-a', description: 'x', probability: 1 }],
    gate: () => ({ 'remote-services': false, experience: false, 'twin-impression': false, 'knowledge-bases': false }),
  });
  const output = await buildVolatile(SHORTLIST_QUERY);
  assert.ok(output !== undefined);
  assert.ok(!output.includes('<available_remote_services>'), 'the gate skipped the directory');
  assert.ok(!output.includes('<remote_service_shortlist>'), 'the shortlist never rides without its block');
  // Fire-at-entry semantics: the rank promise overlaps the gate call, so the
  // ranker was already consulted when the verdict landed — a bounded cost
  // (~one call, pools >= 12 only) accepted to keep the shared 1.5s budget.
  assert.equal(rankerCalls.length, 1);
});

test('runner: the rank call starts before the sections build (overlaps the other cerebellum calls)', async () => {
  const events = [];
  const { buildVolatile } = createShortlistHarness({
    ranker: async () => {
      events.push('rank-start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push('rank-end');
      return [{ id: 'svc-a-i0', name: 'svc-a', description: 'handles family A', probability: 0.9 }];
    },
  });
  events.push('volatile-start');
  await buildVolatile(SHORTLIST_QUERY);
  assert.equal(events[0], 'volatile-start');
  assert.equal(events[1], 'rank-start', 'the rank call fires immediately, not after the sections');
  assert.equal(events[events.length - 1], 'rank-end');
});
