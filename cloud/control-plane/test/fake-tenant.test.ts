import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { describe, test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fake-tenant',
  'fake-tenant.mjs',
);

interface TenantProcess {
  child: ChildProcess;
  port: number;
  lines: string[];
  stop: () => Promise<void>;
}

async function startTenant(extraEnv: Record<string, string>): Promise<TenantProcess> {
  const child = spawn(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      IDBOTS_TENANT_ID: 't_test',
      IDBOTS_GATEWAY_SECRET: 'test-secret',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  let tail = '';
  const portPromise = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fake tenant did not report listening')), 5000);
    child.stdout?.on('data', (chunk: Buffer) => {
      tail += chunk.toString('utf8');
      const parts = tail.split('\n');
      tail = parts.pop() ?? '';
      for (const line of parts) {
        if (line.length === 0) continue;
        lines.push(line);
        try {
          const parsed = JSON.parse(line) as { msg?: string; port?: number };
          if (parsed.msg === 'listening' && typeof parsed.port === 'number') {
            clearTimeout(timer);
            resolve(parsed.port);
          }
        } catch {
          // ignore non-JSON lines
        }
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fake tenant exited before listening (code ${code})`));
    });
  });

  const stop = async () => {
    if (child.exitCode !== null) {
      return;
    }
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  const port = await portPromise;
  return { child, port, lines, stop };
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null && value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface Frame {
  type: string;
  [key: string]: unknown;
}

/**
 * Collects every frame into a buffer and matches waiters against both
 * buffered and future frames — frames that arrive in the same TCP chunk
 * must not be lost between two sequential waitFrame calls.
 */
function frameCollector(ws: WebSocket): {
  frames: Frame[];
  waitFrame: (pred: (frame: Frame) => boolean, timeoutMs?: number) => Promise<Frame>;
} {
  const frames: Frame[] = [];
  const waiters: Array<{
    pred: (frame: Frame) => boolean;
    resolve: (frame: Frame) => void;
    timer: NodeJS.Timeout;
  }> = [];
  ws.on('message', (data: Buffer) => {
    const frame = JSON.parse(data.toString('utf8')) as Frame;
    frames.push(frame);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].pred(frame)) {
        clearTimeout(waiters[i].timer);
        waiters[i].resolve(frame);
        waiters.splice(i, 1);
      }
    }
  });
  function waitFrame(pred: (frame: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
    const existing = frames.find(pred);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitFrame timed out')), timeoutMs);
      waiters.push({ pred, resolve, timer });
    });
  }
  return { frames, waitFrame };
}

function connect(port: number, secret: string | null): WebSocket {
  const headers: Record<string, string> = {};
  if (secret !== null) {
    headers['X-IDBots-Gateway-Secret'] = secret;
  }
  return new WebSocket(`ws://127.0.0.1:${port}/gateway/v1/ws`, { headers });
}

const SECRET = 'test-secret';

describe('fake tenant HTTP surface', () => {
  test('/healthz answers 503 until the gate, then 200 {"ok":true}', async () => {
    const t = await startTenant({ FAKE_TENANT_HEALTH_AFTER_MS: '150', FAKE_TENANT_PHASES: 'ready:0' });
    try {
      const early = await fetch(`http://127.0.0.1:${t.port}/healthz`);
      assert.equal(early.status, 503);
      const late = await waitFor(async () => {
        const res = await fetch(`http://127.0.0.1:${t.port}/healthz`);
        return res.status === 200 ? res : null;
      });
      assert.deepEqual(await late.json(), { ok: true });
    } finally {
      await t.stop();
    }
  });

  test('/readyz walks the phase script to ready with the full C1 body', async () => {
    const t = await startTenant({
      FAKE_TENANT_HEALTH_AFTER_MS: '60',
      FAKE_TENANT_PHASES: 'migrating:200,bootstrapping:150,ready:0',
      FAKE_TENANT_APP_VERSION: '0.12.0',
      FAKE_TENANT_CONTRACT_VERSION: '1.0.0',
    });
    try {
      await waitFor(async () => {
        const res = await fetch(`http://127.0.0.1:${t.port}/healthz`);
        return res.status === 200 ? true : null;
      });
      const first = await fetch(`http://127.0.0.1:${t.port}/readyz`, {
        headers: { 'X-IDBots-Gateway-Secret': SECRET },
      });
      assert.equal(first.status, 503);
      const firstBody = (await first.json()) as { phase: string; ready: boolean };
      assert.equal(firstBody.ready, false);
      assert.ok(['migrating', 'bootstrapping'].includes(firstBody.phase));

      const readyRes = await waitFor(async () => {
        const res = await fetch(`http://127.0.0.1:${t.port}/readyz`, {
          headers: { 'X-IDBots-Gateway-Secret': SECRET },
        });
        return res.status === 200 ? res : null;
      });
      const body = (await readyRes.json()) as Record<string, unknown>;
      assert.equal(body.ready, true);
      assert.equal(body.phase, 'ready');
      assert.equal(body.version, '0.12.0');
      assert.equal(body.contractVersion, '1.0.0');
      assert.equal(typeof body.commit, 'string');
      assert.equal(body.error, null);
      const onboarding = body.onboarding as Record<string, string>;
      for (const step of ['identity', 'llmProvider', 'twinMetabot', 'workspace', 'trafficAccount', 'redeemCode']) {
        assert.ok(step in onboarding, `onboarding.${step} present`);
      }
      assert.equal(onboarding.identity, 'done');
      assert.equal(onboarding.redeemCode, 'skipped');
    } finally {
      await t.stop();
    }
  });

  test('non-healthz routes require the secret (401 empty detail)', async () => {
    const t = await startTenant({ FAKE_TENANT_HEALTH_AFTER_MS: '0', FAKE_TENANT_PHASES: 'ready:0' });
    try {
      const noHeader = await fetch(`http://127.0.0.1:${t.port}/readyz`);
      assert.equal(noHeader.status, 401);
      assert.equal(await noHeader.text(), '');
      const wrongHeader = await fetch(`http://127.0.0.1:${t.port}/readyz`, {
        headers: { 'X-IDBots-Gateway-Secret': 'wrong' },
      });
      assert.equal(wrongHeader.status, 401);
      const healthOpen = await fetch(`http://127.0.0.1:${t.port}/healthz`);
      assert.equal(healthOpen.status, 200);
    } finally {
      await t.stop();
    }
  });
});

describe('fake tenant WebSocket gateway', () => {
  test('welcome + test event + echo invoke + emitAgain event + pong', async () => {
    const t = await startTenant({ FAKE_TENANT_HEALTH_AFTER_MS: '0', FAKE_TENANT_PHASES: 'ready:0' });
    try {
      const ws = connect(t.port, SECRET);
      const { waitFrame } = frameCollector(ws);
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });

      const welcome = await waitFrame((f) => f.type === 'welcome');
      assert.equal(welcome.v, 1);
      assert.equal(welcome.type, 'welcome');
      assert.equal(welcome.contractVersion, '1.0.0');
      assert.equal(welcome.appVersion, '0.12.0');
      assert.equal(welcome.tenantId, 't_test');
      assert.equal(welcome.ready, true);

      const hello = await waitFrame((f) => f.type === 'event' && f.channel === 'fake:test');
      assert.deepEqual(hello.args, ['hello']);

      ws.send(
        JSON.stringify({ v: 1, type: 'invoke', id: 'i1', channel: 'cowork:session:start', args: [42, 'x'] }),
      );
      const result = (await waitFrame((f) => f.type === 'result' && f.id === 'i1')) as unknown as {
        ok: boolean;
        value: { echo: { channel: string; args: unknown[] } };
      };
      assert.equal(result.ok, true);
      assert.equal(result.value.echo.channel, 'cowork:session:start');
      assert.deepEqual(result.value.echo.args, [42, 'x']);

      await waitFrame((f) => f.type === 'event' && f.channel === 'fake:emitAgain');

      ws.send(JSON.stringify({ v: 1, type: 'ping', ts: 1234 }));
      const pong = await waitFrame((f) => f.type === 'pong');
      assert.equal(pong.ts, 1234);

      ws.close();
    } finally {
      await t.stop();
    }
  });

  test('ws upgrade rejects a wrong secret', async () => {
    const t = await startTenant({ FAKE_TENANT_HEALTH_AFTER_MS: '0', FAKE_TENANT_PHASES: 'ready:0' });
    try {
      const outcome = await new Promise<string>((resolve) => {
        const ws = connect(t.port, 'wrong-secret');
        ws.once('open', () => {
          ws.close();
          resolve('opened (bad)');
        });
        ws.once('error', (err) => resolve(`error: ${err.message}`));
        ws.once('close', () => resolve('closed'));
      });
      assert.ok(outcome.startsWith('error:'), `expected an upgrade error, got: ${outcome}`);
      assert.match(outcome, /401/);
    } finally {
      await t.stop();
    }
  });

  test('a frame over 1 MiB closes the socket with 4008', async () => {
    const t = await startTenant({ FAKE_TENANT_HEALTH_AFTER_MS: '0', FAKE_TENANT_PHASES: 'ready:0' });
    try {
      const ws = connect(t.port, SECRET);
      const { waitFrame } = frameCollector(ws);
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      await waitFrame((f) => f.type === 'welcome');
      const big = 'x'.repeat(1024 * 1024 + 64);
      ws.send(JSON.stringify({ v: 1, type: 'invoke', id: 'big', channel: 'fake:big', args: [big] }));
      const code = await new Promise<number>((resolve) => {
        ws.once('close', (closeCode) => resolve(closeCode));
      });
      assert.equal(code, 4008);
    } finally {
      await t.stop();
    }
  });

  test('SIGTERM closes sockets with 4012 and exits 0', async () => {
    const t = await startTenant({ FAKE_TENANT_HEALTH_AFTER_MS: '0', FAKE_TENANT_PHASES: 'ready:0' });
    try {
      const ws = connect(t.port, SECRET);
      const { waitFrame } = frameCollector(ws);
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      await waitFrame((f) => f.type === 'welcome');
      const closeCode = new Promise<number>((resolve) => {
        ws.once('close', (code) => resolve(code));
      });
      const exitCode = new Promise<number>((resolve) => {
        t.child.once('exit', (code) => resolve(code ?? -1));
      });
      t.child.kill('SIGTERM');
      assert.equal(await closeCode, 4012);
      assert.equal(await exitCode, 0);
    } finally {
      await t.stop();
    }
  });
});
