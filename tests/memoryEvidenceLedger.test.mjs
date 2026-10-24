import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

import {
  createCoworkStore,
  createLegacyMemoryDb,
  createSqliteStore,
  getColumns,
  getIndexNames,
  getRow,
} from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

function loadCompiled(modulePath) {
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
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

const {
  MEMORY_EVIDENCE_QUOTE_MAX_CHARS,
  MEMORY_REVISIONS_KEEP_PER_MEMORY,
  normalizeMemoryQuote,
  pickEvidenceQuote,
  splitEvidenceSentences,
} = loadCompiled('../dist-electron/main/memory/memoryEvidence.js');
const { parseDreamOutput } = loadCompiled('../dist-electron/main/libs/dreamPrompt.js');

const OWNER = { scopeKind: 'owner', scopeKey: 'owner:self' };

const countRows = (db, sql, params = []) => Number(getRow(db, sql, params)?.n ?? 0);

test('evidence helpers: sentence split, supporting-sentence pick, quote cap', () => {
  assert.deepEqual(
    splitEvidenceSentences('我最近搬家了。记住:我住在杭州\n周末想去西湖！版本 v1.2 还在测. Next line.'),
    ['我最近搬家了。', '记住:我住在杭州', '周末想去西湖！', '版本 v1.2 还在测.', 'Next line.'],
    'CJK/ASCII terminators and line breaks split; an inner period (v1.2) does not',
  );

  assert.equal(
    pickEvidenceQuote('我最近搬家了。记住:我住在杭州。周末想去西湖。', '我住在杭州'),
    '记住:我住在杭州。',
    'the sentence that supports the memory wins over neighbours',
  );
  assert.equal(
    pickEvidenceQuote('Alice joined Google last spring. She was thrilled about research. Bob stayed home.', 'Alice works at Google'),
    'Alice joined Google last spring.',
  );
  assert.equal(
    pickEvidenceQuote('完全无关的一句话。另一句也无关。', '用户喜欢周五发版'),
    '完全无关的一句话。',
    'no overlap falls back to the opening sentence instead of dropping the evidence',
  );
  assert.equal(pickEvidenceQuote('', '任何记忆'), null);
  assert.equal(pickEvidenceQuote(null, '任何记忆'), null);

  const long = 'x'.repeat(MEMORY_EVIDENCE_QUOTE_MAX_CHARS + 40);
  const capped = normalizeMemoryQuote(`  ${long}  `);
  assert.equal(capped.length, MEMORY_EVIDENCE_QUOTE_MAX_CHARS);
  assert.ok(capped.endsWith('…'));
  assert.equal(normalizeMemoryQuote('   '), null);
  assert.equal(normalizeMemoryQuote('a  b\n c'), 'a b c', 'whitespace collapses');
});

test('schema: fresh store has the quote column and the revisions table; legacy DB migrates idempotently', async () => {
  const fresh = await createSqliteStore();
  try {
    createCoworkStore(fresh.db);
    assert.ok(getColumns(fresh.db, 'user_memory_sources').includes('quote'));
    assert.ok(getColumns(fresh.db, 'user_memory_revisions').includes('previous_text'));
    assert.ok(getIndexNames(fresh.db, 'user_memory_revisions').includes('idx_user_memory_revisions_memory'));
  } finally {
    fresh.cleanup();
  }

  const legacyDb = await createLegacyMemoryDb();
  assert.ok(!getColumns(legacyDb, 'user_memory_sources').includes('quote'), 'legacy fixture predates the column');
  createCoworkStore(legacyDb);
  assert.ok(getColumns(legacyDb, 'user_memory_sources').includes('quote'), 'ALTER adds the column on first run');
  assert.ok(getColumns(legacyDb, 'user_memory_revisions').includes('reason'), 'table is created on first run');
  // Second construction over the same database must be a no-op.
  createCoworkStore(legacyDb);
  assert.equal(getColumns(legacyDb, 'user_memory_sources').filter((column) => column === 'quote').length, 1);
});

test('writes persist the source quote; evidence summary counts proofs and lists newest distinct quotes', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const created = store.createUserMemory({
      metabotId: 1,
      text: '用户住在杭州',
      ...OWNER,
      source: { role: 'user', sourceType: 'turn_explicit', quote: '  记住:我住在杭州  ' },
    });
    assert.equal(getRow(db, 'SELECT quote FROM user_memory_sources WHERE memory_id = ?', [created.id]).quote, '记住:我住在杭州');

    // Same fingerprint restatement: corroboration adds a provenance row (and
    // its quote) without changing the stored wording.
    store.createUserMemory({
      metabotId: 1,
      text: '用户住在杭州',
      ...OWNER,
      source: { role: 'user', sourceType: 'turn_llm', quote: '我现在住杭州西湖区' },
    });
    // A quote-less write still counts as proof.
    store.createUserMemory({ metabotId: 1, text: '用户住在杭州', ...OWNER, source: { role: 'user', sourceType: 'turn_implicit' } });

    const evidence = store.listUserMemoryEvidence([created.id, 'missing-id']);
    assert.deepEqual(evidence.get(created.id), {
      proofCount: 3,
      quotes: ['我现在住杭州西湖区', '记住:我住在杭州'],
    }, 'newest first, quote-less rows counted but not listed');
    assert.deepEqual(evidence.get('missing-id'), { proofCount: 0, quotes: [] }, 'unknown ids map to an empty summary');
    assert.deepEqual(store.listUserMemoryEvidence([created.id], { maxQuotes: 1 }).get(created.id).quotes, ['我现在住杭州西湖区']);
    assert.equal(store.listUserMemoryRevisions(created.id).length, 0, 'an unchanged wording records no revision');
  } finally {
    cleanup();
  }
});

