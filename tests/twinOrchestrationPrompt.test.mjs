import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return { app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() } };
  }
  return originalLoad.apply(this, arguments);
};
const { CoworkRunner } = require('../dist-electron/main/libs/coworkRunner.js');
Module._load = originalLoad;

function runnerFor(metabot, options = {}) {
  const store = {
    getSession: () => ({ metabotId: metabot.id }),
    getConversationSourceContextBySession: () => ({ sourceChannel: 'cowork_ui', externalConversationId: 'test' }),
    getMemoryBackend: () => ({ resolveMetabotIdForMemory: () => metabot.id }),
  };
  return new CoworkRunner(store, { getMetabotById: () => metabot, ...options });
}

function twinDirectory() {
  return {
    requester: { sessionId: 'twin-session', twinId: 1, ownerGlobalMetaId: 'owner-global' },
    workers: [
      {
        id: 1,
        name: 'Twin',
        type: 'twin',
        enabled: true,
        globalMetaID: 'gmid-twin',
        ownerGlobalMetaId: 'owner-global',
        ownerBindingVerified: true,
        role: 'chief of staff',
        bio: null,
        goal: null,
        personaSummary: '',
        skills: [],
        chatSkills: [],
        capabilityEvidence: [],
        availability: 'available',
        activeOrchestrationSteps: null,
      },
      {
        id: 2,
        name: '阿码',
        type: 'worker',
        enabled: true,
        globalMetaID: 'gmid-ama',
        ownerGlobalMetaId: 'owner-global',
        ownerBindingVerified: true,
        role: 'coding specialist',
        bio: 'Writes TypeScript',
        goal: 'Ship code',
        personaSummary: '',
        skills: ['code'],
        chatSkills: [],
        capabilityEvidence: [],
        availability: 'available',
        activeOrchestrationSteps: null,
      },
    ],
  };
}

test('Twin sessions receive a host-owned orchestration overlay', () => {
  const prompt = runnerFor({ id: 1, enabled: true, metabot_type: 'twin' }).buildTwinOrchestrationPrompt('twin-session');
  assert.match(prompt, /one persistent Twin Bot/);
  assert.match(prompt, /local_workers_list/);
  assert.match(prompt, /local_worker_delegate/);
  assert.match(prompt, /metabot-group-task/);
  assert.match(prompt, /Do not personally perform specialist execution/);
  assert.match(prompt, /Local Workers are preferred, never mandatory/);
  assert.match(prompt, /fresh machine with only the Twin Bot/);
  assert.match(prompt, /Worker handoff as evidence/);
  assert.match(prompt, /Do not disclose private owner memory/);
});

test('Worker sessions do not receive the Twin orchestration overlay', () => {
  assert.equal(runnerFor({ id: 2, enabled: true, metabot_type: 'worker' }).buildTwinOrchestrationPrompt('worker-session'), '');
});

test('Twin sessions receive the stable local Worker roster', async () => {
  const runner = runnerFor({ id: 1, enabled: true, metabot_type: 'twin' }, {
    listLocalWorkers: () => twinDirectory(),
  });
  const roster = await runner.buildTwinLocalRosterPrompt('twin-session');
  assert.match(roster, /阿码/);
  assert.match(roster, /id=2/);
  assert.match(roster, /coding specialist/);
  assert.match(roster, /do NOT need to call local_workers_list/);
  assert.doesNotMatch(roster, /\(id=1/);
});

test('Twin sessions receive distilled Worker impressions in the volatile tail', async () => {
  const runner = runnerFor({ id: 1, enabled: true, metabot_type: 'twin', globalmetaid: 'gmid-twin' }, {
    listLocalWorkers: () => twinDirectory(),
    listTwinImpressions: () => [{ subjectGlobalMetaID: 'gmid-ama', summaryText: 'Solid coder' }],
  });
  const impressions = await runner.buildTwinLocalImpressionPrompt('twin-session');
  assert.match(impressions, /阿码: Solid coder/);
});

test('Worker sessions do not receive the Twin roster or impressions', async () => {
  const runner = runnerFor({ id: 2, enabled: true, metabot_type: 'worker' }, {
    listLocalWorkers: () => twinDirectory(),
    listTwinImpressions: () => [{ subjectGlobalMetaID: 'gmid-ama', summaryText: 'Solid coder' }],
  });
  assert.equal(await runner.buildTwinLocalRosterPrompt('worker-session'), '');
  assert.equal(await runner.buildTwinLocalImpressionPrompt('worker-session'), '');
});
