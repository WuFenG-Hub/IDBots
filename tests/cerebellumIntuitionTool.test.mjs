import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CEREBELLUM_INTUITION_TIMEOUT_MS,
  CEREBELLUM_INTUITION_MAX_CONTEXT_CHARS,
  CEREBELLUM_INTUITION_MAX_QUESTIONS,
  CEREBELLUM_INTUITION_MAX_OPTIONS,
  CEREBELLUM_INTUITION_WINDOW_MAX_CALLS,
  validateIntuitionInput,
  buildIntuitionRequest,
  parseIntuitionAnswers,
  askCerebellumIntuition,
} from '../src/main/cerebellum/intuitionTool.ts';

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

const VALID_QUESTIONS = [
  { id: 'tone', type: 'noul', question: 'Does the draft match the tone the user prefers?' },
  { id: 'pick', type: 'choice', question: 'Which title fits the user best?', options: { a: 'Direct and short', b: 'Playful pun' } },
  { id: 'sev', type: 'score', question: 'How urgent is this request?', levels: ['Can wait days', 'Should be today', 'Right now'] },
];

// ---------------------------------------------------------------------------
// Input validation (bot-authored input is untrusted)
// ---------------------------------------------------------------------------

test('validateIntuitionInput: accepts all three question types and defaults ids', () => {
  const result = validateIntuitionInput({
    context: '主人偏好简洁的中文回复',
    questions: [
      { type: 'noul', question: 'Is the claim consistent with the context?' },
      { type: 'choice', question: 'Which option?', options: { x: 'first', y: 'second' } },
      { type: 'score', question: 'How good?', levels: ['bad', 'ok', 'great'] },
    ],
  });
  assert.ok(result.questions, 'valid input carries questions');
  assert.equal(result.error, null);
  assert.deepEqual(result.questions.map((question) => question.id), ['q1', 'q2', 'q3']);
  assert.deepEqual(result.questions[1].options, { x: 'first', y: 'second' });
  assert.deepEqual(result.questions[2].levels, ['bad', 'ok', 'great']);
});

test('validateIntuitionInput: rejects every over-cap shape with a teaching error', () => {
  assert.equal(validateIntuitionInput({ context: '', questions: VALID_QUESTIONS }).questions, null);
  assert.equal(validateIntuitionInput({ context: 'x', questions: [] }).questions, null);
  assert.equal(
    validateIntuitionInput({ context: 'c'.repeat(CEREBELLUM_INTUITION_MAX_CONTEXT_CHARS + 1), questions: VALID_QUESTIONS }).questions,
    null,
  );
  assert.equal(
    validateIntuitionInput({ context: 'x', questions: Array.from({ length: CEREBELLUM_INTUITION_MAX_QUESTIONS + 1 }, () => ({ type: 'noul', question: 'q?' })) }).questions,
    null,
  );
  const badType = validateIntuitionInput({ context: 'x', questions: [{ type: 'essay', question: 'q?' }] });
  assert.equal(badType.questions, null);
  assert.match(badType.error, /"noul", "choice", or "score"/);
  assert.equal(
    validateIntuitionInput({ context: 'x', questions: [{ type: 'choice', question: 'q?', options: Object.fromEntries(Array.from({ length: CEREBELLUM_INTUITION_MAX_OPTIONS + 1 }, (_, i) => [`o${i}`, 'opt'])) }] }).questions,
    null,
  );
  assert.equal(
    validateIntuitionInput({ context: 'x', questions: [{ type: 'score', question: 'q?', levels: ['only one'] }] }).questions,
    null,
  );
  const dupId = validateIntuitionInput({
    context: 'x',
    questions: [
      { id: 'same', type: 'noul', question: 'a?' },
      { id: 'same', type: 'noul', question: 'b?' },
    ],
  });
  assert.equal(dupId.questions, null);
  assert.match(dupId.error, /duplicate/);
});

// ---------------------------------------------------------------------------
// Request building and answer parsing
// ---------------------------------------------------------------------------

test('buildIntuitionRequest: one shared state, per-type JEV criteria shapes', () => {
  const { questions } = validateIntuitionInput({ context: ' 主人偏好简洁回复  ', questions: VALID_QUESTIONS });
  const request = buildIntuitionRequest({ context: ' 主人偏好简洁回复  ', questions, model: 'jev-fast' });
  assert.equal(request.state, '主人偏好简洁回复');
  assert.equal(request.model, 'jev-fast');
  assert.deepEqual(Object.keys(request.questions), ['tone', 'pick', 'sev']);
  assert.equal(request.questions.tone.type, 'noul');
  assert.equal(request.questions.tone.criteria.true.length > 0, true, 'noul gets default criteria');
  assert.deepEqual(request.questions.pick.criteria, { a: 'Direct and short', b: 'Playful pun' });
  assert.deepEqual(request.questions.sev.criteria, ['Can wait days', 'Should be today', 'Right now']);
});

