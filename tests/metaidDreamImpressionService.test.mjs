import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createLegacyMemoryDb, createSqliteStore } from './memoryTestUtils.mjs';

let MetaIDExperienceStore;
let MetaIDImpressionStore;
let buildMetaIDDreamImpressionContext;
let applyMetaIDDreamImpressionUpdates;
let buildDreamPrompt;
let parseDreamOutput;

const require = Module.createRequire(import.meta.url);
function loadDreamService() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') {
      return { app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() } };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return require(require.resolve('../dist-electron/main/services/dreamService.js'));
  } catch {
    return require('../dist-electron/services/dreamService.js');
  } finally {
    Module._load = originalLoad;
  }
}
const { DreamService } = loadDreamService();
try {
  ({ MetaIDExperienceStore } = await import('../dist-electron/main/metaidExperienceStore.js'));
  ({ MetaIDImpressionStore } = await import('../dist-electron/main/metaidImpressionStore.js'));
  ({
    buildMetaIDDreamImpressionContext,
    applyMetaIDDreamImpressionUpdates,
  } = await import('../dist-electron/main/services/metaidDreamImpressionService.js'));
  ({ buildDreamPrompt, parseDreamOutput } = await import('../dist-electron/main/libs/dreamPrompt.js'));
} catch {
  ({ MetaIDExperienceStore } = await import('../dist-electron/metaidExperienceStore.js'));
  ({ MetaIDImpressionStore } = await import('../dist-electron/metaidImpressionStore.js'));
  ({
    buildMetaIDDreamImpressionContext,
    applyMetaIDDreamImpressionUpdates,
  } = await import('../dist-electron/services/metaidDreamImpressionService.js'));
  ({ buildDreamPrompt, parseDreamOutput } = await import('../dist-electron/libs/dreamPrompt.js'));
}

const OWNER = 'idq1observer';
const SUBJECT = 'idq1subject';
const DREAM_DATE = '2026-07-30';
const DREAM_DAY_START = new Date(2026, 6, 30).getTime();

function hash(char) {
  return char.repeat(64);
}

function addEpisode(experience, index, type = 'direct_interaction', startedAt = 1_700_000_000_000 + index * 1_000) {
  const episode = experience.createEpisode({
    ownerGlobalMetaID: OWNER,
    episodeType: type,
    sourceChannel: 'test',
    sourceKey: `dream-episode:${index}`,
    startedAt,
  }).episode;
  experience.addParticipant({ episodeId: episode.id, globalMetaID: OWNER, role: 'observer', source: 'test' });
  experience.addParticipant({ episodeId: episode.id, globalMetaID: SUBJECT, role: 'counterparty', source: 'test' });
  const evidence = experience.addEvidence({
    episodeId: episode.id,
    evidenceType: 'message',
    sourceKey: `dream-evidence:${index}`,
    pinId: `dream-pin-${index}`,
    publisherGlobalMetaID: SUBJECT,
    contentHash: hash('a'),
    occurredAt: startedAt,
  });
  return { episode, evidence };
}

test('dream context is owner-relative and update application validates candidates and converges', async () => {
  const db = await createLegacyMemoryDb();
  try {
    const experience = new MetaIDExperienceStore(db, () => {}, () => 1_800_000_000_000);
    const impressions = new MetaIDImpressionStore(db, () => {}, () => 1_800_000_000_000);
    const first = addEpisode(experience, 1);
    const second = addEpisode(experience, 2, 'task_participation');
    const subjects = buildMetaIDDreamImpressionContext({
      experienceStore: experience,
      impressionStore: impressions,
      observerGlobalMetaID: OWNER,
      fromTime: 1_699_000_000_000,
      toTime: 1_701_000_000_000,
    });
    assert.equal(subjects.length, 1);
    assert.deepEqual(subjects[0].episodeIds.sort(), [first.episode.id, second.episode.id].sort());
    assert.equal(subjects[0].evidenceIds.length, 2);
    const validUpdate = {
      subjectGlobalMetaId: SUBJECT,
      episodeIds: [first.episode.id, second.episode.id],
      evidenceIds: subjects[0].evidenceIds,
      observation: 'The subject followed through on the task.',
      interpretation: 'A promising collaborator.',
      dimensions: { styleDescriptors: ['direct'], cooperation: 'promising' },
      communicationGuidance: 'Give a clear goal and room to execute.',
      confidence: { level: 'medium', uncertainty: 'The sample is still small.' },
    };
    const firstApply = applyMetaIDDreamImpressionUpdates({
      impressionStore: impressions,
      observerGlobalMetaID: OWNER,
      dreamDate: '2026-08-06',
      dreamVersion: 3,
      modelId: 'test-model',
      subjects,
      updates: [validUpdate, { ...validUpdate, subjectGlobalMetaId: 'idq1unknown' }],
    });
    assert.deepEqual(firstApply, { accepted: 1, created: 1, rejected: 1, rebuilt: 1 });
    assert.equal(impressions.getSnapshot(OWNER, SUBJECT).summaryText, 'A promising collaborator.');
    const secondApply = applyMetaIDDreamImpressionUpdates({
      impressionStore: impressions,
      observerGlobalMetaID: OWNER,
      dreamDate: '2026-08-06',
      dreamVersion: 3,
      modelId: 'test-model',
      subjects,
      updates: [validUpdate],
    });
    assert.deepEqual(secondApply, { accepted: 1, created: 0, rejected: 0, rebuilt: 1 });
    assert.equal(impressions.listObservations({ observerGlobalMetaID: OWNER, subjectGlobalMetaID: SUBJECT }).length, 1);
  } finally {
    db.close();
  }
});

