/**
 * Dream review P3 (2026-10-23), item P3-3: pre-dream surf failure storm fix.
 *
 * Dev data (.dev-userdata-dsh): 13/13 pre-dream surf runs failed with the
 * same stale-binding error ("Provider 'deepseek' does not offer enabled model
 * 'deepseek-v4-flash'"), and EVERY run created an orphan [编排任务] cowork
 * session plus its ~49k-char prompt before dying at turn time.
 *
 * Covers:
 *   1. the executeRun guard: a stale binding fails the run row WITHOUT
 *      invoking the session factory — for the pre-dream AND manual triggers
 *      (same orphan-session bug class),
 *   2. the pre-dream gate: skips while the binding is stale, keeps the skip
 *      reason for the night's telemetry, and clears as soon as the binding
 *      resolves again,
 *   3. dream telemetry: a host-side skip surfaces as surfSkipped; a normal
 *      surf (or no surf hook) leaves it null.
  * NOTE: imports the dist-electron build — run `pnpm run compile:electron` first.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);

const { createNativeSqliteDatabase } = await import('../dist-electron/main/nativeSqliteDatabase.js');
const { MetawebSurfStore } = await import('../dist-electron/main/metawebSurfStore.js');
const { SurfService } = await import('../dist-electron/main/services/surfService.js');
const { DreamStore } = require('../dist-electron/main/dreamStore.js');
const { createCoworkStore, createSqliteStore } = await import('./memoryTestUtils.mjs');

const NOW_MS = Date.parse('2026-09-13T01:00:00.000Z');
const NOW_SEC = Math.floor(NOW_MS / 1000);

const makeItem = (pinId, createdAt) => ({
  pinId,
  protocolKey: 'alpha',
  chainName: 'mvc',
  title: `Title ${pinId}`,
  summary: '',
  authorName: '',
  authorGlobalMetaId: 'idq-test',
  createdAt,
  likeCount: null,
  commentCount: null,
  extra: null,
});

const alphaDescriptor = (items) => ({
  key: 'alpha',
  displayName: 'Fake alpha',
  paths: ['/protocols/alpha'],
  interactions: ['like'],
  relevanceHint: 'hint',
  fetchFresh: async () => ({ items, hasMore: false, nextCursor: null }),
});

const setup = ({ binding, sessionSpy }) => {
  const db = createNativeSqliteDatabase(':memory:');
  assert.ok(db, 'native sqlite available in test runtime');
  const store = new MetawebSurfStore(db, () => {});
  const events = [];
  const service = new SurfService({
    store,
    metabotStore: {
      getMetabotById: (id) => (id === 7 ? { id: 7, name: 'Tester' } : null),
      getMetabotSetting: () => null,
    },
    broadcast: (payload) => events.push(payload),
    registry: [alphaDescriptor([makeItem('pin-a', NOW_SEC - 100)])],
    nowMs: () => NOW_MS,
    checkModelBinding: binding ? () => binding() : undefined,
    runSurfSession: sessionSpy
      ? async () => {
          sessionSpy();
          return { stats: {}, reportMarkdown: '# Surf report', reportJson: null, seenActions: [] };
        }
      : undefined,
  });
  return { store, service, events };
};

test('stale binding: the run fails on its row WITHOUT creating a session (manual trigger)', async () => {
  let sessionCalls = 0;
  const { service } = setup({
    binding: () => ({ ok: false, reason: "Provider 'deepseek' does not offer enabled model 'deepseek-v4-flash'" }),
    sessionSpy: () => { sessionCalls += 1; },
  });
  const run = await service.runSurfAndWait(7, 'manual-ui');
  assert.equal(run.status, 'failed');
  assert.match(run.error, /Surf model binding stale/);
  assert.match(run.error, /deepseek-v4-flash/);
  assert.equal(sessionCalls, 0, 'no orphan cowork session is created');
});

test('stale binding: the pre-dream trigger fails the same way without a session', async () => {
  let sessionCalls = 0;
  const { service } = setup({
    binding: () => ({ ok: false, reason: 'binding gone' }),
    sessionSpy: () => { sessionCalls += 1; },
  });
  const run = await service.runSurfAndWait(7, 'pre-dream');
  assert.equal(run.status, 'failed');
  assert.match(run.error, /Surf model binding stale/);
  assert.equal(sessionCalls, 0);
});

test('pre-dream gate: skips while stale, keeps the reason, clears on recovery', async () => {
  let bindingOk = false;
  const { service } = setup({ binding: () => (bindingOk ? { ok: true, reason: null } : { ok: false, reason: 'stale pick' }) });

  const first = service.preDreamModelBindingGate(7);
  assert.equal(first.ok, false);
  assert.equal(first.reason, 'stale pick');
  assert.equal(service.preDreamBindingSkipReason(7), 'stale pick');

  // Still stale → still skipped, reason preserved (one skip per bot).
  const second = service.preDreamModelBindingGate(7);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'stale pick');

  // Binding fixed → the gate opens again and the skip record clears.
  bindingOk = true;
  const third = service.preDreamModelBindingGate(7);
  assert.equal(third.ok, true);
  assert.equal(service.preDreamBindingSkipReason(7), null);
});

test('healthy binding: the session runs and the run completes', async () => {
  let sessionCalls = 0;
  const { service } = setup({
    binding: () => ({ ok: true, reason: null }),
    sessionSpy: () => { sessionCalls += 1; },
  });
  const run = await service.runSurfAndWait(7, 'pre-dream');
  assert.equal(run.status, 'done');
  assert.equal(sessionCalls, 1, 'the surf session runs once the binding resolves');
});

test('a throwing checker never blocks the surf', async () => {
  let sessionCalls = 0;
  const { service } = setup({
    binding: () => { throw new Error('checker exploded'); },
    sessionSpy: () => { sessionCalls += 1; },
  });
  assert.equal(service.preDreamModelBindingGate(7).ok, true, 'gate fails open');
  const run = await service.runSurfAndWait(7, 'manual-ui');
  assert.equal(run.status, 'done');
  assert.equal(sessionCalls, 1);
});

test('dream telemetry: a host-side surf skip lands as surfSkipped', async () => {
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
  let DreamService;
  try {
    ({ DreamService } = require('../dist-electron/main/services/dreamService.js'));
  } finally {
    Module._load = originalLoad;
  }

  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  try {
    const session = coworkStore.createSession('和用户聊发布', '/tmp/a', '', 'local', [], 5);
    db.run(
      'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['u1', session.id, 'user', '今天怎么样', '{}', new Date(2026, 7, 8).getTime() + 1000, 1],
    );
    db.run(
      'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['a1', session.id, 'assistant', '挺好的', '{}', new Date(2026, 7, 8).getTime() + 2000, 2],
    );
    const service = new DreamService({
      coworkStore,
      metabotStore: {
        listMetabots: () => [
          { id: 5, name: '小火', role: '视频创作者', soul: '认真严谨', llm_id: 'bot-own-llm', enabled: true },
        ],
      },
      dreamStore,
      llmTimeoutMs: 5000,
      now: () => new Date(2026, 7, 9, 3, 0),
      surfBeforeDream: async () => ({
        reportMarkdown: null,
        skippedReason: "surf-model-binding: Provider 'deepseek' does not offer enabled model 'deepseek-v4-flash'",
      }),
      performChat: async () => JSON.stringify({
        daily_summary: '今天没有冲浪,直接做梦。',
        sections: {},
        work_reviews: [],
        important_memories: [],
        value_lessons: [],
        self_identity: `我是认真的 MetaBot。${'我先验证再交付。'.repeat(30)}`,
        capability_learnings: [],
      }),
    });
    await service.runNow(5, '2026-08-08');
    const telemetry = dreamStore.getRun(5, '2026-08-08').telemetry;
    assert.match(
      telemetry.surfSkipped,
      /surf-model-binding: Provider 'deepseek' does not offer enabled model 'deepseek-v4-flash'/,
      'the skip reason is auditable in the run telemetry',
    );
  } finally {
    cleanup();
  }
});
