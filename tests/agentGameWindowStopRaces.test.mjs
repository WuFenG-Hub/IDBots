/**
 * Stop/settle race regressions for the agent-game move-LLM window.
 *
 * Findings from the post-merge review of fix/agent-game-llm-window-state-heal
 * (both verified against main @ c2df0d3d):
 *
 * P1-B (generational check): completeMoveInWindow's resolve/reject settle
 * callbacks delete the llmWindows entry UNCONDITIONALLY. A stale callee that
 * settles late — a hung call already cut by the sweeper, with the session
 * resumed and a fresh window created — detaches the NEW window. The runtime
 * then has no in-flight window to enforce: the new call can hang forever with
 * no 120s cut (GAP-4 recurrence path).
 *
 * P1-A (stop leak + ghost resurrection): stop() aborts the in-flight window
 * but never rejects it. Two failure modes:
 *  - degraded wiring (llmComplete ignores signal, never settles): the outer
 *    move-loop await never settles → `busy` leaks forever; the seat is dead
 *    even if resumed.
 *  - wired transport whose abort-settle lands AFTER stop() returned: the
 *    late rejection falls into the move-loop catch, which classifies it as
 *    an LLM failure and markStatus()es the just-stopped session back to
 *    'paused' (ghost resurrection of a terminal session).
 * markStatus() has no terminal-state guard, so nothing defends
 * stopped/finished against async paused/running writes.
 *
 * Suite layout (all on the virtual clock, real 1s sweeper as backup):
 *  - case 1  degraded hung llmComplete + stop: busy must be released, the
 *            session must stay stopped (no paused flip).
 *  - case 2  wired transport, abort-listener captured, rejection fired
 *            strictly AFTER stop() returned: no paused resurrection; resume
 *            on a stopped session stays stopped (terminal, no lease poison).
 *  - case 3  hang → sweeper cut → resume (new window) → OLD callee settles
 *            late: the old settle must NOT detach the new window, and the
 *            new window must still be enforced at its own 120s deadline.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(import.meta.dirname, '..');

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

/** Stale-artifact guard: probes for identifiers introduced by this fix
 *  (SessionStoppedError in stop()). Missing trait → explicit red light with
 *  a rebuild hint instead of misleading behavioral greens. */
const DIST_RUNTIME_JS = path.join(projectRoot, 'dist-electron', 'main', 'agentGame', 'runtime.js');
(function assertFreshAgentGameDist() {
  let src;
  try {
    src = fs.readFileSync(DIST_RUNTIME_JS, 'utf8');
  } catch {
    throw new Error(`[stale-dist-guard] ${DIST_RUNTIME_JS} not found: compile the electron main process first (pnpm run compile:electron), then rerun this suite`);
  }
  if (!src.includes('SessionStoppedError') || !src.includes('terminal state guard')) {
    throw new Error('[stale-dist-guard] dist-electron/main/agentGame/runtime.js lacks the stop/settle race fix traits (SessionStoppedError / terminal state guard) — stale artifact: recompile and rerun');
  }
})();

setTimeout(() => {
  console.error('[suite-watchdog] suite did not finish within 120s (silent hang — stale dist or resource contention), forcing exit 1');
  process.exit(1);
}, 120_000).unref();

/** Minimal SqliteDatabase-shape adapter over node:sqlite. */
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
  db.exec(`ALTER TABLE group_chat_messages ADD COLUMN msg_index INTEGER;`);
}

/* ------------------------------------------------------------------ */
/* Constants + byte-exact judge adapter fixture (same as convergence)  */
/* ------------------------------------------------------------------ */

const GAME_ID = 'xiangqi';
const GROUP_ID = '1fbaed756685856042fba718a22ff2fa6ce57e59a481e4d850e577fd768456d1i0';
const RED_AGENT = 'idq1winred000000000000000000000000000000000000000000000red000';
const BLACK_AGENT = 'idq1winblack000000000000000000000000000000000000000000black00';
const RULES_HASH = 'sha256:window-stop-races-rules-hash';

const FIXTURE_ADAPTER_DIR = path.join(projectRoot, 'tests', 'fixtures', 'xiangqi-adapter');
const JUDGE_ADAPTER_SHA256 = 'eabf1f423c869f91ef9c755e95d61e97ad32189e87a910b4bdfee4678c664a5e';
{
  const actual = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(FIXTURE_ADAPTER_DIR, 'agent-game', 'adapter.js')))
    .digest('hex');
  assert.equal(actual, JUDGE_ADAPTER_SHA256, 'judge adapter fixture drift: agent-game/adapter.js sha256 no longer matches the v1.0.2 game package');
}

/* ------------------------------------------------------------------ */
/* Host harness                                                        */
/* ------------------------------------------------------------------ */

