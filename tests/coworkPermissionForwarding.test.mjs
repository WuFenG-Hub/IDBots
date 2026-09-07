import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function extractRunnerHandler(source, eventName) {
  const anchor = source.indexOf(`coworkRunner.on('${eventName}'`);
  assert.ok(anchor >= 0, `main.ts must register a handler for '${eventName}'`);
  const next = source.indexOf("coworkRunner.on('", anchor + 1);
  return source.slice(anchor, next > anchor ? next : undefined);
}

/**
 * Regression guard for the invisible-confirmation-dialog defect: the
 * permissionRequest bridge used to drop prompts for sessions hidden from the
 * session list (hidden_from_session_list=1), so the owner never saw any
 * confirmation UI and the runner's 60s watchdog auto-denied the request.
 */
test('permissionRequest forwarding ignores session-list visibility', () => {
  const source = read('src/main/main.ts');
  const handler = extractRunnerHandler(source, 'permissionRequest');

  // The permission bridge must not silently drop prompts for hidden
  // sessions — that burns the watchdog into an automatic denial with no
  // visible UI. The renderer's global overlay renders prompts for sessions
  // that have no inline composer seat.
  assert.equal(
    /shouldForwardCoworkStreamEvent/.test(handler),
    false,
    'permissionRequest handler must not gate on session-list visibility',
  );

  // The text-confirmation gate for private-chat automation stays: non-Ask
  // prompts in text mode are answered through the message channel, and
  // AskUserQuestion remains a user-facing interaction. Suppression now also
  // requires a live text-relay owner (IM chats, gig orders) — text-mode
  // orchestrator/worker/scheduler sessions must reach the renderer overlay.
  assert.match(handler, /getSessionConfirmationMode\(sessionId\) === 'text'/);
  assert.match(handler, /request\?\.toolName !== 'AskUserQuestion'/);
  assert.match(handler, /coworkRunner\.hasTextPermissionRelay\(sessionId\)/);

  // Prompts must still reach every window with the session id attached.
  assert.match(handler, /webContents\.send\('cowork:stream:permission', \{ sessionId, request: safeRequest \}/);
});

test('stream events keep their session-visibility gate (only permissions are exempt)', () => {
  const source = read('src/main/main.ts');

  for (const eventName of ['message', 'messageUpdate', 'complete', 'error']) {
    assert.match(
      extractRunnerHandler(source, eventName),
      /shouldForwardCoworkStreamEvent/,
      `'${eventName}' handler should still gate on session-list visibility`,
    );
  }
});
