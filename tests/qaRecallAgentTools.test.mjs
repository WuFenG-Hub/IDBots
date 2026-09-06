import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';

const require = Module.createRequire(import.meta.url);
const {
  buildQaRecallAgentTools,
  formatQaQuestionBullets,
  formatQaAnswerBullets,
  formatQaQuestionDetail,
} = require('../dist-electron/main/libs/qaRecallAgentTools.js');
const {
  qaSearch,
  qaLatestQuestions,
  qaQuestionDetail,
  qaQuestionAnswers,
} = require('../dist-electron/main/services/qaRecallService.js');

const QUESTION_PIN = '1111aaabbbbccccdddd1111aaabbbbccccdddd1111aaabbbbccccdddd1111i0';
const ANSWER_PIN = '2222aaabbbbccccdddd1111aaabbbbccccdddd1111aaabbbbccccdddd2222i0';

function questionFixture(overrides = {}) {
  return {
    pinId: QUESTION_PIN,
    currentPinId: QUESTION_PIN,
    chainName: 'mvc',
    title: 'How to recover a wallet when the mnemonic is lost?',
    summary: 'User reinstalled and lost the mnemonic…',
    tags: ['wallet', 'recovery'],
    contentType: 'text/markdown',
    publisher: { globalMetaId: 'gmid-asker', metaId: 'metaid-1', name: 'Asker Bot', avatar: '' },
    createdAt: 1755000000,
    isMempool: false,
    likeCount: 3,
    dislikeCount: 1,
    commentCount: 2,
    answerCount: 5,
    topAnswer: {
      pinId: ANSWER_PIN,
      summary: 'Re-bind a new wallet to the same identity…',
      publisher: { globalMetaId: 'gmid-helper', metaId: 'metaid-2', name: 'Helper Bot', avatar: '' },
      createdAt: 1755000100,
      likeCount: 8,
      dislikeCount: 1,
      score: 7,
    },
    ...overrides,
  };
}

function answerFixture(overrides = {}) {
  return {
    pinId: ANSWER_PIN,
    currentPinId: ANSWER_PIN,
    questionPinId: QUESTION_PIN,
    chainName: 'mvc',
    summary: 'Re-bind a new wallet to the same identity via identity-manage…',
    tags: ['wallet'],
    publisher: { globalMetaId: 'gmid-helper', metaId: 'metaid-2', name: 'Helper Bot', avatar: '' },
    createdAt: 1755000100,
    isMempool: false,
    likeCount: 8,
    dislikeCount: 1,
    commentCount: 0,
    score: 7,
    ...overrides,
  };
}

function makeHarness(overrides = {}) {
  const calls = { search: [], latestQuestions: [], questionDetail: [], questionAnswers: [] };
  const qaRecall = {
    search: async (input) => {
      calls.search.push(input);
      if (overrides.searchError) throw overrides.searchError;
      return overrides.searchPage ?? {
        items: [questionFixture()],
        hasMore: true,
        nextCursor: 'cur-1',
      };
    },
    latestQuestions: async (input) => {
      calls.latestQuestions.push(input);
      if (overrides.latestError) throw overrides.latestError;
      return overrides.latestPage ?? { items: [questionFixture({ answerCount: 0, topAnswer: null })], hasMore: false, nextCursor: null };
    },
    questionDetail: async (pinId) => {
      calls.questionDetail.push(pinId);
      if (overrides.detailError) throw overrides.detailError;
      return overrides.detail ?? {
        question: questionFixture(),
        answers: [answerFixture()],
        hasMore: false,
        nextCursor: null,
      };
    },
    questionAnswers: async (input) => {
      calls.questionAnswers.push(input);
      if (overrides.answersError) throw overrides.answersError;
      return overrides.answersPage ?? { items: [answerFixture()], hasMore: false, nextCursor: null };
    },
  };
  const tools = buildQaRecallAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    qaRecall,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName };
}

// ---------------------------------------------------------------------------
// Registration + search_qa
// ---------------------------------------------------------------------------

test('registers exactly search_qa, list_latest_questions and get_question_answers', () => {
  const { byName } = makeHarness();
  assert.deepEqual(Object.keys(byName), ['search_qa', 'list_latest_questions', 'get_question_answers']);
});

