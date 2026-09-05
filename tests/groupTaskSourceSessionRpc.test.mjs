import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * R2 RPC validation: POST /api/idbots/group-task/create must accept a standard
 * CoWork session as source_session_id and reject a2a / browser / group_task /
 * non-existent sessions with 400 BEFORE reaching createGroupTask (so no chain
 * write happens for an invalid relay target). Uses a real SqliteStore so the
 * cowork_sessions lookup behaves like production.
 */

function resolveCompiledMetaidRpcServerPath() {
  const candidates = [
    '../dist-electron/services/metaidRpcServer.js',
    '../dist-electron/main/services/metaidRpcServer.js',
  ];
  for (const candidate of candidates) {
    try {
      return require.resolve(candidate);
    } catch {
      // Try next compile output layout.
    }
  }
  return require.resolve(candidates[0]);
}

function resolveCompiledMetaidRpcEndpointPath() {
  const candidates = [
    '../dist-electron/services/metaidRpcEndpoint.js',
    '../dist-electron/main/services/metaidRpcEndpoint.js',
  ];
  for (const candidate of candidates) {
    try {
      return require.resolve(candidate);
    } catch {
      // Try next compile output layout.
    }
  }
  return require.resolve(candidates[0]);
}

// Pin the bearer token for this process: the RPC server mirrors its token
// into <userData>/metaid-rpc-token (userData is mocked to os.tmpdir() here)
// and ADOPTS a leftover mirror from a previous run — which then mismatches
// this run's freshly generated client token and produces spurious 401s on
// repeat runs. An env-pinned token always wins and is re-mirrored.
process.env.IDBOTS_RPC_TOKEN = process.env.IDBOTS_RPC_TOKEN || 'test-rpc-token-group-task-source-session';
const { getMetaidRpcToken } = require(resolveCompiledMetaidRpcEndpointPath());
const RPC_TOKEN = getMetaidRpcToken();
const RPC_AUTH_HEADERS = { 'Content-Type': 'application/json', Authorization: `Bearer ${RPC_TOKEN}` };

