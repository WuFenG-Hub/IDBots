import test from 'node:test';
import assert from 'node:assert/strict';

import { createLegacyMemoryDb } from './memoryTestUtils.mjs';

let parseDreamOutput;
let buildDreamPrompt;
let MAX_KNOWLEDGE_UPDATES;
let MetaIDKnowledgeStore;
try {
  ({
    parseDreamOutput,
    buildDreamPrompt,
    MAX_KNOWLEDGE_UPDATES,
  } = await import('../dist-electron/main/libs/dreamPrompt.js'));
} catch {
  ({
    parseDreamOutput,
    buildDreamPrompt,
    MAX_KNOWLEDGE_UPDATES,
  } = await import('../dist-electron/dreamPrompt.js'));
}
try {
  ({ MetaIDKnowledgeStore } = await import('../dist-electron/main/metaidKnowledgeStore.js'));
} catch {
  ({ MetaIDKnowledgeStore } = await import('../dist-electron/metaidKnowledgeStore.js'));
}

const baseActivity = () => ({
  sessions: [
    {
      sessionId: 's1',
      title: '3D 游戏技术选型',
      sessionType: 'standard',
      peerName: null,
      isOrder: false,
      messages: [{ type: 'user', content: '用 R3F 还是裸 WebGL', createdAt: 1 }],
    },
  ],
  taskRuns: [],
  orderCount: 0,
});

const baseOutput = (overrides = {}) => {
  const obj = {
    daily_summary: '今天讨论了 3D 游戏的技术选型。',
    sections: { human: '和用户聊了 3D 选型' },
    work_reviews: [],
    important_memories: [],
    value_lessons: [],
    self_identity: null,
    impression_updates: [],
    knowledge_points: [
      {
        topic: '快速开发高质量 3D 网页游戏的最快路径',
        summary: 'React Three Fiber + Vite 起步最快，能复用 React 生态。',
        kind: 'know_how',
        category: '技术栈',
      },
      {
        topic: '裸 WebGL 上手成本',
        summary: '直接写 WebGL 容易陷在渲染管线里拖慢业务进度。',
        kind: 'pitfall',
      },
    ],
    ...overrides,
  };
  return JSON.stringify(obj);
};

test('parseDreamOutput parses knowledge_points with kind normalization and category', () => {
  const result = parseDreamOutput(baseOutput());
  assert.equal(result.ok, true);
  const knowledge = result.output.knowledgeUpdates;
  assert.equal(knowledge.length, 2);
  assert.equal(knowledge[0].kind, 'know_how');
  assert.equal(knowledge[0].category, '技术栈');
  assert.equal(knowledge[1].kind, 'pitfall');
  assert.equal(knowledge[1].category, null);
});

test('unknown/missing kind falls back to know_how', () => {
  const result = parseDreamOutput(baseOutput({
    knowledge_points: [
      { topic: 't', summary: 's', kind: 'BOGUS' },
      { topic: 'u', summary: 'v' },
      { topic: 'w', summary: 'x', kind: 'Principle' },
    ],
  }));
  assert.equal(result.ok, true);
  const kinds = result.output.knowledgeUpdates.map((item) => item.kind);
  assert.deepEqual(kinds, ['know_how', 'know_how', 'principle']);
});

test('entries without topic or summary are dropped; episode/evidence ids are carried', () => {
  const result = parseDreamOutput(baseOutput({
    knowledge_points: [
      { summary: 'no topic' },
      { topic: 'has topic' },
      { topic: 'good', summary: 'with refs', episodeIds: ['ep-1', 'ep-1', 'ep-2'], evidenceIds: ['ev-1'] },
    ],
  }));
  assert.equal(result.ok, true);
  assert.equal(result.output.knowledgeUpdates.length, 1);
  assert.deepEqual(result.output.knowledgeUpdates[0].episodeIds, ['ep-1', 'ep-2']);
  assert.deepEqual(result.output.knowledgeUpdates[0].evidenceIds, ['ev-1']);
});

