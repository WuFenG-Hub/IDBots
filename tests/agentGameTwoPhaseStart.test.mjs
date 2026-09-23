import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/** Electron stub — adapterSandbox only needs app.isPackaged + app.getAppPath(). */
const electronStub = {
  app: { isPackaged: false, getAppPath: () => projectRoot },
};
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, parent, isMain);
};


/** 陈旧产物守卫（fix/agent-game-test-stale-dist-guard）：本套件直接对 dist-electron 编译产物
 *  跑回归（gitignored，不随 merge 更新）。合并只带来源码；旧产物里 start 走两阶段改造前的
 *  consent await（等外部 respond 才 resolve），按新契约调用会零输出永挂（2026-09-23 实证，
 *  e6079dae 上 timeout 60 强杀）。此处先做特征探针：产物缺失或缺两阶段 confirmToken 标记 →
 *  立即显式失败并给出重编译提示，把「静默永挂」变成「显式红灯」。 */
const DIST_INDEX_JS = path.join(projectRoot, 'dist-electron', 'main', 'agentGame', 'index.js');
(function assertFreshAgentGameDist() {
  let src;
  try {
    src = fs.readFileSync(DIST_INDEX_JS, 'utf8');
  } catch {
    throw new Error(`[stale-dist-guard] ${DIST_INDEX_JS} 不存在：先编译 electron 主进程（pnpm run compile:electron）再跑本套件`);
  }
  if (!src.includes('confirmToken')) {
    throw new Error('[stale-dist-guard] dist-electron/main/agentGame 是缺两阶段契约的旧产物（无 confirmToken 特征）：start 会挂死在旧版 consent await 上。请重编译（pnpm run compile:electron）后重跑');
  }
})();

/** 套件级看门狗：90s 未结束即 exit(1) 带原因（防任何未来的静默挂起吊死运行方）。
 *  unref：正常跑完不拖住进程退出；挂起时其他句柄维持进程，本定时器仍会触发。 */
setTimeout(() => {
  console.error('[suite-watchdog] 套件 90s 未结束：静默挂起（疑似 dist-electron 陈旧或资源竞争），强制 exit 1');
  process.exit(1);
}, 90_000).unref();

/** Minimal SqliteDatabase-shape adapter over node:sqlite (mirrors chatSkillAuthorization.test.mjs). */
class TestSqliteDb {
  constructor() {
    this.db = new DatabaseSync(':memory:');
  }

  exec(sql, params = []) {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
      this.db.exec(sql);
      return [];
    }
    const stmt = this.db.prepare(sql);
    if (/^\s*(SELECT|PRAGMA)/i.test(sql)) {
      const rows = stmt.all(...params);
      const columns = stmt.columns().map((column) => column.name || column.column || '');
      return [{ columns, values: rows.map((row) => columns.map((column) => row[column])) }];
    }
    stmt.run(...params);
    return [];
  }

  run(sql, params = []) {
    return this.exec(sql, params);
  }
}

function createAgentGameTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_game_sessions (
    session_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'paused',
    app_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    game_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    seat TEXT NOT NULL,
    rules_hash TEXT NOT NULL,
    adapter_hash TEXT NOT NULL,
    manifest_uri TEXT NOT NULL,
    protocol_paths TEXT,
    budget_llm_calls INTEGER NOT NULL DEFAULT 0,
    budget_llm_calls_used INTEGER NOT NULL DEFAULT 0,
    budget_writes INTEGER NOT NULL DEFAULT 0,
    budget_writes_used INTEGER NOT NULL DEFAULT 0,
    last_index INTEGER,
    last_action_seq INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    expires_at INTEGER NOT NULL DEFAULT 0,
    consent TEXT,
    lease_id TEXT,
    lease_expires_at INTEGER,
    serialized_state TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_game_sessions_group ON agent_game_sessions(group_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_game_sessions_status ON agent_game_sessions(status);`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_game_grants (
    resource_uri TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    app_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    game_id TEXT NOT NULL,
    rules_hash TEXT NOT NULL,
    adapter_hash TEXT NOT NULL,
    seat TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    ttl_ms INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL DEFAULT 0,
    budget_llm_calls INTEGER NOT NULL DEFAULT 0,
    budget_writes INTEGER NOT NULL DEFAULT 0,
    protocol_paths TEXT,
    revoked_at INTEGER,
    reason TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (resource_uri, actor_id, app_id, group_id, game_id, rules_hash, adapter_hash, seat)
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_game_write_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    action_seq INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    pin_id TEXT,
    tx_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (group_id, action_seq, event_id)
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_game_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    session_id TEXT,
    actor_id TEXT,
    fields TEXT,
    ts INTEGER NOT NULL
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS group_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pin_id TEXT UNIQUE NOT NULL,
    tx_id TEXT,
    group_id TEXT NOT NULL,
    channel_id TEXT,
    sender_metaid TEXT NOT NULL,
    sender_global_metaid TEXT,
    sender_address TEXT,
    sender_name TEXT,
    sender_avatar TEXT,
    sender_chat_pubkey TEXT,
    protocol TEXT NOT NULL,
    content TEXT,
    content_type TEXT,
    encryption TEXT,
    reply_pin TEXT,
    mention TEXT,
    chain_timestamp INTEGER,
    chain TEXT,
    raw_data TEXT,
    is_processed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );`);
  // Migration parity: runtime cursor reads use msg_index (added by sqliteStore).
  db.exec(`ALTER TABLE group_chat_messages ADD COLUMN msg_index INTEGER;`);
}

