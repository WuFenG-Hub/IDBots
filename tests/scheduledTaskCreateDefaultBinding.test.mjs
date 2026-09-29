/**
 * Scheduled-task session defaulting at the caller layer.
 *
 * Hinting alone did not make bots pass `sessionId`, so create-task.sh now
 * defaults a one-shot ("at") task created inside a session to that session,
 * while recurring tasks keep the fresh-session-per-run default and an explicit
 * sessionId (including null) always wins. update-task.sh deliberately does NOT
 * default — an update with the key absent preserves the existing binding.
 *
 * The payload logic is exercised end-to-end through a PATH-prefixed fake curl
 * (self-contained temp dirs, no external deps), plus source assertions so a
 * rewrite that drops the gate or the opt-out fails loudly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const createTaskScript = path.join(projectRoot, 'SKILLs', 'scheduled-task', 'scripts', 'create-task.sh');
const updateTaskScript = path.join(projectRoot, 'SKILLs', 'scheduled-task', 'scripts', 'update-task.sh');

const createTaskSource = fs.readFileSync(createTaskScript, 'utf8');
const updateTaskSource = fs.readFileSync(updateTaskScript, 'utf8');

// --- Source contract -------------------------------------------------------

test('create-task.sh has a one-shot defaulting step after the "current" resolution', () => {
  assert.match(createTaskSource, /^apply_default_session_binding\(\) \{/m);
  // Invoked after resolve_current_session_id_in_payload, before the POST.
  const resolveIndex = createTaskSource.indexOf('PAYLOAD="$(resolve_current_session_id_in_payload "$PAYLOAD")"');
  const defaultIndex = createTaskSource.indexOf('PAYLOAD="$(apply_default_session_binding "$PAYLOAD")"');
  const postIndex = createTaskSource.indexOf('/api/scheduled-tasks" "$PAYLOAD"');
  assert.ok(resolveIndex > 0, 'resolve_current_session_id_in_payload must still be invoked');
  assert.ok(defaultIndex > resolveIndex, 'the defaulting step must run after the "current" resolution');
  assert.ok(postIndex > defaultIndex, 'the defaulting step must run before the POST');
});

test('the default only applies to one-shot "at" tasks with an absent/empty sessionId', () => {
  // Gate on the schedule type and on the key being absent or an empty string —
  // an explicit null (or any explicit value) must stay untouched.
  assert.match(createTaskSource, /scheduleType === 'at'/);
  assert.match(createTaskSource, /hasOwnProperty\.call\(parsed, 'sessionId'\) \|\| parsed\.sessionId === ''/);
  // The opt-out note is what tells a bot author how to force a new session.
  assert.match(createTaskSource, /Note: one-shot task defaults to current session/);
  assert.match(createTaskSource, /pass "sessionId": null to run in a new session/);
});

test('update-task.sh never defaults the binding', () => {
  assert.doesNotMatch(updateTaskSource, /apply_default_session_binding/);
  assert.doesNotMatch(updateTaskSource, /scheduleType === 'at'/);
  // It documents where the default lives instead.
  assert.match(updateTaskSource, /create-task\.sh defaults one-shot "at" tasks to the current session/);
});

// --- End-to-end payload behaviour -----------------------------------------

const harnessRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-task-default-'));
const binDir = path.join(harnessRoot, 'bin');
const outDir = path.join(harnessRoot, 'out');
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
const fakeCurl = path.join(binDir, 'curl');
fs.writeFileSync(
  fakeCurl,
  [
    '#!/bin/bash',
    'body=""',
    'prev=""',
    'for arg in "$@"; do',
    '  if [ "$prev" = "-d" ]; then body="$arg"; fi',
    '  prev="$arg"',
    'done',
    'printf \'%s\' "$body" > "${FAKE_CURL_OUT}/body.json"',
    'printf \'{"success":true,"task":{"id":"task-fake"}}\'',
    '',
  ].join('\n'),
);
fs.chmodSync(fakeCurl, 0o755);

test.after(() => {
  fs.rmSync(harnessRoot, { recursive: true, force: true });
});

const futureLocalDatetime = () => {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

function runCreateTask(payload, envOverrides = {}) {
  const bodyFile = path.join(outDir, 'body.json');
  fs.rmSync(bodyFile, { force: true });
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    IDBOTS_API_BASE_URL: 'http://127.0.0.1:1',
    FAKE_CURL_OUT: outDir,
    ...envOverrides,
  };
  delete env.IDBOTS_METABOT_ID;
  if (!('IDBOTS_COWORK_SESSION_ID' in envOverrides) || envOverrides.IDBOTS_COWORK_SESSION_ID == null) {
    delete env.IDBOTS_COWORK_SESSION_ID;
  }
  const run = spawnSync('bash', [createTaskScript, JSON.stringify(payload)], { env, encoding: 'utf8' });
  return {
    status: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    sent: fs.existsSync(bodyFile) ? JSON.parse(fs.readFileSync(bodyFile, 'utf8')) : null,
  };
}

const oneShotPayload = () => ({
  name: 'check the release',
  prompt: 'verify the build that was just started',
  schedule: { type: 'at', datetime: futureLocalDatetime() },
});

test('one-shot "at" without sessionId gains the current session id', () => {
  const payload = oneShotPayload();
  const run = runCreateTask(payload, { IDBOTS_COWORK_SESSION_ID: 'sess-default-1' });
  assert.equal(run.status, 0);
  assert.equal(JSON.parse(run.stdout).success, true);
  assert.deepEqual(run.sent, { ...payload, sessionId: 'sess-default-1' });
  assert.match(run.stderr, /one-shot task defaults to current session sess-default-1/);
  assert.match(run.stderr, /pass "sessionId": null to run in a new session/);
});

test('an empty-string sessionId is eligible for the one-shot default', () => {
  const payload = { ...oneShotPayload(), sessionId: '' };
  const run = runCreateTask(payload, { IDBOTS_COWORK_SESSION_ID: 'sess-default-1' });
  assert.equal(run.status, 0);
  assert.equal(run.sent.sessionId, 'sess-default-1');
});

test('an explicit null opts a one-shot task out of the default', () => {
  const payload = { ...oneShotPayload(), sessionId: null };
  const run = runCreateTask(payload, { IDBOTS_COWORK_SESSION_ID: 'sess-default-1' });
  assert.equal(run.status, 0);
  assert.deepEqual(run.sent, payload);
  assert.equal(run.sent.sessionId, null);
  assert.doesNotMatch(run.stderr, /defaults to current session/);
});

test('an explicit UUID wins over the one-shot default', () => {
  const payload = { ...oneShotPayload(), sessionId: '11111111-2222-3333-4444-555555555555' };
  const run = runCreateTask(payload, { IDBOTS_COWORK_SESSION_ID: 'sess-default-1' });
  assert.equal(run.status, 0);
  assert.deepEqual(run.sent, payload);
});

test('recurring interval and cron tasks are left unbound', () => {
  const intervalPayload = {
    name: 'hourly check',
    prompt: 'poll the queue',
    schedule: { type: 'interval', intervalMs: 3600000 },
  };
  const intervalRun = runCreateTask(intervalPayload, { IDBOTS_COWORK_SESSION_ID: 'sess-default-1' });
  assert.equal(intervalRun.status, 0);
  assert.deepEqual(intervalRun.sent, intervalPayload);
  assert.equal('sessionId' in intervalRun.sent, false);

  const cronPayload = {
    name: 'daily report',
    prompt: 'post the daily report',
    schedule: { type: 'cron', expression: '0 9 * * *' },
  };
  const cronRun = runCreateTask(cronPayload, { IDBOTS_COWORK_SESSION_ID: 'sess-default-1' });
  assert.equal(cronRun.status, 0);
  assert.deepEqual(cronRun.sent, cronPayload);
  assert.equal('sessionId' in cronRun.sent, false);
});

test('one-shot "at" without sessionId and without the env id stays untouched', () => {
  const payload = oneShotPayload();
  const run = runCreateTask(payload);
  assert.equal(run.status, 0);
  assert.deepEqual(run.sent, payload);
  assert.equal('sessionId' in run.sent, false);
  assert.doesNotMatch(run.stderr, /defaults to current session/);
});

test('sessionId "current" still resolves to the env id on any schedule type', () => {
  const payload = { name: 'daily report', prompt: 'post it', schedule: { type: 'cron', expression: '0 9 * * *' }, sessionId: 'current' };
  const run = runCreateTask(payload, { IDBOTS_COWORK_SESSION_ID: 'sess-current-7' });
  assert.equal(run.status, 0);
  assert.equal(run.sent.sessionId, 'sess-current-7');
  // Already resolved, so the defaulting step has nothing to announce.
  assert.doesNotMatch(run.stderr, /defaults to current session/);
});
