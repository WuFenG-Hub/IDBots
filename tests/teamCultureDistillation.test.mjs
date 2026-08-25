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

    const entries = store.listCulture({ status: 'active' });
    assert.equal(entries.length, 3);
    const lesson = entries.find((entry) => entry.kind === 'team_lesson');
    assert.equal(lesson.origin, 'distillation');
    const sourced = db.exec(
      'SELECT COUNT(*) AS n FROM team_culture_sources WHERE task_id = 7',
    )[0]?.values?.[0]?.[0];
    assert.equal(Number(sourced), 3, 'task provenance recorded for every applied entry');
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
      title: 't', goal: 'g', summary: SUMMARY, existingTopics: [],
    });
    assert.match(staticPrompt, /silence is a valid answer/);
  } finally {
    harness.cleanup();
  }
});
