import test from 'node:test';
import assert from 'node:assert/strict';

import { createSqliteStore } from './memoryTestUtils.mjs';

let TeamCultureStore;
let runCultureDistillation;
let buildCultureDistillationPrompt;
try {
  ({ TeamCultureStore } = await import('../dist-electron/main/teamCultureStore.js'));
  ({ runCultureDistillation, buildCultureDistillationPrompt } =
    await import('../dist-electron/main/services/teamCultureDistillation.js'));
} catch {
  ({ TeamCultureStore } = await import('../dist-electron/teamCultureStore.js'));
  ({ runCultureDistillation, buildCultureDistillationPrompt } =
    await import('../dist-electron/services/teamCultureDistillation.js'));
}

const SUMMARY = {
  conclusion: 'Deliverables verified and confirmed on-chain.',
  outcome: 'done',
  planChanges: ['original: static image -> blocker: renderer missing font -> fallback: SVG text'],
  deliverables: [
    { status: 'accepted', authorName: 'Coder Bot' },
    { status: 'accepted', authorName: 'Designer Bot' },
  ],
  members: [
    { name: 'Twin Bot', role: 'chair' },
    { name: 'Coder Bot', role: 'worker' },
    { name: 'Designer Bot', role: 'worker' },
  ],
};

const PROPOSAL_JSON = JSON.stringify({
  glossary: [{ term: 'verified deliverable', definition: 'An on-chain metafile whose verification JSON the chair has checked.' }],
  conventions: [{ topic: 'font check before render', text: 'Renderers must confirm required fonts exist before generating final artifacts.' }],
  lessons: [{ topic: 'SVG fallback for text', text: 'When a renderer misses fonts, switching headline text to SVG preserves the deadline.' }],
});

test('distillation applies capped proposals through the governed upsert channel', async () => {
  const harness = await createSqliteStore();
  try {
    const { db } = harness;
    const store = new TeamCultureStore(db, () => {}, () => 1_800_000_000_000);
    const counts = await runCultureDistillation({
      task: { taskId: 7, title: 'Launch poster', goal: 'Make a launch poster', status: 'done', summary: SUMMARY },
      cultureStore: store,
      performChat: async () => '```json\n' + PROPOSAL_JSON + '\n```',
    });
    assert.equal(counts.applied, 3);
    assert.equal(counts.protectedEntries, 0);
    assert.equal(counts.pendingConventions, 1, 'distilled conventions land pending owner approval');

    const entries = store.listCulture({ status: 'active' });
    assert.equal(entries.length, 3);
    const lesson = entries.find((entry) => entry.kind === 'team_lesson');
    assert.equal(lesson.origin, 'distillation');
    assert.equal(lesson.pendingApproval, false, 'lessons are low-risk and auto-activate');
    const convention = entries.find((entry) => entry.kind === 'convention');
    assert.equal(convention.pendingApproval, true);
    const pendingBlock = store.buildCulturePromptBlock();
    assert.ok(!pendingBlock.includes(convention.topic), 'pending conventions never join injection');
    const approved = store.approveCulture(convention.id);
    assert.equal(approved.pendingApproval, false);
    const approvedBlock = store.buildCulturePromptBlock();
    assert.ok(approvedBlock.includes(convention.topic), 'approval joins injection');
    const sourced = db.exec(
      'SELECT COUNT(*) AS n FROM team_culture_sources WHERE task_id = 7',
    )[0]?.values?.[0]?.[0];
    assert.equal(Number(sourced), 3, 'task provenance recorded for every applied entry');
  } finally {
    harness.cleanup();
  }
});

