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

const PHASES = (env.FAKE_TENANT_PHASES ?? 'ready:0')
  .split(',')
  .map((entry) => {
    const [phase, ms] = entry.split(':');
    return { phase: phase.trim(), ms: Number(ms.trim() || '0') };
  })
  .filter((entry) => entry.phase.length > 0);

const INBOUND_LIMIT = 1024 * 1024; // C2: 1 MiB inbound frame limit
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
  return now - startedAt >= HEALTH_AFTER_MS;
}

/** Walk the phase script relative to the moment health came up. */
function currentPhase(now = Date.now()) {
  if (!healthUp(now)) {
    return 'starting';
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