const { createAgentGameHost } = require('../dist-electron/main/agentGame/index.js');

/** chainWrite recorder: records each chain write and lands a message row synchronously. */
function makeChainRecorder(db, groupId) {
  const calls = [];
  let rowSeq = 0;
  return {
    calls,
    async chainWrite(gid, plaintext, opts) {
      const rowTs = Date.now();
      calls.push({ groupId: gid, plaintext, opts: opts ?? null, rowTs });
      rowSeq += 1;
      const maxRow = db.exec('SELECT COALESCE(MAX(msg_index), 0) FROM group_chat_messages WHERE group_id = ?', [gid]);
      const nextIndex = Number(maxRow[0]?.values?.[0]?.[0] ?? 0) + 1;
      db.run(
        `INSERT INTO group_chat_messages
          (pin_id, group_id, sender_metaid, sender_global_metaid, protocol, content, encryption, chain_timestamp, msg_index)
         VALUES (?, ?, ?, ?, 'simplegroupchat', ?, '', ?, ?)`,
        [`wsr-pin-${rowSeq}`, gid, opts?.asAgentId ?? 'unknown', opts?.asAgentId ?? null, plaintext, rowTs, nextIndex],
      );
      return { pinId: `wsr-pin-${calls.length}` };
    },
  };
}

function materializeJudgeAdapter() {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-game-wsr-'));
  fs.mkdirSync(path.join(artifactDir, 'agent-game'), { recursive: true });
  fs.mkdirSync(path.join(artifactDir, 'js'), { recursive: true });
  for (const rel of ['agent-game/adapter.js', 'js/notation.js', 'js/rules.js']) {
    fs.copyFileSync(path.join(FIXTURE_ADAPTER_DIR, rel), path.join(artifactDir, rel));
  }
  fs.writeFileSync(path.join(artifactDir, 'package.json'), JSON.stringify({ type: 'module' }));
  const manifest = {
    protocol: 'agent-game/1',
    gameId: GAME_ID,
    rulesVersion: '1.0.0',
    adapter: './agent-game/adapter.js',
    adapterHash: `sha256:${JUDGE_ADAPTER_SHA256}`,
    turnModel: 'sequential',
    informationModel: 'public',
    maxPlayers: 2,
  };
  fs.writeFileSync(path.join(artifactDir, 'game-manifest.json'), JSON.stringify(manifest));
  return {
    artifactDir,
    manifestFetch: async () => JSON.parse(fs.readFileSync(path.join(artifactDir, 'game-manifest.json'), 'utf8')),
    adapterPathFor: async (_manifestUri, mf) => path.join(artifactDir, mf.adapter),
  };
}

function buildHost({ llm, logSink }) {
  const db = new TestSqliteDb();
  createAgentGameTables(db);
  const judge = materializeJudgeAdapter();
  const recorder = makeChainRecorder(db, GROUP_ID);
  const host = createAgentGameHost({
    db,
    saveDb: () => {},
    llmComplete: llm,
    chainWrite: recorder.chainWrite,
    manifestFetch: judge.manifestFetch,
    adapterPathFor: judge.adapterPathFor,
    resolveActor: () => RED_AGENT,
    actorNameFor: (id) => (id === RED_AGENT ? 'Builder阿码' : id === BLACK_AGENT ? 'AI_Sunny' : ''),
    log: (m) => { if (logSink) logSink.push(m); else if (process.env.WSR_DEBUG) console.error('[runtime]', m); },
  });
  return {
    host,
    db,
    recorder,
    artifactDir: judge.artifactDir,
    cleanup: () => fs.rmSync(judge.artifactDir, { recursive: true, force: true }),
  };
}

function startParams(overrides = {}) {
  return {
    appId: 'wsr.v1',
    sessionType: 'agent-game',
    groupId: GROUP_ID,
    gameId: GAME_ID,
    manifestUri: 'metaapp://judge-fixture-pin-i0',
    rulesHash: RULES_HASH,
    seat: 'red',
    agentId: RED_AGENT,
    ttlMs: 3_600_000,
    budget: { llmCalls: 20, writes: 20 },
    ...overrides,
  };
}

/** Two-phase start: phase1 confirmation card → phase2 session creation. */
async function startSession(host, params) {
  const resourceUri = `metaapp://confirm-${Math.random().toString(36).slice(2)}`;
  const phaseOne = await host.handleSessionMethod('start', params, params.agentId, { resourceUri });
  assert.equal(phaseOne.manualAction, true, 'phase 1 must issue a confirmation');
  const session = await host.handleSessionMethod('start', phaseOne.confirmRequest.payload, params.agentId, { resourceUri });
  assert.equal(session.__error || false, false, `phase 2 failed: ${session.code} ${session.message}`);
  return session;
}