test('distillation never revives archived entries', async () => {
  const harness = await createSqliteStore();
  try {
    const { db } = harness;
    const store = new TeamCultureStore(db, () => {}, () => 1_800_000_000_000);
    const retired = store.upsertCulture({
      kind: 'team_lesson',
      topic: 'SVG fallback for text',
      text: 'When a renderer misses fonts, switching headline text to SVG preserves the deadline.',
      origin: 'distillation',
      taskId: 5,
    }).entry;
    store.archiveCulture(retired.id);

    let prompt = '';
    const counts = await runCultureDistillation({
      task: { taskId: 9, title: 'Poster v3', goal: 'Again', status: 'done', summary: SUMMARY },
      cultureStore: store,
      performChat: async (_system, user) => {
        prompt = user;
        return '```json\n' + JSON.stringify({
          glossary: [],
          conventions: [],
          lessons: [{ topic: 'SVG fallback for text', text: 'reworded revival attempt.' }],
        }) + '\n```';
      },
    });
    assert.equal(counts.protectedEntries, 1, 'the archived entry shields itself');
    assert.equal(counts.applied, 0);
    const still = store.getCulture(retired.id);
    assert.equal(still.status, 'archived');
    assert.equal(still.text.includes('revival attempt'), false);
    assert.match(prompt, /Archived \(retired, do NOT revive\): SVG fallback for text/,
      'the prompt lists archived topics so the LLM avoids them');
  } finally {
    harness.cleanup();
  }
});

test('distillation respects owner protection and skips non-done or tiny tasks', async () => {
  const harness = await createSqliteStore();
  try {
    const { db } = harness;
    const store = new TeamCultureStore(db, () => {}, () => 1_800_000_000_000);
    store.upsertCulture({
      kind: 'convention',
      topic: 'Font check before render',
      text: 'Owner-authored convention text that must survive.',
    });

    let llmCalls = 0;
    const performChat = async () => {
      llmCalls += 1;
      return PROPOSAL_JSON;
    };
    const counts = await runCultureDistillation({
      task: { taskId: 8, title: 'Launch poster', goal: 'Make a launch poster', status: 'done', summary: SUMMARY },
      cultureStore: store,
      performChat,
    });
    assert.equal(counts.applied, 2, 'glossary + lesson applied');
    assert.equal(counts.protectedEntries, 1, 'the owner convention is shielded');
    const convention = store.listCulture({ kind: 'convention' })[0];
    assert.equal(convention.text, 'Owner-authored convention text that must survive.');
    assert.equal(convention.origin, 'owner');

    const cancelled = await runCultureDistillation({
      task: { taskId: 9, title: 'x', goal: 'y', status: 'cancelled', summary: SUMMARY },
      cultureStore: store,
      performChat,
    });
    assert.equal(cancelled.applied, 0);
    const solo = await runCultureDistillation({
      task: {
        taskId: 10, title: 'x', goal: 'y', status: 'done',
        summary: { ...SUMMARY, members: [{ name: 'Twin Bot', role: 'chair' }] },
      },
      cultureStore: store,
      performChat,
    });
    assert.equal(solo.applied, 0);
    assert.equal(llmCalls, 1, 'cancelled and solo tasks never reach the LLM');
  } finally {
    harness.cleanup();
  }
});

test('unparseable output is a silent no-op and the prompt carries existing topics', async () => {
  const harness = await createSqliteStore();
  try {
    const { db } = harness;
    const store = new TeamCultureStore(db, () => {}, () => 1_800_000_000_000);
    store.upsertCulture({ kind: 'glossary', topic: 'seat', text: 'A coarse specialty slot on the team.' });

    let capturedPrompt = '';
    const counts = await runCultureDistillation({
      task: { taskId: 11, title: 'Poster v2', goal: 'Make it again', status: 'done', summary: SUMMARY },
      cultureStore: store,
      performChat: async (_system, user) => {
        capturedPrompt = user;
        return 'the model rambled instead of JSON';
      },
    });
    assert.equal(counts.applied, 0);
    assert.equal(store.listCulture({ status: 'active' }).length, 1, 'nothing was written');

    assert.match(capturedPrompt, /Poster v2/);
    assert.match(capturedPrompt, /Existing culture topics: .*seat/s,
      'the LLM sees current topics so it avoids duplicates');
    const staticPrompt = buildCultureDistillationPrompt({
      title: 't', goal: 'g', summary: SUMMARY, existingTopics: [], archivedTopics: [],
    });
    assert.match(staticPrompt, /silence is a valid answer/);
  } finally {
    harness.cleanup();
  }
});
