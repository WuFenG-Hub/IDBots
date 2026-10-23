#!/usr/bin/env node
/**
 * Fake tenant (REQ-B-21): a dependency-free Node script implementing the
 * C1/C2 surface a real tenant image exposes, for integration tests and the
 * local dev loop without a Docker daemon.
 *
 * Env knobs:
 *   IDBOTS_TENANT_ID            default "t_test"
 *   IDBOTS_GATEWAY_SECRET       default "test-secret"
 *   IDBOTS_GATEWAY_PORT         default 8790; 0 = ephemeral (the chosen port
 *                               is reported on the "listening" log line)
 *   FAKE_TENANT_HEALTH_AFTER_MS default 0 — /healthz answers 503 before this
 *   FAKE_TENANT_PHASES          comma list of {phase}:{ms}, e.g.
 *                               "migrating:200,bootstrapping:300,ready:0";
 *                               /readyz walks the script once health is up,
 *                               the final phase is sticky
 *   FAKE_TENANT_EXIT_AFTER_MS   optional — exit(1) after this (crash test)
 *   FAKE_TENANT_APP_VERSION     default "0.12.0"
 *   FAKE_TENANT_CONTRACT_VERSION default "1.0.0"
 *
 * Logs: one JSON object per line, C1 log shape. Secrets are never logged.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const env = process.env;
const TENANT_ID = env.IDBOTS_TENANT_ID ?? 't_test';
const SECRET = env.IDBOTS_GATEWAY_SECRET ?? 'test-secret';
const PORT = Number(env.IDBOTS_GATEWAY_PORT ?? 8790);
const HEALTH_AFTER_MS = Number(env.FAKE_TENANT_HEALTH_AFTER_MS ?? 0);
const EXIT_AFTER_MS = env.FAKE_TENANT_EXIT_AFTER_MS ? Number(env.FAKE_TENANT_EXIT_AFTER_MS) : null;
const APP_VERSION = env.FAKE_TENANT_APP_VERSION ?? '0.12.0';
const CONTRACT_VERSION = env.FAKE_TENANT_CONTRACT_VERSION ?? '1.0.0';
// Test-only knobs (no production counterpart):
// - FAKE_TENANT_GATE=hold: /healthz answers 503 until the test POSTs
//   /ctl/gate/release, making "503 before ready" assertions deterministic
//   instead of racing a millisecond budget.
// - FAKE_TENANT_PHASES_MODE=manual: /readyz sticks to the current phase until
//   the test POSTs /ctl/advance, so phase-order assertions need no timing.
const GATE_MODE = env.FAKE_TENANT_GATE === 'hold' ? 'hold' : 'time';
const PHASE_MODE = env.FAKE_TENANT_PHASES_MODE === 'manual' ? 'manual' : 'script';
let gateReleased = GATE_MODE !== 'hold';
let manualPhaseIndex = 0;

const PHASES = (env.FAKE_TENANT_PHASES ?? 'ready:0')
  .split(',')
  .map((entry) => {
    const [phase, ms] = entry.split(':');
    return { phase: phase.trim(), ms: Number(ms.trim() || '0') };
  })
  .filter((entry) => entry.phase.length > 0);

const INBOUND_LIMIT = 1024 * 1024; // C2: 1 MiB inbound frame limit
const UPLOAD_LIMIT = 25 * 1024 * 1024; // C2: 25 MB upload cap

// Built-in fixtures for the proxy tests (deterministic, a few KB).
const FIXTURE_FILE_BODY = `${TENANT_ID} fixture file for proxy tests\n`.repeat(128);
const FIXTURE_INDEX_HTML = `<!doctype html><html><head><title>fake app</title><script src="/app/assets/app.fake123.js"></script></head><body><div id="root">fake tenant app fixture</div></body></html>`;
const FIXTURE_ASSET_JS = `console.log('fake tenant app fixture asset');`;

const MNEMONIC_WORDS = 'apple banana cherry dragon eagle falcon grape hazel iris jasmine kite lemon';

function sanitizeName(name) {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'upload.bin';
}

function uploadDir() {
  const base = process.env.FAKE_TENANT_DATA_DIR ?? path.join(os.tmpdir(), 'fake-tenant-data');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

// reveal-mnemonic state: seen nonces with their expiry (C2: kept in memory
// until expiry, then forgotten).
const seenNonces = new Map();

function handleRevealMnemonic(req, res) {
  const fail = () => {
    res.writeHead(401);
    res.end();
  };
  const token = String(req.headers['x-idbots-reverify'] ?? '');
  const dot = token.indexOf('.');
  if (dot === -1) {
    return fail();
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(token.slice(0, dot), 'base64url').toString('utf8'));
  } catch {
    return fail();
  }
  const expected = crypto
    .createHmac('sha256', SECRET)
    .update(Buffer.from(token.slice(0, dot), 'base64url'))
    .digest();
  let actual;
  try {
    actual = Buffer.from(token.slice(dot + 1), 'base64url');
  } catch {
    return fail();
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return fail();
  }
  const now = Date.now();
  if (payload.t !== TENANT_ID || payload.p !== 'reveal-mnemonic' || typeof payload.e !== 'number' || payload.e <= now) {
    return fail();
  }
  if (typeof payload.n !== 'string' || payload.n.length === 0) {
    return fail();
  }
  if (seenNonces.has(payload.n)) {
    return fail();
  }
  seenNonces.set(payload.n, payload.e);
  // Housekeeping: forget expired nonces opportunistically.
  for (const [nonce, expiry] of seenNonces) {
    if (expiry <= now) {
      seenNonces.delete(nonce);
    }
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let target = null;
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      target = body.target === 'metabot' ? `metabot:${Number(body.metabotId)}` : 'user';
    } catch {
      target = 'unknown';
    }
    // Audit-shaped log line WITHOUT the mnemonic.
    log('info', 'sensitive', 'mnemonic revealed', { target });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ mnemonic: MNEMONIC_WORDS }));
  });
}
const startedAt = Date.now();

function log(level, component, msg, extra = undefined) {
  const line = { ts: new Date().toISOString(), level, tenant: TENANT_ID, component, msg, ...(extra ?? {}) };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function secretOk(provided) {
  const a = Buffer.from(String(provided ?? ''));
  const b = Buffer.from(SECRET);
  const len = Math.max(a.length, b.length, 1);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  a.copy(pa);
  b.copy(pb);
  return crypto.timingSafeEqual(pa, pb);
}

function healthUp(now = Date.now()) {
  if (GATE_MODE === 'hold') {
    return gateReleased;
  }
  return now - startedAt >= HEALTH_AFTER_MS;
}

/** Walk the phase script relative to the moment health came up. */
function currentPhase(now = Date.now()) {
  if (!healthUp(now)) {
    return 'starting';
  }
  if (PHASE_MODE === 'manual') {
    return PHASES[Math.min(manualPhaseIndex, PHASES.length - 1)].phase;
  }
  let t = startedAt + HEALTH_AFTER_MS;
  for (const entry of PHASES) {
    t += entry.ms;
    if (now < t) {
      return entry.phase;
    }
  }
  return PHASES[PHASES.length - 1].phase;
}