test('search_qa forwards filters to the control and formats pin:///metaid:// bullets with the top answer', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.search_qa.handler({
    query: 'recover wallet mnemonic',
    tags: ['wallet'],
    answered: true,
    sort: 'newest',
    size: 20,
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.search, [{
    q: 'recover wallet mnemonic',
    tags: ['wallet'],
    publisher: undefined,
    answered: true,
    sort: 'newest',
    size: 20,
    cursor: undefined,
  }]);
  const text = result.content[0].text;
  assert.match(text, /1 on-chain question\(s\) matching "recover wallet mnemonic", newest first:/);
  assert.match(text, /\[How to recover a wallet when the mnemonic is lost\?\]\(pin:\/\/1111aaab/);
  assert.match(text, /asked by \[Asker Bot\]\(metaid:\/\/gmid-asker\)/);
  assert.match(text, /5 answer\(s\)/);
  assert.match(text, /top answer \(\+8\/-1\) by \[Helper Bot\]\(metaid:\/\/gmid-helper\)/);
  assert.match(text, /pin: 1111aaab/);
  assert.match(text, /cursor="cur-1"/);
  assert.doesNotMatch(text, /https?:\/\//);
});

test('search_qa empty result is honest and points to post_simplequestion (the ask moment)', async () => {
  const { byName } = makeHarness({ searchPage: { items: [], hasMore: false, nextCursor: null } });
  const result = await byName.search_qa.handler({ query: 'quantum pin bundling' });
  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  assert.match(text, /No on-chain Q&A matched "quantum pin bundling"\./);
  assert.match(text, /post_simplequestion/);
  assert.match(text, /post_simpleanswer/);
  assert.match(text, /do NOT invent/i);
});

test('search_qa validation and failure paths', async () => {
  const { byName } = makeHarness();
  const empty = await byName.search_qa.handler({ query: '   ' });
  assert.equal(empty.isError, true);
  assert.match(empty.content[0].text, /requires a non-empty `query`/);
  const failed = makeHarness({ searchError: new Error('aggregation unavailable') });
  const failedResult = await failed.byName.search_qa.handler({ query: 'x' });
  assert.equal(failedResult.isError, true);
  assert.match(failedResult.content[0].text, /Q&A search failed: aggregation unavailable/);
});

// ---------------------------------------------------------------------------
// list_latest_questions
// ---------------------------------------------------------------------------

test('list_latest_questions maps snake_case filters (max_answers 0 = unanswered) and formats the feed', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.list_latest_questions.handler({
    max_answers: 0,
    sort: 'hot',
    tags: ['wallet'],
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.latestQuestions, [{
    tags: ['wallet'],
    minAnswers: undefined,
    maxAnswers: 0,
    sort: 'hot',
    size: undefined,
    cursor: undefined,
  }]);
  const text = result.content[0].text;
  assert.match(text, /hot-ranked \(last 7 days\)/);
  assert.match(text, /unanswered/);
  assert.match(text, /post_simpleanswer/);
});

test('list_latest_questions empty result is honest', async () => {
  const { byName } = makeHarness({ latestPage: { items: [], hasMore: false, nextCursor: null } });
  const result = await byName.list_latest_questions.handler({});
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /No on-chain questions matched this filter/);
});

// ---------------------------------------------------------------------------
// get_question_answers
// ---------------------------------------------------------------------------

test('get_question_answers renders the question sheet plus ranked answers from the detail endpoint', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.get_question_answers.handler({ question_pin_id: QUESTION_PIN });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.questionDetail, [QUESTION_PIN]);
  assert.equal(calls.questionAnswers.length, 0);
  const text = result.content[0].text;
  assert.match(text, new RegExp(`Question ${QUESTION_PIN}:`));
  assert.match(text, /- title: How to recover a wallet when the mnemonic is lost\?/);
  assert.match(text, /Answers \(ranked by likes − dislikes, best first\):/);
  assert.match(text, /- #1 /);
  assert.match(text, /score 7 \(likes 8/);
  assert.match(text, /read_metaweb_pin/);
  assert.match(text, /like_pin/);
});

test('publisher filter routes the answer list through questionAnswers', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.get_question_answers.handler({
    question_pin_id: QUESTION_PIN,
    publisher: 'gmid-helper',
    size: 5,
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.questionAnswers, [{
    pinId: QUESTION_PIN,
    publisher: 'gmid-helper',
    size: 5,
    cursor: undefined,
  }]);
});

test('unanswered question detail teaches the answer moment', async () => {
  const { byName } = makeHarness({
    detail: {
      question: questionFixture({ answerCount: 0, topAnswer: null }),
      answers: [],
      hasMore: false,
      nextCursor: null,
    },
  });
  const result = await byName.get_question_answers.handler({ question_pin_id: QUESTION_PIN });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /No answers yet/);
  assert.match(result.content[0].text, /post_simpleanswer/);
});

test('unknown question pinId is reported honestly, not invented', async () => {
  const notFound = new Error('question not found');
  notFound.name = 'QaRecallNotFoundError';
  const { byName } = makeHarness({ detailError: notFound });
  const result = await byName.get_question_answers.handler({ question_pin_id: 'beefi0' });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /No on-chain question matches pinId "beefi0"/);
  assert.match(result.content[0].text, /do NOT invent question data/);
  const failed = makeHarness({ detailError: new Error('aggregation unavailable') });
  const failedResult = await failed.byName.get_question_answers.handler({ question_pin_id: 'beefi0' });
  assert.equal(failedResult.isError, true);
  assert.match(failedResult.content[0].text, /Failed to fetch the question/);
});

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

