#!/usr/bin/env node
/**
 * Local dev loop (REQ-B-21) and T2 acceptance demo — no Docker daemon needed.
 *
 *   node scripts/dev-loop.mjs          full scripted phone loop (T2 demo)
 *   node scripts/dev-loop.mjs --quick  old health-check loop (fake docker,
 *                                      control plane, one fake tenant, /health)
 *
 * Full loop: fake docker + control plane + admin CLI + a scripted phone:
 * invite sign-up -> tenant ready -> disconnect -> reconnect without an
 * invite -> control-plane restart with reconcile (ghost container reported,
 * never deleted) -> the SAME tenant container still running. Any failed
 * assertion exits non-zero. Step lines are printed for the delivery note.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { startFakeDocker } from '../test/fake-docker/index.mjs';
import { DockerClient, tenantBaseUrl } from '../dist/docker/client.js';

const QUICK = process.argv.includes('--quick');
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const startedAt = Date.now();
const elapsed = () => `+${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

if (!existsSync(path.join(pkgRoot, 'dist', 'main.js')) || !existsSync(path.join(pkgRoot, 'dist', 'cli.js'))) {
  console.error('[dev-loop] dist/ is missing — run `pnpm build` first.');
  process.exit(1);
}

const cleanups = [];
function onCleanup(fn) {
  cleanups.push(fn);
}
async function cleanup() {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    try {
      await fn();
    } catch (err) {
      console.error(`[dev-loop] cleanup error: ${err.message}`);
    }
  }
}

let stepNo = 0;
let stepTotal = 0;
const STEPS = [];
function step(name, fn) {
  STEPS.push({ name, fn });
}
function logStep(name, detail = '') {
  stepNo += 1;
  console.log(`[dev-loop] ${String(stepNo).padStart(2, ' ')}/${stepTotal} ${name}${detail ? ` — ${detail}` : ''} (${elapsed()})`);
}

async function waitFor(fn, { timeoutMs = 10_000, intervalMs = 100, label }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // retry
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

// --- shared step context ----------------------------------------------------

let fake;
let client;
let dbPath;
let dbDir;
let cpEnv;
let cpBase;
let metricsBase;
let cpChild;
let cpLog = '';
const PHONE = '+8613900000000';
const TENANT_IMAGE_1 = 'tenant:1.0.0';

function spawnControlPlane() {
  return new Promise((resolve, reject) => {
    cpLog = '';
    cpChild = spawn(process.execPath, [path.join(pkgRoot, 'dist', 'main.js')], {
      env: cpEnv,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    cpChild.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      cpLog += text;
      process.stdout.write(`[cp] ${text}`);
    });
    cpChild.once('error', reject);
    cpChild.once('spawn', () => resolve());
  });
}

async function stopControlPlane() {
  if (!cpChild || cpChild.exitCode !== null) return;
  cpChild.kill('SIGTERM');
  await new Promise((resolve) => cpChild.once('exit', resolve));
}

async function cpHealthOk() {
  const res = await fetch(`${cpBase}/health`);
  const body = await res.json();
  return res.status === 200 && body.ok === true && body.docker === true;
}

async function runCli(...args) {
  const res = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(pkgRoot, 'dist', 'cli.js'), ...args], {
      env: cpEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
  if (res.code !== 0) {
    throw new Error(`cli "${args.join(' ')}" exited ${res.code}: ${res.stderr.trim()}`);
  }
  return res.stdout;
}

async function api(pathname, { method = 'GET', body, cookie } = {}) {
  const headers = { Origin: new URL(cpBase).origin };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(`${cpBase}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.getSetCookie();
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, json, setCookie };
}

// --- quick mode steps (REQ-B-21 smoke) ---------------------------------------

step('start fake docker engine', async () => {
  fake = await startFakeDocker();
  client = new DockerClient(fake.url);
  console.log(`[dev-loop]   fake docker at ${fake.url}`);
  return fake;
});

step('start control plane against the fake docker', async (ctx) => {
  dbDir = mkdtempSync(path.join(tmpdir(), 'cp-devloop-'));
  onCleanup(() => rmSync(dbDir, { recursive: true, force: true }));
  dbPath = path.join(dbDir, 'cp.sqlite');
  const publicPort = await freePort();
  const metricsPort = await freePort();
  metricsBase = `http://127.0.0.1:${metricsPort}`;
  cpEnv = {
    ...process.env,
    CP_PUBLIC_ORIGIN: `http://127.0.0.1:${publicPort}`,
    CP_LISTEN: `127.0.0.1:${publicPort}`,
    CP_METRICS_LISTEN: `127.0.0.1:${metricsPort}`,
    CP_DB_PATH: dbPath,
    CP_MASTER_KEY: crypto.randomBytes(32).toString('base64'),
    CP_DOCKER_URL: ctx[0].url,
    CP_TENANT_IMAGE: 'fake-tenant:devloop',
    CP_TENANT_NETWORK: 'idbots-devloop',
    CP_SMS_MODE: 'fake',
    CP_FAKE_SMS_NUMBERS: PHONE,
  };
  cpBase = `http://127.0.0.1:${publicPort}`;
  await spawnControlPlane();
  onCleanup(stopControlPlane);
  await waitFor(cpHealthOk, { label: 'control plane /health ok with docker=true' });
  console.log(`[dev-loop]   control plane at ${cpBase} (db ${dbPath})`);
});

step('seed image + create fake tenant container (what provisioning does in T2)', async (ctx) => {
  await fetch(`${ctx[0].url}/fake/images`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'fake-tenant:devloop', labels: { 'org.idbots.version': '0.12.0' } }),
  });
  await client.createVolume('idb-t_devloop-data');
  const created = await client.createContainer({
    name: 'idb-t_devloop',
    image: 'fake-tenant:devloop',
    env: {
      IDBOTS_SERVER_MODE: '1',
      IDBOTS_TENANT_ID: 't_devloop',
      IDBOTS_GATEWAY_SECRET: 'devloop-secret',
      FAKE_TENANT_HEALTH_AFTER_MS: '100',
      FAKE_TENANT_PHASES: 'migrating:150,bootstrapping:150,ready:0',
      FAKE_TENANT_APP_VERSION: '0.12.0',
    },
    labels: { 'org.idbots.version': '0.12.0' },
  });
  await client.startContainer(created.Id);
  const inspect = await client.inspectContainer(created.Id);
  console.log(`[dev-loop]   container ${inspect.Name} running=${inspect.State.Running} tenantUrl=${tenantBaseUrl(inspect)}`);
});

step('wait for the fake tenant to become ready', async () => {
  const inspect = await waitFor(async () => {
    const found = (await client.listContainers({ namePrefix: 'idb-t_devloop' }))[0];
    if (!found) return null;
    const full = await client.inspectContainer(found.Id);
    return full.State.Running ? full : null;
  }, { label: 'fake tenant container running' });
  const readyBody = await waitFor(async () => {
    const res = await fetch(`${tenantBaseUrl(inspect)}/readyz`, {
      headers: { 'X-IDBots-Gateway-Secret': 'devloop-secret' },
    });
    return res.status === 200 ? res.json() : null;
  }, { timeoutMs: 15_000, label: 'tenant /readyz ready' });
  console.log(
    `[dev-loop]   tenant t_devloop ready=${readyBody.ready} phase=${readyBody.phase} version=${readyBody.version}`,
  );
});

step('GET /health on the control plane', async () => {
  const res = await fetch(`${cpBase}/health`);
  const body = await res.json();
  console.log(`[dev-loop]   ${cpBase}/health -> ${res.status} ${JSON.stringify(body)}`);
  assert(res.status === 200 && body.ok === true, 'control plane /health not ok');
});

// --- full mode extra steps ---------------------------------------------------

let alertSink;
let inviteCode;
let cookie;
let userId;
let containerIdBefore;

step('start alert sink + seed versioned images', async () => {
  const messages = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        messages.push(JSON.parse(Buffer.concat(chunks).toString('utf8')).content?.text ?? '');
      } catch {
        messages.push('<unparsable>');
      }
      res.writeHead(200);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  alertSink = { messages, close: () => new Promise((r) => server.close(r)) };
  onCleanup(() => alertSink.close());
  cpEnv.CP_ALERT_WEBHOOK = `http://127.0.0.1:${server.address().port}`;
  for (const [ref, labels] of Object.entries({
    [TENANT_IMAGE_1]: { 'org.idbots.version': '1.0.0', 'org.idbots.rollback-safe-to': '' },
    'tenant:1.1.0': { 'org.idbots.version': '1.1.0', 'org.idbots.rollback-safe-to': '1.0.0' },
  })) {
    const res = await fetch(`${fake.url}/fake/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref, labels }),
    });
    assert(res.status === 201, `seed image ${ref}`);
  }
  // Fast fake-tenant phases for the demo phone.
  cpEnv.CP_TENANT_ENV_FAKE_TENANT_HEALTH_AFTER_MS = '80';
  cpEnv.CP_TENANT_ENV_FAKE_TENANT_PHASES = 'migrating:150,bootstrapping:150,ready:0';
  cpEnv.CP_TENANT_IMAGE = TENANT_IMAGE_1;
  console.log(`[dev-loop]   images seeded (${TENANT_IMAGE_1}, tenant:1.1.0), alert sink at ${cpEnv.CP_ALERT_WEBHOOK}`);
});

step('CLI: import one redeem code, create a with-redeem invite', async () => {
  const csv = path.join(dbDir, 'codes.csv');
  writeFileSync(csv, 'LOOP-REDEEM-0001\n');
  const importOut = await runCli('redeem', 'import', '--file', csv, '--note', 'devloop', '--as', 'loop');
  console.log(`[dev-loop]   redeem import -> ${importOut.trim()}`);
  const inviteOut = await runCli('invite', 'create', '--uses', '1', '--with-redeem', '--note', 'devloop', '--as', 'loop');
  inviteCode = /code:\s*(\S+)/.exec(inviteOut)?.[1];
  assert(inviteCode, 'invite code captured from CLI output');
  console.log(`[dev-loop]   invite created: ${inviteCode.slice(0, 2)}… (masked)`);
});

step('phone: sms/send + verify with the invite -> provisioning', async () => {
  const send = await api('/api/v1/auth/sms/send', { method: 'POST', body: { phone: PHONE, purpose: 'login' } });
  assert(send.status === 200, `sms/send -> ${send.status}`);
  const verify = await api('/api/v1/auth/sms/verify', {
    method: 'POST',
    body: { phone: PHONE, code: '246810', inviteCode, displayName: 'Loop Demo' },
  });
  assert(verify.status === 200, `sms/verify -> ${verify.status} ${JSON.stringify(verify.json)}`);
  userId = verify.json.user.id;
  cookie = verify.setCookie.find((entry) => entry.startsWith('idb_session='))?.split(';')[0];
  assert(cookie, 'session cookie captured');
  console.log(
    `[dev-loop]   verify 200, user ${verify.json.user.phoneMasked}, tenant status ${verify.json.tenant.status}`,
  );
});

step('phone: poll /api/v1/me until the tenant is ready', async () => {
  const seen = [];
  await waitFor(
    async () => {
      const me = await api('/api/v1/me', { cookie });
      if (me.status !== 200) return null;
      const status = me.json?.tenant?.status;
      if (seen[seen.length - 1] !== status) {
        seen.push(status);
        console.log(`[dev-loop]   /me tenant status: ${status}`);
      }
      return status === 'ready' ? true : null;
    },
    { timeoutMs: 30_000, intervalMs: 1000, label: 'tenant ready via /me' },
  );
  const stats = await runCli('redeem', 'stats');
  console.log(`[dev-loop]   redeem stats -> ${stats.trim()}`);
  assert(/imported=1 assigned=1 remaining=0/.test(stats), 'redeem code assigned exactly once');
});

step('phone: disconnect (drop the cookie)', async () => {
  cookie = null;
  console.log('[dev-loop]   cookie jar dropped');
});

step('phone: reconnect with the SAME phone and NO invite', async () => {
  // Demo time-travel: the C3 resend window is 60 s; simulating "a minute
  // later" by clearing this phone's sms window in the db (a real user would
  // simply wait).
  const db = new Database(dbPath);
  db.prepare('DELETE FROM sms_codes WHERE phone_e164 = ?').run(PHONE);
  db.close();
  const send = await api('/api/v1/auth/sms/send', { method: 'POST', body: { phone: PHONE, purpose: 'login' } });
  assert(send.status === 200, `reconnect sms/send -> ${send.status}`);
  const verify = await api('/api/v1/auth/sms/verify', {
    method: 'POST',
    body: { phone: PHONE, code: '246810' },
  });
  assert(verify.status === 200, `reconnect sms/verify -> ${verify.status}`);
  assert(verify.json.user.id === userId, 'same user id after reconnect');
  assert(verify.json.tenant.status === 'ready', 'tenant ready after reconnect');
  cookie = verify.setCookie.find((entry) => entry.startsWith('idb_session='))?.split(';')[0];
  const invites = await runCli('invite', 'list');
  assert(/uses 1\/1/.test(invites), 'invite still shows exactly one use');
  console.log(`[dev-loop]   same user ${userId}, same tenant, invite still 1/1`);
});

step('create a ghost container, then restart the control plane', async () => {
  const ghost = await client.createContainer({
    name: 'idb-t_ghost1',
    image: 'fake-tenant:devloop',
    env: {
      IDBOTS_TENANT_ID: 't_ghost1',
      IDBOTS_GATEWAY_SECRET: 'ghost-secret',
      FAKE_TENANT_HEALTH_AFTER_MS: '0',
      FAKE_TENANT_PHASES: 'ready:0',
    },
  });
  await client.startContainer(ghost.Id);
  const mine = (await client.listContainers({ namePrefix: 'idb-t_' })).filter((c) => c.Names[0] === '/idb-t_devloop');
  containerIdBefore = mine[0].Id;
  console.log(`[dev-loop]   ghost idb-t_ghost1 running; tenant container ${containerIdBefore.slice(0, 12)}…`);

  await stopControlPlane();
  await spawnControlPlane();
  await waitFor(cpHealthOk, { label: 'control plane healthy after restart' });

  assert(
    cpLog.includes('unknown container reported, not deleted') && cpLog.includes('idb-t_ghost1'),
    'reconcile reported the unknown container',
  );
  assert(
    alertSink.messages.some((m) => m.includes('unknown container idb-t_ghost1')),
    'unknown-container alert delivered',
  );
  const ghostAfter = await client.inspectContainer(ghost.Id);
  assert(ghostAfter.State.Running, 'ghost container left running (never deleted)');
  console.log('[dev-loop]   reconcile: "unknown container idb-t_ghost1 reported"; ghost still running');
});

step('after restart: session and tenant intact, container NOT recreated', async () => {
  const me = await api('/api/v1/me', { cookie });
  assert(me.status === 200, `/me after restart -> ${me.status}`);
  assert(me.json.user.id === userId, 'same user after CP restart');
  assert(me.json.tenant.status === 'ready', 'tenant still ready after CP restart');
  const mine = (await client.listContainers({ namePrefix: 'idb-t_' })).filter((c) => c.Names[0] === '/idb-t_devloop');
  assert(mine[0].Id === containerIdBefore, 'tenant container not recreated');
  console.log(
    `[dev-loop]   /me 200 (user ${me.json.user.phoneMasked}, tenant ready); container ${mine[0].Id.slice(0, 12)}… unchanged`,
  );
});

// --- T3 steps -----------------------------------------------------------------

step('T3: /ws echo through the control plane (real ws client)', async () => {
  const ws = new WebSocket(`${cpBase.replace(/^http/, 'ws')}/ws`, {
    headers: { Cookie: cookie, Origin: new URL(cpBase).origin },
  });
  const frames = [];
  ws.on('message', (data) => frames.push(JSON.parse(data.toString('utf8'))));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const welcome = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no welcome frame through /ws')), 5000);
    const poll = setInterval(() => {
      const frame = frames.find((f) => f.type === 'welcome');
      if (frame) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(frame);
      }
    }, 20);
  });
  assert(welcome && welcome.tenantId, 'welcome frame through /ws');
  console.log(`[dev-loop]   /ws welcome: tenant=${welcome.tenantId} clientId=${welcome.clientId}`);
  const echoed = new Promise((resolve) => {
    const timer = setInterval(() => {
      const result = frames.find((f) => f.type === 'result' && f.id === 'loop1');
      if (result) {
        clearInterval(timer);
        resolve(result);
      }
    }, 20);
  });
  ws.send(JSON.stringify({ v: 1, type: 'invoke', id: 'loop1', channel: 'cowork:session:start', args: ['dev-loop'] }));
  const result = await echoed;
  console.log(`[dev-loop]   invoke result ok=${result.ok} echo=${JSON.stringify(result.value.echo.channel)}`);
  ws.close();
});

step('T3: HTTP proxy routes (/app, /upload, /files)', async () => {
  const appRes = await fetch(`${cpBase}/app/`, { headers: { Cookie: cookie } });
  assert(appRes.status === 200, `/app/ -> ${appRes.status}`);
  const html = await appRes.text();
  console.log(`[dev-loop]   GET /app/ -> 200 (${html.length} bytes, first: ${JSON.stringify(html.slice(0, 40))})`);

  const upload = await fetch(`${cpBase}/upload?name=devloop.txt`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: new URL(cpBase).origin, 'Content-Type': 'text/plain' },
    body: 'dev-loop upload\n',
  });
  assert(upload.status === 200, `/upload -> ${upload.status}`);
  const uploaded = await upload.json();
  console.log(`[dev-loop]   POST /upload -> 200 path=${uploaded.path} size=${uploaded.size}`);

  const file = await fetch(`${cpBase}/files/devloop.txt`, { headers: { Cookie: cookie } });
  assert(file.status === 200, `/files -> ${file.status}`);
  console.log(`[dev-loop]   GET /files/{token} -> 200 (${(await file.text()).length} fixture bytes)`);
});

step('T3: reverify -> mnemonic export (words never printed)', async () => {
  // Demo time-travel: clear the 60 s resend window (see step 11).
  const db = new Database(dbPath);
  db.prepare('DELETE FROM sms_codes WHERE phone_e164 = ?').run(PHONE);
  db.close();
  const send = await api('/api/v1/reverify/send', { method: 'POST', cookie, body: { purpose: 'reveal-mnemonic' } });
  assert(send.status === 200, `reverify/send -> ${send.status}`);
  const verify = await api('/api/v1/reverify/verify', {
    method: 'POST',
    cookie,
    body: { purpose: 'reveal-mnemonic', code: '246810' },
  });
  assert(verify.status === 200, `reverify/verify -> ${verify.status}`);
  const { reverifyId } = verify.json;
  const reveal = await api('/api/v1/sensitive/reveal-mnemonic', {
    method: 'POST',
    cookie,
    body: { reverifyId, target: 'user' },
  });
  assert(reveal.status === 200, `reveal -> ${reveal.status}`);
  const wordCount = reveal.json.mnemonic.split(' ').length;
  assert(wordCount === 12, '12-word mnemonic');
  assert(!cpLog.includes(reveal.json.mnemonic.split(' ')[0]), 'mnemonic never logged');
  console.log(`[dev-loop]   mnemonic: <redacted len=${wordCount} words>`);
});

step('T3: deletion request -> 202 + operator alert', async () => {
  const res = await api('/api/v1/account/deletion-request', { method: 'POST', cookie, body: { reason: 'dev-loop' } });
  assert(res.status === 202, `deletion-request -> ${res.status}`);
  const { requestId } = res.json;
  await waitFor(async () => (alertSink.messages.some((m) => m.includes(`#${requestId}`)) ? true : null), {
    label: 'deletion alert at the sink',
  });
  const alert = alertSink.messages.find((m) => m.includes(`#${requestId}`));
  assert(!alert.includes(PHONE), 'alert has no full phone');
  console.log(`[dev-loop]   deletion-request -> 202 requestId=${requestId}; alert: ${alert}`);
});

step('T3: scrape /metrics on the internal port', async () => {
  const res = await fetch(`${metricsBase}/metrics`);
  assert(res.status === 200, `/metrics -> ${res.status}`);
  const text = await res.text();
  const cpLines = text.split('\n').filter((line) => line.startsWith('cp_'));
  for (const line of cpLines) {
    console.log(`[dev-loop]   ${line}`);
  }
  assert(cpLines.some((l) => l.startsWith('cp_tenants{status="ready"}')), 'cp_tenants present');
  assert(cpLines.some((l) => l.startsWith('cp_open_sockets')), 'cp_open_sockets present');
  assert(cpLines.some((l) => l.startsWith('cp_http_requests_total')), 'cp_http_requests_total present');
  assert(cpLines.some((l) => l.startsWith('cp_sms_sends_total')), 'cp_sms_sends_total present');
  console.log(
    '[dev-loop]   (in-memory counters reset on the step-12 restart; provisioning/upgrade histograms are covered by test/metrics.test.ts)',
  );
});

step('T3: login bundle at /', async () => {
  const anon = await fetch(`${cpBase}/login`);
  assert(anon.status === 200, `/login -> ${anon.status}`);
  const html = await anon.text();
  const which = html.includes('Preparing your Bot') ? 'built-in placeholder' : 'WS-E dist-mobile-login bundle';
  console.log(`[dev-loop]   GET /login (no cookie) -> 200 (serving: ${which}, ${html.length} bytes)`);

  const ready = await fetch(`${cpBase}/`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert(ready.status === 302 && ready.headers.get('location') === '/app/', 'ready session redirects to /app/');
  console.log('[dev-loop]   GET / (cookie, ready tenant) -> 302 /app/');
});

// --- runner -----------------------------------------------------------------

let failed = false;
const ctx = [];
try {
  const selected = QUICK ? STEPS.slice(0, 5) : STEPS;
  stepTotal = selected.length;
  for (const { name, fn } of selected) {
    logStep(name);
    const out = await fn(ctx);
    if (out !== undefined) {
      ctx.push(out);
    }
  }
  console.log(`[dev-loop] OK — ${QUICK ? 'quick loop' : 'full phone loop'} complete (${elapsed()})`);
} catch (err) {
  failed = true;
  console.error(`[dev-loop] FAILED: ${err.message}`);
} finally {
  await cleanup();
}
process.exit(failed ? 1 : 0);
