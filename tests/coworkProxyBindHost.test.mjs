/**
 * Security regression test: the cowork proxy must bind loopback ONLY.
 * The proxy serves unauthenticated internal APIs (scheduled-task CRUD) and
 * relays the user's upstream API key (/v1/messages); an all-interfaces bind
 * (0.0.0.0, as shipped after the genesis import) exposed all of it to the
 * LAN — anyone on the network could read task prompts, rewrite them, or ride
 * the upstream key. Restores the upstream 83ab8646 hardening.
 *
 * Asserts: reachable on 127.0.0.1, refused on every non-internal IPv4 the
 * machine owns (skips when the machine has none, e.g. bare CI runners).
 *
 * Requires `npm run compile:electron` to have run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

let proxy;
try {
  proxy = await import('../dist-electron/main/libs/coworkOpenAICompatProxy.js');
} catch {
  proxy = await import('../dist-electron/libs/coworkOpenAICompatProxy.js');
}

const { startCoworkOpenAICompatProxy, stopCoworkOpenAICompatProxy, getCoworkOpenAICompatProxyBaseURL } = proxy;

function nonLoopbackIpv4Addresses() {
  const addresses = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      addresses.push(net.address);
    }
  }
  return [...new Set(addresses)];
}

test('proxy listens on loopback only — LAN interfaces are refused', async () => {
  await startCoworkOpenAICompatProxy();
  try {
    const base = getCoworkOpenAICompatProxyBaseURL();
    assert.ok(base?.startsWith('http://127.0.0.1:'), `base URL must be loopback, got ${base}`);

    const localRes = await fetch(`${base}/healthz`);
    assert.equal(localRes.status, 200);

    const lanAddresses = nonLoopbackIpv4Addresses();
    if (lanAddresses.length === 0) {
      return; // no non-internal interfaces to probe on this machine
    }
    for (const address of lanAddresses) {
      const port = new URL(base).port;
      await assert.rejects(
        fetch(`http://${address}:${port}/healthz`, { signal: AbortSignal.timeout(3000) }),
        null,
        `proxy must not answer on ${address} (bind must be 127.0.0.1, not 0.0.0.0)`,
      );
    }
  } finally {
    await stopCoworkOpenAICompatProxy();
  }
});