test('near-duplicate revive that changes the wording records a near_duplicate_merge revision', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const original = store.createUserMemory({
      metabotId: 1,
      text: '用户偏好周五发布版本',
      ...OWNER,
      source: { role: 'user', sourceType: 'turn_implicit', quote: '我们一般周五发版' },
    });
    const merged = store.createUserMemory({
      metabotId: 1,
      text: '用户偏好周五发布版本,因为周末有缓冲时间处理回滚',
      ...OWNER,
      source: { role: 'user', sourceType: 'turn_llm', quote: '周五发版是因为周末能缓冲回滚' },
    });
    assert.equal(merged.id, original.id, 'semantic near-duplicate revives the existing row');
    assert.notEqual(merged.text, original.text, 'the richer wording replaced the stored text');

    const revisions = store.listUserMemoryRevisions(original.id);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].previousText, '用户偏好周五发布版本');
    assert.equal(revisions[0].newText, merged.text);
    assert.equal(revisions[0].reason, 'near_duplicate_merge');
    assert.equal(revisions[0].sourceType, 'turn_llm');
    assert.equal(store.listUserMemoryEvidence([original.id]).get(original.id).proofCount, 2);
  } finally {
    cleanup();
  }
});

test('dream cross-night merge records a dream_cross_night_merge revision only when the wording is replaced', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const night1 = store.createDreamUserMemory({
      metabotId: 1,
      text: '付费写链授权是硬规则:任何付费服务的链上写操作必须先取得人类明确授权',
      ...OWNER,
      usageClass: 'value_boundary',
      origin: 'dream',
      isExplicit: true,
      source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: '2026-10-20', quote: '10/20 订单里差点代签' },
    });
    // Night 2: same rule, slightly reworded but NOT >=30% longer — the stored
    // wording wins, so this is corroboration, not a revision.
    const night2 = store.createDreamUserMemory({
      metabotId: 1,
      text: '付费写链授权是硬规则:付费服务的链上写操作必须先取得人类明确授权',
      ...OWNER,
      usageClass: 'value_boundary',
      origin: 'dream',
      isExplicit: true,
      source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: '2026-10-21', quote: '10/21 再次确认授权流程' },
    });
    assert.equal(night2.merged, true);
    assert.equal(night2.memory.id, night1.memory.id);
    assert.equal(store.listUserMemoryRevisions(night1.memory.id).length, 0, 'stored wording kept → no revision');

    // Night 3: materially richer wording (>=1.3x) replaces the text.
    const night3 = store.createDreamUserMemory({
      metabotId: 1,
      text: '付费写链授权是硬规则:任何付费服务的链上写操作必须先取得人类明确授权,绝不垫付,也不许代签,拿不到授权就停下来问',
      ...OWNER,
      usageClass: 'value_boundary',
      origin: 'dream',
      isExplicit: true,
      source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: '2026-10-22', quote: '10/22 用户明确说不许代签' },
    });
    assert.equal(night3.merged, true);
    assert.equal(night3.memory.id, night1.memory.id);
    const revisions = store.listUserMemoryRevisions(night1.memory.id);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].reason, 'dream_cross_night_merge');
    assert.equal(revisions[0].previousText, night1.memory.text);
    assert.equal(revisions[0].newText, night3.memory.text);

    const evidence = store.listUserMemoryEvidence([night1.memory.id]).get(night1.memory.id);
    assert.equal(evidence.proofCount, 3, 'one provenance row per night');
    assert.deepEqual(evidence.quotes, ['10/22 用户明确说不许代签', '10/21 再次确认授权流程', '10/20 订单里差点代签']);
  } finally {
    cleanup();
  }
});

