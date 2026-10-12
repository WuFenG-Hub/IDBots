import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CEREBELLUM_MEMORY_MAX_CANDIDATES,
  CEREBELLUM_MEMORY_MIN_POOL,
  CEREBELLUM_MEMORY_RANK_INSTRUCTIONS,
  buildMemoryRankQuestions,
  buildMemoryRankRequest,
  parseMemoryRankAnswers,
  rankMemoriesWithCerebellum,
} from '../src/main/cerebellum/memoryRank.ts';

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

function noulPayload(memories, scoreOf = () => 0.5) {
  const answers = {};
  memories.forEach((memory, index) => {
    answers[`mem_${index}`] = { noul: scoreOf(memory, index) };
  });
  return { model: 'jev-latest', answers, usage: { input_tokens: 100 } };
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

test('buildMemoryRankRequest carries the state, model and one noul question per memory', () => {
  const memories = [
    { id: 'm1', text: '主人的猫叫布丁' },
    { id: 'm2', text: '主人偏好简洁直接的回答' },
  ];
  const request = buildMemoryRankRequest({
    currentUserText: '帮我给布丁挑猫粮',
    memories,
    model: 'jev-fast',
  });

  assert.deepEqual(request.state, {
    current_message: '帮我给布丁挑猫粮',
    memories,
  });
  assert.equal(request.model, 'jev-fast');
  assert.deepEqual(Object.keys(request.questions), ['mem_0', 'mem_1']);
  for (const [index, key] of ['mem_0', 'mem_1'].entries()) {
    const question = request.questions[key];
    assert.equal(question.type, 'noul');
    assert.match(question.instructions, /Would the memory at `memories\[\d\]\.text` be useful context/);
    assert.ok(question.instructions.includes(`memories[${index}].text`), 'each question references its own dot-index path');
    assert.ok(question.instructions.includes('`current_message`'));
    assert.match(question.criteria.true, /noticeably better with this memory/);
    assert.match(question.criteria.false, /unrelated|surface words/);
  }
});

test('buildMemoryRankQuestions builds exactly count questions from the shared template', () => {
  const questions = buildMemoryRankQuestions(3);
  assert.equal(Object.keys(questions).length, 3);
  assert.ok(questions.mem_0.instructions.startsWith(CEREBELLUM_MEMORY_RANK_INSTRUCTIONS.split('{{INDEX}}')[0]));
  assert.ok(!questions.mem_1.instructions.includes('{{INDEX}}'), 'the index placeholder is fully substituted');
});

// ---------------------------------------------------------------------------
// Answer parsing
// ---------------------------------------------------------------------------

test('parseMemoryRankAnswers maps mem_<i> answers back to memory ids', () => {
  const memories = [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }, { id: 'c', text: 'z' }];
  const scores = parseMemoryRankAnswers(
    { answers: { mem_0: { noul: 0.9 }, mem_1: { noul: 0 }, mem_2: { noul: 0.42 } } },
    memories,
  );
  assert.deepEqual([...scores.entries()], [['a', 0.9], ['b', 0], ['c', 0.42]]);
});

test('parseMemoryRankAnswers tolerates missing and malformed entries', () => {
  const memories = [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }, { id: 'c', text: 'z' }, { id: 'd', text: 'w' }];
  const scores = parseMemoryRankAnswers(
    {
      answers: {
        mem_0: { noul: 0.7 },
        // mem_1 missing entirely
        mem_2: { noul: 'high' }, // non-numeric noul
        mem_3: 'not-an-object',
        unrelated_key: { noul: 1 }, // not a mem_<i> key — ignored
      },
    },
    memories,
  );
  assert.deepEqual([...scores.entries()], [['a', 0.7]], 'only the well-formed answer survives');
});

test('parseMemoryRankAnswers returns null when the payload has no answers object', () => {
  const memories = [{ id: 'a', text: 'x' }];
  assert.equal(parseMemoryRankAnswers(null, memories), null);
  assert.equal(parseMemoryRankAnswers('nope', memories), null);
  assert.equal(parseMemoryRankAnswers({}, memories), null);
  assert.equal(parseMemoryRankAnswers({ answers: 'nope' }, memories), null);
});