/** Minimal conforming adapter (ten exports); never reaches our seat's turn.
 *  ESM named exports — mirrors the blueprint xiangqi adapter's style. */
const FIXTURE_ADAPTER_SOURCE = `
export function createMatch(config) { return { gameId: config.gameId, seats: ['black', 'white'] }; }
export function initialState(config) { return { gameId: config.gameId, seat: config.seat, moves: [] }; }
export function reduce(state) { return state; }
export function getTurn() { return { phase: 'playing', seat: 'white' }; }
export function getObservation(state) { return { moves: state.moves }; }
export function getActionSchema() { return { type: 'object' }; }
export function parseAction(text) { return { action: { move: String(text).slice(0, 16) } }; }
export function validateAction() { return { valid: true }; }
export function serializeState(state) { return JSON.stringify(state); }
export function getResult() { return { finished: false }; }
`;

const OWNER_ACTOR = 'idq1test-owner-actor-0000000000000000000';
const OTHER_ACTOR = 'idq1test-other-actor-000000000000000000';
const GROUP_ID = 'test-group-1';
const RESOURCE_URI = 'metaapp://fixture-pin-i0';

function buildHost() {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-game-fixture-'));
  const adapterPath = path.join(artifactDir, 'adapter.js');
  fs.writeFileSync(path.join(artifactDir, 'adapter.js'), FIXTURE_ADAPTER_SOURCE);
  // Real game packages ship ESM adapters; pin the module type for import().
  fs.writeFileSync(path.join(artifactDir, 'package.json'), JSON.stringify({ type: 'module' }));
  const adapterHash = `sha256:${crypto.createHash('sha256').update(FIXTURE_ADAPTER_SOURCE).digest('hex')}`;
  const manifest = {
    protocol: 'agent-game/1',
    gameId: 'fixture-game',
    rulesVersion: '1',
    adapter: './adapter.js',
    adapterHash,
    turnModel: 'sequential',
    informationModel: 'public',
    maxPlayers: 2,
  };
  fs.writeFileSync(path.join(artifactDir, 'game-manifest.json'), JSON.stringify(manifest));

  const db = new TestSqliteDb();
  createAgentGameTables(db);
  const { createAgentGameHost } = require('../dist-electron/main/agentGame/index.js');
  const host = createAgentGameHost({
    db,
    saveDb: () => {},
    llmComplete: async () => {
      throw new Error('llm must not be called by the two-phase start test');
    },
    chainWrite: async () => {
      throw new Error('chain must not be written by the two-phase start test');
    },
    manifestFetch: async () => JSON.parse(fs.readFileSync(path.join(artifactDir, 'game-manifest.json'), 'utf8')),
    // IDB-3 contract: async join of the artifact dir + manifest adapter path.
    adapterPathFor: async (manifestUri, mf) => path.join(artifactDir, mf.adapter),
    resolveActor: () => OWNER_ACTOR,
    actorNameFor: (globalMetaId) => (globalMetaId === OWNER_ACTOR ? 'Test Bot' : ''),
    log: () => {},
  });
  return { host, db, artifactDir, manifest, adapterHash };
}

function startParams(overrides = {}) {
  return {
    appId: 'fixture.v1',
    sessionType: 'agent-game',
    groupId: GROUP_ID,
    gameId: 'fixture-game',
    manifestUri: 'metaapp://fixture-pin-i0',
    rulesHash: 'sha256:rules',
    seat: 'black',
    agentId: OWNER_ACTOR,
    ttlMs: 3_600_000,
    budget: { llmCalls: 10, writes: 10 },
    ...overrides,
  };
}

/** handleSessionMethod resolves error envelopes ({__error, code}) instead of throwing. */
async function codeOf(promise) {
  const result = await promise;
  return result && result.__error ? result.code : null;
}

