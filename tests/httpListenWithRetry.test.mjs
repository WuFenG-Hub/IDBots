// MetaID RPC gateway bind resilience:
//  - EADDRINUSE retries never stack one-shot 'listening' listeners
//    (MaxListenersExceededWarning, replayed callbacks on the eventual bind);
//  - after the fast retry budget is spent, a slow background rebind keeps
//    trying until the port frees up — a sibling dev instance or zombie
//    process holding 31200 must not kill this process's skill RPC channels
//    for its whole lifetime;
//  - without rebindDelayMs the legacy give-up behavior is unchanged.
// Requires: npm run compile:electron.

import assert from 'node:assert/strict';
import http from 'node:http';
import Module from 'node:module';
import test from 'node:test';

const requireFromHere = Module.createRequire(import.meta.url);
const { listenWithRetry } = requireFromHere('../dist-electron/main/services/httpListenWithRetry.js');

function createSilentLogger(sink) {
  return {
    warn: (message) => sink.push({ level: 'warn', message: String(message) }),
    error: (message) => sink.push({ level: 'error', message: String(message) }),
  };
}

function listenOnce(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

async function holdPort(port) {
  const blocker = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('busy');
  });
  await listenOnce(blocker, port);
  return {
    close: () => new Promise((resolve) => blocker.close(() => resolve())),
  };
}

async function freePort() {
  const probe = http.createServer();
  await listenOnce(probe, 0);
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(() => resolve()));
  return port;
}

async function waitFor(predicate, timeoutMs = 3000, stepMs = 10) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return predicate();
}

test('binds immediately when the port is free', async (t) => {
  const port = await freePort();
  const server = http.createServer();
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  const logs = [];
  let listening = 0;

  listenWithRetry(server, port, '127.0.0.1', {
    logger: createSilentLogger(logs),
    onListening: () => { listening += 1; },
  });

  assert.ok(await waitFor(() => server.listening));
  assert.equal(listening, 1);
  assert.equal(logs.length, 0, 'no warn/error noise on a clean bind');
});

test('EADDRINUSE: slow background rebind recovers once the port frees, without listener leaks', async (t) => {
  const port = await freePort();
  const blocker = await holdPort(port);
  // t.after guards: even a failed assertion must release the port and stop
  // the server, or the open handles keep the test process alive forever.
  t.after(() => blocker.close());
  const server = http.createServer();
  // http.Server carries one internal 'listening' listener from construction;
  // retries must never stack MORE than that baseline.
  const baselineListeningListeners = server.listenerCount('listening');
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  const logs = [];
  let listening = 0;

  listenWithRetry(server, port, '127.0.0.1', {
    retryDelayMs: 10,
    maxAttempts: 3,
    rebindDelayMs: 20,
    logger: createSilentLogger(logs),
    onListening: () => { listening += 1; },
  });

  // Spend the fast budget and settle into background rebind mode.
  assert.ok(await waitFor(() => logs.some((entry) => entry.level === 'error')));
  assert.equal(server.listening, false);
  assert.ok(
    server.listenerCount('listening') <= baselineListeningListeners + 1,
    `retries must not stack 'listening' listeners (baseline ${baselineListeningListeners}, got ${server.listenerCount('listening')})`,
  );
  assert.ok(
    logs.some((entry) => entry.level === 'error' && entry.message.includes('background rebind')),
    `background rebind announcement missing: ${JSON.stringify(logs)}`,
  );

  // Port frees up (sibling instance quit): the gateway must come back on its own.
  await blocker.close();
  assert.ok(await waitFor(() => server.listening), 'server rebinds after the port frees');
  assert.equal(listening, 1, 'onListening fires exactly once');
  assert.equal(server.listenerCount('listening'), baselineListeningListeners, 'settled server keeps no stray listeners');
});

test('without rebindDelayMs the legacy give-up behavior is unchanged', async (t) => {
  const port = await freePort();
  const blocker = await holdPort(port);
  t.after(() => blocker.close());
  const server = http.createServer();
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  const baselineListeningListeners = server.listenerCount('listening');
  const logs = [];

  listenWithRetry(server, port, '127.0.0.1', {
    retryDelayMs: 10,
    maxAttempts: 2,
    logger: createSilentLogger(logs),
  });

  assert.ok(await waitFor(() => logs.some((entry) => entry.level === 'error')));
  assert.equal(server.listening, false);
  assert.equal(
    server.listenerCount('listening'),
    baselineListeningListeners,
    'give-up leaves no retry listeners behind',
  );
  assert.ok(
    !logs.some((entry) => entry.message.includes('background rebind')),
    'legacy mode never announces a background rebind',
  );

  // Even after the port frees, legacy mode stays down (documents the old contract).
  await blocker.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(server.listening, false);
});