// ---------------------------------------------------------------------------
// rankMemoriesWithCerebellum
// ---------------------------------------------------------------------------

test('rankMemoriesWithCerebellum posts one request and returns the score map', async () => {
  const memories = [
    { id: 'm1', text: '主人的猫叫布丁' },
    { id: 'm2', text: '主人偏好简洁直接的回答' },
  ];
  const captured = [];
  const scores = await rankMemoriesWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl: okFetch(noulPayload(memories, (m) => (m.id === 'm1' ? 0.91 : 0.05)), captured),
    currentUserText: '帮我给布丁挑猫粮',
    memories,
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, 'https://jev.example.com/v1/systemone');
  assert.equal(captured[0].init.method, 'POST');
  assert.equal(captured[0].init.headers.Authorization, 'Bearer sk-jev-test');
  assert.equal(captured[0].init.headers['Content-Type'], 'application/json');
  assert.equal(captured[0].body.model, 'jev-latest');
  assert.equal(captured[0].body.state.current_message, '帮我给布丁挑猫粮');
  assert.equal(Object.keys(captured[0].body.questions).length, 2);
  assert.deepEqual([...scores.entries()], [['m1', 0.91], ['m2', 0.05]]);
});

test('rankMemoriesWithCerebellum returns null on HTTP errors', async () => {
  for (const status of [401, 500]) {
    const fetchImpl = async () => ({ ok: false, status, json: async () => ({}) });
    const scores = await rankMemoriesWithCerebellum({
      config: TEST_CONFIG,
      fetchImpl,
      currentUserText: 'hello',
      memories: [{ id: 'm1', text: 'x' }],
    });
    assert.equal(scores, null, `HTTP ${status} must fall back to lexical (null)`);
  }
});

test('rankMemoriesWithCerebellum returns null on network errors and malformed payloads', async () => {
  const memories = [{ id: 'm1', text: 'x' }];
  assert.equal(
    await rankMemoriesWithCerebellum({
      config: TEST_CONFIG,
      fetchImpl: async () => { throw new Error('ECONNRESET'); },
      currentUserText: 'hello',
      memories,
    }),
    null,
  );
  assert.equal(
    await rankMemoriesWithCerebellum({
      config: TEST_CONFIG,
      fetchImpl: okFetch({ no_answers: true }),
      currentUserText: 'hello',
      memories,
    }),
    null,
  );
  assert.equal(
    await rankMemoriesWithCerebellum({
      config: TEST_CONFIG,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }),
      currentUserText: 'hello',
      memories,
    }),
    null,
  );
});

test('rankMemoriesWithCerebellum returns null when answer coverage is incomplete', async () => {
  // 5 memories, only 3 answered (60% < 80%): the partial map would let
  // unscored lexical entries (>= 1) outrank every noul (<= 1) downstream, so
  // the whole ranking must fall back to lexical instead of mixing scales.
  const memories = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, text: `memory ${i}` }));
  const partial = { answers: { mem_0: { noul: 0.9 }, mem_1: { noul: 0.1 }, mem_2: { noul: 0.4 } } };
  const scores = await rankMemoriesWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl: okFetch(partial),
    currentUserText: 'hello',
    memories,
  });
  assert.equal(scores, null);

  // 4 of 5 answered (80%) meets the coverage floor.
  const adequate = {
    answers: {
      mem_0: { noul: 0.9 }, mem_1: { noul: 0.1 }, mem_2: { noul: 0.4 }, mem_3: { noul: 0.2 },
    },
  };
  const covered = await rankMemoriesWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl: okFetch(adequate),
    currentUserText: 'hello',
    memories,
  });
  assert.deepEqual([...covered.entries()], [['m0', 0.9], ['m1', 0.1], ['m2', 0.4], ['m3', 0.2]]);
});

