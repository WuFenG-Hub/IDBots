/**
 * Dream review P3 (2026-10-23), item P3-1: the capability gate's dual-panel
 *陪审团 is configurable.
 *
 * Persistence: a global cowork_config kv ('capabilityGateConfig'), following
 * the memory-policy row convention — one fleet-wide cost knob, not a per-bot
 * policy (per-bot would add surface for a knob no one has asked to split).
 * ONLY the panel count is configurable: the prospective post-origin citation
 * rule is a data-leak guard and stays unconditionally on — the persisted
 * shape carries no prospective field at all.
 *
 * Covers:
 *   1. config parse/round-trip: default 2, set 1, garbage → 2, panels 3 → 2,
 *      and the persisted shape never carries a prospective switch,
 *   2. single-panel path: persisted panels=1 → one validation call,
 *      telemetry records panelsUsed: 1,
 *   3. dual-panel default unchanged: no config → two calls, panelsUsed: 2,
 *   4. precedence: an explicit deps.capabilityGate test override still wins
 *      over the persisted knob.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

const { DreamStore } = require('../dist-electron/main/dreamStore.js');

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

const DAY = '2026-08-02';
const DAY_START = new Date(2026, 7, 2).getTime();
const LONG_IDENTITY = `我是一个认真严谨的 MetaBot。${'我先验证再交付。'.repeat(30)}`;

const metabotStoreStub = () => ({
  listMetabots: () => [
    { id: 5, name: '小火', role: '视频创作者', soul: '认真严谨', llm_id: 'bot-own-llm', enabled: true },
  ],
});

const seedDraftAndSession = (coworkStore, db) => {
  coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
    { title: '先验证再交付', description: '交付前自己验证一遍', capabilityType: 'workflow' },
  ]);
  const session = coworkStore.createSession('和用户聊发布', '/tmp/a', '', 'local', [], 5);
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['m1', session.id, 'user', '视频做好了吗', '{}', DAY_START + 1000, 1],
  );
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['m2', session.id, 'assistant', '做好了,你看下', '{}', DAY_START + 2000, 2],
  );
};

const makeValidationResponder = (calls) => async (system, user) => {
  if (system.includes('能力验证')) {
    calls.push({ user });
    const ids = [...user.matchAll(/草案 #(\d+)/g)].map((match) => Number(match[1]));
    return JSON.stringify({
      verdicts: ids.map((id) => ({ id, verdict: 'rejected', score: 0.2, rationale: '证据不足' })),
    });
  }
  return JSON.stringify({
    daily_summary: '今天复盘了自己的薄弱点。',
    sections: {},
    work_reviews: [],
    important_memories: [],
    value_lessons: [],
    self_identity: LONG_IDENTITY,
    capability_learnings: [],
  });
};

test('config: default 2 panels, round-trip, garbage falls back, no prospective switch', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    assert.deepEqual(coworkStore.getCapabilityGateConfig(), { panels: 2 }, 'default unchanged');

    assert.deepEqual(coworkStore.setCapabilityGateConfig({ panels: 1 }), { panels: 1 });
    assert.deepEqual(coworkStore.getCapabilityGateConfig(), { panels: 1 });
    coworkStore.setCapabilityGateConfig({ panels: 2 });
    assert.deepEqual(coworkStore.getCapabilityGateConfig(), { panels: 2 });

    // Out-of-range values clamp to the valid set.
    coworkStore.setCapabilityGateConfig({ panels: 3 });
    assert.deepEqual(coworkStore.getCapabilityGateConfig(), { panels: 2 }, 'invalid input clamps to 2');

    // A hand-corrupted row falls back to the default.
    db.run(
      `INSERT INTO cowork_config (key, value, updated_at) VALUES ('capabilityGateConfig', 'not json', 1)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    assert.deepEqual(coworkStore.getCapabilityGateConfig(), { panels: 2 }, 'garbage JSON falls back');

    // Even a hand-crafted row CANNOT carry the prospective switch — the
    // persisted shape is panels-only (the anti-leak guard is not optional).
    db.run(
      `INSERT INTO cowork_config (key, value, updated_at) VALUES ('capabilityGateConfig', ?, 1)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify({ panels: 1, prospective: false })],
    );
    assert.deepEqual(coworkStore.getCapabilityGateConfig(), { panels: 1 }, 'prospective is dropped from the persisted shape');
  } finally {
    cleanup();
  }
});

test('persisted panels=1: one validation call, telemetry records panelsUsed 1', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  try {
    seedDraftAndSession(coworkStore, db);
    coworkStore.setCapabilityGateConfig({ panels: 1 });
    const calls = [];
    const service = new DreamService({
      coworkStore,
      metabotStore: metabotStoreStub(),
      dreamStore,
      llmTimeoutMs: 5000,
      now: () => new Date(2026, 7, 3, 3, 0),
      performChat: makeValidationResponder(calls),
    });
    await service.runNow(5, DAY);
    assert.equal(calls.length, 1, 'single-panel gate calls the model once');
    const telemetry = dreamStore.getRun(5, DAY).telemetry;
    assert.equal(telemetry.validation.panelsUsed, 1, 'telemetry records the actual panel count');
    assert.equal(telemetry.validation.checked, 1);
  } finally {
    cleanup();
  }
});

test('default (no config): two validation calls, panelsUsed 2 — behavior unchanged', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  try {
    seedDraftAndSession(coworkStore, db);
    const calls = [];
    const service = new DreamService({
      coworkStore,
      metabotStore: metabotStoreStub(),
      dreamStore,
      llmTimeoutMs: 5000,
      now: () => new Date(2026, 7, 3, 3, 0),
      performChat: makeValidationResponder(calls),
    });
    await service.runNow(5, DAY);
    assert.equal(calls.length, 2, 'dual-panel gate calls the model twice (panel B sees drafts reversed)');
    const telemetry = dreamStore.getRun(5, DAY).telemetry;
    assert.equal(telemetry.validation.panelsUsed, 2, 'telemetry records the actual panel count');
  } finally {
    cleanup();
  }
});

test('precedence: an explicit deps.capabilityGate override wins over the persisted knob', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  try {
    seedDraftAndSession(coworkStore, db);
    coworkStore.setCapabilityGateConfig({ panels: 1 });
    const calls = [];
    const service = new DreamService({
      coworkStore,
      metabotStore: metabotStoreStub(),
      dreamStore,
      llmTimeoutMs: 5000,
      now: () => new Date(2026, 7, 3, 3, 0),
      capabilityGate: { panels: 2 },
      performChat: makeValidationResponder(calls),
    });
    await service.runNow(5, DAY);
    assert.equal(calls.length, 2, 'deps override wins over persisted panels=1');
    assert.equal(dreamStore.getRun(5, DAY).telemetry.validation.panelsUsed, 2);
  } finally {
    cleanup();
  }
});
