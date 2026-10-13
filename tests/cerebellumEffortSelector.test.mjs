import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CEREBELLUM_EFFORT_TIMEOUT_MS,
  CEREBELLUM_EFFORT_ESCALATION_THRESHOLD,
  CEREBELLUM_EFFORT_QUESTION_ID,
  CEREBELLUM_EFFORT_INSTRUCTIONS,
  CEREBELLUM_EFFORT_RUNG_CRITERIA,
  buildEffortSelectorRequest,
  parseEffortSelectorAnswers,
  resolveAutoEffortRung,
  selectEffortWithCerebellum,
} from '../src/main/cerebellum/effortSelector.ts';

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
    answers: { [CEREBELLUM_EFFORT_QUESTION_ID]: answer },
    usage: { input_tokens: 612 },
  };
}

const DIST = (off, low, high, max) => ({ off, low, high, max });

// ---- request shape ---------------------------------------------------------

test('buildEffortSelectorRequest carries the four rungs and the original-language message', () => {
  const request = buildEffortSelectorRequest({ currentUserText: '  帮我看看这段\n代码为什么死锁  ', model: 'jev-latest' });
  assert.equal(request.model, 'jev-latest');
  assert.equal(request.state.user_message, '帮我看看这段 代码为什么死锁');
  const question = request.questions[CEREBELLUM_EFFORT_QUESTION_ID];
  assert.equal(question.type, 'choice');
  assert.equal(question.instructions, CEREBELLUM_EFFORT_INSTRUCTIONS);
  assert.deepEqual(Object.keys(question.criteria).sort(), ['high', 'low', 'max', 'off']);
  assert.equal(question.criteria.off, CEREBELLUM_EFFORT_RUNG_CRITERIA.off);
});

test('buildEffortSelectorRequest stays in sync with the Phase-0 eval harness shape', () => {
  // The instructions must carry the conservative tie-break sentence and the
  // rung ladder — the exact wording the 28/30 eval validated.
  assert.ok(CEREBELLUM_EFFORT_INSTRUCTIONS.includes('pick the lower one'));
  assert.ok(CEREBELLUM_EFFORT_INSTRUCTIONS.includes('`off`'));
  assert.ok(CEREBELLUM_EFFORT_INSTRUCTIONS.includes('`max`'));
});

// ---- answer parsing ---------------------------------------------------------

test('parseEffortSelectorAnswers reads a probabilities map and zero-fills missing rungs', () => {
  const parsed = parseEffortSelectorAnswers(probabilitiesPayload({ off: 0.98, low: 0.02 }));
  assert.deepEqual(parsed, DIST(0.98, 0.02, 0, 0));
});

test('parseEffortSelectorAnswers clamps out-of-range values and skips unknown rungs', () => {
  const parsed = parseEffortSelectorAnswers(probabilitiesPayload({ off: 1.4, high: -0.2, turbo: 0.9 }));
  assert.deepEqual(parsed, DIST(1, 0, 0, 0));
});

test('parseEffortSelectorAnswers falls back to a bare top-level choice naming a known rung', () => {
  const parsed = parseEffortSelectorAnswers(probabilitiesPayload({}, 'high'));
  assert.deepEqual(parsed, DIST(0, 0, 1, 0));
});

test('parseEffortSelectorAnswers rejects unusable payloads', () => {
  assert.equal(parseEffortSelectorAnswers(null), null);
  assert.equal(parseEffortSelectorAnswers({ answers: null }), null);
  assert.equal(parseEffortSelectorAnswers({ answers: {} }), null);
  assert.equal(parseEffortSelectorAnswers(probabilitiesPayload({ turbo: 0.5 })), null);
  assert.equal(parseEffortSelectorAnswers(probabilitiesPayload({}, 'turbo')), null);
  assert.equal(parseEffortSelectorAnswers({ answers: { [CEREBELLUM_EFFORT_QUESTION_ID]: 7 } }), null);
});

// ---- policy resolution ------------------------------------------------------

test('assistant mode escalates only when P(high)+P(max) crosses the threshold, taking the heavier rung', () => {
  // Casual cliff from the live eval: 0.02 thinking mass stays off.
  assert.equal(resolveAutoEffortRung(DIST(0.98, 0, 0.02, 0), { assistantMode: true }), 'off');
  // Just below the threshold stays off (the policy escalates at >=).
  assert.equal(resolveAutoEffortRung(DIST(0, 0.45, 0.44, 0.05), { assistantMode: true }), 'off');
  // Correctness-risk cliff: 0.81 thinking mass escalates.
  assert.equal(resolveAutoEffortRung(DIST(0, 0, 0.81, 0.19), { assistantMode: true }), 'high');
  assert.equal(resolveAutoEffortRung(DIST(0, 0, 0.4, 0.45), { assistantMode: true }), 'max');
  // Exactly at the threshold escalates (>=).
  assert.equal(
    resolveAutoEffortRung(DIST(0, 0.5, CEREBELLUM_EFFORT_ESCALATION_THRESHOLD, 0), { assistantMode: true }),
    'high',
  );
});

test('professional mode takes the argmax with the lower rung winning ties', () => {
  assert.equal(resolveAutoEffortRung(DIST(0.13, 0.87, 0, 0), { assistantMode: false }), 'low');
  assert.equal(resolveAutoEffortRung(DIST(0, 0, 0, 1), { assistantMode: false }), 'max');
  assert.equal(resolveAutoEffortRung(DIST(0.5, 0.5, 0, 0), { assistantMode: false }), 'off');
  assert.equal(resolveAutoEffortRung(DIST(0, 0.5, 0.5, 0), { assistantMode: false }), 'low');
});

// ---- live call wrapper ------------------------------------------------------

test('selectEffortWithCerebellum returns the parsed distribution on a 200', async () => {
  const captured = [];
  const distribution = await selectEffortWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl: okFetch(probabilitiesPayload({ off: 0, low: 0, high: 1, max: 0 }), captured),
    currentUserText: '重构这个模块，注意并发安全',
  });
  assert.deepEqual(distribution, DIST(0, 0, 1, 0));
  assert.equal(captured[0].url, 'https://jev.example.com/v1/systemone');
  assert.equal(captured[0].init.headers.Authorization, 'Bearer sk-jev-test');
  assert.equal(captured[0].body.questions[CEREBELLUM_EFFORT_QUESTION_ID].type, 'choice');
});

test('selectEffortWithCerebellum returns null on blank text and non-200 without throwing', async () => {
  assert.equal(await selectEffortWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl: okFetch(probabilitiesPayload({ off: 1 })),
    currentUserText: '   ',
  }), null);

  const failFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  assert.equal(await selectEffortWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl: failFetch,
    currentUserText: 'anything',
  }), null);
});

test('selectEffortWithCerebellum aborts at the timeout and returns null', async () => {
  const hangingFetch = (url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const distribution = await selectEffortWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl: hangingFetch,
    currentUserText: 'x',
    timeoutMs: 20,
  });
  assert.equal(distribution, null);
});

test('selectEffortWithCerebellum default timeout is the solo-call budget', () => {
  assert.equal(CEREBELLUM_EFFORT_TIMEOUT_MS, 1000);
});
