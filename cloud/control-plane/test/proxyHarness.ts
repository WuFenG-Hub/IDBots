import type Database from 'better-sqlite3';
import { FakeDocker } from './fake-docker/index.mjs';
import {
  api,
  freshDb,
  insertInvite,
  sessionCookieFrom,
  startAlertSink,
  startTestApp,
  waitFor,
  type TestApp,
} from './helpers.js';
import { DockerClient } from '../src/docker/client.js';
import { TenantPoller } from '../src/services/poller.js';
import type { PublicServerOptions } from '../src/server.js';

export interface ProxyTest {
  db: Database.Database;
  fake: FakeDocker;
  client: DockerClient;
  app: TestApp;
  poller: TenantPoller;
  cpBase: string;
  origin: string;
  phone: string;
  cookie: string;
  sessionToken: string;
  userId: string;
  tenantId: string;
  /** Present only when requested via withAlertSink. */
  sink: { url: string; messages: string[]; close: () => Promise<void> } | null;
  close: () => Promise<void>;
}

/**
 * Full proxy test harness: fake docker + control plane + poller, a real
 * invite sign-up through the HTTP API, and a tenant polled to `ready`.
 * The phone's cookie/token are exposed so tests can derive the expected
 * C2 client id and reconnect.
 */
export async function setupProxyTest(options: {
  wsProxy?: PublicServerOptions['wsProxy'];
  withAlertSink?: boolean;
} = {}): Promise<ProxyTest> {
  const phone = '+8613900009001';
  const db = freshDb();
  const fake = new FakeDocker();
  await fake.listen(0);
  const client = new DockerClient(fake.url());
  const sink = options.withAlertSink ? await startAlertSink() : null;
  const app = await startTestApp({
    db,
    dockerUrl: fake.url(),
    fakeSmsNumbers: [phone],
    wsProxy: options.wsProxy,
    ...(sink ? { alertWebhook: sink.url } : {}),
    tenantEnv: {
      FAKE_TENANT_HEALTH_AFTER_MS: '30',
      FAKE_TENANT_PHASES: 'migrating:100,bootstrapping:100,ready:0',
    },
  });
  const poller = new TenantPoller(app.app, { tickFastMs: 50, tickSlowMs: 100 });
  poller.start();

  insertInvite(db, { code: 'PROXY-1', maxUses: 5, now: Date.now() });
  const send = await api(app.baseUrl, '/api/v1/auth/sms/send', {
    method: 'POST',
    body: { phone, purpose: 'login' },
  });
  if (send.status !== 200) {
    throw new Error(`sms/send failed: ${send.status}`);
  }
  const verify = await api(app.baseUrl, '/api/v1/auth/sms/verify', {
    method: 'POST',
    body: { phone, code: '246810', inviteCode: 'PROXY-1', displayName: 'Proxy Test' },
  });
  if (verify.status !== 200) {
    throw new Error(`sms/verify failed: ${send.status}`);
  }
  const cookie = sessionCookieFrom(verify.setCookie);
  const sessionToken = cookie.slice('idb_session='.length);
  const body = verify.json as { user: { id: string }; tenant: { status: string } };
  const userId = body.user.id;
  const tenantRow = db.prepare('SELECT id FROM tenants WHERE user_id = ?').get(userId) as { id: string };
  const tenantId = tenantRow.id;

  await waitFor(async () => {
    const row = db.prepare('SELECT status FROM tenants WHERE id = ?').get(tenantId) as
      | { status: string }
      | undefined;
    return row?.status === 'ready' ? true : null;
  }, 20_000);

  return {
    db,
    fake,
    client,
    app,
    poller,
    cpBase: app.baseUrl,
    origin: new URL(app.baseUrl).origin,
    phone,
    cookie,
    sessionToken,
    userId,
    tenantId,
    sink,
    close: async () => {
      await poller.stop();
      await app.close();
      await sink?.close();
      await fake.close();
      db.close();
    },
  };
}

/** Buffering frame collector (mirrors fake-tenant.test.ts). */
export interface Frame {
  type: string;
  [key: string]: unknown;
}

export function frameCollector(ws: { on: (event: string, cb: (data: Buffer) => void) => void }): {
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
  function waitFrame(pred: (frame: Frame) => boolean, timeoutMs = 4000): Promise<Frame> {
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