test('rankMemoriesWithCerebellum aborts past the timeout and returns null', async () => {
  let abortSeen = false;
  const fetchImpl = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => {
      abortSeen = true;
      reject(new Error('The operation was aborted'));
    });
  });
  const startedAt = Date.now();
  const scores = await rankMemoriesWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl,
    currentUserText: 'hello',
    memories: [{ id: 'm1', text: 'x' }],
    timeoutMs: 30,
  });
  assert.equal(scores, null);
  assert.ok(abortSeen, 'the abort signal must fire');
  assert.ok(Date.now() - startedAt < 1000, 'the timeout path returns promptly');
});

test('rankMemoriesWithCerebellum skips the call for blank text or an empty pool', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, json: async () => ({}) }; };
  assert.equal(
    await rankMemoriesWithCerebellum({ config: TEST_CONFIG, fetchImpl, currentUserText: '   ', memories: [{ id: 'm1', text: 'x' }] }),
    null,
  );
  assert.equal(
    await rankMemoriesWithCerebellum({ config: TEST_CONFIG, fetchImpl, currentUserText: 'hello', memories: [] }),
    null,
  );
  assert.equal(calls, 0, 'no HTTP request is made for degenerate input');
});

test('rankMemoriesWithCerebellum caps the candidate pool at CEREBELLUM_MEMORY_MAX_CANDIDATES', async () => {
  const memories = Array.from({ length: CEREBELLUM_MEMORY_MAX_CANDIDATES + 50 }, (_, index) => ({
    id: `m${index}`,
    text: `memory ${index}`,
  }));
  const captured = [];
  const scores = await rankMemoriesWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl: okFetch(noulPayload(memories.slice(0, CEREBELLUM_MEMORY_MAX_CANDIDATES)), captured),
    currentUserText: 'hello',
    memories,
  });
  assert.equal(captured[0].body.state.memories.length, CEREBELLUM_MEMORY_MAX_CANDIDATES);
  assert.equal(Object.keys(captured[0].body.questions).length, CEREBELLUM_MEMORY_MAX_CANDIDATES);
  assert.equal(scores.size, CEREBELLUM_MEMORY_MAX_CANDIDATES);
  assert.ok(!scores.has(`m${CEREBELLUM_MEMORY_MAX_CANDIDATES}`), 'the over-cap tail is never scored');
});

// ---------------------------------------------------------------------------
// CoworkRunner integration (compiled dist; lightweight DI harness)
// ---------------------------------------------------------------------------

function createMemoryRankRunnerHarness({ memories, ranker }) {
  const rankerCalls = [];
  const session = {
    id: 'session-1',
    sessionType: 'standard',
    metabotId: 7,
    peerGlobalMetaId: null,
    messages: [],
  };
  const store = {
    getMemoryBackend() {
      return {
        getEffectiveMemoryPolicyForSession() {
          return {
            memoryEnabled: true,
            memoryImplicitUpdateEnabled: true,
            memoryLlmJudgeEnabled: true,
            memoryGuardLevel: 'strict',
            memoryUserMemoriesMaxItems: 12,
            memoryPromptMaxChars: 12000,
          };
        },
        resolveMetabotIdForMemory() {
          return 7;
        },
        listUserMemories() {
          return memories;
        },
        touchUserMemoriesLastUsed() {},
      };
    },
    getSession() {
      return session;
    },
    getConversationSourceContextBySession() {
      return { sourceChannel: 'cowork_ui', externalConversationId: null };
    },
  };
  const runner = new CoworkRunner(store, {
    cerebellumMemoryRanker: ranker
      ? async (input) => {
          rankerCalls.push(input);
          return ranker(input);
        }
      : undefined,
  });
  return { runner, rankerCalls };
}

function buildPool(count) {
  // No lexical overlap with the query — every entry scores 1 lexically.
  return Array.from({ length: count }, (_, index) => ({
    id: `mem-${index}`,
    text: `owner fact number ${index} about daily life`,
    usageClass: 'profile_fact',
    visibility: 'local_only',
    updatedAt: 1000 + index,
    lastUsedAt: null,
  }));
}

