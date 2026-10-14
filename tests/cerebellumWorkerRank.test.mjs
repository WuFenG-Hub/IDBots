import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CEREBELLUM_WORKER_RANK_INSTRUCTIONS,
  CEREBELLUM_WORKER_RANK_MIN_POOL,
  CEREBELLUM_WORKER_RANK_QUESTION_ID,
  CEREBELLUM_WORKER_RANK_TOP_K,
  appendWorkerFitHint,
  buildWorkerAssignmentHint,
  buildWorkerOptionLabel,
  buildWorkerRankRequest,
  parseWorkerRankAnswers,
  rankWorkersWithCerebellum,
} from '../src/main/cerebellum/workerRank.ts';

const TEST_CONFIG = {
  provider: 'typesafe-jev',
  apiKey: 'sk-jev-test',
  baseUrl: 'https://jev.example.com',
  model: 'jev-latest',
};

const WORKERS = [
  { id: 'w-design', name: '小绘', description: 'role: designer. impression: 海报和视觉交付稳。' },
  { id: 'w-eng', name: '阿码', description: 'role: engineer. impression: 擅长把接口和链上交付接上。' },
  { id: 'w-copy', name: '文案', description: 'role: copywriter. impression: 中文短文案快。' },
];

function okFetch(payload, captured = []) {
  return async (url, init) => {
    captured.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => payload };
  };
}

function choicePayload(probabilities, choice) {
  const answer = { type: 'choice', probabilities };
  if (choice !== undefined) answer.choice = choice;
  return { model: 'jev-latest', answers: { [CEREBELLUM_WORKER_RANK_QUESTION_ID]: answer } };
}

test('buildWorkerRankRequest puts the goal in state and workers in criteria', () => {
  const request = buildWorkerRankRequest({
    taskText: '做一张海报并把它发到链上',
    workers: WORKERS,
    model: 'jev-fast',
  });
  assert.equal(request.state.task_goal, '做一张海报并把它发到链上');
  assert.equal(request.model, 'jev-fast');
  const question = request.questions[CEREBELLUM_WORKER_RANK_QUESTION_ID];
  assert.equal(question.type, 'choice');
  assert.equal(question.instructions, CEREBELLUM_WORKER_RANK_INSTRUCTIONS);
  assert.match(question.instructions, /`task_goal`/);
  assert.deepEqual(Object.keys(question.criteria), ['w-design', 'w-eng', 'w-copy']);
  assert.match(question.criteria['w-design'], /^小绘: /);
});

test('buildWorkerOptionLabel caps the description', () => {
  const label = buildWorkerOptionLabel({ id: 'a', name: '阿码', description: 'x'.repeat(500) });
  assert.ok(label.startsWith('阿码: '));
  assert.ok(label.length < 400);
});

test('parseWorkerRankAnswers sorts probabilities and falls back to choice', () => {
  const ranking = parseWorkerRankAnswers(
    choicePayload({ 'w-copy': 0.2, 'w-eng': 0.7, ghost: 0.9, 'w-design': 'nope' }),
    WORKERS,
  );
  assert.deepEqual(ranking.map((entry) => entry.id), ['w-eng', 'w-copy']);
  assert.deepEqual(
    parseWorkerRankAnswers(choicePayload({}, 'w-design'), WORKERS),
    [{ id: 'w-design', probability: 1 }],
  );
  assert.equal(parseWorkerRankAnswers(null, WORKERS), null);
  assert.equal(parseWorkerRankAnswers({ answers: {} }, WORKERS), null);
});

test('buildWorkerAssignmentHint omits probabilities and appendWorkerFitHint is a no-op when empty', () => {
  const hint = buildWorkerAssignmentHint([
    { name: '阿码', description: 'engineer', probability: 0.9 },
    { name: '小绘', description: 'designer', probability: 0.4 },
  ]);
  assert.match(hint, /1\. 阿码 — engineer/);
  assert.match(hint, /2\. 小绘 — designer/);
  assert.equal(hint.includes('0.9'), false);
  assert.match(hint, /Do not pile every subtask/);
  const directive = 'plan as usual';
  assert.equal(appendWorkerFitHint(directive, ''), directive);
  assert.equal(appendWorkerFitHint(directive, null), directive);
  assert.ok(appendWorkerFitHint(directive, hint).endsWith(hint));
  assert.equal(hint.split('\n').filter((line) => /^\d+\./.test(line)).length <= CEREBELLUM_WORKER_RANK_TOP_K, true);
});

test('rankWorkersWithCerebellum returns null below the pool, on blank text, and on failure', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  assert.equal(await rankWorkersWithCerebellum({
    config: TEST_CONFIG, fetchImpl, taskText: '做海报', workers: WORKERS.slice(0, CEREBELLUM_WORKER_RANK_MIN_POOL - 1),
  }), null);
  assert.equal(await rankWorkersWithCerebellum({
    config: TEST_CONFIG, fetchImpl, taskText: '   ', workers: WORKERS,
  }), null);
  assert.equal(calls, 0);
  assert.equal(await rankWorkersWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    taskText: '做海报',
    workers: WORKERS,
  }), null);
  assert.equal(await rankWorkersWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl: async () => { throw new Error('down'); },
    taskText: '做海报',
    workers: WORKERS,
  }), null);
});

test('rankWorkersWithCerebellum posts one choice and sorts the roster', async () => {
  const captured = [];
  const ranking = await rankWorkersWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl: okFetch(choicePayload({ 'w-eng': 0.8, 'w-design': 0.5, 'w-copy': 0.1 }), captured),
    taskText: '把交付发到链上并附 txid',
    workers: WORKERS,
  });
  assert.deepEqual(ranking.map((entry) => entry.id), ['w-eng', 'w-design', 'w-copy']);
  assert.equal(captured[0].url, 'https://jev.example.com/v1/systemone');
  assert.equal(captured[0].body.state.task_goal, '把交付发到链上并附 txid');
  assert.equal(captured[0].body.questions[CEREBELLUM_WORKER_RANK_QUESTION_ID].type, 'choice');
});

test('rankWorkersWithCerebellum aborts past the timeout', async () => {
  let abortSeen = false;
  const fetchImpl = (_url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => {
      abortSeen = true;
      reject(new Error('aborted'));
    });
  });
  const started = Date.now();
  const ranking = await rankWorkersWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl,
    taskText: '做海报',
    workers: WORKERS,
    timeoutMs: 30,
  });
  assert.equal(ranking, null);
  assert.equal(abortSeen, true);
  assert.ok(Date.now() - started < 1000);
});

test('eval script builds the request through the module', () => {
  const source = readFileSync(new URL('../scripts/cerebellum-worker-rank-eval.mjs', import.meta.url), 'utf8');
  assert.match(source, /buildWorkerRankRequest/);
  assert.match(source, /parseWorkerRankAnswers/);
});
