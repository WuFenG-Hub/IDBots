import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const {
  buildTwinWorkerDirectory,
  buildTwinLocalImpressionBlock,
  buildTwinLocalRosterBlock,
  TwinWorkerDirectoryAuthorizationError,
} = require('../dist-electron/main/services/twinWorkerDirectoryService.js');

function bot(id, overrides = {}) {
  return {
    id,
    name: `Bot ${id}`,
    enabled: true,
    metabot_type: 'worker',
    boss_global_metaid: 'owner-global',
    role: 'specialist',
    soul: 'Persistent specialist persona',
    bio: `Bio for bot ${id}`,
    background: null,
    goal: 'Complete assigned work',
    skills: [`skill-${id}`, 'shared-skill'],
    allow_chat_skills: ['chat-skill'],
    ...overrides,
  };
}

function deps({ sessionMetabotId = 1, bots = [bot(1, { metabot_type: 'twin' }), bot(2)], owner = 'owner-global' } = {}) {
  return {
    getSession: (id) => id === 'twin-session' ? { id, metabotId: sessionMetabotId } : null,
    listMetabots: () => bots,
    getOwnerGlobalMetaId: () => owner,
    listCapabilityEvidence: (metabotId) => [{
      summaryDate: '2026-08-06',
      summaryText: `Evidence for ${metabotId}`,
      sessionRefs: [{ sessionId: `session-${metabotId}`, title: 'Completed work' }],
    }],
  };
}

test('Twin directory returns sanitized capabilities and bounded evidence for every local Bot', () => {
  const result = buildTwinWorkerDirectory('twin-session', deps({
    bots: [
      bot(1, { metabot_type: 'twin', role: 'chief of staff' }),
      bot(2, { skills: [' web ', 'web', ''], bio: 'worker bio' }),
      bot(3, { enabled: false, boss_global_metaid: null }),
    ],
  }));

  assert.deepEqual(result.requester, {
    sessionId: 'twin-session',
    twinId: 1,
    ownerGlobalMetaId: 'owner-global',
  });
  assert.equal(result.workers.length, 3);
  assert.equal(result.workers[0].type, 'twin');
  assert.equal(result.workers[0].role, 'chief of staff');
  assert.deepEqual(result.workers[1].skills, ['web']);
  assert.equal(result.workers[2].availability, 'disabled');
  assert.equal(result.workers[2].ownerBindingVerified, false);
  assert.equal(result.workers[1].capabilityEvidence[0].sessionRefs[0].sessionId, 'session-2');
  assert.equal(result.workers[1].activeOrchestrationSteps, null);
});

test('Twin roster block is stable profile-only and excludes the Twin itself', () => {
  const directory = buildTwinWorkerDirectory('twin-session', deps({
    bots: [
      bot(1, { metabot_type: 'twin' }),
      bot(2, { globalmetaid: 'gmid-2', role: 'coding specialist', skills: ['code', 'debug'] }),
      bot(3, { enabled: false, globalmetaid: 'gmid-3' }),
    ],
  }));
  const block = buildTwinLocalRosterBlock(directory);
  assert.match(block, /Bot 2 \(id=2, enabled\)/);
  assert.match(block, /MetaID: gmid-2/);
  assert.match(block, /coding specialist/);
  assert.match(block, /Skills: code, debug/);
  assert.match(block, /Bot 3 \(id=3, disabled\)/);
  assert.doesNotMatch(block, /\(id=1/);
  assert.doesNotMatch(block, /local_worker_delegate/);
});

test('Twin impression block joins snapshots by Worker globalMetaID', () => {
  const directory = buildTwinWorkerDirectory('twin-session', deps({
    bots: [
      bot(1, { metabot_type: 'twin' }),
      bot(2, { globalmetaid: 'gmid-2' }),
      bot(3, { globalmetaid: 'gmid-3' }),
    ],
  }));
  const block = buildTwinLocalImpressionBlock(directory, [
    {
      subjectGlobalMetaID: 'gmid-2',
      summaryText: 'Reliable TypeScript coder',
      capabilityTags: ['engineering'],
      lastCollaboration: { title: 'Skill intro MetaApp', outcome: 'done', pinIds: ['pin-1'] },
    },
  ]);
  assert.match(block, /Bot 2: Reliable TypeScript coder/);
  assert.match(block, /tags: engineering/);
  assert.match(block, /last collab: "Skill intro MetaApp" done/);
  assert.doesNotMatch(block, /Bot 3/);
  assert.equal(buildTwinLocalImpressionBlock(directory, []), '');
});

for (const [name, setup, code] of [
  ['missing source session', () => deps({ sessionMetabotId: 1 }), 'SOURCE_SESSION_NOT_FOUND'],
  ['worker source session', () => deps({ sessionMetabotId: 2 }), 'TWIN_TOOL_FORBIDDEN'],
  ['disabled Twin', () => deps({ bots: [bot(1, { metabot_type: 'twin', enabled: false }), bot(2)] }), 'TWIN_DISABLED'],
  ['owner mismatch', () => deps({ owner: 'different-owner' }), 'OWNER_BINDING_MISMATCH'],
  ['ambiguous Twin invariant', () => deps({ bots: [bot(1, { metabot_type: 'twin' }), bot(2, { metabot_type: 'twin' })] }), 'TWIN_INVARIANT_VIOLATION'],
]) {
  test(`Twin directory denies ${name}`, () => {
    assert.throws(
      () => buildTwinWorkerDirectory(name === 'missing source session' ? 'missing' : 'twin-session', setup()),
      (error) => error instanceof TwinWorkerDirectoryAuthorizationError && error.code === code,
    );
  });
}

test('Cowork host tool denies a Worker before invoking the directory callback', async () => {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return { app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() } };
    }
    return originalLoad.apply(this, arguments);
  };
  let CoworkRunner;
  try {
    ({ CoworkRunner } = require('../dist-electron/main/libs/coworkRunner.js'));
  } finally {
    Module._load = originalLoad;
  }

  const store = {
    getSession: () => ({ metabotId: 2 }),
    getMemoryBackend: () => ({ resolveMetabotIdForMemory: () => 2 }),
  };
  let called = false;
  const runner = new CoworkRunner(store, {
    getMetabotById: (id) => ({ id, enabled: true, metabot_type: 'worker' }),
    listLocalWorkers: () => { called = true; return { requester: {}, workers: [] }; },
  });
  const result = await runner.handleHostToolExecution({ toolName: 'local_workers_list', toolInput: {} }, 'worker-session');
  assert.equal(result.success, false);
  assert.equal(JSON.parse(result.text).code, 'TWIN_TOOL_FORBIDDEN');
  assert.equal(called, false);
});
