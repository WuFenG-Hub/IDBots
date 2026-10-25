// Motion Video Arena — Browser bridge helper + wiring tests (G3 re-acceptance).
//
// Covers the client side of the `agent-browser:request|response|event`
// postMessage protocol that the Bot Browser chrome answers
// (agent-browser-ui dist/browser/app.js), plus the返修 wiring rules:
//   - helper installs request/on/navigate, correlates responses by id,
//     propagates error codes, times out when no host answers
//   - probeBrowserHost distinguishes live host / no host / live-with-undisclosed-actor
//   - mock success copy can never read as a real on-chain write
//   - strict deep-link path matching, poster resolution, host-consistency

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Arena = require('../METAAPPs/motion-video-arena/app.js');
const Helper = require('../METAAPPs/motion-video-arena/agent-browser-helper.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(repoRoot, 'METAAPPs', 'motion-video-arena');
const readAppJs = () => fs.readFileSync(path.join(appDir, 'app.js'), 'utf8');
const readIndexHtml = () => fs.readFileSync(path.join(appDir, 'index.html'), 'utf8');

// ---------------------------------------------------------------------------
// Fake window harness for the postMessage bridge
// ---------------------------------------------------------------------------

function makeFakeWindow({ hasParent = true, responder = null } = {}) {
  const posted = [];
  const listeners = {};
  function send(message) {
    posted.push(message);
    if (responder) {
      const reply = responder(message);
      if (reply) queueMicrotask(() => deliver(reply));
    }
  }
  const win = {
    addEventListener(type, handler) {
      (listeners[type] = listeners[type] || []).push(handler);
    },
    postMessage: send,
  };
  // Framed iframe: parent is a distinct object that shares the send channel;
  // top-level page: parent === window.
  win.parent = hasParent ? { postMessage: send } : win;
  function deliver(data) {
    (listeners.message || []).forEach((handler) => handler({ data }));
  }
  return { win, posted, deliver, listeners };
}

function installOn(fake) {
  globalThis.window = fake.win;
  const bridge = Helper.installAgentBrowserHelper();
  return bridge;
}

test('helper never overwrites a natively injected AgentBrowser', () => {
  const fake = makeFakeWindow();
  const nativeRequest = function () { return Promise.resolve({ native: true }); };
  const nativeOn = function () { return function () {}; };
  fake.win.AgentBrowser = { request: nativeRequest, on: nativeOn };
  globalThis.window = fake.win;
  const bridge = Helper.installAgentBrowserHelper();
  assert.equal(bridge.request, nativeRequest, 'native request preserved');
  assert.equal(bridge.on, nativeOn, 'native on preserved');
  assert.equal(typeof bridge.navigate, 'function', 'missing navigate filled in');
  // The filled-in navigate still speaks the protocol; the native methods stay untouched.
  bridge.navigate('metaapp://native-host');
  assert.equal(fake.posted[0].type, 'agent-browser:navigate');
});

test('helper installs window.AgentBrowser with request/on/navigate', () => {
  const fake = makeFakeWindow();
  const bridge = installOn(fake);
  assert.equal(typeof bridge.request, 'function');
  assert.equal(typeof bridge.on, 'function');
  assert.equal(typeof bridge.navigate, 'function');
  assert.equal(globalThis.window.AgentBrowser, bridge);
  bridge.navigate('metaapp://abc');
  assert.deepEqual(fake.posted[0].type, 'agent-browser:navigate');
  assert.equal(fake.posted[0].uri, 'metaapp://abc');
});

test('request correlates agent-browser:response by id and resolves results', async () => {
  const fake = makeFakeWindow();
  const bridge = installOn(fake);
  const pending = bridge.request({ method: 'browser.actor.current', params: {} });
  const sent = fake.posted.find((m) => m.type === 'agent-browser:request');
  assert.equal(sent.method, 'browser.actor.current');
  assert.equal(sent.version, 1);
  fake.deliver({ type: 'agent-browser:response', id: sent.id, ok: true, result: { actor: { globalMetaId: 'idx' } } });
  const result = await pending;
  assert.deepEqual(result, { actor: { globalMetaId: 'idx' } });
});

test('request propagates host error codes and rejects', async () => {
  const fake = makeFakeWindow();
  const bridge = installOn(fake);
  const pending = bridge.request({ method: 'metaid.pin.write', params: {} });
  const sent = fake.posted.find((m) => m.type === 'agent-browser:request');
  fake.deliver({
    type: 'agent-browser:response',
    id: sent.id,
    ok: false,
    error: { code: 'user_cancelled', message: 'cancelled' },
  });
  await assert.rejects(pending, (error) => error.code === 'user_cancelled' && /cancelled/.test(error.message));
});

test('request times out with bridge_timeout when no host answers', async () => {
  const fake = makeFakeWindow();
  const bridge = installOn(fake);
  await assert.rejects(
    bridge.request({ method: 'browser.actor.current', timeoutMs: 20 }),
    (error) => error.code === 'bridge_timeout',
  );
});

test('on() dispatches agent-browser:event payloads and supports unsubscribe', () => {
  const fake = makeFakeWindow();
  const bridge = installOn(fake);
  const seen = [];
  const off = bridge.on('browser.actor.changed', (payload) => seen.push(payload));
  fake.deliver({ type: 'agent-browser:event', event: 'browser.actor.changed', payload: { actor: { name: 'B' } } });
  off();
  fake.deliver({ type: 'agent-browser:event', event: 'browser.actor.changed', payload: { actor: { name: 'C' } } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].actor.name, 'B');
});

test('probeBrowserHost: live host with actor', async () => {
  const fake = makeFakeWindow({
    responder: (message) => message.type === 'agent-browser:request' && message.method === 'browser.actor.current'
      ? { type: 'agent-browser:response', id: message.id, ok: true, result: { actor: { globalMetaId: 'idprobe' } } }
      : null,
  });
  globalThis.window = fake.win;
  const probe = await Helper.probeBrowserHost(500);
  assert.equal(probe.host, true);
  assert.equal(probe.actor.globalMetaId, 'idprobe');
});

test('probeBrowserHost: silence resolves host=false after the bounded wait', async () => {
  const fake = makeFakeWindow();
  globalThis.window = fake.win;
  const started = Date.now();
  const probe = await Helper.probeBrowserHost(60);
  assert.equal(probe.host, false);
  assert.equal(probe.error, 'bridge_timeout');
  assert.ok(Date.now() - started >= 50, 'waited for the probe window');
});

test('probeBrowserHost: a late consent response recovers the live host and Actor', async () => {
  const fake = makeFakeWindow();
  globalThis.window = fake.win;
  const probe = await Helper.probeBrowserHost(20);
  assert.equal(probe.host, false);
  assert.equal(probe.error, 'bridge_timeout');
  assert.ok(probe.recovery, 'the initial request remains available for late recovery');
  const sent = fake.posted.find((message) => message.method === 'browser.actor.current');
  fake.deliver({
    type: 'agent-browser:response',
    id: sent.id,
    ok: true,
    result: { actor: { globalMetaId: 'idlatehuman' } },
  });
  const recovered = await probe.recovery;
  assert.equal(recovered.host, true);
  assert.equal(recovered.actor.globalMetaId, 'idlatehuman');
});

test('probeBrowserHost: late consent denial recovers the host without an Actor', async () => {
  const fake = makeFakeWindow();
  globalThis.window = fake.win;
  const probe = await Helper.probeBrowserHost(20);
  const sent = fake.posted.find((message) => message.method === 'browser.actor.current');
  fake.deliver({
    type: 'agent-browser:response',
    id: sent.id,
    ok: false,
    error: { code: 'consent_denied', message: 'denied' },
  });
  const recovered = await probe.recovery;
  assert.equal(recovered.host, true);
  assert.equal(recovered.actor, null);
  assert.equal(recovered.error, 'denied');
});

test('probeBrowserHost: consent denial is a live host with an undisclosed actor', async () => {
  const fake = makeFakeWindow({
    responder: (message) => message.type === 'agent-browser:request'
      ? { type: 'agent-browser:response', id: message.id, ok: false, error: { code: 'consent_denied', message: 'denied' } }
      : null,
  });
  globalThis.window = fake.win;
  const probe = await Helper.probeBrowserHost(500);
  assert.equal(probe.host, true, 'a refused disclosure still proves the host is there');
  assert.equal(probe.actor, null);
});

// ---------------------------------------------------------------------------
// Submission outcome copy — mock success can never look like a chain write
// ---------------------------------------------------------------------------

test('submissionOutcomeMessage keeps mock and real wording apart', () => {
  const ok = { ok: true, pinId: 'a'.repeat(64) + 'i0', submittedCount: 2 };
  const mockText = Arena.submissionOutcomeMessage(ok, { mock: true });
  const realText = Arena.submissionOutcomeMessage(ok, { mock: false });
  assert.match(mockText, /Mock submission succeeded/);
  assert.match(mockText, /nothing was written on chain/);
  assert.ok(!/on chain\./.test(mockText.replace(/nothing was written on chain/, '')));
  assert.match(realText, /Submitted 2 comparisons on chain\./);
  assert.equal(Arena.submissionOutcomeMessage({ ok: false, status: 'busy' }), 'A submission is already in flight.');
  assert.match(
    Arena.submissionOutcomeMessage({ ok: false, status: 'unknown', message: 'kept' }),
    /kept/,
  );
});

test('controller maps bridge_timeout on the write call to the unknown outcome', async () => {
  const queue = Arena.createQueue();
  queue.add(Arena.buildComparisonItem(
    {
      left: Arena.normalizeCandidate({ pinId: 'a'.repeat(64) + 'i0', currentPinId: 'a'.repeat(64) + 'i0', chainName: 'mvc', disabled: false, motionVideo: { videoFile: 'metafile://' + 'a'.repeat(64) + 'i0.mp4', videoSha256: 'b'.repeat(64) } }).candidate,
      right: Arena.normalizeCandidate({ pinId: 'b'.repeat(64) + 'i0', currentPinId: 'b'.repeat(64) + 'i0', chainName: 'mvc', disabled: false, motionVideo: { videoFile: 'metafile://' + 'b'.repeat(64) + 'i0', videoSha256: 'c'.repeat(64) } }).candidate,
    },
    'tie',
  ).item);
  let timeoutError = new Error('AgentBrowser bridge timeout.');
  timeoutError.code = 'bridge_timeout';
  const submission = Arena.createSubmissionController({
    bridge: { request: () => Promise.reject(timeoutError) },
    clientArtifactRoot: () => 'd'.repeat(64) + 'i0',
    queue,
  });
  const result = await submission.submit();
  assert.equal(result.ok, false);
  assert.equal(result.status, 'unknown');
  assert.equal(queue.size(), 1, 'items kept on unknown outcome');
});

// ---------------------------------------------------------------------------
// Strict deep-link paths and poster resolution
// ---------------------------------------------------------------------------

test('near-miss compare paths fall back to the pool route', () => {
  assert.equal(Arena.parseCompareRoute('#/comparexyz').route, 'home');
  assert.equal(Arena.parseCompareRoute('#/compare/extra?a=1').route, 'home');
  const real = Arena.parseCompareRoute('#/compare?a=' + 'a'.repeat(64) + 'i0&b=' + 'b'.repeat(64) + 'i0');
  assert.equal(real.route, 'compare');
});

test('resolvePosterUrl accepts https and metafile covers, rejects junk', () => {
  assert.equal(Arena.resolvePosterUrl('https://x.example/p.png'), 'https://x.example/p.png');
  assert.equal(
    Arena.resolvePosterUrl('metafile://' + '1'.repeat(64) + 'i0.jpg'),
    'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/' + '1'.repeat(64) + 'i0',
  );
  assert.equal(Arena.resolvePosterUrl('javascript:alert(1)'), '');
  assert.equal(Arena.resolvePosterUrl(''), '');
  assert.equal(Arena.resolvePosterUrl(null), '');
});

// ---------------------------------------------------------------------------
// Wiring rules (static): helper order, actor.changed, beforeunload, hosts
// ---------------------------------------------------------------------------

test('index.html loads the bridge helper before app.js', () => {
  const html = readIndexHtml();
  const helperAt = html.indexOf('./agent-browser-helper.js');
  const appAt = html.indexOf('./app.js');
  assert.ok(helperAt >= 0, 'helper script tag present');
  assert.ok(appAt > helperAt, 'helper must execute before app.js');
});

test('app wiring follows the helper, listens for actor changes, never unloads silently', () => {
  const js = readAppJs();
  // Live bridge is consumed through the standard helper's window.AgentBrowser.
  assert.match(js, /window\.AgentBrowser/);
  assert.match(js, /MotionVideoArenaBridgeHelper/);
  assert.match(js, /browser\.actor\.changed/);
  // beforeunload warns on ANY unsubmitted item (no in-flight carve-out).
  const unload = js.slice(js.indexOf('beforeunload'), js.indexOf('beforeunload') + 400);
  assert.ok(!unload.includes('isBusy'), 'unload warning must not be skipped while submitting');
  // Live-host-wins mock gating is explicit in the wiring.
  assert.match(js, /if \(mockRequested && !probe\.host\)/);
  assert.match(js, /runtime\.mockIgnored = true/);
  // Poster wiring uses the resolver.
  assert.match(js, /resolvePosterUrl\(candidate\.coverImg\)/);
  // Mock success copy states plainly that nothing went on chain.
  assert.match(js, /Mock submission succeeded — nothing was written on chain/);
});

test('every MetaSo reference in the package uses the single host so.metaid.io', () => {
  for (const source of [readAppJs(), readIndexHtml(), fs.readFileSync(path.join(appDir, 'APP.md'), 'utf8')]) {
    const hosts = [...source.matchAll(/\bso\.[a-z0-9.-]+/g)].map((m) => m[0]);
    assert.ok(
      hosts.every((host) => host === 'so.metaid.io'),
      `unexpected MetaSo host in package: ${[...new Set(hosts)].join(', ')}`,
    );
  }
});