test('owner edits record user_edit revisions, protected updates record protected_update, history is bounded', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const memory = store.createUserMemory({ metabotId: 1, text: '用户喜欢简洁回复', ...OWNER });
    const edited = store.updateUserMemory({ id: memory.id, metabotId: 1, ...OWNER, text: '用户喜欢简洁、要点式的回复' });
    assert.equal(edited.text, '用户喜欢简洁、要点式的回复');
    let revisions = store.listUserMemoryRevisions(memory.id);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].reason, 'user_edit');
    assert.equal(revisions[0].previousText, '用户喜欢简洁回复');

    // A status-only update keeps the wording → no revision.
    store.updateUserMemory({ id: memory.id, metabotId: 1, ...OWNER, status: 'stale' });
    assert.equal(store.listUserMemoryRevisions(memory.id).length, 1);

    // History keeps only the newest N rows per memory.
    for (let index = 0; index < MEMORY_REVISIONS_KEEP_PER_MEMORY + 3; index += 1) {
      store.updateUserMemory({ id: memory.id, metabotId: 1, ...OWNER, text: `用户喜欢简洁回复 v${index}` });
    }
    revisions = store.listUserMemoryRevisions(memory.id, 100);
    assert.equal(revisions.length, MEMORY_REVISIONS_KEEP_PER_MEMORY);
    assert.equal(revisions[0].newText, `用户喜欢简洁回复 v${MEMORY_REVISIONS_KEEP_PER_MEMORY + 2}`, 'newest first');
    assert.equal(
      countRows(db, 'SELECT COUNT(*) AS n FROM user_memory_revisions WHERE memory_id = ?', [memory.id]),
      MEMORY_REVISIONS_KEEP_PER_MEMORY,
      'pruning is physical, not just a list cap',
    );

    // Protected rows (self_identity) rewritten by the dream service.
    const identity = store.createUserMemory({
      metabotId: 1,
      text: '我是一个专注交付、先验证再承诺的 MetaBot。'.repeat(6),
      ...OWNER,
      usageClass: 'self_identity',
      origin: 'dream',
    });
    assert.equal(store.updateUserMemory({ id: identity.id, metabotId: 1, ...OWNER, text: '改写尝试' }), null, 'unprotected edit refused');
    store.updateUserMemory({ id: identity.id, metabotId: 1, ...OWNER, text: '我是一个专注交付的 MetaBot,今天学会了先问再做。'.repeat(5), allowProtected: true });
    const identityRevisions = store.listUserMemoryRevisions(identity.id);
    assert.equal(identityRevisions.length, 1);
    assert.equal(identityRevisions[0].reason, 'protected_update');
  } finally {
    cleanup();
  }
});

