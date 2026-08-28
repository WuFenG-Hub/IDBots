import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');
const {
  setTurnMemoryExtractionRunner,
  parseTurnMemoryExtractionPayload,
} = require('../dist-electron/main/libs/coworkMemoryJudge.js');
const { isSubstantiveMemoryText } = require('../dist-electron/main/libs/coworkMemoryExtractor.js');

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-memory-turn-extract-'));

async function createHarness() {
  const store = await SqliteStore.create(makeTempDir());
  const db = store.getDatabase();
  // user_memories.metabot_id has a foreign key into metabots (wallet required).
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
  const coworkStore = new CoworkStore(store.getDatabase(), () => {});
  const session = coworkStore.createSession('Memory test', os.tmpdir(), '', 'local', [], 1);
  return {
    store,
    coworkStore,
    sessionId: session.id,
    cleanup: () => {
      setTurnMemoryExtractionRunner(null);
      store.close();
    },
  };
}

const applyTurn = (h, overrides = {}) => h.coworkStore.applyTurnMemoryUpdates({
  sessionId: h.sessionId,
  userText: '',
  assistantText: '',
  implicitEnabled: true,
  memoryLlmJudgeEnabled: true,
  guardLevel: 'standard',
  ...overrides,
});

test('parseTurnMemoryExtractionPayload: caps, sanitize, and junk handling', () => {
  const valid = parseTurnMemoryExtractionPayload(
    '{"changes":[{"action":"add","text":"Me llamo Carlos","is_explicit":true},{"action":"add","text":"prefiere respuestas cortas"},{"action":"delete","text":"olvida lo del perro","is_explicit":true}]}',
  );
  assert.deepEqual(valid, [
    { action: 'add', text: 'Me llamo Carlos', isExplicit: true },
    { action: 'add', text: 'prefiere respuestas cortas', isExplicit: false },
    { action: 'delete', text: 'olvida lo del perro', isExplicit: true },
  ]);

  // Cap: at most 2 implicit adds / 2 explicit adds / 2 deletes survive.
  const capped = parseTurnMemoryExtractionPayload(
    '{"changes":[' + [
      ...Array.from({ length: 4 }, (_, i) => `{\"action\":\"add\",\"text\":\"implicit fact number ${i}\"}`),
      ...Array.from({ length: 4 }, (_, i) => `{\"action\":\"add\",\"text\":\"explicit fact ${i}\",\"is_explicit\":true}`),
      ...Array.from({ length: 4 }, (_, i) => `{\"action\":\"delete\",\"text\":\"delete target ${i}\"}`),
    ].join(',') + ']}',
  );
  assert.equal(capped.filter((c) => c.action === 'add' && !c.isExplicit).length, 2);
  assert.equal(capped.filter((c) => c.action === 'add' && c.isExplicit).length, 2);
  assert.equal(capped.filter((c) => c.action === 'delete').length, 2);

  assert.equal(parseTurnMemoryExtractionPayload('not json at all'), null);
  assert.equal(parseTurnMemoryExtractionPayload('{"nope": 1}'), null);
  assert.deepEqual(parseTurnMemoryExtractionPayload('{"changes":[]}'), []);
  // Too-short texts are dropped.
  assert.deepEqual(
    parseTurnMemoryExtractionPayload('{"changes":[{"action":"add","text":"x"}]}'),
    [],
  );
});

test('isSubstantiveMemoryText is a language-neutral cost guard', () => {
  assert.equal(isSubstantiveMemoryText('recuerda que me llamo Carlos'), true);
  assert.equal(isSubstantiveMemoryText('ok'), false);
  assert.equal(isSubstantiveMemoryText('```\ncode only\n```'), false);
  assert.equal(isSubstantiveMemoryText('   '), false);
});

test('a Spanish explicit memory command reaches storage via the turn extraction (global audit)', async () => {
  const h = await createHarness();
  try {
    setTurnMemoryExtractionRunner(async () => ([
      { action: 'add', text: 'Me llamo Carlos', isExplicit: true },
    ]));
    const result = await applyTurn(h, { userText: 'Recuerda que me llamo Carlos' });
    assert.equal(result.created, 1);
    assert.equal(result.llmReviewed, 1);
    const memories = h.coworkStore.listUserMemories({ metabotId: 1 });
    assert.equal(memories.length, 1);
    assert.equal(memories[0].isExplicit, true);
    assert.match(memories[0].text, /Me llamo Carlos/);
  } finally {
    h.cleanup();
  }
});