const RANK_QUERY = 'quantum entanglement lecture notes';

test('runner: cerebellum score map overrides the lexical memory order', async () => {
  const memories = buildPool(CEREBELLUM_MEMORY_MIN_POOL + 3);
  // The lexically last entry (text tie-break order) becomes the cerebellum
  // winner. The real call scores every candidate, so the map covers the pool.
  const winner = memories[memories.length - 1];
  const { runner, rankerCalls } = createMemoryRankRunnerHarness({
    memories,
    ranker: ({ memories: pool }) =>
      new Map(pool.map((memory) => [memory.id, memory.id === winner.id ? 0.99 : 0.05])),
  });

  const xml = await runner.buildScopedMemoryPromptBlocksXml('session-1', RANK_QUERY, { enabled: true });

  assert.equal(rankerCalls.length, 1, 'the ranker is consulted once per turn');
  assert.equal(rankerCalls[0].currentUserText, RANK_QUERY);
  assert.equal(rankerCalls[0].memories.length, memories.length);
  const lines = xml.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(lines[0], `- ${winner.text}`, 'the cerebellum top pick renders first');
});

test('runner: a null ranker result falls back to the lexical order silently', async () => {
  const memories = buildPool(CEREBELLUM_MEMORY_MIN_POOL + 3);
  const withNullRanker = createMemoryRankRunnerHarness({ memories, ranker: () => null });
  const withoutRanker = createMemoryRankRunnerHarness({ memories, ranker: null });

  const xmlNull = await withNullRanker.runner.buildScopedMemoryPromptBlocksXml('session-1', RANK_QUERY, { enabled: true });
  const xmlNone = await withoutRanker.runner.buildScopedMemoryPromptBlocksXml('session-1', RANK_QUERY, { enabled: true });

  assert.equal(xmlNull, xmlNone, 'null scores must reproduce the lexical baseline exactly');
});

test('runner: a throwing ranker falls back to the lexical order silently', async () => {
  const memories = buildPool(CEREBELLUM_MEMORY_MIN_POOL + 3);
  const { runner, rankerCalls } = createMemoryRankRunnerHarness({
    memories,
    ranker: () => { throw new Error('cerebellum exploded'); },
  });
  const baseline = createMemoryRankRunnerHarness({ memories, ranker: null });

  const xml = await runner.buildScopedMemoryPromptBlocksXml('session-1', RANK_QUERY, { enabled: true });
  const xmlBaseline = await baseline.runner.buildScopedMemoryPromptBlocksXml('session-1', RANK_QUERY, { enabled: true });

  assert.equal(rankerCalls.length, 1);
  assert.equal(xml, xmlBaseline, 'a throwing callback must never break the turn');
});

test('runner: pools below CEREBELLUM_MEMORY_MIN_POOL skip the ranker entirely', async () => {
  const memories = buildPool(CEREBELLUM_MEMORY_MIN_POOL - 1);
  const { runner, rankerCalls } = createMemoryRankRunnerHarness({
    memories,
    ranker: () => new Map([['mem-0', 0.99]]),
  });

  const xml = await runner.buildScopedMemoryPromptBlocksXml('session-1', RANK_QUERY, { enabled: true });

  assert.equal(rankerCalls.length, 0, 'small pools stay on the lexical ranker (no cerebellum round-trip)');
  assert.match(xml, /<ownerMemories>/);
});

test('runner: a blank user text skips the ranker entirely', async () => {
  const memories = buildPool(CEREBELLUM_MEMORY_MIN_POOL + 1);
  const { runner, rankerCalls } = createMemoryRankRunnerHarness({
    memories,
    ranker: () => new Map([['mem-0', 0.99]]),
  });

  await runner.buildScopedMemoryPromptBlocksXml('session-1', '   ', { enabled: true });

  assert.equal(rankerCalls.length, 0);
});