async function startRpcServerForTest() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-source-session-rpc-'));
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => os.tmpdir() },
        BrowserWindow: { getAllWindows: () => [] },
      };
    }
    if (request === './httpListenWithRetry' || request.endsWith('/httpListenWithRetry')) {
      return {
        listenWithRetry(server, _port, host, options = {}) {
          server.listen(0, host, () => {
            if (typeof options.onListening === 'function') options.onListening();
          });
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
  let startMetaidRpcServer;
  try {
    const compiledRpcServerPath = resolveCompiledMetaidRpcServerPath();
    delete require.cache[compiledRpcServerPath];
    ({ startMetaidRpcServer } = require(compiledRpcServerPath));
  } finally {
    Module._load = originalLoad;
  }

  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  // session_type is added by CoworkStore's migration in production; ensure it
  // here so the seeded rows + the handler's lookup behave like production.
  const sessionCols = (db.exec('PRAGMA table_info(cowork_sessions)')[0]?.values || []).map((r) => String(r[1]));
  if (!sessionCols.includes('session_type')) {
    db.run("ALTER TABLE cowork_sessions ADD COLUMN session_type TEXT NOT NULL DEFAULT 'standard'");
  }
  // Seed cowork_sessions with one row per session_type so the validation query
  // has real rows to match against.
  const insertSession = (id, sessionType) =>
    db.run(
      `INSERT INTO cowork_sessions (id, title, cwd, session_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, id, '/tmp', sessionType, 1, 1],
    );
  insertSession('sess-standard', 'standard');
  insertSession('sess-a2a', 'a2a');
  insertSession('sess-browser', 'browser');
  insertSession('sess-group-task', 'group_task');

  const metabotStore = {
    getMetabotById: () => null,
    getMetabotWalletByMetabotId: () => null,
    listMetabots: () => [],
  };

  // Phase 4: memory routes are not exercised here; a stub satisfies the
  // MemoryBackend getter argument.
  const server = startMetaidRpcServer(() => metabotStore, () => store, () => ({
    listUserMemories() {
      return [];
    },
    createUserMemory() {
      throw new Error('memory routes are not exercised in this test');
    },
  }));
  await new Promise((resolve, reject) => {
    if (server.listening) {
      resolve();
      return;
    }
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  if (!port) {
    server.close();
    throw new Error('failed to resolve test server port');
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    cleanup: () => {
      server.close();
      store.close();
    },
  };
}

const postCreate = (baseUrl, body) =>
  fetch(`${baseUrl}/api/idbots/group-task/create`, {
    method: 'POST',
    headers: RPC_AUTH_HEADERS,
    body: JSON.stringify(body),
  });

test('rpc group-task create: rejects a2a / group_task / unknown source_session_id', async () => {
  const h = await startRpcServerForTest();
  try {
    // a2a session: not a valid originator.
    let res = await postCreate(h.baseUrl, { title: 'T', goal: 'G', source_session_id: 'sess-a2a' });
    assert.equal(res.status, 400);
    let body = await res.json();
    assert.ok(/standard or browser CoWork session/.test(body.error), `a2a rejected: ${body.error}`);

    // group_task session (the chair's own pseudo session namespace).
    res = await postCreate(h.baseUrl, { title: 'T', goal: 'G', source_session_id: 'sess-group-task' });
    assert.equal(res.status, 400);

    // non-existent session.
    res = await postCreate(h.baseUrl, { title: 'T', goal: 'G', source_session_id: 'sess-does-not-exist' });
    assert.equal(res.status, 400);
    body = await res.json();
    assert.ok(/does not refer to an existing/.test(body.error), `unknown rejected: ${body.error}`);
  } finally {
    h.cleanup();
  }
});

test('rpc group-task create: a browser source_session_id passes validation (bot internet room)', async () => {
  const h = await startRpcServerForTest();
  try {
    // Since the bot-internet composer a browser session is a first-class
    // human conversation surface, so it must pass the source_session_id gate.
    // With no metabots wired the request then fails inside createGroupTask
    // (no twin found) — a 500 proves validation PASSED and the request
    // proceeded past the gate.
    const res = await postCreate(h.baseUrl, { title: 'T', goal: 'G', source_session_id: 'sess-browser' });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.success, false);
    // Reached createGroupTask (service boundary), not the source_session_id gate.
    assert.ok(!/standard or browser CoWork session/.test(body.error));
    assert.ok(!/does not refer to an existing/.test(body.error));
  } finally {
    h.cleanup();
  }
});

test('rpc group-task propose: rejects a2a / group_task / unknown source_session_id, accepts browser', async () => {
  const h = await startRpcServerForTest();
  try {
    const postPropose = (body) =>
      fetch(`${h.baseUrl}/api/idbots/group-task/propose-staffing`, {
        method: 'POST',
        headers: RPC_AUTH_HEADERS,
        body: JSON.stringify(body),
      });

    // a2a source: rejected by the symmetric gate BEFORE the service runs.
    let res = await postPropose({ title: 'T', goal: 'G', source_session_id: 'sess-a2a' });
    assert.equal(res.status, 400);
    let body = await res.json();
    assert.ok(/standard or browser CoWork session/.test(body.error), `a2a rejected: ${body.error}`);

    // group_task pseudo namespace: rejected as well.
    res = await postPropose({ title: 'T', goal: 'G', source_session_id: 'sess-group-task' });
    assert.equal(res.status, 400);

    // unknown session: rejected with the existence error.
    res = await postPropose({ title: 'T', goal: 'G', source_session_id: 'sess-does-not-exist' });
    assert.equal(res.status, 400);
    body = await res.json();
    assert.ok(/does not refer to an existing/.test(body.error), `unknown rejected: ${body.error}`);

    // browser source: passes the gate (fails later in the service on an empty
    // staffing session — NOT with the session-type error).
    res = await postPropose({ title: 'T', goal: 'G', source_session_id: 'sess-browser' });
    body = await res.json();
    assert.ok(!/standard or browser CoWork session/.test(body.error ?? ''), `browser passed the gate: ${body.error}`);
    assert.ok(!/does not refer to an existing/.test(body.error ?? ''));
  } finally {
    h.cleanup();
  }
});

test('rpc group-task create: a standard source_session_id passes validation (reaches the service)', async () => {
  const h = await startRpcServerForTest();
  try {
    // A standard session passes the source_session_id gate. With no metabots
    // wired the request then fails inside createGroupTask (no twin found) — a
    // 500 proves validation PASSED and the request proceeded past the gate.
    const res = await postCreate(h.baseUrl, { title: 'T', goal: 'G', source_session_id: 'sess-standard' });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.success, false);
    // Reached createGroupTask (service boundary), not the source_session_id gate.
    assert.ok(!/standard CoWork session/.test(body.error));
    assert.ok(!/does not refer to an existing/.test(body.error));
  } finally {
    h.cleanup();
  }
});

test('fix-v2 P1-4: rpc group-task show rejects an out-of-range limit with a clear 400', async () => {
  const h = await startRpcServerForTest();
  try {
    const postShow = (body) =>
      fetch(`${h.baseUrl}/api/idbots/group-task/show`, {
        method: 'POST',
        headers: RPC_AUTH_HEADERS,
        body: JSON.stringify(body),
      });

    // limit > 200: rejected at the gate with an explicit range error.
    let res = await postShow({ task_id: 1, limit: 201 });
    assert.equal(res.status, 400);
    let body = await res.json();
    assert.ok(/limit must be an integer between 1 and 200/.test(body.error), `limit=201 rejected: ${body.error}`);

    // limit = 0 / non-integer: same gate.
    res = await postShow({ task_id: 1, limit: 0 });
    assert.equal(res.status, 400);
    res = await postShow({ task_id: 1, limit: 2.5 });
    assert.equal(res.status, 400);

    // before_id must be a positive integer too.
    res = await postShow({ task_id: 1, before_id: -3 });
    assert.equal(res.status, 400);
    body = await res.json();
    assert.ok(/before_id must be a positive integer/.test(body.error), `before_id rejected: ${body.error}`);

    // An in-range limit passes validation and reaches the service (no such
    // task in this bare store → 500 proves the gate let it through).
    res = await postShow({ task_id: 9999, view: 'summary', limit: 20 });
    assert.equal(res.status, 500);
    body = await res.json();
    assert.ok(!/limit must be/.test(body.error ?? ''), 'in-range limit passed the gate');
  } finally {
    h.cleanup();
  }
});
