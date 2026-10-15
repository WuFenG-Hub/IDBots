import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CEREBELLUM_KNOWLEDGE_MAX_CANDIDATES,
  CEREBELLUM_KNOWLEDGE_MIN_ANSWER_COVERAGE,
  CEREBELLUM_KNOWLEDGE_MIN_POOL,
  CEREBELLUM_KNOWLEDGE_RANK_CRITERIA,
  CEREBELLUM_KNOWLEDGE_RANK_INSTRUCTIONS,
  CEREBELLUM_KNOWLEDGE_TEXT_MAX_CHARS,
  buildKnowledgeRankQuestions,
  buildKnowledgeRankRequest,
  formatKnowledgeCandidateText,
  parseKnowledgeRankAnswers,
  rankKnowledgeWithCerebellum,
  selectKnowledgeRankCandidates,
} from '../src/main/cerebellum/knowledgeHotRank.ts';

const { CoworkRunner } = await import('../dist-electron/main/libs/coworkRunner.js');
const { buildKnowledgeBlock, orderKnowledgeEntriesForPrompt } = await import('../dist-electron/main/libs/knowledgePromptBlocks.js');

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

function noulPayload(knowledge, scoreOf = () => 0.5) {
  const answers = {};
  knowledge.forEach((entry, index) => {
    answers[`kn_${index}`] = { noul: scoreOf(entry, index) };
  });
  return { model: 'jev-latest', answers, usage: { input_tokens: 100 } };
}

const SAMPLE = [
  { id: 'k1', topic: '订单交付必须附 txid', summary: '没有 txid 的交付会被打回。', kind: 'pitfall' },
  { id: 'k2', topic: '周报用表格', summary: '数据部分一律用表格。', kind: 'know_how' },
];

test('buildKnowledgeRankRequest carries original-language state and one noul per point', () => {
  const request = buildKnowledgeRankRequest({
    currentUserText: '群任务做完怎么交付',
    entries: SAMPLE,
    model: 'jev-fast',
  });
  assert.equal(request.state.current_message, '群任务做完怎么交付');
  assert.equal(request.model, 'jev-fast');
  assert.deepEqual(request.state.knowledge, [
    { id: 'k1', text: '[pitfall] 订单交付必须附 txid: 没有 txid 的交付会被打回。' },
    { id: 'k2', text: '[know_how] 周报用表格: 数据部分一律用表格。' },
  ]);
  assert.deepEqual(Object.keys(request.questions), ['kn_0', 'kn_1']);
  for (const [index, key] of ['kn_0', 'kn_1'].entries()) {
    const question = request.questions[key];
    assert.equal(question.type, 'noul');
    assert.ok(question.instructions.includes(`knowledge[${index}].text`));
    assert.ok(question.instructions.includes('`current_message`'));
    assert.equal(question.instructions.includes('{{INDEX}}'), false);
    assert.equal(question.criteria.true, CEREBELLUM_KNOWLEDGE_RANK_CRITERIA.true);
    assert.equal(question.criteria.false, CEREBELLUM_KNOWLEDGE_RANK_CRITERIA.false);
  }
  assert.ok(request.questions.kn_0.instructions.startsWith(
    CEREBELLUM_KNOWLEDGE_RANK_INSTRUCTIONS.split('{{INDEX}}')[0],
  ));
});

test('formatKnowledgeCandidateText collapses whitespace, caps length, and drops blanks', () => {
  assert.equal(
    formatKnowledgeCandidateText({ topic: 'a \n b', summary: 'c  d', kind: 'principle' }),
    '[principle] a b: c d',
  );
  const long = '测'.repeat(CEREBELLUM_KNOWLEDGE_TEXT_MAX_CHARS);
  const formatted = formatKnowledgeCandidateText({ topic: 't', summary: long, kind: 'know_how' });
  assert.ok(formatted.length <= CEREBELLUM_KNOWLEDGE_TEXT_MAX_CHARS);
  assert.ok(formatted.startsWith('[know_how] t: '));
  assert.equal(formatKnowledgeCandidateText({ topic: '   ', summary: '', kind: 'know_how' }), '');
  const cut = formatKnowledgeCandidateText({
    topic: 't',
    summary: `${'a'.repeat(CEREBELLUM_KNOWLEDGE_TEXT_MAX_CHARS)}😀`,
    kind: 'know_how',
  });
  const tail = cut.charCodeAt(cut.length - 1);
  assert.ok(tail < 0xd800 || tail > 0xdbff, 'the cap must not leave a lone high surrogate');
});