const realDateNow = Date.now;
async function waitFor(predicate, { timeoutMs = 15_000, stepMs = 25, label = 'condition' } = {}) {
  const deadline = realDateNow() + timeoutMs;
  while (realDateNow() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

/** Manually insert a chain message row (match.created / opponent seat.claimed). */
function insertRow(db, { pinId, senderGlobalMetaId, msgIndex, chainTimestamp, content }) {
  db.run(
    `INSERT INTO group_chat_messages
      (pin_id, group_id, sender_metaid, sender_global_metaid, protocol, content, encryption, chain_timestamp, msg_index)
     VALUES (?, ?, ?, ?, 'simplegroupchat', ?, 'aes', ?, ?)`,
    [pinId, GROUP_ID, 'legacy-metaid', senderGlobalMetaId, content, chainTimestamp, msgIndex],
  );
}

const matchCreatedContent = () => JSON.stringify({
  protocol: 'agent-game/1',
  gameId: GAME_ID,
  matchId: GROUP_ID,
  rulesHash: RULES_HASH,
  type: 'match.created',
  eventId: `row:match.created:${Math.random().toString(36).slice(2)}`,
  payload: { title: 'window-stop race match' },
});

const seatClaimContent = (seat) => JSON.stringify({
  protocol: 'agent-game/1',
  gameId: GAME_ID,
  matchId: GROUP_ID,
  rulesHash: RULES_HASH,
  type: 'seat.claimed',
  eventId: `row:seat.claimed.${seat}:${Math.random().toString(36).slice(2)}`,
  payload: { requestedRole: seat },
});

/** Virtual clock: take over Date.now (runtime/store/lease all read Date.now);
 *  the sweeper is a real 1s interval judging expiry via this.now() — tests
 *  advance the fake clock and drive deterministic cuts directly. */
let fakeNow = 1_785_000_000_000;
function installFakeClock() {
  fakeNow = 1_785_000_000_000;
  Date.now = () => fakeNow;
}
function uninstallFakeClock() {
  Date.now = realDateNow;
}

async function seatRedToMove(db, host) {
  // Prefix stream: match.created → red claim (host start writes it) → black claim.
  insertRow(db, { pinId: 'wsr-row-1', senderGlobalMetaId: RED_AGENT, msgIndex: 1, chainTimestamp: fakeNow, content: matchCreatedContent() });
  await startSession(host, startParams());
  insertRow(db, { pinId: 'wsr-row-3', senderGlobalMetaId: BLACK_AGENT, msgIndex: 3, chainTimestamp: fakeNow, content: seatClaimContent('black') });
  host.onGroupMessage(GROUP_ID);
}

async function statusOf(host, sessionId) {
  return await host.handleSessionMethod('status', { sessionId }, RED_AGENT, {});
}

test('case 1 (P1-A degraded wiring): stop() while llmComplete ignores signal and never settles — busy must be released and the session must stay stopped', { timeout: 40_000 }, async () => {
  installFakeClock();
  let host = null;
  let cleanup = () => {};
  try {
    // Production degradation shape: llmComplete takes no opts and never returns.
    let entered = false;
    const hungLlm = async () => {
      entered = true;
      return new Promise(() => {});
    };
    const built = buildHost({ llm: hungLlm });
    host = built.host;
    cleanup = built.cleanup;

    await seatRedToMove(built.db, host);
    await waitFor(() => entered, { label: 'red llm entry (hang)' });
    const sessionId = host.runtime.deps.store.listRecoverableSessions()[0]?.sessionId;
    assert.ok(sessionId, 'session must exist');

    const stopView = await host.handleSessionMethod('stop', { sessionId }, RED_AGENT, {});
    assert.equal(stopView.status, 'stopped', 'stop must land synchronously (markStatus stopped)');

    // P1-A①: the suspended move-loop await must settle → busy released.
    await waitFor(() => !host.runtime.busy.has(sessionId), {
      timeoutMs: 10_000, label: 'busy released after stop (RED on main: await never settles → busy leaks forever)',
    });

    // No paused resurrection: advance the window, sweep, wake the group.
    fakeNow += 121_000;
    host.runtime.sweepLlmWindows();
    host.onGroupMessage(GROUP_ID);
    await new Promise((r) => setTimeout(r, 200));
    const view = await statusOf(host, sessionId);
    assert.equal(view.status, 'stopped', 'session must remain stopped after stop (no paused flip)');
  } finally {
    if (host) await host.runtime.dispose().catch(() => {});
    cleanup();
    uninstallFakeClock();
  }
});

test('case 2 (P1-A wired wiring): late abort-settle strictly AFTER stop() returned — no paused resurrection, resume stays stopped', { timeout: 40_000 }, async () => {
  installFakeClock();
  let host = null;
  let cleanup = () => {};
  try {
    // Faithful wired shape: signal-aware, but the transport unwind is
    // asynchronous — the test fires the rejection explicitly so the settle
    // lands strictly after stop() returned (the dangerous race ordering the
    // terminal-state guard must defend; in production fetch/socket teardown
    // settles on real I/O turns with exactly this nondeterministic ordering).
    let entered = false;
    let lateReject = null;
    const wiredLateAbortLlm = (messages, opts) => {
      entered = true;
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          lateReject = () => {
            const err = new Error('This operation was aborted');
            err.name = 'AbortError';
            reject(err);
          };
        });
      });
    };
    const built = buildHost({ llm: wiredLateAbortLlm });
    host = built.host;
    cleanup = built.cleanup;

    await seatRedToMove(built.db, host);
    await waitFor(() => entered, { label: 'red llm entry' });
    const sessionId = host.runtime.deps.store.listRecoverableSessions()[0]?.sessionId;
    assert.ok(sessionId, 'session must exist');

    const stopView = await host.handleSessionMethod('stop', { sessionId }, RED_AGENT, {});
    assert.equal(stopView.status, 'stopped', 'stop must land synchronously');

    // The dangerous ordering: settle strictly after stop() returned.
    assert.equal(typeof lateReject, 'function');
    lateReject();
    await new Promise((r) => setTimeout(r, 200));

    const view = await statusOf(host, sessionId);
    assert.equal(view.status, 'stopped', 'late abort-settle must NOT resurrect the stopped session to paused (RED on main: catch marks paused)');
    assert.equal(view.lastError, null, 'a stop interruption must not paint an LLM failure onto the stopped session');

    // Terminal coherence: resume on a stopped session must be a no-op view,
    // never a re-activation (stop released the lease; half-resume would
    // re-acquire it while the status stays stopped — a poisoned seat lease).
    const resumeView = await host.handleSessionMethod('resume', { sessionId }, RED_AGENT, {});
    assert.equal(resumeView.status, 'stopped', 'resume must not re-activate a stopped session (RED on main: ghost paused → running)');
  } finally {
    if (host) await host.runtime.dispose().catch(() => {});
    cleanup();
    uninstallFakeClock();
  }
});