const ONBOARDING_STEPS = ['identity', 'llmProvider', 'twinMetabot', 'workspace', 'trafficAccount', 'redeemCode'];

function onboardingFor(phase) {
  const states = {
    starting: ['pending', 'pending', 'pending', 'pending', 'pending', 'pending'],
    migrating: ['running', 'pending', 'pending', 'pending', 'pending', 'pending'],
    bootstrapping: ['done', 'done', 'running', 'running', 'running', 'pending'],
    ready: ['done', 'done', 'done', 'done', 'done', 'skipped'],
    degraded: ['done', 'done', 'done', 'done', 'done', 'failed'],
  };
  const picked = states[phase] ?? states.starting;
  const onboarding = {};
  ONBOARDING_STEPS.forEach((step, i) => {
    onboarding[step] = picked[i];
  });
  if (picked[2] === 'done') {
    onboarding.globalMetaId = 'idq1fake000000000000000000000000';
    onboarding.twinMetabotId = 1;
  }
  return onboarding;
}

function readyBody(now = Date.now()) {
  const phase = currentPhase(now);
  const ready = phase === 'ready' || phase === 'degraded';
  return {
    ready,
    phase,
    version: APP_VERSION,
    commit: 'fakecommit0000000000000000000000000000',
    contractVersion: CONTRACT_VERSION,
    onboarding: onboardingFor(phase),
    error:
      phase === 'degraded'
        ? { step: 'redeemCode', message: 'fake tenant running degraded (redeem code step failed)' }
        : phase === 'failed'
          ? { step: 'identity', message: 'fake tenant failed' }
          : null,
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/healthz') {
    if (healthUp()) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false }));
    }
    return;
  }

  // Test-only control routes (no gateway secret; only meaningful with the
  // FAKE_TENANT_GATE / FAKE_TENANT_PHASES_MODE knobs documented at the top).
  if (req.method === 'POST' && url.pathname === '/ctl/gate/release') {
    gateReleased = true;
    log('info', 'lifecycle', 'test control: gate released');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ released: true }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/ctl/advance') {
    if (PHASE_MODE === 'manual' && manualPhaseIndex < PHASES.length - 1) {
      manualPhaseIndex += 1;
    }
    const phase = PHASES[Math.min(manualPhaseIndex, PHASES.length - 1)].phase;
    log('info', 'lifecycle', 'test control: advanced', { phase });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ phase }));
    return;
  }

  // Every other HTTP route requires the gateway secret (C1).
  if (!secretOk(req.headers['x-idbots-gateway-secret'])) {
    res.writeHead(401);
    res.end();
    return;
  }

  if (url.pathname === '/readyz') {
    const body = readyBody();
    res.writeHead(body.ready ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }

  // -- C2 file download. Token crypto validation is WS-A's side; the fake
  // accepts any token when the secret is right and serves a deterministic
  // fixture, honoring Range (RFC 7231 single-range subset).
  if (req.method === 'GET' && url.pathname.startsWith('/gateway/v1/files/')) {
    const token = url.pathname.slice('/gateway/v1/files/'.length);
    const body = Buffer.from(FIXTURE_FILE_BODY, 'utf8');
    const ext = token.includes('.') ? token.split('.').pop().toLowerCase() : 'txt';
    const contentType =
      { txt: 'text/plain; charset=utf-8', json: 'application/json', js: 'text/javascript', png: 'image/png' }[ext] ??
      'application/octet-stream';
    const rangeHeader = req.headers.range;
    const match = typeof rangeHeader === 'string' ? /^bytes=(\d+)-(\d*)$/.exec(rangeHeader) : null;
    if (match) {
      const start = Number(match[1]);
      const end = match[2] === '' ? body.length - 1 : Math.min(Number(match[2]), body.length - 1);
      if (start >= body.length || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${body.length}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': contentType,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${body.length}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      });
      res.end(body.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': body.length,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return;
  }

  // -- C2 upload: stream-store into the data dir; enforces its own 25 MB cap.
  if (req.method === 'POST' && url.pathname === '/gateway/v1/upload') {
    const name = sanitizeName(new URL(req.url, 'http://localhost').searchParams.get('name') ?? 'upload.bin');
    const targetDir = uploadDir();
    fs.mkdirSync(targetDir, { recursive: true });
    const target = path.join(targetDir, `${Date.now()}-${name}`);
    const file = fs.createWriteStream(target);
    // An aborted upload (proxy cutting at 25 MB) can still deliver queued
    // chunks after destroy — swallow the stream error and guard writes.
    file.on('error', () => {});
    let size = 0;
    let over = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > UPLOAD_LIMIT && !over) {
        over = true;
        file.destroy();
        fs.rmSync(target, { force: true });
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'over the 25 MB limit' } }));
        req.resume();
        return;
      }
      if (!over && !file.destroyed) {
        file.write(chunk);
      }
    });
    req.on('end', () => {
      if (over) {
        return;
      }
      file.end(() => {
        log('info', 'gateway', 'upload stored', { name, size });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            path: `/data/workspace/uploads/${path.basename(target)}`,
            size,
            mime: String(req.headers['content-type'] ?? 'application/octet-stream'),
          }),
        );
      });
    });
    req.on('error', () => {
      file.destroy();
      fs.rmSync(target, { force: true });
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
    return;
  }

  // -- C2 sensitive route: full reveal-mnemonic implementation (C2 token:
  // base64url(payload) + '.' + base64url(HMAC-SHA256(secret, payload))).
  if (req.method === 'POST' && url.pathname === '/gateway/v1/sensitive/reveal-mnemonic') {
    handleRevealMnemonic(req, res);
    return;
  }

  // -- C2 static mobile bundle fixture.
  if (req.method === 'GET' && (url.pathname === '/app' || url.pathname.startsWith('/app/'))) {
    const rest = url.pathname === '/app' ? '' : url.pathname.slice('/app/'.length);
    if (rest === '' || rest === 'index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(FIXTURE_INDEX_HTML);
      return;
    }
    if (rest === 'assets/app.fake123.js') {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      res.end(FIXTURE_ASSET_JS);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

const wss = new WebSocketServer({ noServer: true, maxPayload: INBOUND_LIMIT * 2 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/gateway/v1/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  if (!secretOk(req.headers['x-idbots-gateway-secret'])) {
    log('warn', 'gateway', 'ws upgrade rejected: bad gateway secret');
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  const clientId = req.headers['x-idbots-client-id'] ?? null;
  log('info', 'gateway', 'client connected', clientId ? { clientId } : undefined);

  // Test-only extension: echo the upstream headers the control plane added
  // so proxy tests can assert they were set (never in the real tenant).
  ws.send(
    JSON.stringify({
      v: 1,
      type: 'welcome',
      contractVersion: CONTRACT_VERSION,
      appVersion: APP_VERSION,
      tenantId: TENANT_ID,
      serverTime: Date.now(),
      ready: readyBody().ready,
      phase: currentPhase(),
      clientId: clientId ?? null,
      xff: req.headers['x-forwarded-for'] ?? null,
    }),
  );

  const helloTimer = setTimeout(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ v: 1, type: 'event', channel: 'fake:test', args: ['hello'] }));
    }
  }, 50);

  ws.on('message', (data) => {
    if (Buffer.byteLength(data) > INBOUND_LIMIT) {
      log('warn', 'gateway', 'frame over 1 MiB inbound limit, closing');
      ws.close(4008);
      return;
    }
    let frame;
    try {
      frame = JSON.parse(data.toString('utf8'));
    } catch {
      log('warn', 'gateway', 'invalid frame ignored');
      return;
    }
    if (frame.type === 'ping') {
      ws.send(JSON.stringify({ v: 1, type: 'pong', ts: frame.ts ?? Date.now() }));
      return;
    }
    if (frame.type === 'invoke') {
      ws.send(
        JSON.stringify({
          v: 1,
          type: 'result',
          id: frame.id,
          ok: true,
          value: { echo: { channel: frame.channel, args: frame.args } },
        }),
      );
      ws.send(JSON.stringify({ v: 1, type: 'event', channel: 'fake:emitAgain', args: [frame.id] }));
      return;
    }
  });

  ws.on('close', (code) => {
    clearTimeout(helloTimer);
    log('info', 'gateway', 'client disconnected', { code });
  });
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'lifecycle', `${signal} received, draining`);
  for (const ws of wss.clients) {
    ws.close(4012);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (EXIT_AFTER_MS !== null) {
  setTimeout(() => {
    log('error', 'lifecycle', `fake crash after ${EXIT_AFTER_MS} ms`);
    process.exit(1);
  }, EXIT_AFTER_MS).unref();
}

server.listen(PORT, '127.0.0.1', () => {
  const address = server.address();
  log('info', 'gateway', 'listening', { port: address.port });
  // Test/export affordance: when the harness hands us a data dir, leave a
  // small state file in it so the tenant-export archive has real content.
  if (process.env.FAKE_TENANT_DATA_DIR) {
    try {
      fs.writeFileSync(
        path.join(process.env.FAKE_TENANT_DATA_DIR, 'tenant-state.json'),
        JSON.stringify({ tenantId: TENANT_ID, appVersion: APP_VERSION, contractVersion: CONTRACT_VERSION }),
      );
    } catch (err) {
      log('warn', 'lifecycle', 'could not write tenant-state.json', { error: String(err) });
    }
  }
});