test(`knowledge_points is capped at MAX_KNOWLEDGE_UPDATES (${MAX_KNOWLEDGE_UPDATES})`, () => {
  const points = Array.from({ length: 12 }, (_, index) => ({ topic: `t${index}`, summary: 's', kind: 'know_how' }));
  const result = parseDreamOutput(baseOutput({ knowledge_points: points }));
  assert.equal(result.ok, true);
  assert.equal(result.output.knowledgeUpdates.length, MAX_KNOWLEDGE_UPDATES);
});

test('output with no knowledge_points yields an empty array, not undefined', () => {
  const result = parseDreamOutput(baseOutput({ knowledge_points: undefined }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.output.knowledgeUpdates, []);
});

test('buildDreamPrompt always advertises the knowledge_points schema field', () => {
  const { user } = buildDreamPrompt({
    botName: 'MVC',
    date: '2026-08-13',
    activity: baseActivity(),
  });
  assert.ok(user.includes('"knowledge_points"'), 'knowledge_points schema field present in prompt');
});

test('buildDreamPrompt injects the existing-knowledge section so the model can revise by topic', () => {
  const { user } = buildDreamPrompt({
    botName: 'MVC',
    date: '2026-08-13',
    activity: baseActivity(),
    existingKnowledge: [
      { topic: '用户喜欢的设计风格', summary: '偏好简约。', kind: 'know_how', version: 1 },
      { topic: '别在 SSR 产物里访问 window', summary: '会崩。', kind: 'pitfall', version: 3 },
    ],
  });
  assert.ok(user.includes('我已有的知识点'), 'existing knowledge section header present');
  assert.ok(user.includes('用户喜欢的设计风格'), 'existing topic surfaced for revision');
  assert.ok(user.includes('坑'), 'pitfall kind labeled');
  assert.ok(
    user.includes('复用 topic 来修正更新') || user.includes('相同 topic'),
    'guidance tells the model to reuse the topic to revise',
  );
});

test('dream knowledge round-trip: same topic revises (version bump), new topic creates', async () => {
  const db = await createLegacyMemoryDb();
  const store = new MetaIDKnowledgeStore(db, () => {}, () => 1000);

  // Seed an existing knowledge point the dream would "see".
  store.upsertKnowledge({
    metabotId: 1,
    topic: '用户喜欢的设计风格',
    summary: '偏好简约风。',
    kind: 'know_how',
  });

  // The dream decides to REVISE the existing topic (same wording) and CREATE a new one.
  const dreamView = store.listKnowledgeForDream(1);
  assert.equal(dreamView.length, 1);

  const parsed = parseDreamOutput(baseOutput({
    knowledge_points: [
      // revise: reuse the exact existing topic with today's richer conclusion
      { topic: '用户喜欢的设计风格', summary: '偏好简约风：大量留白、最多两种主色、圆角卡片。', kind: 'principle' },
      // create: brand-new knowledge
      { topic: '快速开发高质量 3D 网页游戏的最快路径', summary: 'React Three Fiber + Vite。', kind: 'know_how' },
    ],
  }));
  assert.equal(parsed.ok, true);

  let created = 0;
  let revised = 0;
  for (const update of parsed.output.knowledgeUpdates) {
    const result = store.upsertKnowledge({
      metabotId: 1,
      topic: update.topic,
      summary: update.summary,
      kind: update.kind,
      origin: 'dream',
      sourceDreamDate: '2026-08-13',
    });
    if (result.created) created += 1;
    if (result.revised) revised += 1;
  }
  assert.equal(created, 1);
  assert.equal(revised, 1);

  const all = store.listKnowledge({ metabotId: 1, status: 'all' });
  assert.equal(all.length, 2);
  const design = all.find((entry) => entry.topic === '用户喜欢的设计风格');
  assert.equal(design.version, 2);
  assert.equal(design.kind, 'principle');
  assert.equal(design.origin, 'dream');
  assert.equal(store.listKnowledgeRevisions(design.id).length, 1);
});