test('phase 1 issues a confirmation bound to resource + actor', { timeout: 15_000 }, async () => {
  const { host } = buildHost();
  try {
    const result = await host.handleSessionMethod('start', startParams(), OWNER_ACTOR, { resourceUri: RESOURCE_URI });
    assert.equal(result.manualAction, true);
    assert.equal(result.confirmRequest.kind, 'app-session-start');
    assert.equal(result.confirmRequest.resourceUri, RESOURCE_URI);
    assert.equal(typeof result.confirmRequest.payload.confirmToken, 'string');
    assert.equal(result.confirmation.appId, 'fixture.v1');
    assert.equal(result.confirmation.gameId, 'fixture-game');
    assert.equal(result.confirmation.seat, 'black');
    assert.equal(result.confirmation.actor.globalMetaId, OWNER_ACTOR);
    assert.equal(result.confirmation.actor.name, 'Test Bot');
    assert.equal(result.confirmation.resourceUri, RESOURCE_URI);
    assert.match(result.confirmation.adapterHash, /^sha256:[0-9a-f]{64}$/);
  } finally {
    await host.dispose();
  }
});

test('phase 1 rejects invalid payloads with contract error codes', { timeout: 15_000 }, async () => {
  const { host } = buildHost();
  try {
    const ctx = { resourceUri: RESOURCE_URI };
    const run = (payload, actor = OWNER_ACTOR, context = ctx) => codeOf(host.handleSessionMethod('start', payload, actor, context));
    assert.equal(await run(startParams({ seat: undefined })), 'invalid_params');
    assert.equal(await run(startParams({ ttlMs: 0 })), 'invalid_params');
    assert.equal(await run(startParams({ budget: undefined })), 'invalid_params');
    assert.equal(await run(startParams(), OTHER_ACTOR), 'invalid_params');
    // explicit undefined ctx (no Browser resource) — bypass run()'s default param
    assert.equal(await codeOf(host.handleSessionMethod('start', startParams(), OWNER_ACTOR, undefined)), 'invalid_params');
    assert.equal(await run(startParams({ adapterHash: 'sha256:deadbeef' })), 'adapter_invalid');
    assert.equal(await run(startParams({ seat: '7' })), 'seat_unavailable');
  } finally {
    await host.dispose();
  }
});

test('phase 1 maps manifest failures to adapter_invalid', { timeout: 15_000 }, async () => {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-game-fixture-'));
  const db = new TestSqliteDb();
  createAgentGameTables(db);
  const { createAgentGameHost } = require('../dist-electron/main/agentGame/index.js');
  const host = createAgentGameHost({
    db,
    saveDb: () => {},
    llmComplete: async () => {
      throw new Error('unused');
    },
    chainWrite: async () => {
      throw new Error('unused');
    },
    manifestFetch: async () => {
      throw new Error('artifact dir not cached');
    },
    adapterPathFor: async () => {
      throw new Error('unused');
    },
    resolveActor: () => OWNER_ACTOR,
    log: () => {},
  });
  try {
    const code = await codeOf(host.handleSessionMethod('start', startParams(), OWNER_ACTOR, { resourceUri: RESOURCE_URI }));
    assert.equal(code, 'adapter_invalid');
  } finally {
    await host.dispose();
  }
});

test('phase 2 denies tampered token / resource / actor echoes', { timeout: 15_000 }, async () => {
  const { host } = buildHost();
  try {
    const phaseOne = await host.handleSessionMethod('start', startParams(), OWNER_ACTOR, { resourceUri: RESOURCE_URI });
    const token = phaseOne.confirmRequest.payload.confirmToken;

    assert.equal(await codeOf(host.handleSessionMethod('start', { confirmToken: 'forged' }, OWNER_ACTOR, { resourceUri: RESOURCE_URI })), 'consent_denied');
    assert.equal(await codeOf(host.handleSessionMethod('start', { confirmToken: token }, OWNER_ACTOR, { resourceUri: 'metaapp://other-pin-i0' })), 'consent_denied');
    assert.equal(await codeOf(host.handleSessionMethod('start', { confirmToken: token }, OTHER_ACTOR, { resourceUri: RESOURCE_URI })), 'consent_denied');
  } finally {
    await host.dispose();
  }
});