test('case 3 (P1-B generational check): hang → sweep → resume → OLD callee settles late — the new window must survive and stay enforced', { timeout: 40_000 }, async () => {
  installFakeClock();
  let host = null;
  let cleanup = () => {};
  try {
    // Manual deferreds: call #1 hangs past the window and is cut by the
    // sweeper; call #2 (after resume) is the fresh window; #1 settles late.
    const deferreds = [];
    const deferredLlm = () => new Promise((_resolve, reject) => {
      deferreds.push({ reject });
    });
    const built = buildHost({ llm: deferredLlm });
    host = built.host;
    cleanup = built.cleanup;

    await seatRedToMove(built.db, host);
    await waitFor(() => deferreds.length === 1, { label: 'call #1 entered (hang)' });
    const sessionId = host.runtime.deps.store.listRecoverableSessions()[0]?.sessionId;
    assert.ok(sessionId, 'session must exist');

    // Sweeper cuts call #1 at its 120s deadline → paused llm_timeout.
    fakeNow += 121_000;
    host.runtime.sweepLlmWindows();
    await waitFor(async () => {
      const view = await statusOf(host, sessionId);
      return view.status === 'paused' && view.lastError?.code === 'llm_timeout';
    }, { label: 'call #1 swept to paused llm_timeout' });

    // Resume → fresh window, call #2 enters.
    await host.handleSessionMethod('resume', { sessionId }, RED_AGENT, {});
    await waitFor(() => deferreds.length === 2, { label: 'call #2 entered after resume (fresh window)' });
    assert.equal(host.runtime.llmWindows.has(sessionId), true, 'fresh window must be registered after resume');

    // OLD callee settles late (transport death after the cut).
    deferreds[0].reject(new Error('late transport death of call #1'));
    await new Promise((r) => setTimeout(r, 200));

    // P1-B: the stale settle must not detach the NEW window.
    assert.equal(host.runtime.llmWindows.has(sessionId), true, 'late OLD settle must not remove the NEW window (RED on main: unconditional delete)');

    // The new window must still be enforced at its own 120s deadline.
    fakeNow += 121_000;
    host.runtime.sweepLlmWindows();
    await waitFor(async () => {
      const view = await statusOf(host, sessionId);
      return view.status === 'paused' && view.lastError?.code === 'llm_timeout';
    }, { timeoutMs: 20_000, label: 'new window enforced at its own deadline (RED on main: window was detached, call #2 hangs forever)' });
  } finally {
    if (host) await host.runtime.dispose().catch(() => {});
    cleanup();
    uninstallFakeClock();
  }
});
