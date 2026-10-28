import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * REQ-A-24 — mobile gateway channel unit tests.
 *
 * Covers `gateway:file:sign` (happy path with an injected gateway context via
 * the wiring test seam + the structured gateway-not-running failure),
 * the pending-permission tracker behind `mobile:permission:listPending`
 * (record on raise / remove on resolve), and the readiness provider behind
 * `mobile:bootstrap:status`.
 */

const require = createRequire(import.meta.url);

const wiring = require('../dist-electron/main/gateway/wiring.js');
const { createGatewayFileSignHandler } = require('../dist-electron/main/gateway/fileSignChannel.js');
const pendingPermissions = require('../dist-electron/main/ipc/pendingPermissions.js');
const { sanitizeIpcPayload } = require('../dist-electron/main/ipc/sanitize.js');

const SECRET = 'test-gateway-secret';
const TENANT = 't_testtenant0000000001';

function makeTenantTree(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-channels-')));
  const paths = {
    dataRoot: path.join(base, 'data'),
    workspaceRoot: path.join(base, 'data', 'workspace'),
    uploadsRoot: path.join(base, 'data', 'workspace', 'uploads'),
  };
  fs.mkdirSync(paths.uploadsRoot, { recursive: true });
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
    wiring.setGatewayContextForTesting(null);
    wiring.setGatewayReadinessForTesting(null);
  });
  return { base, paths };
}

// ---------------------------------------------------------------------------
// gateway:file:sign
// ---------------------------------------------------------------------------

test('gateway:file:sign returns a signed descriptor for a path inside the data root', async (t) => {
  const { paths } = makeTenantTree(t);
  const filePath = path.join(paths.workspaceRoot, 'report.pdf');
  fs.writeFileSync(filePath, Buffer.from('%PDF-1.4 stub'));

  wiring.setGatewayContextForTesting({ secret: SECRET, tenantId: TENANT, paths });
  const handler = createGatewayFileSignHandler(wiring.getActiveGatewayContext);

  const result = await handler({}, { path: filePath, disposition: 'inline' });
  assert.equal(result.success, undefined, 'happy path returns the descriptor, not an envelope');
  assert.match(result.url, /^\/gateway\/v1\/files\//);
  assert.equal(result.size, Buffer.from('%PDF-1.4 stub').length);
  assert.equal(result.mime, 'application/pdf');
  assert.ok(result.expiresAt > Date.now());
});

test('gateway:file:sign reports ARG_RESTRICTED for a path outside the data root', async (t) => {
  const { paths } = makeTenantTree(t);
  wiring.setGatewayContextForTesting({ secret: SECRET, tenantId: TENANT, paths });
  const handler = createGatewayFileSignHandler(wiring.getActiveGatewayContext);

  const outside = path.join(paths.dataRoot, '..', 'outside.txt');
  fs.writeFileSync(outside, 'nope');
  const result = await handler({}, { path: outside });
  assert.equal(result.success, false);
  assert.equal(result.code, 'ARG_RESTRICTED');
});

test('gateway:file:sign returns a structured failure when the gateway is not running', async (t) => {
  t.after(() => wiring.setGatewayContextForTesting(null));
  wiring.setGatewayContextForTesting(null);
  const handler = createGatewayFileSignHandler(wiring.getActiveGatewayContext);

  const result = await handler({}, { path: '/anywhere.txt' });
  assert.deepEqual(result, { success: false, error: 'gateway not running' });
});

// ---------------------------------------------------------------------------
// mobile:permission:listPending tracker
// ---------------------------------------------------------------------------

test('pending-permission tracker records on raise, removes on resolve, lists in order', (t) => {
  t.after(() => pendingPermissions.resetPendingPermissionsForTests());
  pendingPermissions.resetPendingPermissionsForTests();

  // The tracker keys off request.requestId; a request without one is ignored.
  pendingPermissions.trackPendingPermission('s1', { toolName: 'Bash', toolInput: {} });
  assert.equal(pendingPermissions.listPendingPermissions().length, 0);

  pendingPermissions.trackPendingPermission('s1', { requestId: 'r1', toolName: 'Bash', toolInput: { command: 'ls' } });
  pendingPermissions.trackPendingPermission('s2', { requestId: 'r2', toolName: 'AskUserQuestion', toolInput: {} });
  let list = pendingPermissions.listPendingPermissions();
  assert.equal(list.length, 2);
  assert.equal(list[0].sessionId, 's1');
  assert.equal(list[0].request.requestId, 'r1');
  assert.equal(list[1].sessionId, 's2');
  assert.ok(list[0].createdAt > 0);

  pendingPermissions.resolvePendingPermission('s1', 'r1');
  list = pendingPermissions.listPendingPermissions();
  assert.equal(list.length, 1);
  assert.equal(list[0].request.requestId, 'r2');

  // Session-level sweep clears the rest (safety net for session-stop hooks).
  pendingPermissions.clearPendingPermissionsForSession('s2');
  assert.equal(pendingPermissions.listPendingPermissions().length, 0);
});

test('mobile:permission:listPending payload survives the IPC sanitizer', (t) => {
  t.after(() => pendingPermissions.resetPendingPermissionsForTests());
  pendingPermissions.resetPendingPermissionsForTests();
  pendingPermissions.trackPendingPermission('s1', { requestId: 'r1', toolName: 'Bash', toolInput: { command: 'ls' } });

  const sanitized = sanitizeIpcPayload(pendingPermissions.listPendingPermissions());
  assert.equal(sanitized.length, 1);
  assert.equal(sanitized[0].sessionId, 's1');
  assert.equal(sanitized[0].request.requestId, 'r1');
  assert.equal(sanitized[0].request.toolName, 'Bash');
});

test('long-term board participants survive the bounded IPC sanitizer', () => {
  const sanitized = sanitizeIpcPayload({
    success: true,
    board: {
      generatedAtMs: 1,
      columns: [],
      cards: [{ id: 'lt-1', participants: [{ id: 1, name: 'Gateway Twin', avatar: null }] }],
    },
  });
  assert.deepEqual(sanitized.board.cards[0].participants, [{ id: 1, name: 'Gateway Twin', avatar: null }]);

  // F-17a raised IPC_MAX_DEPTH 6 -> 10 (the gateway event fan-out needs headroom
  // for ask-option objects), so the cap now bites one level deeper: depth six
  // survives, depth ten is the hard cut.
  const deep = sanitizeIpcPayload({ a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } } });
  assert.equal(deep.a.b.c.d.e.f.g, 'too deep', 'depth six values still survive');
  const past = sanitizeIpcPayload({ a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 'past the cap' } } } } } } } } } });
  assert.equal(past.a.b.c.d.e.f.g.h.i, '[truncated-depth]', 'the depth cap remains enforced');
});