test('formatters keep on-chain link discipline (pin:// and metaid:// only, never Web2)', () => {
  const bullets = formatQaQuestionBullets([questionFixture()]);
  assert.match(bullets, /pin:\/\/1111aaab/);
  assert.match(bullets, /metaid:\/\/gmid-asker/);
  assert.doesNotMatch(bullets, /https?:\/\//);
  const detail = formatQaQuestionDetail({ question: questionFixture(), answers: [answerFixture()] });
  assert.doesNotMatch(detail, /https?:\/\//);
  const answers = formatQaAnswerBullets([answerFixture(), answerFixture({ pinId: '3333i0', score: 2 })]);
  assert.match(answers, /- #1 /);
  assert.match(answers, /- #2 /);
  assert.doesNotMatch(answers, /https?:\/\//);
});

// ---------------------------------------------------------------------------
// Service client (envelope, params, errors) with a fake fetch
// ---------------------------------------------------------------------------

function envelope(data) {
  return { json: async () => ({ code: 0, data, message: 'ok', processingTime: 3 }) };
}

function makeFetch(capture) {
  return async (url) => {
    capture.url = String(url);
    if (capture.respond) return capture.respond();
    return envelope(capture.data ?? {});
  };
}

test('qaSearch serializes params and normalizes the question page', async () => {
  const capture = {};
  capture.data = {
    items: [questionFixture({ score: 12.5 })],
    nextCursor: 'next',
    hasMore: true,
  };
  const page = await qaSearch(
    { q: 'wallet recovery', tags: ['wallet', 'recovery'], answered: true, sort: 'newest', size: 20 },
    { fetchImpl: makeFetch(capture), baseUrl: 'https://so.metaid.io/' },
  );
  assert.equal(capture.url, 'https://so.metaid.io/api/qa/search?q=wallet+recovery&tags=wallet%2Crecovery&answered=true&sort=newest&size=20');
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].score, 12.5);
  assert.equal(page.items[0].topAnswer.score, 7);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextCursor, 'next');
});

test('qaLatestQuestions carries answer-count bounds; maxAnswers=0 stays on the wire', async () => {
  const capture = {};
  capture.data = { items: [], nextCursor: null, hasMore: false };
  await qaLatestQuestions(
    { maxAnswers: 0, minAnswers: 0, sort: 'hot', tags: ['wallet'] },
    { fetchImpl: makeFetch(capture) },
  );
  assert.equal(
    capture.url,
    'https://so.metaid.io/api/qa/questions?tags=wallet&minAnswers=0&maxAnswers=0&sort=hot',
  );
});

test('qaQuestionDetail and qaQuestionAnswers normalize their shapes; publisher and pinId are encoded', async () => {
  const capture = {};
  capture.data = { question: questionFixture(), answers: [answerFixture()], nextCursor: null, hasMore: false };
  const detail = await qaQuestionDetail(QUESTION_PIN, { fetchImpl: makeFetch(capture) });
  assert.equal(capture.url, `https://so.metaid.io/api/qa/questions/${QUESTION_PIN}`);
  assert.equal(detail.question.pinId, QUESTION_PIN);
  assert.equal(detail.answers[0].questionPinId, QUESTION_PIN);
  await qaQuestionAnswers(
    { pinId: QUESTION_PIN, publisher: 'gmid-helper', size: 5 },
    { fetchImpl: makeFetch(capture) },
  );
  assert.equal(
    capture.url,
    `https://so.metaid.io/api/qa/questions/${QUESTION_PIN}/answers?publisher=gmid-helper&size=5`,
  );
});

test('service maps business error codes honestly (40400 → NotFound, others → Error)', async () => {
  const notFoundFetch = async () => ({
    json: async () => ({ code: 40400, data: null, message: 'question not found' }),
  });
  await assert.rejects(
    qaQuestionDetail('beefi0', { fetchImpl: notFoundFetch }),
    (error) => error.name === 'QaRecallNotFoundError' && /question not found/.test(error.message),
  );
  const serverErrorFetch = async () => ({
    json: async () => ({ code: 50000, data: null, message: 'aggregation unavailable' }),
  });
  await assert.rejects(
    qaSearch({ q: 'x' }, { fetchImpl: serverErrorFetch }),
    (error) => /Q&A API error 50000: aggregation unavailable/.test(error.message),
  );
  const invalidFetch = async () => ({ status: 502, json: async () => null });
  await assert.rejects(
    qaSearch({ q: 'x' }, { fetchImpl: invalidFetch }),
    (error) => /invalid response \(HTTP 502\)/.test(error.message),
  );
});
