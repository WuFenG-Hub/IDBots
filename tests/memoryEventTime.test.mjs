import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { createCoworkStore, createLegacyMemoryDb, createSqliteStore, getColumns, getRow } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);
function loadCompiled(modulePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') return { app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() } };
    return originalLoad.call(this, request, ...rest);
  };
  try { return require(modulePath); } finally { Module._load = originalLoad; }
}
const { parseTurnMemoryExtractionPayload } = loadCompiled('../dist-electron/main/libs/coworkMemoryJudge.js');
const OWNER = { scopeKind: 'owner', scopeKey: 'owner:self' };
const DAY = (iso) => Date.parse(`${iso}T00:00:00.000Z`);

test('schema: occurred_at migrates idempotently (fresh + legacy), rows default NULL', async () => {
  const fresh = await createSqliteStore();
  try {
    createCoworkStore(fresh.db);
    assert.ok(getColumns(fresh.db, 'user_memories').includes('occurred_at'));
  } finally { fresh.cleanup(); }
  const legacy = await createLegacyMemoryDb();
  createCoworkStore(legacy);
  createCoworkStore(legacy);
  assert.equal(getColumns(legacy, 'user_memories').filter((c) => c === 'occurred_at').length, 1);
});

test('writes persist occurredAt; first event time wins across restatements and merges', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const created = store.createUserMemory({
      metabotId: 1, text: '用户 3 月入职了新公司', ...OWNER,
      occurredAt: '2026-03-15',
      source: { role: 'user', quote: '3 月 15 号入职' },
    });
    assert.equal(created.occurredAt, DAY('2026-03-15'), 'YYYY-MM-DD resolves to UTC epoch');

    // Same-fingerprint restatement with a different date keeps the first event time.
    const revived = store.createUserMemory({
      metabotId: 1, text: '用户 3 月入职了新公司', ...OWNER, occurredAt: '2026-06-01',
    });
    assert.equal(revived.id, created.id);
    assert.equal(revived.occurredAt, DAY('2026-03-15'), 'COALESCE keeps the first-seen event time');

    // A pre-migration NULL row gets backfilled by the next write that carries a date.
    const legacyRow = store.createUserMemory({ metabotId: 1, text: '用户开始学习 Rust', ...OWNER, forceNew: true });
    assert.equal(legacyRow.occurredAt, null);
    const filled = store.createUserMemory({ metabotId: 1, text: '用户开始学习 Rust', ...OWNER, occurredAt: DAY('2026-10-01') });
    assert.equal(filled.id, legacyRow.id);
    assert.equal(filled.occurredAt, DAY('2026-10-01'));

    // Malformed / absurd dates are dropped, not written.
    const bad = store.createUserMemory({ metabotId: 1, text: '用户去了未来', ...OWNER, occurredAt: '2999-01-01' });
    assert.equal(bad.occurredAt, null);
    const bad2 = store.createUserMemory({ metabotId: 1, text: '格式错误的日期', ...OWNER, occurredAt: '15/03/2026' });
    assert.equal(bad2.occurredAt, null);
  } finally { cleanup(); }
});

test('dream writes carry the dreamed day as event time; cross-night merge backfills only NULL', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const night1 = store.createDreamUserMemory({
      metabotId: 1, text: '付费写链授权是硬规则:先取得人类明确授权,绝不垫付', ...OWNER,
      usageClass: 'value_boundary', origin: 'dream', isExplicit: true,
      occurredAt: '2026-10-20',
      source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: '2026-10-20' },
    });
    assert.equal(night1.memory.occurredAt, DAY('2026-10-20'));
    // Night 2 restates the same rule: stored event time survives.
    const night2 = store.createDreamUserMemory({
      metabotId: 1, text: '付费写链授权是硬规则:先取得人类明确授权,绝不垫付,也不代签', ...OWNER,
      usageClass: 'value_boundary', origin: 'dream', isExplicit: true,
      occurredAt: '2026-10-21',
      source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: '2026-10-21' },
    });
    assert.equal(night2.memory.id, night1.memory.id);
    assert.equal(night2.memory.occurredAt, DAY('2026-10-20'), 'merge keeps the earliest event time');
    // Pre-migration NULL row merged by a dream write gets backfilled.
    const oldRow = store.createDreamUserMemory({
      metabotId: 1, text: '用户喜欢先看摘要再读全文', ...OWNER,
      usageClass: 'profile_fact', origin: 'dream', isExplicit: true,
      source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: '2026-10-01' },
    });
    db.run('UPDATE user_memories SET occurred_at = NULL WHERE id = ?', [oldRow.memory.id]);
    const merged = store.createDreamUserMemory({
      metabotId: 1, text: '用户喜欢先看摘要再读全文,长文只要要点', ...OWNER,
      usageClass: 'profile_fact', origin: 'dream', isExplicit: true,
      occurredAt: '2026-10-22',
      source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: '2026-10-22' },
    });
    assert.equal(merged.memory.id, oldRow.memory.id);
    assert.equal(merged.memory.occurredAt, DAY('2026-10-22'), 'COALESCE backfills a NULL event time');
  } finally { cleanup(); }
});

