// Motion Video Arena MetaApp — component tests (workstream WS4, gate G3).
//
// Drives the DOM-free core exported by METAAPPs/motion-video-arena/app.js
// with the two REAL reference fixture shapes (docs/design/motion-video-
// preference/acceptance-plan.md §2) and a mocked Browser bridge:
//   - candidate normalization incl. optional video extension / audio fields
//   - root/currentPinId → ArtifactRef mapping
//   - deep-link parsing and error classification
//   - pair selection: no identical videos, exposure balance, side randomization
//   - audio exclusivity coordinator
//   - queue add/remove/28-item cap
//   - exact comparison-batch payload against the shared conformance vectors
//   - one metaid.pin.write per batch, no Actor id, no telemetry
//   - success/failure/unknown submission outcomes, read-only host

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Arena = require('../METAAPPs/motion-video-arena/app.js');

// ----- reference fixtures (acceptance-plan §2) -----

const FIXTURE_A_ROOT = '22ce6ca2ba950c3659c739e235b519e94341fe0a19f13c876807dad6e0955659i0';
const FIXTURE_B_ROOT = '5686db0dd51ac19ec60c4a02ff66bc51adcf0149b8484141b38e730c734d9bb4i0';
const FIXTURE_A_SHA = 'b8113ccc77c592466f8c67b7ff775cb9c57927a516c34989e8611a1d09f81674';
const FIXTURE_B_SHA = '39c9c6c9b2a035568a07273b92b3f426d383a5ab5c1d98dfb7bd760faf0e1860';

function fixtureA(overrides = {}) {
  return {
    pinId: FIXTURE_A_ROOT,
    sourcePinId: FIXTURE_A_ROOT,
    currentPinId: FIXTURE_A_ROOT,
    chainName: 'mvc',
    title: 'Ukiyo-e 10-second example',
    tags: ['motion-video'],
    disabled: false,
    publisherGlobalMetaId: 'idfixturepublisher0000000000000000000000a',
    publisherName: 'Fixture Publisher A',
    motionVideo: {
      // Fixture A carries a filename extension on the metafile reference.
      videoFile: 'metafile://a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90i0.mp4',
      videoSha256: FIXTURE_A_SHA,
      durationSec: 10,
      fps: 24,
      frames: 240,
      resolution: '1920x1080',
      hasAudio: false,
      engine: 'lemo-opuscar',
      style: 'ukiyoe',
    },
    ...overrides,
  };
}

