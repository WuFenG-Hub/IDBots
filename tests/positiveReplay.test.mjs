/**
 * Dream review P0 (2026-10-23), item 3: positive reinforcement path — the
 * 👍-symmetric counterpart of the counterfactual replay.
 *
 * Covers:
 *   1. extractPositiveDecisionPoints — thumbs-up replies with context,
 *      comment-first ordering, ≤3/day cap,
 *   2. buildPositiveReplayPrompt + parsePositiveReplayOutput — rendering and
 *      the tolerant parser (fences, unknown ids dropped),
 *   3. pickPositiveLesson — the conservative quality gate (repeatable +
 *      substantive beyond flattery + grounded in the quoted reply),
 *   4. end-to-end dream run — a 👍 message triggers one extra LLM pass and a
 *      passing lesson lands as a capability_draft (status 'draft',
 *      origin 'positive_replay'); flattery/ungated output writes nothing;
 *      a clean day makes no positive-replay call at all; telemetry counts
 *      points/lessons like the negative path.
  * NOTE: imports the dist-electron build — run `pnpm run compile:electron` first.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

const {
  extractPositiveDecisionPoints,
  buildPositiveReplayPrompt,
  parsePositiveReplayOutput,
  pickPositiveLesson,
  POSITIVE_REPLAY_MAX_POINTS,
  POSITIVE_LESSON_MAX_CHARS,
} = require('../dist-electron/main/libs/positiveReplayPrompt.js');

function loadDreamServiceModule() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => process.cwd(),
        },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return require('../dist-electron/main/services/dreamService.js');
  } finally {
    Module._load = originalLoad;
  }
}

const { DreamService } = loadDreamServiceModule();
const { DreamStore } = require('../dist-electron/main/dreamStore.js');

const DAY = '2026-08-04';
const DAY_START = new Date(2026, 7, 4).getTime();
const LONG_IDENTITY = `我是一个认真严谨的 MetaBot。${'我先验证再交付。'.repeat(30)}`;

const metabotStoreStub = () => ({
  listMetabots: () => [
    { id: 5, name: '小火', role: '视频创作者', soul: '认真严谨', llm_id: 'bot-own-llm', enabled: true },
  ],
});

const dreamJson = (overrides = {}) => JSON.stringify({
  daily_summary: '今天一切顺利。',
  sections: {},
  work_reviews: [],
  important_memories: [],
  value_lessons: [],
  self_identity: LONG_IDENTITY,
  capability_learnings: [],
  ...overrides,
});

test('extract picks thumbs-up replies with context, comment first, capped', () => {
  const messages = [
    { type: 'user', content: '帮我剪个视频', createdAt: 1 },
    { type: 'assistant', content: '好的马上', createdAt: 2, feedbackRating: 'up' },
    { type: 'user', content: '加个字幕', createdAt: 3 },
    { type: 'assistant', content: '已经加上了', createdAt: 4, feedbackRating: 'up', feedbackComment: '字幕位置很讲究' },
    { type: 'assistant', content: '被踩的回复', createdAt: 5, feedbackRating: 'down' },
  ];
  const activity = {
    sessions: [{ sessionId: 's1', title: '剪视频', sessionType: 'standard', peerName: null, isOrder: false, messages }],
    taskRuns: [],
    orderCount: 0,
    groupTasks: [],
  };
  const points = extractPositiveDecisionPoints(activity);
  assert.equal(points.length, 2);
  assert.equal(points[0].id, 'msg:s1:3', 'commented thumbs-up sorts first');
  assert.ok(points[0].outcome.includes('字幕位置很讲究'));
  assert.ok(points[0].situation.includes('帮我剪个视频'), 'up to 6 prior context messages ride along');
  assert.equal(points[1].id, 'msg:s1:1');
  assert.ok(points.every((point) => point.botAction.length > 0));
});

test('extract caps at POSITIVE_REPLAY_MAX_POINTS (3) per day', () => {
  const messages = Array.from({ length: 8 }, (_, index) => ({
    type: 'assistant',
    content: `被赞回复 ${index}`,
    createdAt: index + 1,
    feedbackRating: 'up',
  }));
  const activity = {
    sessions: [{ sessionId: 's1', title: 't', sessionType: 'standard', peerName: null, isOrder: false, messages }],
    taskRuns: [],
    orderCount: 0,
    groupTasks: [],
  };
  const points = extractPositiveDecisionPoints(activity);
  assert.equal(points.length, POSITIVE_REPLAY_MAX_POINTS);
});

test('prompt renders points and the conservative output contract', () => {
  const prompt = buildPositiveReplayPrompt({
    botName: '小火',
    date: DAY,
    points: [{
      id: 'msg:s1:3',
      situation: '会话「剪视频」:\n对方: 加个字幕',
      botAction: '已经加上了,字幕对齐了人声的节奏点',
      outcome: '人类对这条回复点了赞,并留言:「字幕位置很讲究」',
    }],
  });
  assert.ok(prompt.system.includes('正向重放'));
  assert.ok(prompt.user.includes('决策点 msg:s1:3'));
  assert.ok(prompt.user.includes('字幕对齐了人声的节奏点'));
  assert.ok(prompt.user.includes('字幕位置很讲究'));
  assert.ok(prompt.user.includes('"repeatable"'));
  assert.ok(prompt.user.includes('"grounding"'));
});

test('parser accepts fenced JSON and drops results with unknown ids', () => {
  const valid = new Set(['msg:s1:1']);
  const fenced = '```json\n' + JSON.stringify({
    results: [
      { id: 'msg:s1:1', repeatable: true, lesson: '具体的做法', grounding: '对照原文' },
      { id: 'msg:evil:9', repeatable: true, lesson: '不该被采纳', grounding: 'x' },
    ],
  }) + '\n```';
  const parsed = parsePositiveReplayOutput(fenced, valid);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.results.length, 1);
  assert.equal(parsed.results[0].id, 'msg:s1:1');
  assert.equal(parsePositiveReplayOutput('not json at all', valid).ok, false);
  assert.equal(parsePositiveReplayOutput('{"results": []}', valid).ok, false, 'no usable results is a parse failure');
});

test('quality gate: only repeatable, substantive, reply-grounded lessons pass', () => {
  const point = {
    id: 'msg:s1:1',
    situation: '会话「剪视频」:',
    botAction: '已经加上了,字幕对齐了人声的节奏点',
    outcome: '人类对这条回复点了赞。',
  };
  const good = { id: 'msg:s1:1', repeatable: true, lesson: '做字幕类修改时,先对齐人声节奏点再导出,避免返工', grounding: '回复里把字幕对齐了人声的节奏点' };
  assert.equal(pickPositiveLesson(good, point), good.lesson);

  // Not affirmed repeatable → dropped.
  assert.equal(pickPositiveLesson({ ...good, repeatable: false }, point), null);
  // Empty lesson → dropped.
  assert.equal(pickPositiveLesson({ ...good, lesson: '' }, point), null);
  // Too short → dropped.
  assert.equal(pickPositiveLesson({ ...good, lesson: '短' }, point), null);
  // Over the size window → dropped.
  assert.equal(pickPositiveLesson({ ...good, lesson: '长'.repeat(POSITIVE_LESSON_MAX_CHARS + 1) }, point), null);
  // Generic flattery only → dropped.
  assert.equal(pickPositiveLesson({ ...good, lesson: '这条回复做得很好,值得表扬' }, point), null);
  // Ungrounded (grounding shares no bigram with the praised reply) → dropped.
  assert.equal(pickPositiveLesson({ ...good, grounding: '完全不相关的说明文字' }, point), null);
  // Missing grounding → dropped.
  assert.equal(pickPositiveLesson({ ...good, grounding: '' }, point), null);
});

test('dream run replays praised points and writes gate-passing lessons as origin-marked drafts', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  const session = coworkStore.createSession('剪视频', '/tmp/a', '', 'local', [], 5);
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['u1', session.id, 'user', '帮我把字幕加上', '{}', DAY_START + 1000, 1]
  );
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['a1', session.id, 'assistant', '已经加上了,字幕对齐了人声的节奏点', '{}', DAY_START + 2000, 2]
  );
  db.run(
    'INSERT INTO message_feedback (message_id, session_id, rating, comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['a1', session.id, 'up', '字幕位置很讲究', DAY_START + 3000, DAY_START + 3000]
  );

  const calls = [];
  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 5, 3, 0),
    performChat: async (system, user) => {
      calls.push({ system, user });
      if (system.includes('正向重放')) {
        const ids = [...user.matchAll(/### 决策点 (\S+?)\(/g)].map((match) => match[1]);
        return JSON.stringify({
          results: ids.map((id) => ({
            id,
            repeatable: true,
            lesson: '做字幕类修改时,先对齐人声节奏点再导出,避免返工',
            grounding: '回复里把字幕对齐了人声的节奏点,这就是被认可的关键做法',
          })),
        });
      }
      if (system.includes('能力验证')) return JSON.stringify({ verdicts: [] });
      return dreamJson();
    },
  });
  try {
    await service.runNow(5, DAY);

    // Dream call + positive replay call (+ possibly an empty validation call).
    const replayCall = calls.find((call) => call.system.includes('正向重放'));
    assert.ok(replayCall, 'one extra LLM pass for the praised points');
    assert.ok(replayCall.user.includes('字幕位置很讲究'));

    const drafts = coworkStore.listCapabilityDrafts(5);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].status, 'draft', 'flows into the existing pipeline as a draft');
    assert.equal(drafts[0].origin, 'positive_replay', 'distinguishable origin marker');
    assert.ok(drafts[0].description.includes('做字幕类修改时'));
    assert.ok(drafts[0].description.includes('正向重放'));

    const telemetry = dreamStore.getRun(5, DAY).telemetry;
    assert.deepEqual(telemetry.positiveReplay, { points: 1, lessons: 1 });
    assert.equal(dreamStore.getRun(5, DAY).status, 'completed');
  } finally {
    cleanup();
  }
});

test('dream run writes no drafts when the replay answer is generic flattery', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  const session = coworkStore.createSession('剪视频', '/tmp/a', '', 'local', [], 5);
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['a1', session.id, 'assistant', '已经加上了,字幕对齐了人声的节奏点', '{}', DAY_START + 2000, 1]
  );
  db.run(
    'INSERT INTO message_feedback (message_id, session_id, rating, comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['a1', session.id, 'up', null, DAY_START + 3000, DAY_START + 3000]
  );

  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 5, 3, 0),
    performChat: async (system, user) => {
      if (system.includes('正向重放')) {
        const ids = [...user.matchAll(/### 决策点 (\S+?)\(/g)].map((match) => match[1]);
        return JSON.stringify({
          results: ids.map((id) => ({
            id,
            repeatable: true,
            lesson: '这条回复做得很好,值得表扬',
            grounding: '字幕对齐了人声的节奏点',
          })),
        });
      }
      if (system.includes('能力验证')) return JSON.stringify({ verdicts: [] });
      return dreamJson();
    },
  });
  try {
    await service.runNow(5, DAY);
    assert.equal(coworkStore.listCapabilityDrafts(5).length, 0, 'flattery never becomes a draft');
    const telemetry = dreamStore.getRun(5, DAY).telemetry;
    assert.deepEqual(telemetry.positiveReplay, { points: 1, lessons: 0 }, 'points counted, lessons gated');
  } finally {
    cleanup();
  }
});

test('a day without thumbs-up makes no positive-replay LLM call', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  const session = coworkStore.createSession('聊天', '/tmp/a', '', 'local', [], 5);
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['a1', session.id, 'assistant', '你好呀', '{}', DAY_START + 1000, 1]
  );

  const systems = [];
  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 5, 3, 0),
    performChat: async (system) => {
      systems.push(system);
      return dreamJson();
    },
  });
  try {
    await service.runNow(5, DAY);
    assert.ok(!systems.some((system) => system.includes('正向重放')));
    const telemetry = dreamStore.getRun(5, DAY).telemetry;
    assert.deepEqual(telemetry.positiveReplay, { points: 0, lessons: 0 });
  } finally {
    cleanup();
  }
});

test('the dream prompt contract covers 👍-annotated replies in work_reviews', () => {
  const { buildDreamPrompt } = require('../dist-electron/main/libs/dreamPrompt.js');
  const prompt = buildDreamPrompt({
    botName: '小火',
    date: DAY,
    activity: { sessions: [], taskRuns: [], orderCount: 0, groupTasks: [] },
  });
  assert.match(prompt.user, /〔人类评价:赞〕/);
  assert.match(prompt.user, /work_reviews 里必须为每条被赞回复写一条复盘/);
  // Symmetric thumbs-down rule intact.
  assert.match(prompt.user, /work_reviews 与 value_lessons 必须正视这些负反馈/);
});
