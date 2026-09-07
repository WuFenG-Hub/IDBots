import test from 'node:test';
import assert from 'node:assert/strict';

// The electron compile output lives under dist-electron/main/ (tsc rootDir=src
// since the src/main+src/renderer split). Probe the current layout first and
// fall back to the legacy flat path for older checkouts.
const forwardingModule = await import('../dist-electron/main/services/coworkStreamForwarding.js')
  .catch(() => import('../dist-electron/services/coworkStreamForwarding.js'));
const { shouldForwardCoworkStreamEvent } = forwardingModule;

test('shouldForwardCoworkStreamEvent suppresses hidden internal sessions', () => {
  const store = {
    isSessionHiddenFromList(sessionId) {
      return sessionId === 'hidden-order-execution';
    },
  };

  assert.equal(shouldForwardCoworkStreamEvent(store, 'hidden-order-execution'), false);
  assert.equal(shouldForwardCoworkStreamEvent(store, 'visible-peer-session'), true);
});

test('shouldForwardCoworkStreamEvent falls back to session visibility when lightweight lookup is unavailable', () => {
  const store = {
    getSession(sessionId) {
      return {
        id: sessionId,
        hiddenFromSessionList: sessionId === 'hidden-session',
      };
    },
  };

  assert.equal(shouldForwardCoworkStreamEvent(store, 'hidden-session'), false);
  assert.equal(shouldForwardCoworkStreamEvent(store, 'visible-session'), true);
});

test('shouldForwardCoworkStreamEvent keeps forwarding when visibility cannot be read', () => {
  const store = {
    isSessionHiddenFromList() {
      throw new Error('database unavailable');
    },
  };

  assert.equal(shouldForwardCoworkStreamEvent(store, 'unknown-session'), true);
});