function fixtureB(overrides = {}) {
  return {
    pinId: FIXTURE_B_ROOT,
    sourcePinId: FIXTURE_B_ROOT,
    // A real modify chain: current version differs from the stable root.
    currentPinId: 'd84baa3aced0047aeddaf5b99f069106a46ea7329b0aa252674abdafa9f4786ei0',
    chainName: 'mvc',
    title: 'Silent film ~47s with music',
    tags: ['motion-video'],
    disabled: false,
    publisherGlobalMetaId: 'idfixturepublisher0000000000000000000000b',
    motionVideo: {
      // Fixture B has no extension and no hasAudio field (unknown, not false).
      videoFile: 'metafile://b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1i0',
      videoSha256: FIXTURE_B_SHA,
      durationSec: 47,
      fps: 24,
      resolution: '1280x720',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Candidate normalization — both reference shapes
// ---------------------------------------------------------------------------

test('fixture A normalizes with extension, hasAudio false', () => {
  const { ok, candidate } = Arena.normalizeCandidate(fixtureA());
  assert.equal(ok, true);
  assert.equal(candidate.rootPinId, FIXTURE_A_ROOT);
  assert.equal(candidate.hasAudio, false);
  assert.equal(candidate.durationSec, 10);
  assert.deepEqual(candidate.artifactRef, {
    chainName: 'mvc',
    app: 'metaapp://' + FIXTURE_A_ROOT,
    version: 'metaapp://' + FIXTURE_A_ROOT,
    video: fixtureA().motionVideo.videoFile,
    videoSha256: FIXTURE_A_SHA,
  });
});

test('fixture B normalizes without extension; missing hasAudio stays unknown', () => {
  const { ok, candidate } = Arena.normalizeCandidate(fixtureB());
  assert.equal(ok, true);
  // Root vs currentPinId mapping: version is the exact folded pin, not the root.
  assert.equal(candidate.artifactRef.app, 'metaapp://' + FIXTURE_B_ROOT);
  assert.equal(candidate.artifactRef.version, 'metaapp://' + fixtureB().currentPinId);
  assert.equal(candidate.hasAudio, null, 'missing hasAudio is unknown, never false');
  assert.equal(candidate.videoPinId, 'b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1i0');
});

test('disabled, cross-chain, and incomplete candidates are technical exclusions', () => {
  assert.equal(Arena.normalizeCandidate(fixtureA({ disabled: true })).status, 'disabled');
  assert.equal(Arena.normalizeCandidate(fixtureA({ chainName: 'mvc-test' })).status, 'chain');
  assert.equal(Arena.normalizeCandidate(fixtureA({ currentPinId: '' })).status, 'malformed');
  assert.equal(Arena.normalizeCandidate(fixtureA({ motionVideo: { videoSha256: FIXTURE_A_SHA } })).status, 'malformed');
  assert.equal(
    Arena.normalizeCandidate(fixtureA({ motionVideo: { ...fixtureA().motionVideo, videoSha256: 'NOT-A-SHA' } })).status,
    'malformed',
  );
  assert.equal(Arena.normalizeCandidate(fixtureA({ motionVideo: { ...fixtureA().motionVideo, videoFile: 'https://example.com/v.mp4' } })).status, 'malformed');
});

test('normalizePool separates eligible from technical exclusions', () => {
  const pool = Arena.normalizePool([
    fixtureA(),
    fixtureB(),
    fixtureA({ disabled: true }),
    { pinId: 'x', chainName: 'mvc' },
  ]);
  assert.equal(pool.eligible.length, 2);
  assert.equal(pool.excluded.disabled, 1);
  assert.equal(pool.excluded.malformed, 1);
});

// ---------------------------------------------------------------------------
// 2. Video URL resolution
// ---------------------------------------------------------------------------

test('videoUrl wins when MetaSo supplies it; MetaFile fallback strips the extension', () => {
  const withUrl = Arena.normalizeCandidate(
    fixtureA({ motionVideo: { ...fixtureA().motionVideo, videoUrl: 'https://cdn.example.com/a.mp4' } }),
  ).candidate;
  assert.equal(withUrl.videoUrl, 'https://cdn.example.com/a.mp4');
  assert.equal(Arena.resolveVideoUrl(withUrl), 'https://cdn.example.com/a.mp4');

  const a = Arena.normalizeCandidate(fixtureA()).candidate;
  assert.equal(
    Arena.resolveVideoUrl(a),
    'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90i0',
  );
  const b = Arena.normalizeCandidate(fixtureB()).candidate;
  assert.equal(
    Arena.resolveVideoUrl(b),
    'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1i0',
  );
});

// ---------------------------------------------------------------------------
// 3. Deep-link parsing and error recovery
// ---------------------------------------------------------------------------

test('parseCompareRoute accepts #/ and #/compare with full pin ids', () => {
  assert.deepEqual(Arena.parseCompareRoute('#/'), { route: 'home' });
  assert.deepEqual(Arena.parseCompareRoute(''), { route: 'home' });
  const parsed = Arena.parseCompareRoute(
    '#/compare?a=' + encodeURIComponent(FIXTURE_A_ROOT) + '&b=' + encodeURIComponent(FIXTURE_B_ROOT),
  );
  assert.deepEqual(parsed, { route: 'compare', a: FIXTURE_A_ROOT, b: FIXTURE_B_ROOT });
});

test('parseCompareRoute classifies every invalid link as a recoverable error', () => {
  assert.equal(Arena.parseCompareRoute('#/compare').route, 'error');
  assert.equal(Arena.parseCompareRoute('#/compare?x=1').error, 'missing-ids');
  assert.equal(Arena.parseCompareRoute('#/compare?a=' + FIXTURE_A_ROOT).error, 'missing-b');
  assert.equal(Arena.parseCompareRoute('#/compare?a=abc&b=' + FIXTURE_B_ROOT).error, 'invalid-a');
  assert.equal(Arena.parseCompareRoute('#/compare?a=' + FIXTURE_A_ROOT + '&b=short').error, 'invalid-b');
  assert.equal(
    Arena.parseCompareRoute('#/compare?a=' + FIXTURE_A_ROOT + '&b=' + FIXTURE_A_ROOT).error,
    'same-root',
  );
  // Unknown routes fall back home instead of crashing.
  assert.equal(Arena.parseCompareRoute('#/whatever').route, 'home');
});

// ---------------------------------------------------------------------------
// 4. Pair selection: dedupe, exposure balance, side randomization
// ---------------------------------------------------------------------------

function candidatePool() {
  return [
    Arena.normalizeCandidate(fixtureA()).candidate,
    Arena.normalizeCandidate(fixtureB()).candidate,
    Arena.normalizeCandidate(
      fixtureA({
        pinId: 'e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4i0',
        currentPinId: 'e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4i0',
        motionVideo: {
          ...fixtureA().motionVideo,
          videoFile: 'metafile://e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4i0.webm',
          videoSha256: '11'.repeat(32),
        },
      }),
    ).candidate,
  ];
}

test('pair selection never pairs identical video hashes', () => {
  const sameShaPool = [
    Arena.normalizeCandidate(fixtureA()).candidate,
    Arena.normalizeCandidate(fixtureA({ pinId: FIXTURE_B_ROOT, currentPinId: FIXTURE_B_ROOT })).candidate,
  ];
  const selector = Arena.createPairSelector({ rng: () => 0.5 });
  assert.equal(selector.pick(sameShaPool), null);
});

test('a 2-candidate pool serves its only pair once and then exhausts', () => {
  const pool = [Arena.normalizeCandidate(fixtureA()).candidate, Arena.normalizeCandidate(fixtureB()).candidate];
  const selector = Arena.createPairSelector({ rng: () => 0.5 });
  assert.ok(selector.pick(pool));
  assert.equal(selector.pick(pool), null, 'an already-shown pair is not recycled');
});

test('a 4-candidate pool serves all six unordered pairs once and then exhausts', () => {
  const pool = candidatePool();
  pool.push(Arena.normalizeCandidate(fixtureB({
    pinId: 'a1'.repeat(32) + 'i0',
    currentPinId: 'a1'.repeat(32) + 'i0',
    motionVideo: {
      ...fixtureB().motionVideo,
      videoFile: 'metafile://' + 'a1'.repeat(32) + 'i0.mp4',
      videoSha256: '22'.repeat(32),
    },
  })).candidate);
  const selector = Arena.createPairSelector({ rng: () => 0.9 });
  const keys = new Set();
  for (let i = 0; i < 6; i++) {
    const pair = selector.pick(pool);
    assert.ok(pair, `pair ${i + 1} should exist`);
    keys.add([pair.left.rootPinId, pair.right.rootPinId].sort().join('|'));
  }
  assert.equal(keys.size, 6);
  assert.equal(selector.pick(pool), null, 'no seventh duplicate pair');
  const counts = Object.values(selector.shownCounts());
  assert.equal(counts.length, 4);
  assert.ok(counts.every((count) => count === 3), `balanced four-candidate exposure, got ${counts.join(',')}`);
});

test('exposure stays balanced across the unique-pair cycle', () => {
  const selector = Arena.createPairSelector({ rng: () => 0.9 });
  const pool = candidatePool();
  for (let i = 0; i < 3; i++) assert.ok(selector.pick(pool));
  assert.equal(selector.pick(pool), null);
  const counts = Object.values(selector.shownCounts());
  assert.equal(counts.length, 3, 'every candidate keeps exposure');
  assert.ok(counts.every((count) => count === 2), `expected two appearances each, got ${counts.join(',')}`);
});

test('left/right placement follows the injected (crypto) rng', () => {
  const pool = [Arena.normalizeCandidate(fixtureA()).candidate, Arena.normalizeCandidate(fixtureB()).candidate];
  const neverSwap = Arena.createPairSelector({ rng: () => 0.99 }).pick(pool);
  const alwaysSwap = Arena.createPairSelector({ rng: () => 0.0 }).pick(pool);
  assert.equal(neverSwap.left.rootPinId, FIXTURE_A_ROOT, 'a<b order preserved without swap');
  assert.equal(alwaysSwap.left.rootPinId, FIXTURE_B_ROOT, 'swap flips the displayed sides');
});

// ---------------------------------------------------------------------------
// 5. Audio exclusivity — one audible side at a time
// ---------------------------------------------------------------------------

test('audible play on one side pauses the other playing side', () => {
  const audio = Arena.createAudioCoordinator();
  assert.deepEqual(audio.onPlay('left', true), [], 'nothing to pause yet');
  assert.deepEqual(audio.onPlay('right', true), [{ side: 'left', action: 'pause' }]);
});

test('muted play and unmute-while-playing are handled', () => {
  const audio = Arena.createAudioCoordinator();
  audio.onPlay('right', true);
  // A muted side starting does not pause anyone.
  assert.deepEqual(audio.onPlay('left', false), []);
  // But unmuting it while both play pauses the other soundtrack.
  assert.deepEqual(audio.onUnmute('left'), [{ side: 'right', action: 'pause' }]);
});

test('pause/ended clear side state', () => {
  const audio = Arena.createAudioCoordinator();
  audio.onPlay('left', true);
  audio.onPause('left');
  assert.equal(audio.isPlaying('left'), false);
  assert.deepEqual(audio.onPlay('right', true), []);
});

// ---------------------------------------------------------------------------
// 6. Queue: add/remove/review, 28-item cap
// ---------------------------------------------------------------------------

function queuedPair() {
  return {
    left: Arena.normalizeCandidate(fixtureA()).candidate,
    right: Arena.normalizeCandidate(fixtureB()).candidate,
  };
}

function filledQueue(count) {
  const queue = Arena.createQueue();
  for (let i = 0; i < count; i++) {
    const built = Arena.buildComparisonItem(queuedPair(), i % 2 ? 'right' : 'left', i === 0 ? 'calmer motion' : '');
    assert.equal(built.ok, true);
    queue.add(built.item);
  }
  return queue;
}

test('queue holds at most 28 items and refuses the 29th', () => {
  const queue = filledQueue(28);
  assert.equal(queue.size(), 28);
  const refused = queue.add(Arena.buildComparisonItem(queuedPair(), 'tie').item);
  assert.deepEqual(refused, { ok: false, error: 'queue-full', limit: 28 });
  assert.equal(queue.size(), 28);
});

test('queue items can be reviewed and removed individually', () => {
  const queue = filledQueue(3);
  assert.equal(queue.removeAt(1).ok, true);
  assert.equal(queue.size(), 2);
  assert.equal(queue.removeAt(9).ok, false);
  const items = queue.items();
  // filledQueue alternates left/right/left; removing the middle leaves two
  // "a" picks, and the reviewed reason stays attached to item 0.
  assert.ok(items[0].reason === 'calmer motion' && items[1].pick === 'a');
  assert.deepEqual(Object.keys(items[0]).sort(), ['a', 'b', 'pick', 'reason']);
});

// ---------------------------------------------------------------------------
// 7. Comparison item + exact batch payload (shared conformance vectors)
// ---------------------------------------------------------------------------

test('buildComparisonItem maps left/right/tie and trims reasons', () => {
  const pickLeft = Arena.buildComparisonItem(queuedPair(), 'left', '  steadier camera  ');
  assert.deepEqual(
    { pick: pickLeft.item.pick, reason: pickLeft.item.reason },
    { pick: 'a', reason: 'steadier camera' },
  );
  assert.equal(Arena.buildComparisonItem(queuedPair(), 'right').item.pick, 'b');
  assert.equal(Arena.buildComparisonItem(queuedPair(), 'tie', '   ').item.reason, undefined);
  assert.equal(Arena.buildComparisonItem(queuedPair(), 'nope').ok, false);
  assert.equal(Arena.buildComparisonItem(queuedPair(), 'left', 'x'.repeat(1001)).error, 'reason-too-long');
  const sameVideo = {
    left: Arena.normalizeCandidate(fixtureA()).candidate,
    right: Arena.normalizeCandidate(fixtureA({ pinId: FIXTURE_B_ROOT, currentPinId: FIXTURE_B_ROOT })).candidate,
  };
  assert.equal(Arena.buildComparisonItem(sameVideo, 'left').error, 'same-video');
});

const PUBLISHED_ROOT = '142b91336422ee4e9401655d3a567e6f00cc537256f617ba7079b7ca614cdd08i0';

function exactPayloadItems() {
  return [
    Arena.buildComparisonItem(queuedPair(), 'left', 'left side held visual focus better').item,
    Arena.buildComparisonItem(
      {
        left: Arena.normalizeCandidate(fixtureB()).candidate,
        right: candidatePool()[2],
      },
      'tie',
    ).item,
  ];
}

test('buildBatchPayload emits the exact contract shape', () => {
  const built = Arena.buildBatchPayload(exactPayloadItems(), PUBLISHED_ROOT);
  assert.equal(built.ok, true, JSON.stringify(built));
  const [itemA, itemB] = exactPayloadItems();
  assert.deepEqual(built.payload, {
    category: ['motion-video'],
    kind: 'comparison-batch',
    client: { artifact: 'metaapp://' + PUBLISHED_ROOT, mode: 'arena' },
    items: [itemA, itemB],
  });
  assert.equal(Arena.validateBatchPayload(built.payload).ok, true);
});

test('payload carries no Actor id, judge id, score, timestamp, or telemetry', () => {
  const built = Arena.buildBatchPayload(exactPayloadItems(), PUBLISHED_ROOT);
  const serialized = JSON.stringify(built.payload);
  for (const forbidden of ['actor', 'judge', 'globalMetaId', 'score', 'watch', 'telemetry', 'timestamp', 'playedFor']) {
    assert.ok(!serialized.includes(forbidden), `payload must not contain "${forbidden}"`);
  }
  assert.deepEqual(Object.keys(built.payload).sort(), ['category', 'client', 'items', 'kind']);
});

test('unpublished client root cannot build a real batch', () => {
  const items = [Arena.buildComparisonItem(queuedPair(), 'left').item];
  assert.equal(Arena.buildBatchPayload(items, '').error, 'client-artifact-unpublished');
});

test('only an explicitly authorized smoke run adds the test: tag', () => {
  const items = [Arena.buildComparisonItem(queuedPair(), 'left').item];
  const plain = Arena.buildBatchPayload(items, PUBLISHED_ROOT).payload;
  const smoke = Arena.buildBatchPayload(items, PUBLISHED_ROOT, { smokeTag: Arena.SMOKE_TAG }).payload;
  assert.deepEqual(plain.category, ['motion-video']);
  assert.deepEqual(smoke.category, ['motion-video', 'test:motion-video-smoke']);
  // The smoke tag still validates (diagnostics-only upstream).
  assert.equal(Arena.validateBatchPayload(smoke).ok, true);
});

test('validator enforces item count bounds 1..28', () => {
  const makeItem = () => Arena.buildComparisonItem(queuedPair(), 'tie').item;
  const base = Arena.buildBatchPayload([makeItem()], PUBLISHED_ROOT).payload;
  assert.equal(Arena.validateBatchPayload({ ...base, items: [] }).ok, false);
  const twentyNine = Array.from({ length: 29 }, makeItem);
  assert.equal(Arena.validateBatchPayload({ ...base, items: twentyNine }).ok, false);
  const twentyEight = Array.from({ length: 28 }, makeItem);
  assert.equal(Arena.validateBatchPayload({ ...base, items: twentyEight }).ok, true);
  assert.equal(Arena.buildBatchPayload(twentyNine, PUBLISHED_ROOT).ok, false);
});

test('validator rejects malformed batches atomically (one bad item invalidates the pin)', () => {
  const base = Arena.buildBatchPayload([Arena.buildComparisonItem(queuedPair(), 'left').item], PUBLISHED_ROOT).payload;
  const cases = [
    { ...base, kind: 'reaction-batch' },
    { ...base, category: ['Motion Video'] },
    { ...base, category: ['other-category'] },
    { ...base, client: { artifact: 'not-a-pin', mode: 'arena' } },
    { ...base, judge: 'idq1someone' },
    { ...base, items: [{ ...base.items[0], pick: 'both' }] },
    { ...base, items: [{ ...base.items[0], extra: 1 }] },
    { ...base, items: [{ ...base.items[0], dims: { 'Bad-Id': 'a' } }] },
    { ...base, items: [{ ...base.items[0], dims: { visual: 'left' } }] },
    { ...base, items: [{ ...base.items[0], reason: 'y'.repeat(1001) }] },
  ];
  for (const payload of cases) {
    assert.equal(Arena.validateBatchPayload(payload).ok, false, JSON.stringify(payload).slice(0, 120));
  }
  // Same-video pair inside an otherwise valid item invalidates the whole pin.
  const refA = Arena.normalizeCandidate(fixtureA()).candidate.artifactRef;
  const sameVideo = { a: refA, b: { ...refA, version: 'metaapp://' + FIXTURE_B_ROOT }, pick: 'a' };
  assert.equal(Arena.validateBatchPayload({ ...base, items: [sameVideo] }).ok, false);
  // >6 dims rejected; 6 well-formed dims accepted.
  const sevenDims = Object.fromEntries(Array.from({ length: 7 }, (_, i) => ['dim' + i, 'tie']));
  assert.equal(Arena.validateBatchPayload({ ...base, items: [{ ...base.items[0], dims: sevenDims }] }).ok, false);
  const sixDims = Object.fromEntries(Array.from({ length: 6 }, (_, i) => ['dim' + i, 'tie']));
  assert.equal(Arena.validateBatchPayload({ ...base, items: [{ ...base.items[0], dims: sixDims }] }).ok, true);
});

// ---------------------------------------------------------------------------
// 8. Submission controller — one pin.write per batch, outcomes
// ---------------------------------------------------------------------------

function recordedBridge(handler) {
  const calls = [];
  return {
    calls,
    request(call) {
      calls.push(call);
      return handler(call, calls.length);
    },
  };
}

const GOOD_PIN = '0b522dd518aae71eb9f9f6f3c192399ba405ae03db88c190648ee572e6720464i0';

function controllerFor(queue, bridge, options) {
  return Arena.createSubmissionController({
    bridge,
    clientArtifactRoot: () => PUBLISHED_ROOT,
    queue,
    options: options || { smokeTag: () => '' },
  });
}

test('no bridge → read-only host: unavailable, no write attempted, no signer substituted', async () => {
  const queue = filledQueue(2);
  const submission = controllerFor(queue, null);
  assert.equal(submission.canWrite(), false, 'no bridge means no write path');
  const result = await submission.submit();
  assert.equal(result.ok, false);
  assert.equal(result.status, 'unavailable');
  assert.equal(queue.size(), 2);
});

test('success: exactly one metaid.pin.write with contract params; only submitted items clear', async () => {
  const queue = filledQueue(3);
  queue.add(Arena.buildComparisonItem(queuedPair(), 'tie').item); // 4 queued
  const bridge = recordedBridge(() => ({ pinId: GOOD_PIN, actor: { globalMetaId: 'idsigner', name: 'S' } }));
  const submission = controllerFor(queue, bridge);
  const result = await submission.submit();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.pinId, GOOD_PIN);
  assert.equal(result.submittedCount, 4);
  assert.equal(queue.size(), 0, 'success clears the submitted items');
  assert.equal(bridge.calls.length, 1, 'one pin write per batch');
  const call = bridge.calls[0];
  assert.equal(call.method, 'metaid.pin.write');
  assert.deepEqual(
    {
      operation: call.params.operation,
      path: call.params.path,
      version: call.params.version,
      contentType: call.params.contentType,
    },
    {
      operation: 'create',
      path: '/protocols/preference/feedback',
      version: '1.0.0',
      contentType: 'application/json',
    },
  );
  const payload = JSON.parse(call.params.payload.value);
  assert.equal(payload.kind, 'comparison-batch');
  assert.equal(payload.items.length, 4);
  assert.match(call.params.display.title, /4 comparisons/);
  // No Actor id in any MetaApp-supplied parameter.
  assert.ok(!JSON.stringify(call.params).includes('actorId'));
  assert.ok(!Object.keys(call.params).includes('actor'));
});

test('rejection keeps every queued item and reports a recoverable status', async () => {
  const queue = filledQueue(2);
  const bridge = recordedBridge(() => Promise.reject(new Error('user cancelled the confirmation')));
  const result = await controllerFor(queue, bridge).submit();
  assert.equal(result.ok, false);
  assert.equal(result.status, 'rejected');
  assert.equal(queue.size(), 2);
});

test('unknown broadcast outcome (no pin id) keeps items and never blind-retries', async () => {
  const queue = filledQueue(1);
  const bridge = recordedBridge(() => ({ something: 'resolved without a pin id' }));
  const submission = controllerFor(queue, bridge);
  const result = await submission.submit();
  assert.equal(result.ok, false);
  assert.equal(result.status, 'unknown');
  assert.match(result.message, /unknown/i);
  assert.equal(queue.size(), 1);
  assert.equal(bridge.calls.length, 1, 'no automatic retry');
});

test('duplicate clicks while in flight are refused', async () => {
  const queue = filledQueue(1);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const bridge = recordedBridge(() => gate.then(() => ({ pinId: GOOD_PIN })));
  const submission = controllerFor(queue, bridge);
  const first = submission.submit();
  const second = await submission.submit();
  assert.equal(second.ok, false);
  assert.equal(second.status, 'busy');
  release();
  const done = await first;
  assert.equal(done.ok, true);
  assert.equal(bridge.calls.length, 1, 'still exactly one write');
});

test('empty queue or unpublished root refuses before any bridge call', async () => {
  const emptyBridge = recordedBridge(() => ({ pinId: GOOD_PIN }));
  const empty = await controllerFor(Arena.createQueue(), emptyBridge).submit();
  assert.equal(empty.status, 'empty');
  assert.equal(emptyBridge.calls.length, 0);

  const queue = filledQueue(1);
  const unpublishedBridge = recordedBridge(() => ({ pinId: GOOD_PIN }));
  const unpublished = await Arena.createSubmissionController({
    bridge: unpublishedBridge,
    clientArtifactRoot: () => '',
    queue,
  }).submit();
  assert.equal(unpublished.ok, false);
  assert.equal(unpublished.status, 'invalid');
  assert.equal(unpublishedBridge.calls.length, 0, 'no real feedback without a published client.artifact');
});