test('dream prompt and parser carry bounded GlobalMetaID impression updates', () => {
  const prompt = buildDreamPrompt({
    botName: 'Dreamer',
    date: '2026-08-06',
    activity: { sessions: [], taskRuns: [], orderCount: 0 },
    impressionSubjects: [{
      subjectGlobalMetaID: SUBJECT,
      episodeIds: ['episode-1'],
      evidenceIds: ['evidence-1'],
      interactionCount: 1,
      directInteractionCount: 1,
      evidence: [{
        id: 'evidence-1',
        evidenceType: 'message',
        pinId: 'pin-1',
        publisherGlobalMetaID: SUBJECT,
        occurredAt: 1_700_000_000_000,
      }],
      previousSnapshot: null,
    }],
  });
  assert.match(prompt.user, /subjectGlobalMetaId=idq1subject/);
  assert.match(prompt.user, /impression_updates/);
  const parsed = parseDreamOutput(JSON.stringify({
    daily_summary: 'A day with one subject.',
    impression_updates: [{
      subjectGlobalMetaId: SUBJECT,
      episodeIds: ['episode-1'],
      evidenceIds: ['evidence-1'],
      observation: 'A clear fact.',
      interpretation: 'A cautious interpretation.',
      dimensions: { styleDescriptors: ['concise'] },
      communicationGuidance: 'Be concrete.',
      confidence: { level: 'low' },
    }],
  }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.output.impressionUpdates[0].subjectGlobalMetaId, SUBJECT);
  assert.deepEqual(parsed.output.impressionUpdates[0].evidenceIds, ['evidence-1']);
});

test('DreamService applies validated impression updates at the completion boundary', async () => {
  const harness = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(harness.db);
    const { DreamStore } = await import('../dist-electron/main/dreamStore.js').catch(() => import('../dist-electron/dreamStore.js'));
    const dreamStore = new DreamStore(harness.db, () => {});
    const experience = new MetaIDExperienceStore(harness.db, () => {});
    const impressions = new MetaIDImpressionStore(harness.db, () => {});
    const source = addEpisode(experience, 9, 'direct_interaction', DREAM_DAY_START + 1_000);
    const identity = `I am a persistent MetaBot who learns from concrete interaction evidence. ${'I keep improving my judgment. '.repeat(12)}`;
    const calls = [];
    const service = new DreamService({
      coworkStore,
      dreamStore,
      metabotStore: {
        listMetabots: () => [{
          id: 5,
          name: 'Dreamer',
          globalmetaid: OWNER,
          llm_id: 'test-model',
          enabled: true,
        }],
      },
      metaidExperienceStore: experience,
      metaidImpressionStore: impressions,
      performChat: async (system, user) => {
        calls.push({ system, user });
        return JSON.stringify({
          daily_summary: 'The day had one direct interaction.',
          sections: {},
          work_reviews: [],
          important_memories: [],
          value_lessons: [],
          impression_updates: [{
            subjectGlobalMetaId: SUBJECT,
            episodeIds: [source.episode.id],
            evidenceIds: [source.evidence.id],
            observation: 'The subject responded with a concrete follow-through.',
            interpretation: 'A promising collaborator.',
            dimensions: { cooperation: 'promising' },
            communicationGuidance: 'Keep requests concrete.',
            confidence: { level: 'medium', uncertainty: 'Only one observed turn.' },
          }],
          self_identity: identity,
        });
      },
      now: () => new Date(2026, 7, 1, 3, 0),
      llmTimeoutMs: 5000,
    });
    await service.runNow(5, DREAM_DATE);
    assert.equal(calls.length, 1);
    assert.match(calls[0].user, new RegExp(SUBJECT));
    const snapshot = impressions.getSnapshot(OWNER, SUBJECT);
    assert.equal(snapshot.summaryText, 'A promising collaborator.');
    assert.equal(snapshot.directInteractionCount, 1);
    assert.equal(dreamStore.getRun(5, DREAM_DATE).status, 'completed');
  } finally {
    harness.cleanup();
  }
});