test('IPC sanitizer preserves deep gateway-wrapped objects and truncates past the cap', () => {
  const nested = (value, depth) => {
    let result = value;
    for (let index = 0; index < depth; index += 1) result = { child: result };
    return result;
  };
  const atDepthSix = (value) => value.child.child.child.child.child.child;
  const atDepthTen = (value) => value.child.child.child.child.child.child.child.child.child.child;
  assert.equal(atDepthSix(sanitizeIpcPayload(nested('keep', 6))), 'keep');
  assert.deepEqual(atDepthSix(sanitizeIpcPayload(nested('drop', 8))), { child: { child: 'drop' } }, 'event-fan-out depth survives the raised cap');
  assert.equal(atDepthTen(sanitizeIpcPayload(nested('drop', 12))), '[truncated-depth]');
});

// ---------------------------------------------------------------------------
// mobile:bootstrap:status (readiness provider seam)
// ---------------------------------------------------------------------------

test('bootstrap status returns the injected readiness provider onboarding object', (t) => {
  t.after(() => wiring.setGatewayReadinessForTesting(null));
  const onboarding = {
    identity: 'done',
    llmProvider: 'done',
    twinMetabot: 'running',
    workspace: 'pending',
    trafficAccount: 'done',
    redeemCode: 'skipped',
    globalMetaId: 'idq1test',
    twinMetabotId: 7,
  };
  wiring.setGatewayReadinessForTesting(() => ({
    phase: 'bootstrapping',
    version: '0.0.0-test',
    commit: 'test',
    contractVersion: '1.0.0',
    onboarding,
    error: null,
  }));

  const state = wiring.getActiveGatewayReadiness();
  assert.deepEqual(state.onboarding, onboarding);
});

test('bootstrap status falls back to the dev default when no provider ran', (t) => {
  t.after(() => wiring.setGatewayReadinessForTesting(null));
  wiring.setGatewayReadinessForTesting(null);
  const onboarding = wiring.getActiveGatewayReadiness().onboarding;
  assert.deepEqual(onboarding, {
    identity: 'done',
    llmProvider: 'done',
    twinMetabot: 'done',
    workspace: 'done',
    trafficAccount: 'done',
    redeemCode: 'skipped',
    globalMetaId: null,
    twinMetabotId: null,
  });
});