test('selectKnowledgeRankCandidates skips blank rows and honors the pool cap', () => {
  const entries = [
    { id: ' ', topic: 'x', summary: 'y', kind: 'know_how' },
    { id: 'blank', topic: '  ', summary: '', kind: 'know_how' },
    ...Array.from({ length: CEREBELLUM_KNOWLEDGE_MAX_CANDIDATES + 5 }, (_, index) => ({
      id: `k${index}`,
      topic: `topic ${index}`,
      summary: `summary ${index}`,
      kind: 'know_how',
    })),
  ];
  const selected = selectKnowledgeRankCandidates(entries);
  assert.equal(selected.length, CEREBELLUM_KNOWLEDGE_MAX_CANDIDATES);
  assert.equal(selected[0].id, 'k0');
});

test('buildKnowledgeRankQuestions substitutes the index placeholder', () => {
  const questions = buildKnowledgeRankQuestions(2);
  assert.equal(Object.keys(questions).length, 2);
  assert.equal(questions.kn_1.instructions.includes('{{INDEX}}'), false);
  assert.ok(questions.kn_1.instructions.includes('knowledge[1].text'));
});

test('parseKnowledgeRankAnswers maps kn_<i> back to ids and skips junk', () => {
  const knowledge = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const scores = parseKnowledgeRankAnswers({
    answers: {
      kn_0: { noul: 0.9 },
      kn_2: { noul: 'high' },
      kn_3: 'nope',
      mem_0: { noul: 1 },
    },
  }, knowledge);
  assert.deepEqual([...scores.entries()], [['a', 0.9]]);
  assert.equal(parseKnowledgeRankAnswers(null, knowledge), null);
  assert.equal(parseKnowledgeRankAnswers({}, knowledge), null);
  assert.equal(parseKnowledgeRankAnswers({ answers: 'nope' }, knowledge), null);
});

test('orderKnowledgeEntriesForPrompt promotes scored ids and leaves a missing map untouched', () => {
  const entries = [
    { id: 'new', topic: 'new', summary: 'recent', kind: 'know_how' },
    { id: 'old', topic: 'old', summary: 'relevant', kind: 'pitfall' },
    { id: 'mid', topic: 'mid', summary: 'other', kind: 'know_how' },
  ];
  assert.equal(orderKnowledgeEntriesForPrompt(entries, null), entries);
  assert.equal(orderKnowledgeEntriesForPrompt(entries, new Map()), entries);
  const ordered = orderKnowledgeEntriesForPrompt(entries, new Map([['old', 0.9], ['new', 0.1]]));
  assert.deepEqual(ordered.map((entry) => entry.id), ['old', 'new', 'mid']);
  const block = buildKnowledgeBlock(entries, 1, 10000, new Map([['old', 0.9], ['new', 0.2]]));
  assert.match(block, /topic="old"/);
  assert.equal(block.includes('topic="new"'), false);
});

test('rankKnowledgeWithCerebellum posts one request and returns the score map', async () => {
  const captured = [];
  const selected = selectKnowledgeRankCandidates(SAMPLE);
  const scores = await rankKnowledgeWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl: okFetch(noulPayload(selected, (entry) => (entry.id === 'k1' ? 0.91 : 0.05)), captured),
    currentUserText: '群任务做完怎么交付',
    entries: SAMPLE,
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, 'https://jev.example.com/v1/systemone');
  assert.equal(captured[0].init.method, 'POST');
  assert.equal(captured[0].init.headers.Authorization, 'Bearer sk-jev-test');
  assert.equal(captured[0].body.model, 'jev-latest');
  assert.equal(captured[0].body.state.current_message, '群任务做完怎么交付');
  assert.equal(Object.keys(captured[0].body.questions).length, 2);
  assert.deepEqual([...scores.entries()], [['k1', 0.91], ['k2', 0.05]]);
});

test('rankKnowledgeWithCerebellum returns null on HTTP, network, and malformed payloads', async () => {
  const entries = SAMPLE;
  for (const status of [401, 429, 500]) {
    const scores = await rankKnowledgeWithCerebellum({
      config: TEST_CONFIG,
      fetchImpl: async () => ({ ok: false, status, json: async () => ({}) }),
      currentUserText: 'hello',
      entries,
    });
    assert.equal(scores, null, `HTTP ${status} falls open`);
  }
  assert.equal(await rankKnowledgeWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl: async () => { throw new Error('ECONNRESET'); },
    currentUserText: 'hello',
    entries,
  }), null);
  assert.equal(await rankKnowledgeWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl: okFetch({ no_answers: true }),
    currentUserText: 'hello',
    entries,
  }), null);
  assert.equal(await rankKnowledgeWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }),
    currentUserText: 'hello',
    entries,
  }), null);
});