test('rewriteUserMemoryText: evolution rewrite is guarded, reversible via revision, and never touches self_identity', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const belief = store.createUserMemory({
      metabotId: 1,
      text: '老板偏好周五发版',
      ...OWNER,
      usageClass: 'profile_fact',
      origin: 'dream',
      forceNew: true,
    });
    const snapshotAt = Date.now() + 1_000;

    assert.equal(
      store.rewriteUserMemoryText({ id: belief.id, metabotId: 1, text: '老板偏好周五发版', reason: 'evolution_rewrite' }),
      false,
      'identical wording is not a rewrite',
    );
    assert.equal(
      store.rewriteUserMemoryText({ id: belief.id, metabotId: 1, text: '   ', reason: 'evolution_rewrite' }),
      false,
      'empty text is refused',
    );
    assert.equal(
      store.rewriteUserMemoryText({
        id: belief.id,
        metabotId: 1,
        text: '老板曾偏好周五发版(10月前),10月起改为周三发版,周五只做热修',
        reason: 'evolution_rewrite',
        sourceType: 'deep_consolidation',
        notUsedSince: snapshotAt,
      }),
      true,
    );
    const rewritten = store.listUserMemories({ metabotId: 1, ...OWNER, status: 'created' }).find((entry) => entry.id === belief.id);
    assert.equal(rewritten.text, '老板曾偏好周五发版(10月前),10月起改为周三发版,周五只做热修');
    assert.equal(rewritten.importance, belief.importance, 'importance is untouched by a rewrite');
    const revisions = store.listUserMemoryRevisions(belief.id);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].reason, 'evolution_rewrite');
    assert.equal(revisions[0].sourceType, 'deep_consolidation');
    assert.equal(revisions[0].previousText, '老板偏好周五发版', 'the replaced wording survives for reversal');

    // notUsedSince guard: a row touched after the proposal snapshot is skipped.
    db.run('UPDATE user_memories SET last_used_at = ? WHERE id = ?', [snapshotAt + 5_000, belief.id]);
    assert.equal(
      store.rewriteUserMemoryText({ id: belief.id, metabotId: 1, text: '更新后的叙事', reason: 'evolution_rewrite', notUsedSince: snapshotAt }),
      false,
      'touched during the LLM window → refused',
    );

    // Archived rows are not rewrite targets.
    db.run('UPDATE user_memories SET last_used_at = NULL, archived_at = ? WHERE id = ?', [Date.now(), belief.id]);
    assert.equal(store.rewriteUserMemoryText({ id: belief.id, metabotId: 1, text: '更新后的叙事', reason: 'evolution_rewrite' }), false);

    // self_identity is never rewritten through this channel.
    const identity = store.createUserMemory({
      metabotId: 1,
      text: '我是一个专注交付、先验证再承诺的 MetaBot。'.repeat(6),
      ...OWNER,
      usageClass: 'self_identity',
      origin: 'dream',
    });
    assert.equal(store.rewriteUserMemoryText({ id: identity.id, metabotId: 1, text: '被改写的身份', reason: 'evolution_rewrite' }), false);
    assert.equal(store.listUserMemoryRevisions(identity.id).length, 0);
  } finally {
    cleanup();
  }
});

test('tombstone purge removes a memory\'s revisions along with its sources', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const memory = store.createUserMemory({ metabotId: 1, text: 'aged tombstone', ...OWNER, forceNew: true });
    store.updateUserMemory({ id: memory.id, metabotId: 1, ...OWNER, text: 'aged tombstone, reworded' });
    assert.equal(store.listUserMemoryRevisions(memory.id).length, 1);
    assert.equal(store.deleteUserMemory(memory.id, 1), true);
    const now = Date.now();
    db.run('UPDATE user_memories SET updated_at = ? WHERE id = ?', [now - 400 * 86_400_000, memory.id]);

    assert.equal(store.purgeDeletedMemoryTombstones({ cutoffMs: now - 365 * 86_400_000 }), 1);
    assert.equal(getRow(db, 'SELECT id FROM user_memories WHERE id = ?', [memory.id]), null);
    assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM user_memory_sources WHERE memory_id = ?', [memory.id]), 0);
    assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM user_memory_revisions WHERE memory_id = ?', [memory.id]), 0);
  } finally {
    cleanup();
  }
});

