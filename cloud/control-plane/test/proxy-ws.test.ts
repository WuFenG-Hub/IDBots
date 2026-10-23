import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { WebSocket } from 'ws';
import { frameCollector, setupProxyTest, type ProxyTest } from './proxyHarness.js';
import { sha256Hex } from '../src/crypto.js';

function wsUrl(cpBase: string): string {
  return `${cpBase.replace(/^http/, 'ws')}/ws`;
}

interface ConnectOptions {
  cookie?: string | null;
  origin?: string | null;
  autoPong?: boolean;
}

function connect(cpBase: string, origin: string, options: ConnectOptions = {}): WebSocket {
  const headers: Record<string, string> = {};
  if (options.cookie) {
    headers.Cookie = options.cookie;
  }
  if (options.origin !== null) {
    headers.Origin = options.origin ?? origin;
  }
  const wsOptions: Record<string, unknown> = { headers };
  if (options.autoPong === false) {
    wsOptions.autoPong = false;
  }
  return new WebSocket(wsUrl(cpBase), wsOptions as never);
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws open timed out')), 4000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitClose(ws: WebSocket, timeoutMs = 4000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws close timed out')), timeoutMs);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString('utf8') });
    });
  });
}

function expectedClientId(sessionToken: string): string {
  return `c_${sha256Hex(sessionToken).slice(0, 16)}`;
}

describe('proxy /ws (REQ-B-13, REQ-B-15)', () => {
  let t: ProxyTest;

  before(async () => {
    t = await setupProxyTest();
  });

  after(async () => {
    await t.close();
  });

  test('welcome carries the session-derived client id; invoke echo and events flow', async () => {
    const ws = connect(t.cpBase, t.origin, { cookie: t.cookie });
    const { waitFrame } = frameCollector(ws);
    await waitOpen(ws);

    const welcome = await waitFrame((f) => f.type === 'welcome');
    assert.equal(welcome.tenantId, t.tenantId);
    assert.equal(welcome.clientId, expectedClientId(t.sessionToken), 'client id derived from the session token');
    assert.equal(typeof welcome.xff, 'string', 'X-Forwarded-For reached the tenant');

    ws.send(JSON.stringify({ v: 1, type: 'invoke', id: 'p1', channel: 'cowork:session:start', args: [7] }));
    const result = await waitFrame((f) => f.type === 'result' && f.id === 'p1');
    assert.equal(result.ok, true);

    await waitFrame((f) => f.type === 'event' && f.channel === 'fake:test');
    ws.close();
  });

  test('an oversized invoke answers PAYLOAD_TOO_LARGE and the socket stays usable', async () => {
    const ws = connect(t.cpBase, t.origin, { cookie: t.cookie });
    const { waitFrame } = frameCollector(ws);
    await waitOpen(ws);
    await waitFrame((f) => f.type === 'welcome');

    const big = 'x'.repeat(1024 * 1024 + 1024);
    ws.send(JSON.stringify({ v: 1, type: 'invoke', id: 'big1', channel: 'app:getVersion', args: [big] }));
    const rejected = await waitFrame((f) => f.type === 'result' && f.id === 'big1');
    assert.equal(rejected.ok, false);
    assert.equal((rejected.error as { code: string }).code, 'PAYLOAD_TOO_LARGE');

    ws.send(JSON.stringify({ v: 1, type: 'invoke', id: 'p2', channel: 'app:getVersion', args: [] }));
    const after = await waitFrame((f) => f.type === 'result' && f.id === 'p2');
    assert.equal(after.ok, true, 'socket still answers after the oversize frame');
    ws.close();
  });

  test('reconnecting with the same cookie yields the same client id', async () => {
    const first = connect(t.cpBase, t.origin, { cookie: t.cookie });
    const firstFrames = frameCollector(first);
    await waitOpen(first);
    await firstFrames.waitFrame((f) => f.type === 'welcome');
    first.close();
    await waitClose(first);

    const second = connect(t.cpBase, t.origin, { cookie: t.cookie });
    const secondFrames = frameCollector(second);
    await waitOpen(second);
    const welcomeAgain = await secondFrames.waitFrame((f) => f.type === 'welcome');
    assert.equal(welcomeAgain.clientId, expectedClientId(t.sessionToken));
    second.close();
  });

  test('no cookie closes 4001; a bad Origin closes 4003', async () => {
    const noCookie = connect(t.cpBase, t.origin, { cookie: null });
    const close1 = waitClose(noCookie);
    await waitOpen(noCookie);
    assert.equal((await close1).code, 4001);

    const badOrigin = connect(t.cpBase, t.origin, { cookie: t.cookie, origin: 'https://evil.example.com' });
    const close2 = waitClose(badOrigin);
    await waitOpen(badOrigin);
    assert.equal((await close2).code, 4003);
  });

  test('the proxy pings the phone; a client that never pongs is terminated', async () => {
    const t2 = await setupProxyTest({ wsProxy: { pingIntervalMs: 100, pongTimeoutMs: 350 } });
    try {
      // Well-behaved client: stays open across several ping cycles.
      const good = connect(t2.cpBase, t2.origin, { cookie: t2.cookie });
      await waitOpen(good);
      await new Promise((resolve) => setTimeout(resolve, 550));
      assert.equal(good.readyState, good.OPEN, 'auto-ponging client survives proxy pings');
      good.close();

      // Client that never answers pings: terminated by the proxy.
      const mute = connect(t2.cpBase, t2.origin, { cookie: t2.cookie, autoPong: false });
      const closed = waitClose(mute, 3000);
      await waitOpen(mute);
      const { code } = await closed;
      // The proxy drops the connection (terminate), so the client sees the
      // abnormal close locally; 1006 never appears on the wire.
      assert.equal(code, 1006);
    } finally {
      await t2.close();
    }
  });

  test('REQ-B-15: client-supplied tenant hints never reroute the socket', async () => {
    const ws = new WebSocket(`${wsUrl(t.cpBase)}?tenant=t_attacker`, {
      headers: { Cookie: t.cookie, Origin: t.origin, 'X-IDBots-Tenant': 't_attacker' },
    });
    const { waitFrame } = frameCollector(ws);
    await waitOpen(ws);
    const welcome = await waitFrame((f) => f.type === 'welcome');
    assert.equal(welcome.tenantId, t.tenantId, 'still the session tenant');
    ws.close();
  });

  test('tenant SIGTERM passes close 4012 to the phone', async () => {
    const ws = connect(t.cpBase, t.origin, { cookie: t.cookie });
    const { waitFrame } = frameCollector(ws);
    await waitOpen(ws);
    await waitFrame((f) => f.type === 'welcome');

    const containers = await t.client.listContainers({ namePrefix: `idb-${t.tenantId}` });
    const closed = waitClose(ws, 6000);
    await t.client.stopContainer(containers[0].Id, 30);
    const { code } = await closed;
    assert.equal(code, 4012, 'tenant drain close code passed through');
  });

  test('a stopped tenant closes the socket with 4013', async () => {
    t.db.prepare("UPDATE tenants SET status = 'stopped' WHERE id = ?").run(t.tenantId);
    const ws = connect(t.cpBase, t.origin, { cookie: t.cookie });
    const closed = waitClose(ws);
    await waitOpen(ws);
    assert.equal((await closed).code, 4013);
  });

});