test('rankKnowledgeWithCerebellum discards incomplete answer coverage', async () => {
  const entries = Array.from({ length: 5 }, (_, index) => ({
    id: `k${index}`,
    topic: `topic ${index}`,
    summary: `summary ${index}`,
    kind: 'know_how',
  }));
  const partial = { answers: { kn_0: { noul: 0.9 }, kn_1: { noul: 0.1 }, kn_2: { noul: 0.4 } } };
  assert.ok(3 < entries.length * CEREBELLUM_KNOWLEDGE_MIN_ANSWER_COVERAGE);
  assert.equal(await rankKnowledgeWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl: okFetch(partial),
    currentUserText: 'hello',
    entries,
  }), null);

  const adequate = {
    answers: {
      kn_0: { noul: 0.9 }, kn_1: { noul: 0.1 }, kn_2: { noul: 0.4 }, kn_3: { noul: 0.2 },
    },
  };
  const covered = await rankKnowledgeWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl: okFetch(adequate),
    currentUserText: 'hello',
    entries,
  });
  assert.deepEqual([...covered.entries()], [['k0', 0.9], ['k1', 0.1], ['k2', 0.4], ['k3', 0.2]]);
});

test('rankKnowledgeWithCerebellum aborts past the timeout and skips degenerate input', async () => {
  let abortSeen = false;
  const fetchImpl = (_url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => {
      abortSeen = true;
      reject(new Error('The operation was aborted'));
    });
  });
  const startedAt = Date.now();
  const scores = await rankKnowledgeWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl,
    currentUserText: 'hello',
    entries: SAMPLE,
    timeoutMs: 30,
  });
  assert.equal(scores, null);
  assert.equal(abortSeen, true);
  assert.ok(Date.now() - startedAt < 1000);

  let calls = 0;
  const counting = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  assert.equal(await rankKnowledgeWithCerebellum({
    config: TEST_CONFIG, fetchImpl: counting, currentUserText: '   ', entries: SAMPLE,
  }), null);
  assert.equal(await rankKnowledgeWithCerebellum({
    config: TEST_CONFIG, fetchImpl: counting, currentUserText: 'hello', entries: [],
  }), null);
  assert.equal(calls, 0);
});

test('rankKnowledgeWithCerebellum caps the candidate pool', async () => {
  const entries = Array.from({ length: CEREBELLUM_KNOWLEDGE_MAX_CANDIDATES + 10 }, (_, index) => ({
    id: `k${index}`,
    topic: `topic ${index}`,
    summary: `summary ${index}`,
    kind: 'know_how',
  }));
  const captured = [];
  const selected = selectKnowledgeRankCandidates(entries);
  const scores = await rankKnowledgeWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl: okFetch(noulPayload(selected), captured),
    currentUserText: 'hello',
    entries,
  });
  assert.equal(captured[0].body.state.knowledge.length, CEREBELLUM_KNOWLEDGE_MAX_CANDIDATES);
  assert.equal(scores.size, CEREBELLUM_KNOWLEDGE_MAX_CANDIDATES);
  assert.equal(scores.has(`k${CEREBELLUM_KNOWLEDGE_MAX_CANDIDATES}`), false);
});

test('eval script builds the request through the module', () => {
  const source = readFileSync(new URL('../scripts/cerebellum-knowledge-hot-rank-eval.mjs', import.meta.url), 'utf8');
  assert.match(source, /buildKnowledgeRankRequest/);
  assert.match(source, /rankKnowledgeWithCerebellum/);
  assert.match(source, /orderKnowledgeEntriesForPrompt/);
});

// ---------------------------------------------------------------------------
// CoworkRunner integration (compiled dist; lightweight DI harness)
// ---------------------------------------------------------------------------

function knowledgeEntry(index) {
  return {
    id: `k${index}`,
    topic: `topic-${index}`,
    summary: `summary ${index} about subject ${index}`,
    kind: index % 2 === 0 ? 'know_how' : 'pitfall',
    category: null,
    tags: [],
    version: 1,
    status: 'active',
    updatedAt: 10_000 - index,
  };
}