test('turn path: an explicit remember-command stores the supporting sentence as the quote', async () => {
  const { SqliteStore } = loadCompiled('../dist-electron/main/sqliteStore.js');
  const { CoworkStore } = loadCompiled('../dist-electron/main/coworkStore.js');
  const store = await SqliteStore.create(fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-memory-evidence-turn-')));
  try {
    const db = store.getDatabase();
    db.run(
      'INSERT INTO metabot_wallets (id, mnemonic, path, created_at) VALUES (?, ?, ?, ?)',
      [1, 'abandon ability able about above absent absorb abstract absurd abuse access accident', "m/44'/10001'/0'/0/0", 1700000000000],
    );
    db.run(
      `INSERT INTO metabots (
        id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
        name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
        boss_global_metaid, llm_id, allow_chat_skills, bio, goal, created_at, updated_at
      ) VALUES (1, 1, 'mvc-1', 'btc-1', 'doge-1', 'pk-1', 'cpk-1',
        'Twin Bot', 1, 'metaid-1', 'gmid-twin', 'twin', '0000', 'role', 'soul',
        'gmid-owner', NULL, '[]', NULL, NULL, 1700000000000, 1700000000000)`,
    );
    const coworkStore = new CoworkStore(db, () => {});
    const session = coworkStore.createSession('Evidence test', os.tmpdir(), '', 'local', [], 1);
    const result = await coworkStore.applyTurnMemoryUpdates({
      sessionId: session.id,
      // The explicit extractor keeps facts of >= 6 chars; the command line is
      // one sentence among three so the picker has neighbours to beat.
      userText: '我最近搬家了。\n记住:我现在住在杭州西湖区,离公司很近\n周末想去西湖玩。',
      assistantText: '好的,已记住你住在杭州西湖区。',
      // Explicit channel only: with implicit adds on, the profile regex also
      // extracts the same fact and merges a second provenance row into this
      // memory, which is correct but not what this test isolates.
      implicitEnabled: false,
      memoryLlmJudgeEnabled: false,
      // The rule judge scores this fact 0.56 ("neutral"): borderline under
      // the standard explicit bar (0.6, where the live app would consult the
      // LLM), accepted under relaxed (0.52) — deterministic without an LLM.
      guardLevel: 'relaxed',
      userMessageId: 'u-1',
      assistantMessageId: 'a-1',
    });
    assert.equal(result.created, 1);
    const memory = coworkStore.listUserMemories({ metabotId: 1, ...OWNER, status: 'created' })[0];
    assert.equal(memory.text, '我现在住在杭州西湖区,离公司很近');
    const evidence = coworkStore.listUserMemoryEvidence([memory.id]).get(memory.id);
    assert.equal(evidence.proofCount, 1, 'explicit commands add only the user source row');
    assert.deepEqual(
      evidence.quotes,
      ['记住:我现在住在杭州西湖区,离公司很近'],
      'the sentence carrying the command is the evidence, not the whole message',
    );
  } finally {
    store.close();
  }
});

test('dream output parser carries important_memories evidence alongside the string list', () => {
  const payload = {
    daily_summary: '今天和用户敲定了发布计划。',
    important_memories: [
      { text: '用户偏好周五发布', source: '用户说"我们一直周五发版,周末好回滚"' },
      '对象形态也要支持',
      { text: '带 evidence 别名', evidence: '旧字段名也接受' },
      { text: '   ', source: 'empty text is dropped' },
    ],
  };
  const result = parseDreamOutput(JSON.stringify(payload));
  assert.equal(result.ok, true);
  assert.deepEqual(result.output.importantMemories, ['用户偏好周五发布', '对象形态也要支持', '带 evidence 别名']);
  assert.deepEqual(result.output.importantMemoryItems, [
    { text: '用户偏好周五发布', source: '用户说"我们一直周五发版,周末好回滚"' },
    { text: '对象形态也要支持', source: null },
    { text: '带 evidence 别名', source: '旧字段名也接受' },
  ]);
});

test('proofCountBoost is neutral at one source, monotonic, and capped at +5%; listUserMemories carries proofCount', async () => {
  const { proofCountBoost, MEMORY_PROOF_BOOST_ALPHA } = loadCompiled('../dist-electron/main/memory/memoryEvidence.js');
  assert.equal(MEMORY_PROOF_BOOST_ALPHA, 0.1);
  assert.equal(proofCountBoost(undefined), 1);
  assert.equal(proofCountBoost(0), 1);
  assert.equal(proofCountBoost(1), 1);
  assert.ok(Math.abs(proofCountBoost(3) - 1.011) < 0.001, `3 sources ≈ +1.1% (got ${proofCountBoost(3)})`);
  assert.ok(Math.abs(proofCountBoost(10) - 1.023) < 0.001, `10 sources ≈ +2.3% (got ${proofCountBoost(10)})`);
  assert.ok(proofCountBoost(10) > proofCountBoost(3) && proofCountBoost(3) > proofCountBoost(1), 'monotonic');
  assert.equal(proofCountBoost(1_000_000), 1 + MEMORY_PROOF_BOOST_ALPHA * 0.5, 'saturates at +5%');

  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const corroborated = store.createUserMemory({ metabotId: 1, text: '用户常用 pnpm 管理依赖', ...OWNER, source: { role: 'user', quote: 'q1' } });
    store.createUserMemory({ metabotId: 1, text: '用户常用 pnpm 管理依赖', ...OWNER, source: { role: 'user', quote: 'q2' } });
    const single = store.createUserMemory({ metabotId: 1, text: '用户的时区是上海', ...OWNER });
    const listed = store.listUserMemories({ metabotId: 1, ...OWNER, status: 'created' });
    assert.equal(listed.find((entry) => entry.id === corroborated.id).proofCount, 2);
    assert.equal(listed.find((entry) => entry.id === single.id).proofCount, 1);
  } finally {
    cleanup();
  }
});