test('turn-extraction parser carries a validated occurred_on and drops malformed values', () => {
  const payload = JSON.stringify({ changes: [
    { action: 'add', text: '用户上周五搬到了杭州', is_explicit: false, occurred_on: '2026-10-16' },
    { action: 'add', text: ' timeless fact without date', is_explicit: false },
    { action: 'add', text: 'malformed date', is_explicit: false, occurred_on: '上周五' },
    { action: 'delete', text: '忘记旧的偏好', is_explicit: true, occurred_on: '2026-10-16' },
  ]});
  const changes = parseTurnMemoryExtractionPayload(payload);
  // The 3rd implicit add is dropped by the judge's 2-add cap — by design.
  assert.deepEqual(changes?.map((c) => c.occurredOn ?? null), ['2026-10-16', null, '2026-10-16']);
  assert.equal(changes?.[1].occurredOn, undefined, 'absent field stays undefined');
});

test('recency boost is bounded (+10% / -8%), neutral without event time, and only reorders', () => {
  const { memoryRecencyBoost } = loadCompiled('../dist-electron/main/memory/memoryEvidence.js');
  const { buildScopedMemoryPromptBlocksDetailed } = loadCompiled('../dist-electron/main/memory/memoryPromptBlocks.js');
  const now = Date.UTC(2026, 9, 24);
  assert.equal(memoryRecencyBoost(null, now), 1);
  assert.equal(memoryRecencyBoost(undefined, now), 1);
  assert.ok(Math.abs(memoryRecencyBoost(now, now) - 1.10) < 1e-9, 'today = +10%');
  assert.ok(Math.abs(memoryRecencyBoost(now - 182.5 * 86_400_000, now) - 1.0) < 1e-9, 'half a year = neutral');
  assert.ok(Math.abs(memoryRecencyBoost(now - 5 * 365 * 86_400_000, now) - 0.92) < 1e-9, 'years ago floors at -8%');
  assert.ok(memoryRecencyBoost(now + 86_400_000, now) <= 1.10, 'future dates never exceed the cap');

  const recent = Date.now() - 86_400_000;
  const old = Date.now() - 3 * 365 * 86_400_000;
  const { injectedIds } = buildScopedMemoryPromptBlocksDetailed({
    channel: 'cowork_ui',
    ownerEntries: [
      { id: 'old', text: 'owner moved to shanghai', usageClass: 'profile_fact', visibility: 'local_only', updatedAt: 1, occurredAt: old },
      { id: 'recent', text: 'owner moved to hangzhou', usageClass: 'profile_fact', visibility: 'local_only', updatedAt: 1, occurredAt: recent },
      { id: 'undated', text: 'owner moved to suzhou', usageClass: 'profile_fact', visibility: 'local_only', updatedAt: 1 },
    ],
    currentUserText: 'unrelated question',
  });
  assert.deepEqual(injectedIds, ['recent', 'undated', 'old'], 'recent > undated(neutral) > old at equal relevance');

  const hit = buildScopedMemoryPromptBlocksDetailed({
    channel: 'cowork_ui',
    ownerEntries: [
      { id: 'relevant-old', text: 'deployment runs on wednesday', usageClass: 'profile_fact', visibility: 'local_only', updatedAt: 1, occurredAt: old },
      { id: 'irrelevant-recent', text: 'owner likes tea', usageClass: 'preference', visibility: 'local_only', updatedAt: 1, occurredAt: recent },
    ],
    currentUserText: 'deployment schedule',
  });
  assert.equal(hit.injectedIds[0], 'relevant-old', 'a token hit (+3) still beats a +10% recency nudge');
});

test('deep-consolidation inventory renders occurred dates and the prompt tells the model to use them', () => {
  const { buildDeepConsolidationPrompt } = loadCompiled('../dist-electron/main/libs/deepConsolidationPrompt.js');
  const prompt = buildDeepConsolidationPrompt({
    botName: 'Twin',
    items: [
      ...Array.from({ length: 8 }, (_, i) => ({ id: `b${i}`, kind: 'value_boundary', text: `rule ${i}` })),
      { id: 'f1', kind: 'profile_fact', text: '老板偏好周五发版', origin: 'dream', rewritable: true, proofCount: 2, occurred: '2026-09-05', firstSeen: '2026-09-06', lastSeen: '2026-10-20' },
    ],
  });
  assert.ok(prompt.includes('[origin=dream, proof=2, occurred=2026-09-05, first=2026-09-06, last=2026-10-20]'), 'occurred renders before first/last');
  assert.ok(prompt.includes('use occurred=YYYY-MM-DD (when the fact happened)'), 'narratives are told to use real event dates');
});
