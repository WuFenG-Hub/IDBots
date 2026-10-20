#!/usr/bin/env node
/**
 * Local dev loop (REQ-B-21): control plane + fake docker + fake tenant,
 * no Docker daemon required.
 *
 *   pnpm build && node scripts/dev-loop.mjs
 *
 * Steps: start the fake docker engine, start the control plane against it,
 * create a fake tenant container through the docker client (what T2
 * provisioning will do), wait for the tenant to reach `ready`, print the
 * control plane's GET /health, then tear everything down. T2 extends the
 * `STEPS` list into the full register -> provision -> reconnect loop.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { startFakeDocker } from '../test/fake-docker/index.mjs';
import { DockerClient, tenantBaseUrl } from '../dist/docker/client.js';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const startedAt = Date.now();
const elapsed = () => `+${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

if (!existsSync(path.join(pkgRoot, 'dist', 'main.js'))) {
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
const STEPS = [];
function step(name, fn) {
  STEPS.push({ name, fn });
}
function logStep(name, detail = '') {
  stepNo += 1;
  console.log(`[dev-loop] ${String(stepNo).padStart(2, ' ')}/${STEPS.length} ${name}${detail ? ` — ${detail}` : ''} (${elapsed()})`);
}

async function waitFor(fn, { timeoutMs = 10_000, intervalMs = 100, label }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await fn();
      if (value) {
        return value;
      }
    } catch {
      // retry
    }
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for: ${label}`);
    }
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

const TENANT_ID = 't_devloop';
const TENANT_SECRET = crypto.randomBytes(32).toString('base64url');

// --- step definitions -------------------------------------------------------

step('start fake docker engine', async () => {
  const fake = await startFakeDocker();
  onCleanup(fake.close);
  console.log(`[dev-loop]   fake docker at ${fake.url}`);
  return fake;
});

let cpBase;
let cpChild;

step('start control plane against the fake docker', async (ctx) => {
  const dbDir = mkdtempSync(path.join(tmpdir(), 'cp-devloop-'));
  onCleanup(() => rmSync(dbDir, { recursive: true, force: true }));
  const publicPort = await freePort();
  const metricsPort = await freePort();
  const env = {
    ...process.env,
    CP_PUBLIC_ORIGIN: `http://localhost:${publicPort}`,
    CP_LISTEN: `127.0.0.1:${publicPort}`,
    CP_METRICS_LISTEN: `127.0.0.1:${metricsPort}`,
    CP_DB_PATH: path.join(dbDir, 'cp.sqlite'),
    CP_MASTER_KEY: crypto.randomBytes(32).toString('base64'),
    CP_DOCKER_URL: ctx[0].url,
    CP_TENANT_IMAGE: 'fake-tenant:devloop',
    CP_TENANT_NETWORK: 'idbots-devloop',
    CP_SMS_MODE: 'fake',
    CP_FAKE_SMS_NUMBERS: '+8613900000000',
  };
  cpBase = `http://127.0.0.1:${publicPort}`;
  cpChild = spawn(process.execPath, [path.join(pkgRoot, 'dist', 'main.js')], { env, stdio: 'inherit' });
  onCleanup(async () => {
    if (cpChild.exitCode === null) {
      cpChild.kill('SIGTERM');
      await new Promise((resolve) => cpChild.once('exit', resolve));
    }
  });
  await waitFor(async () => {
    const res = await fetch(`${cpBase}/health`);
    const body = await res.json();
    return res.status === 200 && body.ok === true && body.docker === true;
  }, { label: 'control plane /health ok with docker=true' });
  console.log(`[dev-loop]   control plane at ${cpBase} (db ${env.CP_DB_PATH})`);
});

let client;

step('seed image + create fake tenant container (T2 will call this provisioning)', async (ctx) => {
  client = new DockerClient(ctx[0].url);
  await fetch(`${ctx[0].url}/fake/images`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ref: 'fake-tenant:devloop',
      labels: { 'org.idbots.version': '0.12.0', 'org.idbots.rollback-safe-to': '0.11.0' },
    }),
  });
  await client.createVolume(`idb-${TENANT_ID}-data`);
  const created = await client.createContainer({
    name: `idb-${TENANT_ID}`,
    image: 'fake-tenant:devloop',
    env: {
      IDBOTS_SERVER_MODE: '1',
      IDBOTS_TENANT_ID: TENANT_ID,
      IDBOTS_GATEWAY_SECRET: TENANT_SECRET,
      FAKE_TENANT_HEALTH_AFTER_MS: '100',
      FAKE_TENANT_PHASES: 'migrating:150,bootstrapping:150,ready:0',
      FAKE_TENANT_APP_VERSION: '0.12.0',
    },
    labels: { 'org.idbots.version': '0.12.0' },
  });
  await client.startContainer(created.Id);
  const inspect = await client.inspectContainer(created.Id);
  console.log(
    `[dev-loop]   container ${inspect.Name} running=${inspect.State.Running} ` +
      `tenantUrl=${tenantBaseUrl(inspect)}`,
  );
});

step('wait for the fake tenant to become ready', async () => {
  const inspect = await waitFor(async () => {
    const found = (await client.listContainers({ namePrefix: `idb-${TENANT_ID}` }))[0];
    if (!found) {
      return null;
    }
    const full = await client.inspectContainer(found.Id);
    return full.State.Running ? full : null;
  }, { label: 'fake tenant container running' });
  const tenantUrl = tenantBaseUrl(inspect);
  const readyBody = await waitFor(async () => {
    const res = await fetch(`${tenantUrl}/readyz`, {
      headers: { 'X-IDBots-Gateway-Secret': TENANT_SECRET },
    });
    if (res.status !== 200) {
      return null;
    }
    return res.json();
  }, { timeoutMs: 15_000, label: 'tenant /readyz ready' });
  console.log(
    `[dev-loop]   tenant ${TENANT_ID} ready=${readyBody.ready} phase=${readyBody.phase} ` +
      `version=${readyBody.version} contract=${readyBody.contractVersion}`,
  );
});

step('GET /health on the control plane', async () => {
  const res = await fetch(`${cpBase}/health`);
  const body = await res.json();
  console.log(`[dev-loop]   ${cpBase}/health -> ${res.status} ${JSON.stringify(body)}`);
  if (res.status !== 200 || body.ok !== true) {
    throw new Error(`control plane /health not ok: ${JSON.stringify(body)}`);
  }
});

// --- runner -----------------------------------------------------------------

let failed = false;
const ctx = [];
try {
  for (const { name, fn } of STEPS) {
    logStep(name);
    const out = await fn(ctx);
    if (out !== undefined) {
      ctx.push(out);
    }
  }
  console.log(`[dev-loop] OK — local loop complete (${elapsed()})`);
} catch (err) {
  failed = true;
  console.error(`[dev-loop] FAILED: ${err.message}`);
} finally {
  await cleanup();
}
process.exit(failed ? 1 : 0);
