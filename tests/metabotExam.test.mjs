/**
 * Dream review P2 (2026-10-23), item P2-1: frozen per-bot exams — the
 * comparable growth curve (design 2026-10-10 §P2.5, activation condition met:
 * loop telemetry is moving).
 *
 * Covers:
 *   1. exam-bank builder: deterministic, category caps, ≤5 questions, hash
 *      freeze, null when the sediment is too thin,
 *   2. store freeze idempotency: same content hash never rebuilds; a changed
 *      hash archives the old paper,
 *   3. the dream pass: ≥14-day data gate, ≤1 run per bot per week, answers +
 *      scoring land on the run row, telemetry carries the score,
 *   4. score parser: tolerant JSON, unknown ids dropped, total recomputed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore, getRow } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

const {
  buildMetabotExam,
  buildExamSessionPrompt,
  buildExamScoringPrompt,
  parseExamScores,
  examContentHash,
  EXAM_MAX_QUESTIONS,
} = require('../dist-electron/main/libs/metabotExam.js');
const { DreamStore } = require('../dist-electron/main/dreamStore.js');

const { dayStartMs } = await import('./fixtures/rrsiDreamHarness.mjs');

const sediment = () => ({
  valueBoundaries: [
    { id: 'vb1', text: '涉及个人痛苦的话题要更谨慎。', updatedAt: 100 },
    { id: 'vb2', text: '不确定的问题不要不懂装懂。', updatedAt: 200 },
    { id: 'vb3', text: '第三条边界。', updatedAt: 300 },
  ],
  workReviews: [{ id: 'wr1', text: '交付前先自查一遍再回复。', updatedAt: 150 }],
  knowledgeEntries: [{ id: 'k1', topic: '视频导出流程', summary: '先渲染预览再导出。', updatedAt: 120 }],
  feedbackEvents: [
    { messageId: 'm1', sessionTitle: '剪视频', rating: 'down', comment: '根本没做完', occurredAt: 400 },
    { messageId: 'm2', sessionTitle: '剪视频', rating: 'up', comment: '字幕位置很讲究', occurredAt: 500 },
  ],
  groupTaskComments: [{ taskId: 9, title: '官网海报', rating: 4, comment: '构图不错但配色保守。', occurredAt: 600 }],
});

test('exam bank: deterministic, capped at 5, hash-frozen, thin sediment → null', () => {
  const a = buildMetabotExam(sediment());
  const b = buildMetabotExam(sediment());
  assert.ok(a);
  assert.equal(a.questions.length, EXAM_MAX_QUESTIONS, 'hard cap at 5 questions');
  assert.equal(a.contentHash, b.contentHash, 'deterministic build');
  assert.deepEqual(a.questions.map((question) => question.kind), [
    'value_boundary', 'value_boundary', 'work_review', 'knowledge', 'feedback',
  ], 'oldest-first category mix, group review cut by the cap');
  assert.ok(a.questions.every((question) => question.rubric.length > 0 && question.sourceAnchor));
  assert.ok(buildExamSessionPrompt({ botName: '小火', exam: a }).includes('q1'));
  const scoring = buildExamScoringPrompt({ botName: '小火', exam: a, answers: '作答' });
  assert.ok(scoring.user.includes('根本没做完'), 'the frozen rubric carries the feedback comment');

  // Any question change changes the hash (the freeze).
  const mutated = { ...a, questions: a.questions.map((question, index) => index === 0 ? { ...question, prompt: 'changed' } : question) };
  assert.notEqual(examContentHash(mutated.questions), a.contentHash);

  // Thin sediment: one boundary only → not worth the tokens.
  assert.equal(buildMetabotExam({
    valueBoundaries: [{ id: 'vb1', text: '一条边界。', updatedAt: 1 }],
    workReviews: [],
    knowledgeEntries: [],
    feedbackEvents: [],
    groupTaskComments: [],
  }), null);
});

test('score parser: tolerant JSON, unknown ids dropped, total recomputed', () => {
  const valid = new Set(['q1', 'q2']);
  const parsed = parseExamScores('```json\n{"scores":[{"id":"q1","score":0.8,"note":"覆盖要点"},{"id":"evil","score":1},{"id":"q2","score":0.4}]}\n```', valid);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.scores.length, 2);
  assert.ok(Math.abs(parsed.total - 0.6) < 1e-9, 'total is the mean of valid scores, never model-reported');
  assert.equal(parseExamScores('junk', valid).ok, false);
  const clamped = parseExamScores('{"scores":[{"id":"q1","score":1.7}]}', valid);
  assert.equal(clamped.ok, true);
  assert.equal(clamped.scores[0].score, 1, 'scores clamp to [0,1]');
});

test('store freeze: same hash never rebuilds; a changed hash archives the old paper', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const dreamStore = new DreamStore(db, () => {});
    const questions = [{ id: 'q1', kind: 'value_boundary', prompt: 'p', rubric: ['r'], sourceAnchor: 'memory:x' }];
    const first = dreamStore.freezeExam(5, examContentHash(questions), questions, 1000);
    assert.ok(first);
    const again = dreamStore.freezeExam(5, examContentHash(questions), questions, 2000);
    assert.equal(again.id, first.id, 'same hash → keep the frozen paper');
    assert.equal(db.exec('SELECT COUNT(*) FROM metabot_exams')[0].values[0][0], 1);

    const other = [{ id: 'q1', kind: 'knowledge', prompt: 'p2', rubric: ['r2'], sourceAnchor: 'knowledge:y' }];
    const second = dreamStore.freezeExam(5, examContentHash(other), other, 3000);
    assert.notEqual(second.id, first.id, 'new hash → new paper');
    assert.equal(db.exec('SELECT COUNT(*) FROM metabot_exams WHERE archived_at IS NULL')[0].values[0][0], 1, 'old paper archived');
  } finally {
    cleanup();
  }
});

test('dream pass: end-to-end — exam session + scoring run, weekly gate on the second night', async () => {
  const { createSqliteStore } = await import('./memoryTestUtils.mjs');
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  const insertMessage = (sessionId, id, type, content, createdAt, sequence) => {
    db.run(
      'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, sessionId, type, content, '{}', createdAt, sequence],
    );
  };
  try {
    db.run(
      `INSERT INTO metabots (
        id, wallet_id, mvc_address, btc_address, doge_address, public_key,
        chat_public_key, name, metaid, metabot_type, created_by, role, soul, created_at, updated_at
      ) VALUES (5, 1, 'mvc-5', 'btc-5', 'doge-5', 'pub-5', 'chat-5', '小火', 'metaid-5', 'worker', 'test', 'role', 'soul', 1, 1)`,
    );
    // ≥14 days of dream data ending at D.
    const D = '2026-08-20';
    const D_START = dayStartMs(D);
    for (let offset = 16; offset >= 1; offset -= 1) {
      const date = new Date(D_START - offset * 86_400_000);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      db.run(
        `INSERT INTO metabot_daily_summaries (id, metabot_id, summary_date, summary_text, sections_json, stats_json, session_refs_json, created_at, updated_at)
         VALUES (?, 5, ?, '普通的一天。', '{}', '{}', '[]', ?, ?)`,
        [`sum-${key}`, key, D_START - offset * 86_400_000, D_START - offset * 86_400_000],
      );
    }
    const day = coworkStore.createSession('和用户聊发布', '/tmp/a', '', 'local', [], 5);
    insertMessage(day.id, 'u1', 'user', '在吗', D_START + 1000, 1);
    insertMessage(day.id, 'a1', 'assistant', '在的', D_START + 2000, 2);
    coworkStore.createDreamUserMemory({
      metabotId: 5,
      text: '涉及个人痛苦的话题要更谨慎。',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'value_boundary',
      origin: 'dream',
      isExplicit: true,
      source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: '2026-08-04' },
    });
    coworkStore.createDreamUserMemory({
      metabotId: 5,
      text: '不确定的问题不要不懂装懂。',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'value_boundary',
      origin: 'dream',
      isExplicit: true,
      source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: '2026-08-05' },
    });

    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, ...rest) {
      if (request === 'electron') {
        return { app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() } };
      }
      return originalLoad.call(this, request, ...rest);
    };
    let DreamService;
    try {
      ({ DreamService } = require('../dist-electron/main/services/dreamService.js'));
    } finally {
      Module._load = originalLoad;
    }

    let examSessionCalls = 0;
    let now = new Date(D_START + 27 * 60 * 60 * 1000);
    const makeService = () => new DreamService({
      coworkStore,
      metabotStore: {
        listMetabots: () => [
          { id: 5, name: '小火', role: '视频创作者', soul: '认真严谨', llm_id: 'bot-own-llm', enabled: true },
        ],
      },
      dreamStore,
      llmTimeoutMs: 5000,
      now: () => now,
      runExamSession: async ({ userMessage }) => {
        examSessionCalls += 1;
        assert.ok(userMessage.includes('q1'), 'the frozen paper rides the session prompt');
        return 'q1: 先确认感受再回应。 q2: 直说不知道并给出核实路径。';
      },
      performChat: async (system) => {
        if (system.includes('固定能力试卷评分') || system.includes('评分')) {
          return JSON.stringify({
            scores: [
              { id: 'q1', score: 0.8, note: '覆盖要点' },
              { id: 'q2', score: 0.6, note: '基本覆盖' },
            ],
          });
        }
        return JSON.stringify({
          daily_summary: '今天固定试卷得分不错。',
          sections: {},
          work_reviews: [],
          important_memories: [],
          value_lessons: [],
          self_identity: `我是认真的 MetaBot。${'我先验证再交付。'.repeat(30)}`,
          capability_learnings: [],
        });
      },
    });

    const service = makeService();
    await service.runNow(5, D);
    assert.equal(examSessionCalls, 1, 'one exam run on the first eligible night');
    const telemetry = dreamStore.getRun(5, D).telemetry;
    assert.equal(telemetry.exam.ran, true);
    assert.equal(telemetry.exam.score, 0.7);
    assert.equal(telemetry.exam.questions, 2);
    const runRow = getRow(db, "SELECT status, total_score FROM metabot_exam_runs WHERE status = 'done'");
    assert.equal(runRow.status, 'done');
    assert.ok(Math.abs(runRow.total_score - 0.7) < 1e-9, 'the score lands on the run row');

    // The weekly gate: a second night three days later runs no exam.
    now = new Date(D_START + 3 * 86_400_000 + 27 * 60 * 60 * 1000);
    const D2 = '2026-08-23';
    const day2 = coworkStore.createSession('又一天', '/tmp/a', '', 'local', [], 5);
    insertMessage(day2.id, 'u2', 'user', '在吗', dayStartMs(D2) + 1000, 1);
    insertMessage(day2.id, 'a2', 'assistant', '在的', dayStartMs(D2) + 2000, 2);
    await service.runNow(5, D2);
    assert.equal(examSessionCalls, 1, '≤1 exam run per week per bot');

    // Eight days later the gate opens again.
    now = new Date(D_START + 8 * 86_400_000 + 27 * 60 * 60 * 1000);
    const D3 = '2026-08-28';
    const day3 = coworkStore.createSession('再一天', '/tmp/a', '', 'local', [], 5);
    insertMessage(day3.id, 'u3', 'user', '在吗', dayStartMs(D3) + 1000, 1);
    insertMessage(day3.id, 'a3', 'assistant', '在的', dayStartMs(D3) + 2000, 2);
    await service.runNow(5, D3);
    assert.equal(examSessionCalls, 2, 'the gate reopens after 7 days');
  } finally {
    cleanup();
  }
});

test('dream pass: bots younger than 14 days of data skip the exam', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  try {
    db.run(
      `INSERT INTO metabots (
        id, wallet_id, mvc_address, btc_address, doge_address, public_key,
        chat_public_key, name, metaid, metabot_type, created_by, role, soul, created_at, updated_at
      ) VALUES (5, 1, 'mvc-5', 'btc-5', 'doge-5', 'pub-5', 'chat-5', '小火', 'metaid-5', 'worker', 'test', 'role', 'soul', 1, 1)`,
    );
    const D = '2026-08-05';
    const D_START = dayStartMs(D);
    // Only 5 days of summaries.
    for (let offset = 5; offset >= 1; offset -= 1) {
      const date = new Date(D_START - offset * 86_400_000);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      db.run(
        `INSERT INTO metabot_daily_summaries (id, metabot_id, summary_date, summary_text, sections_json, stats_json, session_refs_json, created_at, updated_at)
         VALUES (?, 5, ?, '普通的一天。', '{}', '{}', '[]', ?, ?)`,
        [`sum-${key}`, key, D_START - offset * 86_400_000, D_START - offset * 86_400_000],
      );
    }
    const day = coworkStore.createSession('聊天', '/tmp/a', '', 'local', [], 5);
    db.run(
      'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['u1', day.id, 'user', '在吗', '{}', D_START + 1000, 1],
    );
    db.run(
      'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['a1', day.id, 'assistant', '在的', '{}', D_START + 2000, 2],
    );
    coworkStore.createDreamUserMemory({
      metabotId: 5,
      text: '涉及个人痛苦的话题要更谨慎。',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'value_boundary',
      origin: 'dream',
      isExplicit: true,
      source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: '2026-08-01' },
    });
    coworkStore.createDreamUserMemory({
      metabotId: 5,
      text: '不确定的问题不要不懂装懂。',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'value_boundary',
      origin: 'dream',
      isExplicit: true,
      source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: '2026-08-02' },
    });

    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, ...rest) {
      if (request === 'electron') {
        return { app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() } };
      }
      return originalLoad.call(this, request, ...rest);
    };
    let DreamService;
    try {
      ({ DreamService } = require('../dist-electron/main/services/dreamService.js'));
    } finally {
      Module._load = originalLoad;
    }
    let examCalls = 0;
    const service = new DreamService({
      coworkStore,
      metabotStore: {
        listMetabots: () => [
          { id: 5, name: '小火', role: '视频创作者', soul: '认真严谨', llm_id: 'bot-own-llm', enabled: true },
        ],
      },
      dreamStore,
      llmTimeoutMs: 5000,
      now: () => new Date(D_START + 27 * 60 * 60 * 1000),
      runExamSession: async () => {
        examCalls += 1;
        return 'q1: … q2: …';
      },
      performChat: async () => JSON.stringify({
        daily_summary: '年轻的一天。',
        sections: {},
        work_reviews: [],
        important_memories: [],
        value_lessons: [],
        self_identity: `我是认真的 MetaBot。${'我先验证再交付。'.repeat(30)}`,
        capability_learnings: [],
      }),
    });
    await service.runNow(5, D);
    assert.equal(examCalls, 0, '<14 days of data → no exam');
    assert.equal(dreamStore.getRun(5, D).telemetry.exam.ran, false);
  } finally {
    cleanup();
  }
});
