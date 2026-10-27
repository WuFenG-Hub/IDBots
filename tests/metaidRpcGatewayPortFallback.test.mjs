// MetaID RPC gateway port isolation:
//  - when another app instance permanently holds the default port (production
//    app alongside a dev-fresh/e2e profile), listenWithPortFallback must bind
//    a spare port instead of waiting forever — an unbound gateway plus env
//    injection pointing at the busy default is what sent a dev-fresh OpenTeam
//    test into the production app's gateway/database (2026-10-27 incident);
//  - getMetaidRpcBase must follow the actually-bound port once reported via
//    setActiveMetaidRpcPort, so session env injection lands in THIS instance;
//  - the port mirror file records the bound port for observability.
// Requires: pnpm run compile:electron.

import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import Module from 'node:module';
import test from 'node:test';

const requireFromHere = Module.createRequire(import.meta.url);
const { listenWithPortFallback } = requireFromHere('../dist-electron/main/services/httpListenWithRetry.js');
const {
  getActiveMetaidRpcPort,
  getMetaidRpcBase,
  setActiveMetaidRpcPort,
  writeMetaidRpcPortFile,
  getMetaidRpcPortFilePath,
} = requireFromHere('../dist-electron/main/services/metaidRpcEndpoint.js');

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
    port,
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
  return false;
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}

test('listenWithPortFallback binds the preferred port when it is free', async () => {
  const preferred = await freePort();
  const server = http.createServer(() => {});
  let selected = null;
  let listening = false;
  listenWithPortFallback(server, preferred, '127.0.0.1', {
    fallbackPortSpan: 8,
    onPortSelected: (port) => { selected = port; },
    onListening: () => { listening = true; },
  });
  assert.ok(await waitFor(() => server.listening), 'server should bind the free preferred port');
  assert.equal(server.address().port, preferred);
  assert.equal(selected, preferred);
  assert.equal(listening, true);
  await closeServer(server);
});

test('listenWithPortFallback steps to a spare port when the preferred one is held', async () => {
  const preferred = await freePort();
  const blocker = await holdPort(preferred);
  const server = http.createServer(() => {});
  let selected = null;
  listenWithPortFallback(server, preferred, '127.0.0.1', {
    fallbackPortSpan: 16,
    onPortSelected: (port) => { selected = port; },
  });
  assert.ok(await waitFor(() => server.listening), 'server should bind a fallback port');
  const bound = server.address().port;
  assert.equal(selected, bound, 'onPortSelected must report the actually-bound port');
  assert.notEqual(bound, preferred, 'must not bind the held preferred port');
  assert.ok(bound > preferred && bound <= preferred + 16, `fallback port ${bound} should sit just above ${preferred}`);
  await closeServer(server);
  await blocker.close();
});

test('getMetaidRpcBase follows the active port and writeMetaidRpcPortFile mirrors it', () => {
  assert.equal(getActiveMetaidRpcPort(), null, 'no gateway bound in this test process yet');
  assert.equal(getMetaidRpcBase(), 'http://127.0.0.1:31200');

  setActiveMetaidRpcPort(31217);
  assert.equal(getActiveMetaidRpcPort(), 31217);
  assert.equal(getMetaidRpcBase(), 'http://127.0.0.1:31217');

  const dir = path.join(os.tmpdir(), `idbots-rpc-port-test-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  writeMetaidRpcPortFile(dir, 31217);
  assert.equal(readFileSync(getMetaidRpcPortFilePath(dir), 'utf8'), '31217\n');

  // A pinned env port still wins when no gateway has reported a bind.
  setActiveMetaidRpcPort(31218);
  assert.equal(getMetaidRpcBase({ IDBOTS_METAID_RPC_PORT: '' }), 'http://127.0.0.1:31218');
});
