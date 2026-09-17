import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

const {
  bigramSimilarity,
  extractImplicitSignals,
  IMPLICIT_REASK_MIN_SIMILARITY,
} = require('../dist-electron/main/libs/implicitSignals.js');
const { buildDreamPrompt } = require('../dist-electron/main/libs/dreamPrompt.js');
const { extractNegativeDecisionPoints } = require('../dist-electron/main/libs/counterfactualReplayPrompt.js');

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

const DAY = '2026-08-06';
const DAY_START = new Date(2026, 7, 6).getTime();
const LONG_IDENTITY = `我是一个认真严谨的 MetaBot。${'我先验证再交付。'.repeat(30)}`;

const metabotStoreStub = () => ({
  listMetabots: () => [
    { id: 5, name: '小火', role: '视频创作者', soul: '认真严谨', llm_id: 'bot-own-llm', enabled: true },
  ],
});

const emptyActivity = () => ({ sessions: [], taskRuns: [], orderCount: 0, groupTasks: [] });

test('bigramSimilarity: identical = 1, disjoint ≈ 0, partial in between', () => {
  assert.equal(bigramSimilarity('帮我做一个生日视频', '帮我做一个生日视频'), 1);
  assert.ok(bigramSimilarity('帮我做一个生日视频', '今天天气怎么样') < 0.2);
  const partial = bigramSimilarity('帮我做一个生日视频', '帮我做一个生日视频吧');
  assert.ok(partial >= IMPLICIT_REASK_MIN_SIMILARITY, `expected >= threshold, got ${partial}`);
  assert.equal(bigramSimilarity('a', 'ab'), 0);
});

test('implicit detection is language-agnostic: case and script insensitive', () => {
  // English re-ask with different case and a politeness prefix still counts.
  assert.ok(bigramSimilarity('Make me a Birthday Video', 'please make me a birthday video') > 0.6);
  // Unrelated English texts stay far apart.
  assert.ok(bigramSimilarity('make me a birthday video', 'what is the weather today') < 0.2);

  const activity = {
    sessions: [{
      sessionId: 's1', title: 'Birthday video', sessionType: 'standard', peerName: null, isOrder: false,
      messages: [
        { type: 'user', content: 'Make me a Birthday Video', createdAt: DAY_START },
        { type: 'assistant', content: 'On it', createdAt: DAY_START + 60_000 },
        { type: 'user', content: 'please make me a birthday video', createdAt: DAY_START + 5 * 60_000 },
      ],
    }],
    taskRuns: [], orderCount: 0, groupTasks: [],
  };
  const signals = extractImplicitSignals(activity);
  assert.equal(signals.filter((signal) => signal.kind === 'reask').length, 1);
});

test('extractImplicitSignals: reask within window, burst tail, repeat orders', () => {
  const activity = {
    sessions: [
      {
        sessionId: 's1', title: '生日视频', sessionType: 'standard', peerName: null, isOrder: false,
        messages: [
          { type: 'user', content: '帮我做一个生日视频', createdAt: DAY_START },
          { type: 'assistant', content: '好的', createdAt: DAY_START + 60_000 },
          { type: 'user', content: '帮我做一个生日视频吧', createdAt: DAY_START + 5 * 60_000 },
        ],
      },
      {
        sessionId: 's2', title: '闲聊', sessionType: 'standard', peerName: null, isOrder: false,
        messages: [
          { type: 'assistant', content: '在吗', createdAt: DAY_START + 1000 },
          { type: 'user', content: '在的', createdAt: DAY_START + 2000 },
          { type: 'user', content: '人呢', createdAt: DAY_START + 3000 },
        ],
      },
      { sessionId: 'o1', title: '订单一', sessionType: 'standard', peerName: '客户A', isOrder: true, messages: [] },
      { sessionId: 'o2', title: '订单二', sessionType: 'standard', peerName: '客户A', isOrder: true, messages: [] },
    ],
    taskRuns: [], orderCount: 2, groupTasks: [],
  };
  const signals = extractImplicitSignals(activity);
  const kinds = signals.map((signal) => signal.kind);
  assert.ok(kinds.includes('reask'));
  assert.ok(kinds.includes('unanswered_burst'));
  assert.ok(kinds.includes('repeat_order'));
  // Facts carry numbers, never sentiment labels.
  const reask = signals.find((signal) => signal.kind === 'reask');
  assert.ok(reask.text.includes('分钟后重述了同一诉求'));
  assert.ok(reask.text.includes('相似度'));
  assert.equal(reask.sessionId, 's1');
  assert.equal(reask.messageIndex, 2);
  assert.ok(!/负面|差评|不满/.test(reask.text));
  assert.ok(extractImplicitSignals(emptyActivity()).length === 0);
});

test('extractImplicitSignals: no reask when the gap is too wide or text too short', () => {
  const wide = {
    sessions: [{
      sessionId: 's1', title: 't', sessionType: 'standard', peerName: null, isOrder: false,
      messages: [
        { type: 'user', content: '帮我做一个生日视频', createdAt: DAY_START },
        { type: 'user', content: '帮我做一个生日视频吧', createdAt: DAY_START + 30 * 60_000 },
      ],
    }],
    taskRuns: [], orderCount: 0, groupTasks: [],
  };
  assert.equal(extractImplicitSignals(wide).filter((s) => s.kind === 'reask').length, 0);

  const tooShort = {
    sessions: [{
      sessionId: 's1', title: 't', sessionType: 'standard', peerName: null, isOrder: false,
      messages: [
        { type: 'user', content: '好的', createdAt: DAY_START },
        { type: 'user', content: '好的', createdAt: DAY_START + 60_000 },
      ],
    }],
    taskRuns: [], orderCount: 0, groupTasks: [],
  };
  assert.equal(extractImplicitSignals(tooShort).filter((s) => s.kind === 'reask').length, 0);
});