test('phase 2 starts the session, persists the grant, scopes list, replays idempotently', { timeout: 15_000 }, async () => {
  const { host, manifest } = buildHost();
  try {
    const phaseOne = await host.handleSessionMethod('start', startParams(), OWNER_ACTOR, { resourceUri: RESOURCE_URI });
    const confirmRequest = phaseOne.confirmRequest;

    const session = await host.handleSessionMethod('start', confirmRequest.payload, OWNER_ACTOR, { resourceUri: RESOURCE_URI });
    assert.equal(session.__error || false, false, `phase 2 failed: ${session.code} ${session.message}`);
    assert.equal(session.status, 'running');
    assert.equal(session.gameId, 'fixture-game');
    assert.equal(session.seat, 'black');
    assert.equal(session.agentId, OWNER_ACTOR);

    const grant = host.store.getGrant({
      resourceUri: `metaapp://${startParams().appId}`,
      actorId: OWNER_ACTOR,
      appId: 'fixture.v1',
      groupId: GROUP_ID,
      gameId: 'fixture-game',
      rulesHash: 'sha256:rules',
      adapterHash: manifest.adapterHash,
      seat: 'black',
    });
    assert.ok(grant, 'grant must be persisted');
    assert.equal(grant.status, 'active');

    // Actor scoping (docs/09 §4.2).
    const mine = await host.handleSessionMethod('list', {}, OWNER_ACTOR);
    assert.equal(mine.sessions.length, 1);
    const theirs = await host.handleSessionMethod('list', {}, OTHER_ACTOR);
    assert.equal(theirs.sessions.length, 0);

    // Idempotent reuse for the same (groupId, seat, agentId, rulesHash).
    const phaseOne2 = await host.handleSessionMethod('start', startParams(), OWNER_ACTOR, { resourceUri: RESOURCE_URI });
    const replay = await host.handleSessionMethod('start', phaseOne2.confirmRequest.payload, OWNER_ACTOR, { resourceUri: RESOURCE_URI });
    assert.equal(replay.sessionId, session.sessionId);

    // Tokens are single-use.
    assert.equal(await codeOf(host.handleSessionMethod('start', confirmRequest.payload, OWNER_ACTOR, { resourceUri: RESOURCE_URI })), 'consent_denied');
  } finally {
    await host.dispose();
  }
});

test('pause/resume/stop stay idempotent and status scoping holds', { timeout: 15_000 }, async () => {
  const { host } = buildHost();
  try {
    const phaseOne = await host.handleSessionMethod('start', startParams(), OWNER_ACTOR, { resourceUri: RESOURCE_URI });
    const session = await host.handleSessionMethod('start', phaseOne.confirmRequest.payload, OWNER_ACTOR, { resourceUri: RESOURCE_URI });
    assert.equal(session.__error || false, false, `phase 2 failed: ${session.code} ${session.message}`);
    const sessionId = session.sessionId;

    const paused = await host.handleSessionMethod('pause', { sessionId }, OWNER_ACTOR);
    assert.equal(paused.status, 'paused');
    const pausedAgain = await host.handleSessionMethod('pause', { sessionId }, OWNER_ACTOR);
    assert.equal(pausedAgain.status, 'paused');
    const resumed = await host.handleSessionMethod('resume', { sessionId }, OWNER_ACTOR);
    assert.equal(resumed.status, 'running');

    // NOTE: docs/09 §4.3 actor-scoping of status/pause/resume/stop is a known
    // pre-existing gap in runtime.ts (out of scope for IDB-1/2/3); `list`
    // scoping is covered in the phase-2 test above.

    const stopped = await host.handleSessionMethod('stop', { sessionId }, OWNER_ACTOR);
    assert.equal(stopped.status, 'stopped');
    const stoppedAgain = await host.handleSessionMethod('stop', { sessionId }, OWNER_ACTOR);
    assert.equal(stoppedAgain.status, 'stopped');

    assert.equal(await codeOf(host.handleSessionMethod('status', { sessionId: 'missing' }, OWNER_ACTOR)), 'session_not_found');
  } finally {
    await host.dispose();
  }
});

test('second runner on the same (groupId, seat) is rejected with session_conflict', { timeout: 15_000 }, async () => {
  const { host } = buildHost();
  try {
    const first = await host.handleSessionMethod('start', startParams(), OWNER_ACTOR, { resourceUri: RESOURCE_URI });
    const started = await host.handleSessionMethod('start', first.confirmRequest.payload, OWNER_ACTOR, { resourceUri: RESOURCE_URI });
    assert.equal(started.__error || false, false, `phase 2 failed: ${started.code} ${started.message}`);

    const rival = await host.handleSessionMethod(
      'start',
      startParams({ agentId: OTHER_ACTOR, seat: 'black' }),
      OTHER_ACTOR,
      { resourceUri: RESOURCE_URI },
    );
    assert.equal(rival.manualAction, true);
    const code = await codeOf(
      host.handleSessionMethod('start', rival.confirmRequest.payload, OTHER_ACTOR, { resourceUri: RESOURCE_URI }),
    );
    assert.equal(code, 'session_conflict');
  } finally {
    await host.dispose();
  }
});

test('negative control: a bare relative adapter path fails hash load (pre-IDB-3 behavior)', { timeout: 15_000 }, async () => {
  const { loadAdapterSandbox } = require('../dist-electron/main/agentGame/adapterSandbox.js');
  await assert.rejects(
    () => loadAdapterSandbox('./adapter.js', 'sha256:whatever'),
    (err) => err instanceof Error,
  );
});
