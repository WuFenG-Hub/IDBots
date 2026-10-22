#!/usr/bin/env node
// Smoke test for the tenant image's C1/C2 contract surface. Runs against a
// started container; used by CI (.github/workflows/cloud-images.yml) until
// WS-A's conformance kit (cloud/conformance/run.mjs) lands, and handy for
// local checks:
//   node smoke-test.mjs http://127.0.0.1:8790 test-secret
// Exit 0 = all checks passed.

const [base = 'http://127.0.0.1:8790', secret = 'test-secret'] = process.argv.slice(2);
const wsBase = base.replace(/^http/, 'ws');

let failed = 0;
const ok = (name) => console.log(`ok   - ${name}`);
const fail = (name, why) => { failed++; console.error(`FAIL - ${name}: ${why}`); };

function assert(cond, name, why) {
  if (cond) ok(name); else fail(name, why);
}

const timeout = (ms, what) => new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms));

async function main() {
  // /healthz is unauthenticated per C1.
  const health = await fetch(`${base}/healthz`).then((r) => r.json()).catch(() => null);
  assert(health?.ok === true, 'GET /healthz returns {"ok":true} without auth');

  // Everything else requires the gateway secret.
  const noAuth = await fetch(`${base}/readyz`).catch(() => null);
  assert(noAuth?.status === 401, 'GET /readyz without secret is 401');

  const ready = await fetch(`${base}/readyz`, { headers: { 'x-idbots-gateway-secret': secret } })
    .then(async (r) => ({ status: r.status, body: await r.json() })).catch(() => null);
  assert(ready?.status === 200, 'GET /readyz with secret is 200');
  const b = ready?.body ?? {};
  assert(b.ready === true && b.phase === 'ready', 'readyz payload: ready/phase');
  assert(typeof b.version === 'string' && typeof b.contractVersion === 'string',
    'readyz payload: version + contractVersion');
  assert(b.onboarding && typeof b.onboarding === 'object', 'readyz payload: onboarding block');

  // Upload roundtrip (C2): 1 KB file in, {path,size} out.
  const up = await fetch(`${base}/gateway/v1/upload?name=smoke.bin`, {
    method: 'POST',
    headers: { 'x-idbots-gateway-secret': secret, 'content-type': 'application/octet-stream' },
    body: Buffer.alloc(1024, 7),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) })).catch(() => null);
  assert(up?.status === 200 && up?.body?.size === 1024 && typeof up?.body?.path === 'string',
    'POST /gateway/v1/upload stores the body and returns {path,size}',
    `got ${up?.status} ${JSON.stringify(up?.body)}`);

  // WebSocket: wrong secret must not upgrade.
  const badWs = await new Promise((resolve) => {
    let settled = false;
    try {
      const ws = new WebSocket(`${wsBase}/gateway/v1/ws`, { headers: { 'x-idbots-gateway-secret': 'wrong' } });
      ws.onopen = () => { if (!settled) { settled = true; ws.close(); resolve('opened'); } };
      ws.onerror = () => { if (!settled) { settled = true; resolve('rejected'); } };
      setTimeout(() => { if (!settled) { settled = true; resolve('timeout'); } }, 5000);
    } catch { resolve('rejected'); }
  });
  assert(badWs === 'rejected', 'WS upgrade with wrong secret is refused', `got ${badWs}`);

  // WebSocket: welcome -> invoke echo -> ping/pong, then a 4th socket gets 4009.
  await Promise.race([timeout(10_000, 'ws session'), (async () => {
    const ws = new WebSocket(`${wsBase}/gateway/v1/ws`, { headers: { 'x-idbots-gateway-secret': secret } });
    const frames = [];
    const once = () => new Promise((res) => {
      const prev = ws.onmessage;
      ws.onmessage = (ev) => { prev?.(ev); res(JSON.parse(ev.data)); };
    });
    ws.onmessage = (ev) => frames.push(JSON.parse(ev.data));
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    const welcome = await once();
    assert(welcome?.type === 'welcome' && welcome?.v === 1, 'WS welcome frame');
    assert(typeof welcome?.contractVersion === 'string' && typeof welcome?.tenantId === 'string',
      'WS welcome: contractVersion + tenantId');

    ws.send(JSON.stringify({ v: 1, type: 'invoke', id: 'smoke-1', channel: 'test:echo', args: [{ a: 1 }] }));
    const result = await once();
    assert(result?.type === 'result' && result?.id === 'smoke-1' && result?.ok === true,
      'WS invoke returns echo result');
    assert(result?.value?.echo === true && result?.value?.channel === 'test:echo',
      'WS echo payload round-trips channel');

    ws.send(JSON.stringify({ v: 1, type: 'ping', ts: Date.now() }));
    const pong = await once();
    assert(pong?.type === 'pong', 'WS app-level ping answered with pong');

    const extra = [1, 2, 3].map(() => new WebSocket(`${wsBase}/gateway/v1/ws`,
      { headers: { 'x-idbots-gateway-secret': secret } }));
    // The server keeps 3 sockets and closes whichever upgrade arrives fourth —
    // any one of the three extras may be the unlucky one.
    const closed = await Promise.race([
      Promise.any(extra.map((s) => new Promise((res) => {
        s.onclose = (ev) => res(ev.code);
        s.onerror = () => res(-1);
      }))),
      timeout(5000, '4009 close'),
    ]).catch(() => -2);
    assert(closed === 4009, 'fourth concurrent socket closed with 4009', `got ${closed}`);
    extra.forEach((s) => { try { s.close(); } catch { /* already closed */ } });
    ws.close();
  })()]);

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nsmoke test passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