function createKnowledgeRankHarness({
  entries,
  ranker,
  includeMemoryPromptBlocks = true,
  gate,
}) {
  const rankerCalls = [];
  const listCalls = [];
  const store = {
    getMemoryBackend() {
      return {
        getEffectiveMemoryPolicyForSession() {
          return {
            memoryEnabled: true,
            memoryImplicitUpdateEnabled: true,
            memoryLlmJudgeEnabled: true,
            memoryGuardLevel: 'standard',
            memoryUserMemoriesMaxItems: 12,
            memoryPromptMaxChars: 12000,
          };
        },
        resolveMetabotIdForMemory() {
          return 7;
        },
        listUserMemories() {
          return [];
        },
        touchUserMemoriesLastUsed() {},
      };
    },
    listCapabilityDrafts() {
      return [];
    },
    listInjectableTechniques() {
      return [];
    },
    getSession() {
      return { id: 'session-1', sessionType: 'standard', metabotId: 7, messages: [] };
    },
    getSessionWithoutMessages() {
      return {};
    },
    getConversationSourceContextBySession() {
      return { sourceChannel: 'cowork_ui', externalConversationId: null };
    },
    getMetabotIdForSession() {
      return 7;
    },
  };
  const runner = new CoworkRunner(store, {
    knowledgeStore: {
      listKnowledge(options) {
        listCalls.push(options);
        const limit = typeof options.limit === 'number' ? options.limit : entries.length;
        return entries.slice(0, limit);
      },
      listProcedures() {
        return [];
      },
    },
    // Merged turn-decision bundle (mock of the main.ts caller): the
    // knowledge ranking rides the single per-turn callback together with the
    // block gate, exactly like the real caller.
    cerebellumTurnDecisions: ranker || gate
      ? async (input) => {
          let knowledgeScores = null;
          // Mirrors the real bundle: the knowledge questions ride only when
          // the runner gathered an eligible pool (>= CEREBELLUM_KNOWLEDGE_MIN_POOL,
          // memory blocks on) — otherwise this decision contributes nothing.
          if (ranker && input.knowledge.length > 0) {
            rankerCalls.push(input);
            knowledgeScores = await ranker(input);
          }
          return {
            memoryScores: null,
            knowledgeScores,
            skillRanking: null,
            serviceRanking: null,
            gateVerdicts: gate ? await gate(input) : null,
          };
        }
      : undefined,
  });
  const buildVolatile = (prompt) => runner.buildVolatileContextPrompt(
    'session-1',
    prompt,
    true,
    { includeMemoryPromptBlocks },
    true,
  );
  return { rankerCalls, listCalls, buildVolatile };
}

const RANK_QUERY = '把旧的交付坑用上';

test('runner: a score map promotes an older knowledge point into the hot layer', async () => {
  const entries = Array.from({ length: CEREBELLUM_KNOWLEDGE_MIN_POOL + 3 }, (_, index) => knowledgeEntry(index));
  const winner = entries[entries.length - 1];
  const { rankerCalls, buildVolatile } = createKnowledgeRankHarness({
    entries,
    ranker: ({ knowledge: pool }) => new Map(pool.map((entry) => [entry.id, entry.id === winner.id ? 0.99 : 0.05])),
  });
  const output = await buildVolatile(RANK_QUERY);
  assert.equal(rankerCalls.length, 1);
  assert.equal(rankerCalls[0].currentUserText, RANK_QUERY);
  assert.equal(rankerCalls[0].knowledge.length, entries.length);
  assert.equal(rankerCalls[0].knowledge[0].topic, 'topic-0');
  assert.match(output, new RegExp(`topic="${winner.topic}"`));
  assert.equal(output.includes('topic="topic-7"'), false, 'a low-scoring recent point yields its slot');
  assert.ok(output.indexOf(`topic="${winner.topic}"`) < output.indexOf('topic="topic-0"'));
});

test('runner: a null ranker result reproduces the newest-8 block byte-for-byte', async () => {
  const entries = Array.from({ length: CEREBELLUM_KNOWLEDGE_MIN_POOL + 3 }, (_, index) => knowledgeEntry(index));
  const withNull = createKnowledgeRankHarness({ entries, ranker: () => null });
  const without = createKnowledgeRankHarness({ entries, ranker: null });
  const outputNull = await withNull.buildVolatile(RANK_QUERY);
  const outputNone = await without.buildVolatile(RANK_QUERY);
  assert.equal(outputNull, outputNone);
  assert.match(outputNone, /topic="topic-0"/);
  assert.match(outputNone, /topic="topic-7"/);
  assert.equal(outputNone.includes('topic="topic-11"'), false);
});