test('parseIntuitionAnswers: passes through usable answers, clamps, skips junk', () => {
  const answers = parseIntuitionAnswers(
    {
      answers: {
        tone: { noul: 1.4 },
        pick: { choice: 'a', probabilities: { a: 0.8, b: 0.2 }, confidence: 0.9 },
        sev: { score: 1.43, probabilities: { '0': 0, '1': 0.57, '2': 0.43 }, legend: { '0': 'x' } },
        ghost: 'not-an-object',
      },
    },
    ['tone', 'pick', 'sev'],
  );
  assert.equal(answers.tone.noul, 1, 'clamped');
  assert.equal(answers.pick.choice, 'a');
  assert.equal(answers.pick.probabilities.a, 0.8);
  assert.equal(answers.sev.score, 1.43);
  assert.equal(answers.ghost, undefined);
  assert.equal(parseIntuitionAnswers({ nope: 1 }, ['tone']), null);
  assert.equal(parseIntuitionAnswers({ answers: {} }, ['tone']), null);
  assert.equal(parseIntuitionAnswers('junk', ['tone']), null);
});

test('askCerebellumIntuition: request shape, answer passthrough, fail-open', async () => {
  const captured = [];
  const result = await askCerebellumIntuition({
    config: TEST_CONFIG,
    fetchImpl: okFetch(
      { model: 'jev-latest', answers: { tone: { noul: 0.82 } }, usage: { input_tokens: 420 } },
      captured,
    ),
    context: '主人偏好简洁回复',
    questions: VALID_QUESTIONS,
  });
  assert.equal(result.answers.tone.noul, 0.82);
  assert.equal(result.inputTokens, 420);
  assert.equal(captured[0].url, 'https://jev.example.com/v1/systemone');
  assert.equal(captured[0].init.headers.Authorization, 'Bearer sk-jev-test');
  assert.equal(captured[0].body.state, '主人偏好简洁回复');
  assert.deepEqual(Object.keys(captured[0].body.questions), ['tone', 'pick', 'sev']);

  const http500 = async () => ({ ok: false, status: 500, json: async () => ({}) });
  assert.equal(
    await askCerebellumIntuition({ config: TEST_CONFIG, fetchImpl: http500, context: 'x', questions: VALID_QUESTIONS }),
    null,
  );
  const throwing = async () => {
    throw new Error('network down');
  };
  assert.equal(
    await askCerebellumIntuition({ config: TEST_CONFIG, fetchImpl: throwing, context: 'x', questions: VALID_QUESTIONS }),
    null,
  );
  assert.equal(
    await askCerebellumIntuition({ config: TEST_CONFIG, fetchImpl: okFetch({}), context: '   ', questions: VALID_QUESTIONS }),
    null,
    'blank context never leaves the machine',
  );
});

