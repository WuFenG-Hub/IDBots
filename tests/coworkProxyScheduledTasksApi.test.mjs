/**
 * Runtime tests for the cowork proxy's scheduled-task management HTTP API.
 * The scheduled-task skill scripts (list/get/update/delete/toggle) talk to
 * `${IDBOTS_API_BASE_URL}/api/scheduled-tasks...`; historically only POST
 * create existed, so every other script 404'd with not_found_error and the
 * only workaround was direct sqlite edits. These tests pin the full route
 * set against a fake store injected via setScheduledTaskDeps.
 *
 * Requires `npm run compile:electron` to have run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

// The POST create handler pings renderer windows via electron's BrowserWindow.
// Plain Node resolves `require('electron')` to the binary path string, so stub
// the module before the proxy loads (same trick other electron-runtime tests
// in this directory use).
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: () => process.cwd(),
      },
      BrowserWindow: { getAllWindows: () => [] },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

let proxy;
try {
  proxy = await import('../dist-electron/main/libs/coworkOpenAICompatProxy.js');
} catch {
  proxy = await import('../dist-electron/main/libs/coworkOpenAICompatProxy.js');
}

const {
  setScheduledTaskDeps,
  startCoworkOpenAICompatProxy,
  stopCoworkOpenAICompatProxy,
  getCoworkOpenAICompatProxyBaseURL,
} = proxy;

function buildFakeStores() {
  const tasks = new Map();
  let nextId = 1;
  const calls = { reschedule: 0, stopTask: [] };
  const makeTask = (patch) => ({
    id: `task-${nextId++}`,
    name: 'Daily skill',
    prompt: 'original prompt',
    schedule: { type: 'cron', expression: '0 8 * * *' },
    workingDirectory: '/tmp/project',
    metabotId: null,
    enabled: true,
    state: 'idle',
    ...patch,
  });
  const seed = makeTask();
  tasks.set(seed.id, seed);

  const store = {
    listTasks: () => [...tasks.values()],
    getTask: (id) => tasks.get(id) ?? null,
    createTask: (input) => {
      const task = makeTask(input);
      tasks.set(task.id, task);
      return task;
    },
    updateTask: (id, input) => {
      const existing = tasks.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...input };
      tasks.set(id, updated);
      return updated;
    },
    deleteTask: (id) => tasks.delete(id),
    toggleTask: (id, enabled) => {
      const task = tasks.get(id);
      if (!task) return { task: null, warning: null };
      const updated = { ...task, enabled };
      tasks.set(id, updated);
      return { task: updated, warning: null };
    },
  };
  const scheduler = {
    reschedule: () => { calls.reschedule += 1; },
    stopTask: (id) => { calls.stopTask.push(id); },
  };
  return { store, scheduler, calls, tasks, seedId: seed.id };
}

async function setup(depsPatch = {}) {
  const fake = buildFakeStores();
  setScheduledTaskDeps({
    getScheduledTaskStore: () => fake.store,
    getScheduler: () => fake.scheduler,
    ...depsPatch,
  });
  await startCoworkOpenAICompatProxy();
  const base = getCoworkOpenAICompatProxyBaseURL();
  assert.ok(base, 'proxy base URL must resolve after start');
  return { ...fake, base };
}

function createViaApi(base, patch = {}) {
  return fetch(`${base}/api/scheduled-tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Bound task',
      prompt: 'follow up here',
      schedule: { type: 'cron', expression: '0 8 * * *' },
      ...patch,
    }),
  });
}

function updateViaApi(base, id, patch = {}) {
  return fetch(`${base}/api/scheduled-tasks/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

test.afterEach(async () => {
  await stopCoworkOpenAICompatProxy();
});

test('GET /api/scheduled-tasks lists tasks from the store', async () => {
  const { base, seedId } = await setup();
  const res = await fetch(`${base}/api/scheduled-tasks`, { headers: { Accept: 'application/json' } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.ok(Array.isArray(body.tasks));
  assert.ok(body.tasks.some((task) => task.id === seedId));
});

test('GET /api/scheduled-tasks/:id returns the task and 404s on unknown id', async () => {
  const { base, seedId } = await setup();
  const ok = await fetch(`${base}/api/scheduled-tasks/${seedId}`);
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.equal(okBody.success, true);
  assert.equal(okBody.task.id, seedId);

  const missing = await fetch(`${base}/api/scheduled-tasks/nope`);
  assert.equal(missing.status, 404);
  const missingBody = await missing.json();
  assert.equal(missingBody.success, false);
});

test('PUT /api/scheduled-tasks/:id updates the prompt and reschedules', async () => {
  const { base, seedId, calls, store } = await setup();
  const res = await fetch(`${base}/api/scheduled-tasks/${seedId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'updated prompt with 免确认 clause' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.task.prompt, 'updated prompt with 免确认 clause');
  // Read back through the store (what list-tasks.sh serves).
  assert.equal(store.getTask(seedId).prompt, 'updated prompt with 免确认 clause');
  assert.ok(calls.reschedule >= 1, 'scheduler.reschedule must run after update');
});

test('PUT /api/scheduled-tasks/:id validates partial payloads', async () => {
  const { base, seedId } = await setup();
  const badName = await fetch(`${base}/api/scheduled-tasks/${seedId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '   ' }),
  });
  assert.equal(badName.status, 400);

  const badSchedule = await fetch(`${base}/api/scheduled-tasks/${seedId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schedule: { type: 'weekly' } }),
  });
  assert.equal(badSchedule.status, 400);

  const missing = await fetch(`${base}/api/scheduled-tasks/nope`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'x' }),
  });
  assert.equal(missing.status, 404);
});

test('POST /api/scheduled-tasks/:id/toggle flips enabled and reschedules', async () => {
  const { base, seedId, calls, store } = await setup();
  const res = await fetch(`${base}/api/scheduled-tasks/${seedId}/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.task.enabled, false);
  assert.equal(store.getTask(seedId).enabled, false);
  assert.ok(calls.reschedule >= 1);

  const invalid = await fetch(`${base}/api/scheduled-tasks/${seedId}/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: 'yes' }),
  });
  assert.equal(invalid.status, 400);
});

test('DELETE /api/scheduled-tasks/:id stops, deletes and reschedules', async () => {
  const { base, seedId, calls, store } = await setup();
  const res = await fetch(`${base}/api/scheduled-tasks/${seedId}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.result, true);
  assert.equal(store.getTask(seedId), null);
  assert.deepEqual(calls.stopTask, [seedId]);
  assert.ok(calls.reschedule >= 1);

  const missing = await fetch(`${base}/api/scheduled-tasks/${seedId}`, { method: 'DELETE' });
  assert.equal(missing.status, 404);
});

test('unrelated paths still return the Anthropic-style 404', async () => {
  const { base } = await setup();
  const res = await fetch(`${base}/api/unknown-endpoint`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'not_found_error');
});

test('PUT rejects an "at" schedule datetime in the past', async () => {
  const { base, seedId } = await setup();
  const past = new Date(Date.now() - 3600_000).toISOString();
  const res = await fetch(`${base}/api/scheduled-tasks/${seedId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schedule: { type: 'at', datetime: past } }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /must be in the future/);
});

test('PUT trims name and prompt before storing', async () => {
  const { base, seedId, store } = await setup();
  const res = await fetch(`${base}/api/scheduled-tasks/${seedId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '  Daily skill  ', prompt: '  run the pipeline  ' }),
  });
  assert.equal(res.status, 200);
  const stored = store.getTask(seedId);
  assert.equal(stored.name, 'Daily skill');
  assert.equal(stored.prompt, 'run the pipeline');
});

test('oversized update body gets 413, not 400', async () => {
  const { base, seedId } = await setup();
  const res = await fetch(`${base}/api/scheduled-tasks/${seedId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: 'a'.repeat(21 * 1024 * 1024 + 1),
  });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.match(body.error, /too large/i);
});

test('POST create stores a sessionId binding as targetSessionId (readable via GET)', async () => {
  const { base } = await setup();
  const res = await createViaApi(base, { sessionId: '  session-uuid-1  ' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.sessionWarning, undefined);

  const read = await (await fetch(`${base}/api/scheduled-tasks/${body.task.id}`)).json();
  assert.equal(read.task.targetSessionId, 'session-uuid-1');
});

test('POST create without sessionId stores no binding and does not warn', async () => {
  const { base } = await setup();
  const body = await (await createViaApi(base)).json();
  assert.equal(body.success, true);
  assert.equal(body.task.targetSessionId, undefined);
  assert.equal(body.sessionWarning, undefined);
});

test('POST create treats the unresolved literal "current" as omitted, never storing it', async () => {
  const { base } = await setup({ isSessionUsableAsTaskTarget: () => true });
  const res = await createViaApi(base, { sessionId: 'current' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.task.targetSessionId, undefined);
  assert.match(body.sessionWarning, /current/);
});

test('POST create warns when the bound session does not resolve, but still creates', async () => {
  const { base } = await setup({ isSessionUsableAsTaskTarget: () => false });
  const res = await createViaApi(base, { sessionId: 'missing-session' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.task.targetSessionId, 'missing-session');
  assert.match(body.sessionWarning, /missing-session/);
  assert.match(body.sessionWarning, /new session/);
});

test('POST create stays silent when the bound session resolves', async () => {
  const { base } = await setup({ isSessionUsableAsTaskTarget: () => true });
  const body = await (await createViaApi(base, { sessionId: 'live-session' })).json();
  assert.equal(body.task.targetSessionId, 'live-session');
  assert.equal(body.sessionWarning, undefined);
});

test('PUT update sets, preserves and clears the session binding', async () => {
  const { base } = await setup({ isSessionUsableAsTaskTarget: () => true });
  const created = await (await createViaApi(base, { sessionId: 'session-a' })).json();
  const id = created.task.id;

  // A partial update that does not mention sessionId keeps the binding.
  const untouched = await (await updateViaApi(base, id, { prompt: 'updated prompt' })).json();
  assert.equal(untouched.task.targetSessionId, 'session-a');

  // A session UUID replaces it.
  const rebound = await (await updateViaApi(base, id, { sessionId: 'session-b' })).json();
  assert.equal(rebound.task.targetSessionId, 'session-b');
  assert.equal(rebound.sessionWarning, undefined);

  // "current" must never be stored — the existing binding is kept.
  const literal = await (await updateViaApi(base, id, { sessionId: 'current' })).json();
  assert.equal(literal.task.targetSessionId, 'session-b');
  assert.match(literal.sessionWarning, /current/);

  // null and '' both clear the binding.
  const cleared = await (await updateViaApi(base, id, { sessionId: null })).json();
  assert.equal(cleared.task.targetSessionId, null);

  await updateViaApi(base, id, { sessionId: 'session-c' });
  const clearedEmpty = await (await updateViaApi(base, id, { sessionId: '' })).json();
  assert.equal(clearedEmpty.task.targetSessionId, null);
});

test('PUT update warns when the new session binding does not resolve', async () => {
  const { base } = await setup({ isSessionUsableAsTaskTarget: () => false });
  const created = await (await createViaApi(base)).json();
  const body = await (await updateViaApi(base, created.task.id, { sessionId: 'ghost-session' })).json();
  assert.equal(body.task.targetSessionId, 'ghost-session');
  assert.match(body.sessionWarning, /ghost-session/);
});

test('PUT rejects a non-string sessionId', async () => {
  const { base, seedId } = await setup();
  const res = await updateViaApi(base, seedId, { sessionId: 42 });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /sessionId must be a string/);
});