test('runner: a throwing ranker falls back to newest-8', async () => {
  const entries = Array.from({ length: CEREBELLUM_KNOWLEDGE_MIN_POOL + 3 }, (_, index) => knowledgeEntry(index));
  const { rankerCalls, buildVolatile } = createKnowledgeRankHarness({
    entries,
    ranker: () => { throw new Error('cerebellum exploded'); },
  });
  const baseline = createKnowledgeRankHarness({ entries, ranker: null });
  const output = await buildVolatile(RANK_QUERY);
  const outputBaseline = await baseline.buildVolatile(RANK_QUERY);
  assert.equal(rankerCalls.length, 1);
  assert.equal(output, outputBaseline);
});

test('runner: pools below the minimum skip the ranker', async () => {
  const entries = Array.from({ length: CEREBELLUM_KNOWLEDGE_MIN_POOL - 1 }, (_, index) => knowledgeEntry(index));
  const { rankerCalls, buildVolatile } = createKnowledgeRankHarness({
    entries,
    ranker: () => new Map([['k0', 0.99]]),
  });
  const output = await buildVolatile(RANK_QUERY);
  assert.equal(rankerCalls.length, 0);
  assert.match(output, /topic="topic-0"/);
  assert.match(output, /<knowledge>/);
});

test('runner: a blank prompt never calls the ranker', async () => {
  const entries = Array.from({ length: CEREBELLUM_KNOWLEDGE_MIN_POOL + 3 }, (_, index) => knowledgeEntry(index));
  const { rankerCalls, buildVolatile } = createKnowledgeRankHarness({
    entries,
    ranker: () => new Map([['k11', 0.99]]),
  });
  await buildVolatile('   ');
  assert.equal(rankerCalls.length, 0);
});

test('runner: memory-disabled profiles skip the ranker', async () => {
  const entries = Array.from({ length: CEREBELLUM_KNOWLEDGE_MIN_POOL + 3 }, (_, index) => knowledgeEntry(index));
  const { rankerCalls, buildVolatile } = createKnowledgeRankHarness({
    entries,
    includeMemoryPromptBlocks: false,
    ranker: () => new Map([['k11', 0.99]]),
  });
  const output = await buildVolatile(RANK_QUERY);
  assert.equal(rankerCalls.length, 0);
  assert.equal(output.includes('<knowledge>'), false);
});

test('runner: the rank call starts before the experience section is awaited', async () => {
  const entries = Array.from({ length: CEREBELLUM_KNOWLEDGE_MIN_POOL + 3 }, (_, index) => knowledgeEntry(index));
  const events = [];
  const { buildVolatile } = createKnowledgeRankHarness({
    entries,
    ranker: async () => {
      events.push('rank-start');
      await new Promise((resolve) => setTimeout(resolve, 15));
      events.push('rank-end');
      return new Map([['k11', 0.99]]);
    },
  });
  events.push('volatile-start');
  await buildVolatile(RANK_QUERY);
  assert.equal(events[0], 'volatile-start');
  assert.equal(events[1], 'rank-start');
  assert.equal(events[events.length - 1], 'rank-end');
});

test('runner: a gated-out experience block drops the knowledge block entirely', async () => {
  const entries = Array.from({ length: CEREBELLUM_KNOWLEDGE_MIN_POOL + 3 }, (_, index) => knowledgeEntry(index));
  const { buildVolatile } = createKnowledgeRankHarness({
    entries,
    // The merged bundle always settles (its fetch rides a hard 1.5s abort
    // budget), so a slow — not never-ending — ranker is the honest shape of
    // "the verdict is not in yet".
    ranker: () => new Promise((resolve) => setTimeout(() => resolve(new Map([['k11', 0.99]])), 30)),
    gate: () => ({ experience: false }),
  });
  let timer;
  const output = await Promise.race([
    buildVolatile(RANK_QUERY),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('blocked on knowledge rank')), 250);
    }),
  ]);
  clearTimeout(timer);
  assert.equal(output.includes('<knowledge>'), false, 'a skipped experience section renders no knowledge points');
});
