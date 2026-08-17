import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { gateExternalChairSend } = require('../dist-electron/main/services/groupTaskDaemon.js');

// ---------------------------------------------------------------------------
// P2: gateExternalChairSend (pure)
// ---------------------------------------------------------------------------

test('P2: an external chair-identity send without confirm_chair is refused', () => {
  const result = gateExternalChairSend({
    taskId: 21,
    senderMetabotId: 1,
    chairMetabotId: 1,
    confirmChair: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CHAIR_IDENTITY_CONFIRM_REQUIRED');
  assert.match(result.error, /confirm_chair/);
  assert.match(result.error, /task 21/);
});

test('P2: the explicit confirm_chair escape hatch passes the guard', () => {
  const result = gateExternalChairSend({
    taskId: 21,
    senderMetabotId: 1,
    chairMetabotId: 1,
    confirmChair: true,
  });
  assert.deepEqual(result, { ok: true });
});

test('P2: worker-identity sends are never blocked by the impersonation guard', () => {
  const result = gateExternalChairSend({
    taskId: 21,
    senderMetabotId: 2,
    chairMetabotId: 1,
    confirmChair: false,
  });
  assert.deepEqual(result, { ok: true });
});

// ---------------------------------------------------------------------------
// Static guards: the RPC wires the impersonation gate before the F2 mutex,
// and the skill script forwards the escape hatch.
// ---------------------------------------------------------------------------

test('RPC send handler runs the impersonation gate first and answers 403 with the code', () => {
  const source = fs.readFileSync(
    path.join(projectRoot, 'src', 'main', 'services', 'metaidRpcServer.ts'),
    'utf8',
  );
  const gateIndex = source.indexOf('gateExternalChairSend({');
  const mutexIndex = source.indexOf('gateChairDrivingSend({');
  assert.ok(gateIndex >= 0, 'impersonation gate is wired');
  assert.ok(mutexIndex > gateIndex, 'impersonation gate runs BEFORE the F2 mutex');
  const block = source.slice(gateIndex, gateIndex + 1200);
  assert.match(block, /writeHead\(403\)/);
  assert.match(block, /code: impersonationGate\.code/);
  assert.match(block, /confirmChair: parsed\.confirm_chair === true/);
});

test('skill script forwards confirm_chair and driver_id on send', () => {
  const source = fs.readFileSync(
    path.join(projectRoot, 'SKILLs', 'metabot-group-task', 'scripts', 'index.js'),
    'utf8',
  );
  assert.match(source, /params\.confirm_chair === true\) body\.confirm_chair = true/);
  assert.match(source, /params\.driver_id \?\? ''\)\.trim\(\)/);
});

test('SKILL.md documents the guard and the supervisor-not-speaker rule', () => {
  const source = fs.readFileSync(
    path.join(projectRoot, 'SKILLs', 'metabot-group-task', 'SKILL.md'),
    'utf8',
  );
  assert.match(source, /CHAIR_IDENTITY_CONFIRM_REQUIRED/);
  assert.match(source, /Never retry a refused chair send in a loop/);
  assert.match(source, /supervisor, not the speaker/);
});