test('dream prompt renders implicit signals as facts, and omits the section when empty', () => {
  const withSignals = buildDreamPrompt({
    botName: '小火',
    date: DAY,
    activity: {
      ...emptyActivity(),
      implicitSignals: [{ kind: 'reask', sessionId: 's1', messageIndex: 2, text: '会话「生日视频」:用户在 5 分钟后重述了同一诉求(相似度 0.89)' }],
    },
  });
  assert.ok(withSignals.user.includes('当日隐式信号'));
  assert.ok(withSignals.user.includes('结构化事实,不代表负面'));
  assert.ok(withSignals.user.includes('出处')); // grounding contract line

  const without = buildDreamPrompt({ botName: '小火', date: DAY, activity: emptyActivity() });
  assert.ok(!without.user.includes('当日隐式信号'));
});

test('counterfactual replay adds implicit candidates below explicit negative points', () => {
  const activity = {
    sessions: [{
      sessionId: 's1', title: '生日视频', sessionType: 'standard', peerName: null, isOrder: false,
      messages: [
        { type: 'user', content: '帮我做一个生日视频', createdAt: 1 },
        { type: 'assistant', content: '好的马上', createdAt: 2, feedbackRating: 'down', feedbackComment: '敷衍' },
        { type: 'user', content: '帮我做一个生日视频吧', createdAt: 3 },
        { type: 'assistant', content: '这次一定做好', createdAt: 4 },
      ],
    }],
    taskRuns: [], orderCount: 0, groupTasks: [],
    implicitSignals: [{ kind: 'reask', sessionId: 's1', messageIndex: 2, text: '用户在 1 分钟后重述了同一诉求(相似度 0.89)' }],
  };
  const points = extractNegativeDecisionPoints(activity);
  assert.equal(points.length, 2);
  assert.equal(points[0].kind, 'thumbs_down');
  assert.equal(points[1].kind, 'implicit');
  assert.equal(points[1].botAction, '好的马上'); // the reply the user restated over
  assert.ok(points[1].outcome.includes('隐式信号'));
});

test('validation gate drops verdicts citing diary dates that were never provided', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  const session = coworkStore.createSession('聊天', '/tmp/a', '', 'local', [], 5);
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['m1', session.id, 'user', '你好', '{}', DAY_START + 1000, 1]
  );
  coworkStore.insertCapabilityDrafts(5, '2026-08-05', [
    { title: '被真实证据支持的技巧', description: '有日记佐证', capabilityType: 'skill' },
    { title: '被幻觉日期支持的技巧', description: '引用了不存在的日记', capabilityType: 'skill' },
  ]);

  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 7, 3, 0),
    performChat: async (system, user) => {
      if (system.includes('能力验证')) {
        const verdicts = [...user.matchAll(/### 草案 #(\d+)[\s\S]*?标题:([^\n]+)/g)].map((match) => ({
          id: Number(match[1]),
          verdict: 'validated',
          score: 0.9,
          rationale: match[2].includes('真实证据')
            ? `在 ${DAY} 的日记里有明确佐证`   // today's diary exists post-run
            : '在 2026-01-01 的日记里有明确佐证', // hallucinated citation
        }));
        return JSON.stringify({ verdicts });
      }
      return JSON.stringify({
        daily_summary: '普通的一天。',
        sections: {}, work_reviews: [], important_memories: [], value_lessons: [],
        self_identity: LONG_IDENTITY, capability_learnings: [],
      });
    },
  });
  try {
    await service.runNow(5, DAY);
    const validated = coworkStore.listCapabilityDrafts(5, { status: 'validated' });
    assert.equal(validated.length, 1);
    assert.equal(validated[0].title, '被真实证据支持的技巧');
    // The hallucinated citation stays a draft — not promoted, not rejected.
    const stillDraft = coworkStore.listCapabilityDrafts(5, { status: 'draft' });
    assert.equal(stillDraft.length, 1);
    assert.equal(stillDraft[0].title, '被幻觉日期支持的技巧');
  } finally {
    cleanup();
  }
});

test('run telemetry records implicit signal count and diary unmatched refs', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  const session = coworkStore.createSession('生日视频', '/tmp/a', '', 'local', [], 5);
  const messages = [
    ['u1', 'user', '帮我做一个生日视频', DAY_START + 1000],
    ['a1', 'assistant', '好的', DAY_START + 2000],
    ['u2', 'user', '帮我做一个生日视频吧', DAY_START + 5 * 60_000],
  ];
  messages.forEach(([id, type, content, createdAt], index) => {
    db.run(
      'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, session.id, type, content, '{}', createdAt, index + 1]
    );
  });

  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 7, 3, 0),
    performChat: async () => JSON.stringify({
      daily_summary: '今天在「不存在的会话」里帮用户做了视频。',
      sections: {}, work_reviews: [], important_memories: [], value_lessons: [],
      self_identity: LONG_IDENTITY, capability_learnings: [],
    }),
  });
  try {
    await service.runNow(5, DAY);
    const run = dreamStore.getRun(5, DAY);
    assert.equal(run.status, 'completed');
    assert.equal(run.telemetry.implicitSignals, 1);
    // 「不存在的会话」 matches no real session title; 「生日视频」 would have.
    assert.equal(run.telemetry.diaryUnmatchedRefs, 1);
    assert.equal(typeof run.telemetry.replay.pointsByKind, 'object');
  } finally {
    cleanup();
  }
});