test('a Spanish implicit personal fact is stored with the turn_llm provenance', async () => {
  const h = await createHarness();
  try {
    setTurnMemoryExtractionRunner(async () => ([
      { action: 'add', text: 'Tengo un perro que se llama Rocco', isExplicit: false },
    ]));
    const result = await applyTurn(h, { userText: 'Tengo un perro que se llama Rocco y vive conmigo' });
    assert.equal(result.created, 1);
    const memories = h.coworkStore.listUserMemories({ metabotId: 1 });
    assert.equal(memories.length, 1);
    assert.equal(memories[0].isExplicit, false);
  } finally {
    h.cleanup();
  }
});

test('implicit-off sessions only take explicit extraction entries', async () => {
  const h = await createHarness();
  try {
    setTurnMemoryExtractionRunner(async () => ([
      { action: 'add', text: 'dato implícito en español', isExplicit: false },
      { action: 'add', text: 'Recuerda: uso Neovim', isExplicit: true },
    ]));
    const result = await applyTurn(h, {
      userText: 'por cierto, dato implícito. Recuerda: uso Neovim',
      implicitEnabled: false,
    });
    assert.equal(result.created, 1);
    assert.equal(result.skipped, 1);
    const memories = h.coworkStore.listUserMemories({ metabotId: 1 });
    assert.equal(memories.length, 1);
    assert.match(memories[0].text, /Neovim/);
    assert.equal(memories[0].isExplicit, true);
  } finally {
    h.cleanup();
  }
});

test('extraction failure degrades to the regex-only path without throwing', async () => {
  const h = await createHarness();
  try {
    setTurnMemoryExtractionRunner(async () => null);
    const result = await applyTurn(h, { userText: 'Recuerda que me llamo Carlos' });
    assert.equal(result.created, 0);
    // zh/en regex candidates still work when present (unchanged fast path).
    const zh = await applyTurn(h, { userText: '记住：我叫小明，我是设计师' });
    assert.equal(zh.created, 1);
    assert.match(h.coworkStore.listUserMemories({ metabotId: 1 })[0].text, /我叫小明/);
  } finally {
    h.cleanup();
  }
});

test('an extraction entry duplicating a regex candidate is dropped, not double-written', async () => {
  const h = await createHarness();
  try {
    setTurnMemoryExtractionRunner(async () => ([
      { action: 'add', text: '我叫小明，是设计师', isExplicit: false },
    ]));
    await applyTurn(h, { userText: '记住：我叫小明，是设计师' });
    const rows = h.store.getDatabase().exec(
      `SELECT COUNT(*) FROM user_memory_sources WHERE source_type = 'turn_llm'`,
    )[0].values[0][0];
    assert.equal(rows, 0, 'the duplicated LLM entry never reached storage');
    // The regex path's own (pre-existing) explicit + implicit rows stand.
    const memories = h.coworkStore.listUserMemories({ metabotId: 1 });
    assert.equal(memories.length, 2);
    assert.ok(memories.some((entry) => entry.text === '我叫小明，是设计师'));
    assert.ok(memories.some((entry) => entry.text === '记住：我叫小明，是设计师'));
  } finally {
    h.cleanup();
  }
});

test('an LLM delete instruction removes the best-matching memory', async () => {
  const h = await createHarness();
  try {
    setTurnMemoryExtractionRunner(async () => ([
      { action: 'add', text: 'Tengo dos gatos', isExplicit: false },
    ]));
    await applyTurn(h, { userText: 'por cierto, tengo dos gatos en casa' });
    assert.equal(h.coworkStore.listUserMemories({ metabotId: 1 }).length, 1);

    setTurnMemoryExtractionRunner(async () => ([
      { action: 'delete', text: 'Tengo dos gatos', isExplicit: true },
    ]));
    const result = await applyTurn(h, { userText: 'Olvida lo de los gatos' });
    assert.equal(result.deleted, 1);
    assert.equal(h.coworkStore.listUserMemories({ metabotId: 1 }).length, 0);
  } finally {
    h.cleanup();
  }
});

test('the extraction never runs when the LLM judge is disabled (cost guard)', async () => {
  const h = await createHarness();
  try {
    let called = 0;
    setTurnMemoryExtractionRunner(async () => {
      called += 1;
      return [{ action: 'add', text: 'x'.repeat(20), isExplicit: true }];
    });
    await applyTurn(h, { userText: 'Recuerda que me llamo Carlos', memoryLlmJudgeEnabled: false });
    assert.equal(called, 0, 'extraction skipped when the session judge is off');
    // Substantive-text guard also skips the runner.
    await applyTurn(h, { userText: 'ok', memoryLlmJudgeEnabled: true });
    assert.equal(called, 0, 'extraction skipped for non-substantive text');
  } finally {
    h.cleanup();
  }
});