test('askCerebellumIntuition: a hanging endpoint is aborted at the deadline', async () => {
  const hanging = (url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const startedAt = Date.now();
  assert.equal(
    await askCerebellumIntuition({ config: TEST_CONFIG, fetchImpl: hanging, context: 'x', questions: VALID_QUESTIONS, timeoutMs: 25 }),
    null,
  );
  assert.ok(Date.now() - startedAt < 1000, 'abort deadline honored');
  assert.equal(CEREBELLUM_INTUITION_TIMEOUT_MS, 3000, 'explicit tool calls get a 3s budget');
});

// ---------------------------------------------------------------------------
// CoworkRunner integration (compiled dist; inline-tool harness)
// ---------------------------------------------------------------------------

function passthroughTool() {
  const tools = [];
  const tool = (name, description, parameters, execute) => {
    tools.push({ name, description, parameters, execute });
    return { name, description, parameters, execute };
  };
  return { tools, tool };
}

function createIntuitionHarness({ intuition, available = () => true, sourceChannel = 'cowork_ui' } = {}) {
  const store = {
    getMemoryBackend() {
      return {
        getEffectiveMemoryPolicyForSession() {
          return {
            memoryEnabled: true,
            memoryImplicitUpdateEnabled: true,
            memoryLlmJudgeEnabled: false,
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
      return { sourceChannel, externalConversationId: null };
    },
    getMetabotIdForSession() {
      return 7;
    },
  };
  const runner = new CoworkRunner(store, {
    cerebellumIntuitionAvailable: available,
    cerebellumIntuition: intuition,
  });
  const { tools, tool } = passthroughTool();
  const allTools = runner.buildSessionInlineTools('session-1', tool, undefined);
  const intuitionTool = allTools.find((entry) => entry.name === 'intuition') ?? null;
  return { runner, tools, allTools, intuitionTool };
}

const TOOL_ARGS = {
  context: '主人偏好简洁的中文回复，昨天又强调了一遍',
  questions: [
    { id: 'tone', type: 'noul', question: 'Would a playful joking reply match the tone this user prefers?' },
  ],
};

test('runner: the intuition tool mounts only when available AND cowork_ui', () => {
  const mounted = createIntuitionHarness({ intuition: async () => null });
  assert.ok(mounted.intuitionTool, 'mounts when cerebellum available on an owner session');

  const unavailable = createIntuitionHarness({ intuition: async () => null, available: () => false });
  assert.equal(unavailable.intuitionTool, null, 'no tool when the cerebellum is not configured');

  const external = createIntuitionHarness({ intuition: async () => null, sourceChannel: 'open_team' });
  assert.equal(external.intuitionTool, null, 'external-facing sessions keep the phase-1 privacy posture');
});

test('runner: the tool description carries the teaching text (when / when not / how)', () => {
  const { intuitionTool } = createIntuitionHarness({ intuition: async () => null });
  assert.match(intuitionTool.description, /WHEN to use:/);
  assert.match(intuitionTool.description, /WHEN NOT to use:/);
  assert.match(intuitionTool.description, /never generates text/i);
  assert.match(intuitionTool.description, /calibrated across groups, NOT per-case guarantees/i);
  assert.match(intuitionTool.description, /How to ask well/);
});

test('runner: answers flow back with the calibration caveat', async () => {
  const { intuitionTool } = createIntuitionHarness({
    intuition: async ({ context, questions }) => {
      assert.equal(context, TOOL_ARGS.context);
      assert.equal(questions.length, 1);
      return { answers: { tone: { noul: 0.13 } }, inputTokens: 210 };
    },
  });
  const result = await intuitionTool.execute(TOOL_ARGS);
  const text = result.content[0].text;
  assert.match(text, /calibrated across groups/);
  assert.match(text, /"noul": 0\.13/);
});

test('runner: validation errors teach the model instead of throwing', async () => {
  const { intuitionTool } = createIntuitionHarness({ intuition: async () => null });
  const result = await intuitionTool.execute({ context: 'x', questions: [{ type: 'essay', question: 'q?' }] });
  assert.match(result.content[0].text, /"noul", "choice", or "score"/);
});

test('runner: a null verdict reports honestly without retry-baiting', async () => {
  const { intuitionTool } = createIntuitionHarness({ intuition: async () => null });
  const result = await intuitionTool.execute(TOOL_ARGS);
  assert.match(result.content[0].text, /no verdict/);
  assert.match(result.content[0].text, /do not retry immediately/);
});

test('runner: the rolling window caps runaway loops and resets lazily', async () => {
  const { runner, intuitionTool } = createIntuitionHarness({
    intuition: async () => ({ answers: { tone: { noul: 0.5 } }, inputTokens: 10 }),
  });
  const activeSession = { sessionId: 'session-1', cerebellumIntuitionCallsInWindow: 0, cerebellumIntuitionWindowStartAt: Date.now() };
  runner.activeSessions.set('session-1', activeSession);

  for (let call = 0; call < CEREBELLUM_INTUITION_WINDOW_MAX_CALLS; call += 1) {
    const result = await intuitionTool.execute(TOOL_ARGS);
    assert.match(result.content[0].text, /noul/, `call ${call + 1} within the cap`);
  }
  const capped = await intuitionTool.execute(TOOL_ARGS);
  assert.match(capped.content[0].text, /rate limit/);

  // Window expiry resets the counter without any per-turn hooks.
  activeSession.cerebellumIntuitionWindowStartAt = Date.now() - 61_000;
  const afterWindow = await intuitionTool.execute(TOOL_ARGS);
  assert.match(afterWindow.content[0].text, /noul/, 'expired window allows a fresh call');
});
