/**
 * Motion Video Arena — side-by-side blind comparison client for code-rendered
 * Motion Videos (docs/design/motion-video-preference, workstream WS4).
 *
 * Reads candidates from the public MetaSo aggregation API, plays two videos,
 * queues explicit pairwise choices in a volatile in-memory store, and submits
 * one `/protocols/preference/feedback` comparison-batch per host-confirmed
 * `metaid.pin.write`. The Arena never signs anything itself: Actor selection
 * and confirmation belong to the Browser chrome (window.AgentBrowser).
 *
 * Layout: a DOM-free core (constants, normalization, routing, pair selection,
 * queue, payload build/validate, audio coordination, submission controller) is
 * exported for component tests; browser wiring below only renders and calls it.
 */
(function () {
  'use strict';

  // ===== Contract constants (shared data contract v1) =====

  var METASO_BASE = 'https://so.metaid.io';
  var CHAIN_NAME = 'mvc';
  var CATEGORY = 'motion-video';
  var LIST_URL = METASO_BASE + '/api/metaapp/list?tag=' + CATEGORY + '&chainName=' + CHAIN_NAME + '&size=100';
  var DETAIL_URL_FOR = function (rootPinId) {
    return METASO_BASE + '/api/metaapp/detail/' + encodeURIComponent(rootPinId) + '?chainName=' + CHAIN_NAME;
  };
  var METAFILE_CONTENT_BASE = 'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/';

  var PIN_PATH = '/protocols/preference/feedback';
  var PIN_METAID_VERSION = '1.0.0';
  var PIN_CONTENT_TYPE = 'application/json';
  var CLIENT_MODE = 'arena';
  var SMOKE_TAG = 'test:motion-video-smoke';

  var MAX_QUEUE = 28;
  var MAX_REASON_CHARS = 1000;
  var MAX_DIMS = 6;
  var MAX_CATEGORY_TAGS = 8;

  var PIN_ID_RE = /^[0-9a-f]{64}i0$/;
  var SHA256_RE = /^[0-9a-f]{64}$/;
  var METAFILE_RE = /^metafile:\/\/([0-9a-f]{64}i0)(?:\.[a-z0-9]{1,12})?$/i;
  var TAG_RE = /^[a-z0-9-]+(:[a-z0-9-]+)?$/;
  var DIM_ID_RE = /^[a-z][a-z0-9_]{0,23}$/;
  var PICK_VALUES = ['a', 'b', 'tie'];
  var DIM_VALUES = ['a', 'b', 'tie'];
  var ALLOWED_ITEM_KEYS = ['a', 'b', 'pick', 'reason', 'dims'];
  var ALLOWED_PAYLOAD_KEYS = ['category', 'kind', 'client', 'items'];

  /**
   * Published Arena root used as `client.artifact`. Real submission requires a
   * published root (shared contract §4.2); until the owner publishes this app,
   * the value stays empty and the submit path stays mock-only / disabled.
   */
  var CLIENT_ARTIFACT_ROOT = '';

  // ===== Small helpers =====

  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function defaultRng() {
    var cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
      return function rngCrypto() {
        var buf = new Uint32Array(1);
        cryptoObj.getRandomValues(buf);
        return buf[0] / 4294967296;
      };
    }
    return Math.random;
  }

  // ===== Candidate normalization =====

  /**
   * Normalize one MetaSo list/detail item into a comparison candidate.
   * Returns { ok: true, candidate } or { ok: false, status, title } where
   * status ∈ disabled | chain | malformed. Technical exclusions are never
   * negative preference — callers must surface them as technical status only.
   */
  function normalizeCandidate(raw) {
    if (!isPlainObject(raw)) return { ok: false, status: 'malformed', title: '' };
    var title = text(raw.title) || text(raw.appName);
    if (raw.disabled === true || raw.disabled === 'true') {
      return { ok: false, status: 'disabled', title: title };
    }
    var chainName = text(raw.chainName);
    if (!chainName) return { ok: false, status: 'malformed', title: title };
    if (chainName !== CHAIN_NAME) return { ok: false, status: 'chain', title: title };
    var rootPinId = text(raw.pinId);
    var currentPinId = text(raw.currentPinId);
    if (!PIN_ID_RE.test(rootPinId) || !PIN_ID_RE.test(currentPinId)) {
      return { ok: false, status: 'malformed', title: title };
    }
    var motionVideo = isPlainObject(raw.motionVideo) ? raw.motionVideo : null;
    var videoFile = motionVideo ? text(motionVideo.videoFile) : '';
    var videoSha256 = motionVideo ? text(motionVideo.videoSha256) : '';
    var ref = videoFile ? METAFILE_RE.exec(videoFile) : null;
    if (!ref) return { ok: false, status: 'malformed', title: title };
    if (!SHA256_RE.test(videoSha256)) return { ok: false, status: 'malformed', title: title };
    var videoUrl = motionVideo ? text(motionVideo.videoUrl) : '';
    var durationSec = Number(motionVideo && motionVideo.durationSec);
    var coverImg = text(raw.coverImg);
    return {
      ok: true,
      candidate: {
        rootPinId: rootPinId,
        currentPinId: currentPinId,
        chainName: chainName,
        title: title,
        videoFile: videoFile,
        videoPinId: ref[1],
        videoSha256: videoSha256,
        videoUrl: /^https:\/\//i.test(videoUrl) ? videoUrl : '',
        coverImg: coverImg,
        durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
        // Missing hasAudio is unknown (null), never false.
        hasAudio: motionVideo && motionVideo.hasAudio === undefined ? null : (motionVideo ? motionVideo.hasAudio === true : null),
        artifactRef: {
          chainName: chainName,
          app: 'metaapp://' + rootPinId,
          version: 'metaapp://' + currentPinId,
          video: videoFile,
          videoSha256: videoSha256,
        },
      },
    };
  }

  /** Group list normalization into eligible candidates + exclusion counts. */
  function normalizePool(rawItems) {
    var eligible = [];
    var excluded = { disabled: 0, chain: 0, malformed: 0 };
    (Array.isArray(rawItems) ? rawItems : []).forEach(function (raw) {
      var result = normalizeCandidate(raw);
      if (result.ok) eligible.push(result.candidate);
      else excluded[result.status] = (excluded[result.status] || 0) + 1;
    });
    return { eligible: eligible, excluded: excluded };
  }

  // ===== Hash routing =====

  /**
   * Parse '#/' or '#/compare?a=<rootPinId>&b=<rootPinId>'.
   * Query values are decoded by URLSearchParams and validated as full
   * 66-character app root ids (64 lowercase hex + 'i0'). Only the exact
   * '/compare' path (before '?') is a deep link — near-miss prefixes such as
   * '/comparexyz' fall back to the pool route instead of half-matching.
   */
  function parseCompareRoute(hash) {
    var raw = String(hash == null ? '' : hash).replace(/^#/, '');
    if (!raw || raw === '/') return { route: 'home' };
    if (raw.split('?')[0] !== '/compare') return { route: 'home' };
    var queryIndex = raw.indexOf('?');
    if (queryIndex < 0) return { route: 'error', error: 'missing-query' };
    var params = new URLSearchParams(raw.slice(queryIndex + 1));
    var a = params.get('a');
    var b = params.get('b');
    if (!a && !b) return { route: 'error', error: 'missing-ids' };
    if (!a) return { route: 'error', error: 'missing-a' };
    if (!b) return { route: 'error', error: 'missing-b' };
    if (!PIN_ID_RE.test(a)) return { route: 'error', error: 'invalid-a' };
    if (!PIN_ID_RE.test(b)) return { route: 'error', error: 'invalid-b' };
    if (a === b) return { route: 'error', error: 'same-root' };
    return { route: 'compare', a: a, b: b };
  }

  // ===== Video URL resolution =====

  /**
   * Prefer motionVideo.videoUrl; otherwise resolve the metafile:// pin through
   * the documented public MetaFile content endpoint. Works with or without a
   * filename extension in videoFile.
   */
  function resolveVideoUrl(candidate) {
    if (candidate.videoUrl) return candidate.videoUrl;
    return METAFILE_CONTENT_BASE + candidate.videoPinId;
  }

  /**
   * Initial poster: use the item's coverImg (package poster) when it is an
   * https URL or a metafile:// reference; anything else yields no poster.
   */
  function resolvePosterUrl(coverImg) {
    var value = text(coverImg);
    if (!value) return '';
    if (/^https:\/\//i.test(value)) return value;
    var ref = METAFILE_RE.exec(value);
    if (ref) return METAFILE_CONTENT_BASE + ref[1];
    return '';
  }

  // ===== Pair selection =====

  function pairKey(candidateA, candidateB) {
    var ids = [candidateA.rootPinId, candidateB.rootPinId].sort();
    return ids[0] + '|' + ids[1];
  }

  /**
   * Exposure-balanced local pair selection for the initial corpus.
   * - never pairs identical videoSha256 values
   * - avoids repeating the previous unordered pair
   * - prefers least-shown candidates so new/unjudged works keep exposure
   * - randomizes left/right with the injected rng (browser crypto by default)
   */
  function createPairSelector(options) {
    var rng = (options && typeof options.rng === 'function') ? options.rng : defaultRng();
    var shownCount = {};
    var lastPair = '';
    return {
      pick: function (eligible) {
        var pool = (eligible || []).filter(function (candidate) {
          return candidate && candidate.ok !== false;
        });
        if (pool.length < 2) return null;
        pool.forEach(function (candidate) {
          if (!Object.prototype.hasOwnProperty.call(shownCount, candidate.rootPinId)) {
            shownCount[candidate.rootPinId] = 0;
          }
        });
        var byExposure = pool.slice().sort(function (x, y) {
          var diff = shownCount[x.rootPinId] - shownCount[y.rootPinId];
          if (diff !== 0) return diff;
          return x.rootPinId < y.rootPinId ? -1 : 1;
        });
        var candidates = null;
        for (var attempt = 0; attempt < 2 && !candidates; attempt++) {
          var avoidLastPair = attempt === 0;
          for (var band = 2; band <= byExposure.length && !candidates; band++) {
            var head = byExposure.slice(0, band);
            for (var i = 0; i < head.length && !candidates; i++) {
              for (var j = i + 1; j < head.length; j++) {
                if (head[i].videoSha256 === head[j].videoSha256) continue;
                if (avoidLastPair && pairKey(head[i], head[j]) === lastPair) continue;
                candidates = [head[i], head[j]];
                break;
              }
            }
          }
        }
        // Distinct video hashes are a hard rule; repeating a pair is only
        // avoided when an alternative exists (a 2-candidate pool has none).
        if (!candidates) return null;
        lastPair = pairKey(candidates[0], candidates[1]);
        shownCount[candidates[0].rootPinId] += 1;
        shownCount[candidates[1].rootPinId] += 1;
        // Random left/right placement per pair.
        if (rng() < 0.5) candidates = [candidates[1], candidates[0]];
        return { left: candidates[0], right: candidates[1] };
      },
      shownCounts: function () {
        var copy = {};
        Object.keys(shownCount).forEach(function (key) { copy[key] = shownCount[key]; });
        return copy;
      },
    };
  }

  // ===== Volatile comparison queue (in-memory only, never persisted) =====

  function createQueue() {
    var items = [];
    return {
      items: function () { return items.slice(); },
      size: function () { return items.length; },
      isFull: function () { return items.length >= MAX_QUEUE; },
      add: function (item) {
        if (items.length >= MAX_QUEUE) {
          return { ok: false, error: 'queue-full', limit: MAX_QUEUE };
        }
        items.push(item);
        return { ok: true, index: items.length - 1 };
      },
      removeAt: function (index) {
        if (index < 0 || index >= items.length) return { ok: false, error: 'bad-index' };
        items.splice(index, 1);
        return { ok: true };
      },
      removeRange: function (indices) {
        var set = {};
        (indices || []).forEach(function (index) { set[index] = true; });
        items = items.filter(function (_, index) { return !set[index]; });
        return { ok: true };
      },
    };
  }

  // ===== Comparison item and batch payload =====

  /**
   * Build one protocol comparison item from the displayed pair.
   * `a` is the left video as shown and `b` the right; `pick` maps
   * left → 'a', right → 'b', tie → 'tie'. The user's on-screen orientation is
   * preserved faithfully (aggregation uses unordered pairs downstream).
   */
  function buildComparisonItem(pair, pickSide, reason) {
    if (!pair || !pair.left || !pair.right) return { ok: false, error: 'bad-pair' };
    if (['left', 'right', 'tie'].indexOf(pickSide) < 0) return { ok: false, error: 'bad-pick' };
    if (pair.left.videoSha256 === pair.right.videoSha256) return { ok: false, error: 'same-video' };
    var trimmedReason = text(reason);
    if (trimmedReason.length > MAX_REASON_CHARS) {
      return { ok: false, error: 'reason-too-long', limit: MAX_REASON_CHARS };
    }
    var item = {
      a: pair.left.artifactRef,
      b: pair.right.artifactRef,
      pick: pickSide === 'left' ? 'a' : pickSide === 'right' ? 'b' : 'tie',
    };
    if (trimmedReason) item.reason = trimmedReason;
    return { ok: true, item: item };
  }

  /**
   * Build the exact comparison-batch payload.
   * `options.smokeTag` adds SMOKE_TAG only for an explicitly authorized smoke
   * run; ordinary operation never adds a `test:` category tag.
   */
  function buildBatchPayload(items, clientArtifactRoot, options) {
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_QUEUE) {
      return { ok: false, error: 'bad-item-count' };
    }
    var root = text(clientArtifactRoot);
    if (!PIN_ID_RE.test(root.replace(/^metaapp:\/\//, ''))) {
      return { ok: false, error: 'client-artifact-unpublished' };
    }
    var category = [CATEGORY];
    if (options && options.smokeTag === SMOKE_TAG) category.push(SMOKE_TAG);
    var payload = {
      category: category,
      kind: 'comparison-batch',
      client: { artifact: 'metaapp://' + root.replace(/^metaapp:\/\//, ''), mode: CLIENT_MODE },
      items: items.map(function (item) { return item; }),
    };
    var validation = validateBatchPayload(payload);
    if (!validation.ok) return validation;
    return { ok: true, payload: payload };
  }

  function validateArtifactRef(ref, label) {
    if (!isPlainObject(ref)) return label + ' must be an ArtifactRef object';
    if (text(ref.chainName) !== CHAIN_NAME) return label + '.chainName must be "' + CHAIN_NAME + '"';
    var appPin = text(ref.app).replace(/^metaapp:\/\//, '');
    if (!PIN_ID_RE.test(appPin)) return label + '.app must be metaapp://<rootPinId>';
    var versionPin = text(ref.version).replace(/^metaapp:\/\//, '');
    if (!PIN_ID_RE.test(versionPin)) return label + '.version must be metaapp://<versionPinId>';
    if (!METAFILE_RE.test(text(ref.video))) return label + '.video must be a metafile:// reference';
    if (!SHA256_RE.test(text(ref.videoSha256))) return label + '.videoSha256 must be 64 lowercase hex';
    return '';
  }

  /** Mirror of the shared contract rules; used before every write. */
  function validateBatchPayload(payload) {
    if (!isPlainObject(payload)) return { ok: false, error: 'payload not an object' };
    var keys = Object.keys(payload);
    for (var i = 0; i < keys.length; i++) {
      if (ALLOWED_PAYLOAD_KEYS.indexOf(keys[i]) < 0) {
        return { ok: false, error: 'unexpected payload field "' + keys[i] + '" (no judge id, score, or telemetry allowed)' };
      }
    }
    if (!Array.isArray(payload.category) || payload.category.length < 1 || payload.category.length > MAX_CATEGORY_TAGS) {
      return { ok: false, error: 'category must be an array of 1-' + MAX_CATEGORY_TAGS + ' tags' };
    }
    for (var c = 0; c < payload.category.length; c++) {
      if (!TAG_RE.test(payload.category[c])) return { ok: false, error: 'invalid category tag "' + payload.category[c] + '"' };
    }
    if (payload.category.indexOf(CATEGORY) < 0) {
      return { ok: false, error: 'category must contain "' + CATEGORY + '"' };
    }
    if (payload.kind !== 'comparison-batch') return { ok: false, error: 'kind must be "comparison-batch"' };
    if (!isPlainObject(payload.client) || !PIN_ID_RE.test(text(payload.client.artifact).replace(/^metaapp:\/\//, ''))) {
      return { ok: false, error: 'client.artifact must be a published metaapp:// root' };
    }
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(text(payload.client.mode))) {
      return { ok: false, error: 'client.mode must be a lowercase interface label' };
    }
    if (!Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > MAX_QUEUE) {
      return { ok: false, error: 'items must contain 1-' + MAX_QUEUE + ' comparisons' };
    }
    for (var n = 0; n < payload.items.length; n++) {
      var item = payload.items[n];
      if (!isPlainObject(item)) return { ok: false, error: 'items[' + n + '] is not an object' };
      var itemKeys = Object.keys(item);
      for (var k = 0; k < itemKeys.length; k++) {
        if (ALLOWED_ITEM_KEYS.indexOf(itemKeys[k]) < 0) {
          return { ok: false, error: 'items[' + n + '] has unexpected field "' + itemKeys[k] + '"' };
        }
      }
      var aError = validateArtifactRef(item.a, 'items[' + n + '].a');
      if (aError) return { ok: false, error: aError };
      var bError = validateArtifactRef(item.b, 'items[' + n + '].b');
      if (bError) return { ok: false, error: bError };
      if (text(item.a.videoSha256) === text(item.b.videoSha256)) {
        return { ok: false, error: 'items[' + n + ']: identical videoSha256 is not a visual comparison' };
      }
      if (PICK_VALUES.indexOf(item.pick) < 0) return { ok: false, error: 'items[' + n + '].pick must be a, b, or tie' };
      if (item.reason !== undefined && text(item.reason).length > MAX_REASON_CHARS) {
        return { ok: false, error: 'items[' + n + '].reason exceeds ' + MAX_REASON_CHARS + ' trimmed characters' };
      }
      if (item.dims !== undefined) {
        if (!isPlainObject(item.dims)) return { ok: false, error: 'items[' + n + '].dims must be an object' };
        var dimKeys = Object.keys(item.dims);
        if (dimKeys.length > MAX_DIMS) return { ok: false, error: 'items[' + n + '].dims exceeds ' + MAX_DIMS + ' entries' };
        for (var d = 0; d < dimKeys.length; d++) {
          if (!DIM_ID_RE.test(dimKeys[d])) return { ok: false, error: 'items[' + n + '].dims has invalid id "' + dimKeys[d] + '"' };
          if (DIM_VALUES.indexOf(item.dims[dimKeys[d]]) < 0) {
            return { ok: false, error: 'items[' + n + '].dims["' + dimKeys[d] + '"] must be a, b, or tie' };
          }
        }
      }
    }
    return { ok: true };
  }

  // ===== Audio exclusivity coordinator =====

  /**
   * One sound at a time: when a side starts playing audibly, the other side is
   * paused. Pure decision function so component tests can drive it without a
   * DOM; the browser layer applies the returned actions.
   */
  function createAudioCoordinator() {
    var playing = { left: false, right: false };
    function otherSide(side) { return side === 'left' ? 'right' : 'left'; }
    return {
      onPlay: function (side, audible) {
        playing[side] = true;
        var other = otherSide(side);
        if (audible && playing[other]) return [{ side: other, action: 'pause' }];
        return [];
      },
      onPause: function (side) {
        playing[side] = false;
        return [];
      },
      onUnmute: function (side) {
        var other = otherSide(side);
        if (playing[side] && playing[other]) return [{ side: other, action: 'pause' }];
        return [];
      },
      isPlaying: function (side) { return !!playing[side]; },
    };
  }

  // ===== Submission controller (one pin.write per batch) =====

  /**
   * deps: { bridge, clientArtifactRoot, queue, onLoadPool, renderStatus }
   * - no bridge at all → read-only host, submit reports unavailable
   * - duplicate clicks while in flight are refused ('busy')
   * - success (pinId present) clears only the submitted items
   * - rejection/failure keeps every queued item; the user decides to retry
   * - a resolve without pinId is an unknown broadcast outcome: items are kept
   *   and never auto-retried blindly
   * - the write params never carry an Actor id; the Browser chrome owns it
   */
  function createSubmissionController(deps) {
    var bridge = deps.bridge || null;
    var busy = false;
    return {
      isBusy: function () { return busy; },
      canWrite: function () { return !!bridge && !!text(deps.clientArtifactRoot()); },
      submit: async function () {
        if (busy) return { ok: false, status: 'busy' };
        if (!bridge) return { ok: false, status: 'unavailable', message: 'This host does not expose a Browser pin-write bridge. Browsing stays available; feedback submission is disabled.' };
        var queued = deps.queue.items();
        if (!queued.length) return { ok: false, status: 'empty' };
        var built = buildBatchPayload(queued, deps.clientArtifactRoot(), deps.options ? { smokeTag: deps.options.smokeTag() } : undefined);
        if (!built.ok) return { ok: false, status: 'invalid', message: built.error };
        var payload = built.payload;
        busy = true;
        try {
          var result = await bridge.request({
            method: 'metaid.pin.write',
            timeoutMs: 120000,
            params: {
              operation: 'create',
              path: PIN_PATH,
              encryption: '0',
              version: PIN_METAID_VERSION,
              contentType: PIN_CONTENT_TYPE,
              payload: { encoding: 'utf8', value: JSON.stringify(payload) },
              display: {
                title: 'Motion Video Arena — submit ' + payload.items.length + ' comparison' + (payload.items.length === 1 ? '' : 's'),
                summary: payload.items.length + ' pairwise motion-video comparison' + (payload.items.length === 1 ? '' : 's') + ' as /protocols/preference/feedback',
              },
            },
          });
          var pinId = result && (text(result.pinId) || (result.result && text(result.result.pinId)) || text(result.id));
          if (pinId && PIN_ID_RE.test(pinId)) {
            deps.queue.removeRange(queued.map(function (_, index) { return index; }));
            return {
              ok: true,
              pinId: pinId,
              submittedCount: payload.items.length,
              actor: (result && result.actor) || null,
            };
          }
          // Resolved without a usable pin id: treat as unknown, keep items,
          // never blind-retry (a duplicate pin would double-count).
          return {
            ok: false,
            status: 'unknown',
            message: 'The broadcast outcome is unknown (no pin id returned). Queued comparisons were kept. Check the Browser write history before submitting again.',
          };
        } catch (error) {
          if (error && error.code === 'bridge_timeout') {
            return {
              ok: false,
              status: 'unknown',
              message: 'The broadcast outcome is unknown (no host response before the bridge timeout). Queued comparisons were kept — do not resubmit blindly; check the Browser write history first.',
            };
          }
          return {
            ok: false,
            status: 'rejected',
            message: (error && error.message ? error.message : 'The pin write was rejected or failed.'),
            keepItems: true,
          };
        } finally {
          busy = false;
        }
      },
    };
  }

  /**
   * Single source of submission status copy so mock wording can never be
   * mistaken for a real on-chain write. Mock success must say, in plain
   * words, that nothing was written on chain.
   */
  function submissionOutcomeMessage(result, options) {
    var isMock = !!(options && options.mock);
    if (result.ok) {
      if (isMock) return 'Mock submission succeeded — nothing was written on chain.';
      return 'Submitted ' + result.submittedCount + ' comparison' + (result.submittedCount === 1 ? '' : 's') + ' on chain.';
    }
    if (result.status === 'busy') return 'A submission is already in flight.';
    if (result.message) return result.message;
    return 'Submission failed: ' + result.status + '.';
  }

  // ===== Core export (component tests; unused in the browser) =====

  var ArenaCore = {
    METASO_BASE: METASO_BASE,
    CHAIN_NAME: CHAIN_NAME,
    LIST_URL: LIST_URL,
    DETAIL_URL_FOR: DETAIL_URL_FOR,
    METAFILE_CONTENT_BASE: METAFILE_CONTENT_BASE,
    PIN_PATH: PIN_PATH,
    PIN_METAID_VERSION: PIN_METAID_VERSION,
    PIN_CONTENT_TYPE: PIN_CONTENT_TYPE,
    CLIENT_MODE: CLIENT_MODE,
    SMOKE_TAG: SMOKE_TAG,
    MAX_QUEUE: MAX_QUEUE,
    MAX_REASON_CHARS: MAX_REASON_CHARS,
    normalizeCandidate: normalizeCandidate,
    normalizePool: normalizePool,
    parseCompareRoute: parseCompareRoute,
    resolveVideoUrl: resolveVideoUrl,
    resolvePosterUrl: resolvePosterUrl,
    createPairSelector: createPairSelector,
    createQueue: createQueue,
    buildComparisonItem: buildComparisonItem,
    buildBatchPayload: buildBatchPayload,
    validateBatchPayload: validateBatchPayload,
    createAudioCoordinator: createAudioCoordinator,
    createSubmissionController: createSubmissionController,
    submissionOutcomeMessage: submissionOutcomeMessage,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ArenaCore;
  }

  // =====================================================================
  // Browser wiring (skipped entirely when loaded outside a DOM)
  // =====================================================================

  if (typeof document === 'undefined' || !document.getElementById('arena-root')) return;

  var queryParams = new URLSearchParams(location.search);
  // Development mode is explicit AND exclusive with a live host:
  //   ?mock=1      mock bridge success
  //   ?mock=fail   mock bridge rejection
  //   ?mock=unknown  mock bridge resolves without a pin id (unknown outcome)
  // When a live Browser bridge answers the probe, the mock parameter is
  // ignored — a production instance inside the Bot Browser can never be
  // flipped into mock mode through the query string.
  var MOCK_PARAM = text(queryParams.get('mock'));
  var MOCK_VARIANTS = ['1', 'fail', 'unknown'];
  var mockRequested = MOCK_VARIANTS.indexOf(MOCK_PARAM) >= 0;
  // Smoke runs opt in with the short label ?smoke=motion-video-smoke; the
  // batch then carries the full test:motion-video-smoke category tag.
  var SMOKE_SHORT_PARAM = 'motion-video-smoke';
  var SMOKE_ACTIVE = text(queryParams.get('smoke')) === SMOKE_SHORT_PARAM;
  // Mock-only client.artifact root: shape-valid 66-char id that is never a
  // real published app. It exists so an unpublished preview can exercise the
  // full mock write path; the production root below stays locked until the
  // Arena is actually published.
  var MOCK_CLIENT_ARTIFACT_ROOT = 'f00df00df00df00df00df00df00df00df00df00df00df00df00df00df00df00di0';
  var MOCK_PIN_ID = 'e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4i0';

  var MOCK_ROOT_A = '22ce6ca2ba950c3659c739e235b519e94341fe0a19f13c876807dad6e0955659i0';
  var MOCK_ROOT_B = '5686db0dd51ac19ec60c4a02ff66bc51adcf0149b8484141b38e730c734d9bb4i0';
  var MOCK_VIDEO_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90i0.mp4';
  var MOCK_VIDEO_B = 'b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1i0';
  var MOCK_SHA_A = 'b8113ccc77c592466f8c67b7ff775cb9c57927a516c34989e8611a1d09f81674';
  var MOCK_SHA_B = '39c9c6c9b2a035568a07273b92b3f426d383a5ab5c1d98dfb7bd760faf0e1860';

  function mockListResponse() {
    return {
      code: 0,
      data: {
        items: [
          {
            pinId: MOCK_ROOT_A, sourcePinId: MOCK_ROOT_A, currentPinId: MOCK_ROOT_A,
            chainName: 'mvc', title: 'Ukiyo-e 10s fixture', appName: 'motion-fixture-a',
            tags: ['motion-video'], disabled: false,
            coverImg: 'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/1a2b3c4d5e6f0718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9i0.png',
            publisherGlobalMetaId: 'idmockpublisher0000000000000000000000000a',
            publisherName: 'Mock Publisher A',
            motionVideo: {
              videoFile: 'metafile://' + MOCK_VIDEO_A,
              videoUrl: mockVideoOverrides.a,
              videoSha256: MOCK_SHA_A,
              durationSec: 10, fps: 24, frames: 240, resolution: '1920x1080',
              hasAudio: false, loudnessLufs: null, engine: 'lemo-opuscar', style: 'ukiyoe',
              learning: { sourceIncluded: true, hasPrompt: true, status: 'declared' },
            },
            preference: { open: { score: null, state: 'unjudged', comparisons: 0, judges: 0 } },
          },
          {
            pinId: MOCK_ROOT_B, sourcePinId: MOCK_ROOT_B, currentPinId: MOCK_ROOT_B,
            chainName: 'mvc', title: 'Silent film 47s fixture', appName: 'motion-fixture-b',
            tags: ['motion-video'], disabled: false,
            coverImg: 'metafile://2b3c4d5e6f70818293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a2i0.jpg',
            publisherGlobalMetaId: 'idmockpublisher0000000000000000000000000b',
            publisherName: 'Mock Publisher B',
            motionVideo: {
              videoFile: 'metafile://' + MOCK_VIDEO_B,
              videoUrl: mockVideoOverrides.b,
              videoSha256: MOCK_SHA_B,
              durationSec: 47, fps: 24, resolution: '1280x720',
              learning: { sourceIncluded: true, hasPrompt: true, status: 'declared' },
            },
            preference: { open: { score: 0.73, state: 'established', comparisons: 18, judges: 5 } },
          },
          { pinId: MOCK_ROOT_A, currentPinId: MOCK_ROOT_A, chainName: 'mvc', title: 'Disabled fixture', disabled: true, motionVideo: { videoFile: 'metafile://' + MOCK_VIDEO_A, videoSha256: MOCK_SHA_A } },
          { pinId: 'c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2i0', currentPinId: 'c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2i0', chainName: 'mvc', title: 'Malformed fixture (no video)', disabled: false },
        ],
        nextCursor: null, hasMore: false,
      },
      message: 'ok', processingTime: 1,
    };
  }

  function mockDetailResponse(rootPinId) {
    var source = mockListResponse().data.items;
    var hit = source.filter(function (item) { return item.pinId === rootPinId && !item.disabled; })[0];
    if (!hit) return { code: 40400, data: null, message: 'not found', processingTime: 1 };
    return { code: 0, data: hit, message: 'ok', processingTime: 1 };
  }

  var mockVideoOverrides = {
    a: text(new URLSearchParams(location.search).get('mockVideoA')),
    b: text(new URLSearchParams(location.search).get('mockVideoB')),
  };

  function mockFetch(url) {
    var body = String(url).indexOf('/api/metaapp/detail/') >= 0
      ? mockDetailResponse(decodeURIComponent(String(url).split('/api/metaapp/detail/')[1].split('?')[0]))
      : mockListResponse();
    return Promise.resolve({
      ok: true,
      status: 200,
      json: function () { return Promise.resolve(body); },
    });
  }

  function mockBridge() {
    return {
      request: function (call) {
        if (call.method === 'browser.actor.current') {
          return Promise.resolve({ actor: { globalMetaId: 'idmockactor0000000000000000000000000001', name: 'Mock Actor', kind: 'idbots-account' } });
        }
        if (call.method === 'metaid.pin.write') {
          if (MOCK_PARAM === 'fail') {
            return Promise.reject(new Error('Mock rejection: the broadcast failed (nothing was written on chain).'));
          }
          if (MOCK_PARAM === 'unknown') {
            return Promise.resolve({ status: 'accepted', note: 'mock unknown-outcome response without a pin id' });
          }
          return Promise.resolve({
            pinId: MOCK_PIN_ID,
            actor: { globalMetaId: 'idmockactor0000000000000000000000000001', name: 'Mock Actor' },
          });
        }
        return Promise.reject(new Error('Mock bridge: unsupported method ' + call.method));
      },
    };
  }

  function httpFetch(url) {
    return fetch(url, { headers: { accept: 'application/json' } });
  }

  // Runtime mode resolution happens once, after the host probe settles:
  //   live bridge → production path (mock parameter ignored, if any)
  //   no host + mock requested → local mock bridge + mock MetaSo fetch
  //   no host, no mock → read-only
  var runtime = {
    booting: true,
    mock: false,
    mockIgnored: false,
    hostProbe: 'pending',
    bridge: null,
  };
  var fetchImpl = httpFetch;
  var submission = null;

  async function apiGet(url) {
    var response = await fetchImpl(url);
    var body = null;
    try { body = await response.json(); } catch (error) { body = null; }
    if (!isPlainObject(body)) {
      throw new Error('MetaSo API returned an invalid response (HTTP ' + response.status + ').');
    }
    if (Number(body.code) === 0 && isPlainObject(body.data)) return body.data;
    throw new Error('MetaSo API error ' + body.code + ': ' + (text(body.message) || 'unknown error'));
  }

  // ---- DOM helpers (text-safe by construction) ----

  function byId(id) { return document.getElementById(id); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (key === 'class') node.className = attrs[key];
        else if (key === 'text') node.textContent = attrs[key];
        else if (key.indexOf('on') === 0 && typeof attrs[key] === 'function') node.addEventListener(key.slice(2), attrs[key]);
        else node.setAttribute(key, attrs[key]);
      });
    }
    (children || []).forEach(function (child) { node.appendChild(child); });
    return node;
  }

  function shortPin(pinId) {
    var value = String(pinId || '');
    return value.length <= 12 ? value : value.slice(0, 6) + '…' + value.slice(-4);
  }

  function audioLabel(hasAudio) {
    if (hasAudio === true) return 'has audio';
    if (hasAudio === false) return 'silent';
    return 'audio unknown';
  }

  // ---- App state ----

  var state = {
    pool: { eligible: [], excluded: { disabled: 0, chain: 0, malformed: 0 } },
    selector: createPairSelector({}),
    queue: createQueue(),
    pair: null,
    actor: null,
    lastStatus: null,
  };

  function createSubmission() {
    return createSubmissionController({
      bridge: runtime.bridge,
      clientArtifactRoot: function () {
        return runtime.mock ? MOCK_CLIENT_ARTIFACT_ROOT : CLIENT_ARTIFACT_ROOT;
      },
      queue: state.queue,
      options: { smokeTag: function () { return SMOKE_ACTIVE ? SMOKE_TAG : ''; } },
    });
  }

  // ---- Rendering ----

  function renderTopbar() {
    var modeLine = byId('mode-line');
    modeLine.textContent = '';
    if (runtime.mock) {
      modeLine.appendChild(el('span', { class: 'pill pill-mock', text: 'MOCK MODE — local mocks only; nothing is read from or written to chain' }));
    } else if (runtime.mockIgnored) {
      modeLine.appendChild(el('span', { class: 'pill pill-smoke', text: 'mock parameter ignored — live Browser bridge in use' }));
    }
    if (SMOKE_ACTIVE) {
      modeLine.appendChild(el('span', { class: 'pill pill-smoke', text: 'Authorized smoke run — batch will carry ' + SMOKE_TAG }));
    }
    var actorLine = byId('actor-line');
    actorLine.textContent = '';
    if (runtime.booting) {
      actorLine.appendChild(el('span', { class: 'muted', text: 'Detecting Browser bridge…' }));
    } else if (!runtime.bridge) {
      actorLine.appendChild(el('span', { class: 'muted', text: 'No Browser bridge detected — read-only host. Feedback submission is unavailable here.' }));
    } else if (state.actor && state.actor.globalMetaId) {
      actorLine.appendChild(el('span', {
        text: (runtime.mock ? 'Mock Actor: ' : 'Current Actor: ') + (state.actor.name || shortPin(state.actor.globalMetaId)) + ' (' + shortPin(state.actor.globalMetaId) + ')',
      }));
    } else {
      actorLine.appendChild(el('span', { class: 'muted', text: 'Browser bridge active — no Actor disclosed yet (consent may be required). The Browser chip owns signing identity.' }));
    }
  }

  function renderPoolStatus() {
    var node = byId('pool-status');
    node.textContent = '';
    var eligible = state.pool.eligible.length;
    var excluded = state.pool.excluded;
    var parts = ['Pool: ' + eligible + ' eligible candidate' + (eligible === 1 ? '' : 's')];
    var excludedTotal = (excluded.disabled || 0) + (excluded.chain || 0) + (excluded.malformed || 0);
    if (excludedTotal > 0) {
      var detail = [];
      if (excluded.disabled) detail.push(excluded.disabled + ' disabled');
      if (excluded.chain) detail.push(excluded.chain + ' other chain');
      if (excluded.malformed) detail.push(excluded.malformed + ' incomplete/unplayable');
      parts.push(excludedTotal + ' excluded for technical reasons — never counted as negative preference');
    }
    node.appendChild(el('span', { text: parts.join(' · ') }));
    // "Next pair" needs an eligible pool; deep-link errors clear it.
    byId('next-pair-button').disabled = state.pool.eligible.length < 2;
  }

  function videoPane(side, candidate) {
    var videoAttrs = {
      controls: 'controls',
      preload: 'metadata',
      playsinline: 'playsinline',
      'aria-label': side + ' video for comparison',
      src: resolveVideoUrl(candidate),
    };
    // Initial poster from the candidate's coverImg, when usable.
    var posterUrl = resolvePosterUrl(candidate.coverImg);
    if (posterUrl) videoAttrs.poster = posterUrl;
    var video = el('video', videoAttrs);
    video.muted = false;
    var replayButton = el('button', {
      type: 'button',
      class: 'ghost',
      text: 'Replay ' + side,
      'aria-label': 'Replay the ' + side + ' video from the start',
      onclick: function () {
        try { video.currentTime = 0; } catch (error) { /* not loaded yet */ }
        var playPromise = video.play();
        if (playPromise && playPromise.catch) playPromise.catch(function () { /* user gesture gates autoplay; ignore */ });
      },
    });
    var metaBits = [audioLabel(candidate.hasAudio)];
    if (candidate.durationSec) metaBits.push(candidate.durationSec + 's');
    var metaLine = el('p', { class: 'pane-meta', text: metaBits.join(' · ') });
    var loadError = el('p', { class: 'pane-error', role: 'status' });
    loadError.hidden = true;
    video.addEventListener('error', function () {
      loadError.hidden = false;
      loadError.textContent = 'Technical load failure on the ' + side + ' side. This is not a negative vote — use Skip or pick the other side only if you can judge it.';
    });
    return el('section', {
      class: 'pane',
      'aria-label': side + ' comparison pane',
    }, [
      el('h2', { class: 'pane-title', text: side === 'left' ? 'Left video' : 'Right video' }),
      video,
      metaLine,
      replayButton,
      loadError,
    ]);
  }

  function wireAudioExclusivity(leftVideo, rightVideo) {
    var coordinator = createAudioCoordinator();
    function videos() { return { left: leftVideo, right: rightVideo }; }
    function apply(actions) {
      actions.forEach(function (action) {
        var target = videos()[action.side];
        if (action.action === 'pause') {
          var pausePromise = target.pause();
          if (pausePromise && pausePromise.catch) pausePromise.catch(function () { /* already stopped */ });
        }
      });
    }
    [leftVideo, rightVideo].forEach(function (video) {
      var side = video === leftVideo ? 'left' : 'right';
      video.addEventListener('play', function () {
        apply(coordinator.onPlay(side, !video.muted && video.volume > 0));
      });
      video.addEventListener('pause', function () { coordinator.onPause(side); });
      video.addEventListener('ended', function () { coordinator.onPause(side); });
      video.addEventListener('volumechange', function () {
        apply(coordinator.onUnmute(side));
      });
    });
  }

  function renderCompare() {
    var stage = byId('stage');
    stage.textContent = '';
    var pair = state.pair;
    if (!pair) {
      stage.appendChild(el('div', { class: 'notice' }, [
        el('p', { text: 'Not enough eligible Motion Video candidates to form a pair yet.' }),
        el('button', { type: 'button', class: 'primary', text: 'Reload pool', onclick: function () { loadHome(); } }),
      ]));
      return;
    }
    var leftPane = videoPane('left', pair.left);
    var rightPane = videoPane('right', pair.right);
    wireAudioExclusivity(leftPane.querySelector('video'), rightPane.querySelector('video'));

    var reasonInput = el('input', {
      type: 'text',
      id: 'reason-input',
      maxlength: String(MAX_REASON_CHARS),
      autocomplete: 'off',
      placeholder: 'Optional — concrete reasons make rejected examples useful for learning',
      'aria-label': 'Optional public reason (will be written on chain with your choice)',
    });
    var reasonNote = el('p', { class: 'muted small', text: 'Reasons are optional and public on chain. Do not include private information.' });

    function vote(pickSide) {
      if (state.queue.isFull()) {
        setStatus('error', 'Queue is full (' + MAX_QUEUE + ' items). Submit the queued comparisons before adding more.');
        return;
      }
      var built = buildComparisonItem(state.pair, pickSide, reasonInput.value);
      if (!built.ok) {
        setStatus('error', 'Could not queue that choice: ' + built.error);
        return;
      }
      state.queue.add(built.item);
      renderQueue();
      setStatus('ok', 'Choice queued (' + state.queue.size() + '/' + MAX_QUEUE + ').');
      reasonInput.value = '';
      nextPair();
    }

    var controls = el('div', { class: 'controls', role: 'group', 'aria-label': 'Comparison choice' }, [
      el('button', { type: 'button', class: 'choice', text: 'Prefer left', onclick: function () { vote('left'); } }),
      el('button', { type: 'button', class: 'choice', text: 'Prefer right', onclick: function () { vote('right'); } }),
      el('button', { type: 'button', class: 'choice', text: 'Tie', onclick: function () { vote('tie'); } }),
      el('button', { type: 'button', class: 'ghost', text: 'Skip (records nothing)', onclick: function () { nextPair(); } }),
    ]);

    stage.appendChild(el('div', { class: 'compare-grid' }, [leftPane, rightPane]));
    stage.appendChild(el('div', { class: 'vote-block' }, [
      el('label', { class: 'reason-label', for: 'reason-input', text: 'Optional reason (public on chain)' }),
      reasonInput,
      reasonNote,
      controls,
    ]));
  }

  function nextPair() {
    state.pair = state.selector.pick(state.pool.eligible);
    renderCompare();
  }

  function queueItemSummary(item, index) {
    var pickText = item.pick === 'a' ? 'preferred left' : item.pick === 'b' ? 'preferred right' : 'tie';
    var summary = el('summary', {}, [
      el('span', { text: 'Comparison ' + (index + 1) + ' — ' + pickText + (item.reason ? ' · reason included' : '') }),
    ]);
    var details = el('details', { class: 'queue-item' }, [summary]);
    var body = el('div', { class: 'queue-item-body' });
    ['a', 'b'].forEach(function (side) {
      var ref = item[side];
      body.appendChild(el('p', { class: 'mono small', text: side + ': app=' + ref.app + ' version=' + ref.version }));
      body.appendChild(el('p', { class: 'mono small', text: '   video=' + ref.video + ' sha256=' + ref.videoSha256 }));
    });
    if (item.reason) body.appendChild(el('p', { class: 'small', text: 'reason: ' + item.reason }));
    var removeButton = el('button', {
      type: 'button',
      class: 'ghost small',
      text: 'Remove',
      'aria-label': 'Remove comparison ' + (index + 1) + ' from the queue',
      onclick: function () {
        state.queue.removeAt(index);
        renderQueue();
      },
    });
    body.appendChild(removeButton);
    details.appendChild(body);
    return details;
  }

  function renderQueue() {
    var wrap = byId('queue');
    var listNode = byId('queue-list');
    var countNode = byId('queue-count');
    listNode.textContent = '';
    var items = state.queue.items();
    countNode.textContent = 'Queued: ' + items.length + ' / ' + MAX_QUEUE;
    if (!items.length) {
      listNode.appendChild(el('p', { class: 'muted small', text: 'No queued comparisons yet. Watch both sides, then choose.' }));
    }
    items.forEach(function (item, index) {
      listNode.appendChild(queueItemSummary(item, index));
    });
    var submitButton = byId('submit-button');
    var writable = !!submission && submission.canWrite();
    submitButton.disabled = !items.length || !writable || (submission && submission.isBusy());
    submitButton.textContent = 'Submit ' + Math.max(items.length, 1) + ' comparison' + (items.length === 1 ? '' : 's');
    if (runtime.mock) {
      submitButton.textContent += ' (mock — nothing goes on chain)';
    } else if (runtime.booting) {
      submitButton.textContent = 'Detecting Browser bridge…';
    } else if (!runtime.bridge) {
      submitButton.textContent = 'Submission unavailable — no Browser bridge';
    } else if (!writable) {
      submitButton.textContent = 'Submission locked — Arena root not yet published';
    }
  }

  function setStatus(kind, message, extraNode) {
    var node = byId('status-line');
    node.textContent = '';
    node.className = 'status-line ' + (kind || '');
    node.appendChild(el('span', { text: message }));
    if (extraNode) node.appendChild(extraNode);
    state.lastStatus = { kind: kind, message: message };
  }

  async function onSubmit() {
    if (!submission || submission.isBusy()) return;
    byId('submit-button').disabled = true;
    setStatus('muted', runtime.mock
      ? 'Submitting through the mock bridge — nothing goes on chain.'
      : 'Submitting — one pin write for the whole batch. Confirm in the Browser dialog…');
    var result = await submission.submit();
    var message = submissionOutcomeMessage(result, { mock: runtime.mock });
    var extra = null;
    if (result.ok) {
      var pinLabel = runtime.mock ? ' mock pin id: ' : ' pin: ';
      extra = el('span', { class: 'mono small', text: pinLabel + result.pinId + (result.actor && result.actor.globalMetaId ? ' · signed by ' + (result.actor.name || result.actor.globalMetaId) : '') });
      setStatus(result.ok ? 'ok' : 'error', message, extra);
    } else {
      setStatus('error', message);
    }
    renderQueue();
  }

  // ---- Loading ----

  async function loadHome() {
    setStatus('muted', 'Loading Motion Video candidates…');
    try {
      var data = await apiGet(LIST_URL);
      state.pool = normalizePool(data.items);
      renderPoolStatus();
      state.pair = state.selector.pick(state.pool.eligible);
      renderCompare();
      if (!state.pool.eligible.length) {
        setStatus('error', 'No comparison-eligible motion-video candidates on ' + CHAIN_NAME + ' yet. This stays a read-only view until the pool grows.');
      } else {
        setStatus('muted', 'Pair loaded. Watch both sides, then choose — choices queue locally until you submit.');
      }
    } catch (error) {
      setStatus('error', 'Could not load the candidate pool: ' + (error && error.message ? error.message : 'network error'));
    }
  }

  async function loadDeepLink(route) {
    setStatus('muted', 'Loading the linked pair…');
    try {
      var results = await Promise.all([apiGet(DETAIL_URL_FOR(route.a)), apiGet(DETAIL_URL_FOR(route.b))]);
      var candidates = [];
      var problems = [];
      results.forEach(function (raw, index) {
        var sideName = index === 0 ? 'first (a)' : 'second (b)';
        var normalized = normalizeCandidate(raw);
        if (!normalized.ok) {
          problems.push('The ' + sideName + ' candidate cannot be compared (' + normalized.status + ').');
        } else {
          candidates.push(normalized.candidate);
        }
      });
      if (problems.length) throw new Error(problems.join(' '));
      if (candidates[0].videoSha256 === candidates[1].videoSha256) {
        throw new Error('The linked pair references the same video — that is not a visual comparison.');
      }
      state.pool = { eligible: candidates, excluded: { disabled: 0, chain: 0, malformed: 0 } };
      state.pair = { left: candidates[0], right: candidates[1] };
      renderPoolStatus();
      renderCompare();
      setStatus('muted', 'Deep-linked pair loaded (left = a, right = b as linked).');
    } catch (error) {
      // A broken deep link leaves no usable pair behind: clear pool/pair so
      // "Next pair" cannot resurrect a stale selection.
      state.pair = null;
      state.pool = { eligible: [], excluded: { disabled: 0, chain: 0, malformed: 0 } };
      renderPoolStatus();
      var stage = byId('stage');
      stage.textContent = '';
      var back = el('button', { type: 'button', class: 'primary', text: 'Back to the candidate pool', onclick: function () { location.hash = '#/'; } });
      stage.appendChild(el('div', { class: 'notice', role: 'alert' }, [
        el('p', { text: 'This comparison link could not be loaded: ' + (error && error.message ? error.message : 'unknown error') }),
        back,
      ]));
      setStatus('error', 'Invalid or unloadable deep link.');
    }
  }

  async function refreshActor() {
    if (!runtime.bridge || runtime.mock) return;
    try {
      var result = await runtime.bridge.request({ method: 'browser.actor.current', timeoutMs: 15000 });
      state.actor = (result && result.actor) || null;
    } catch (error) {
      state.actor = null;
    }
    renderTopbar();
  }

  function onRoute() {
    var route = parseCompareRoute(location.hash);
    if (route.route === 'compare') loadDeepLink(route);
    else if (route.route === 'error') {
      state.pair = null;
      state.pool = { eligible: [], excluded: { disabled: 0, chain: 0, malformed: 0 } };
      renderPoolStatus();
      var stage = byId('stage');
      stage.textContent = '';
      stage.appendChild(el('div', { class: 'notice', role: 'alert' }, [
        el('p', { text: 'Invalid comparison link (' + route.error + '). Links use #/compare?a=<rootPinId>&b=<rootPinId> with full 66-character pin ids.' }),
        el('button', { type: 'button', class: 'primary', text: 'Back to the candidate pool', onclick: function () { location.hash = '#/'; } }),
      ]));
    } else {
      loadHome();
    }
  }

  window.addEventListener('beforeunload', function (event) {
    // Any unsubmitted queued item warrants the warning, including while a
    // submission is in flight (its outcome is not confirmed yet).
    if (state.queue.size() > 0) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  byId('submit-button').addEventListener('click', onSubmit);
  byId('next-pair-button').addEventListener('click', function () { nextPair(); });

  /**
   * Boot: paint the shell, then resolve the runtime mode once the host probe
   * settles (live Browser bridge / local mocks / read-only), then route.
   */
  async function initRuntime() {
    var probe = { host: false, actor: null, error: 'helper-missing' };
    var helper = typeof window.MotionVideoArenaBridgeHelper === 'object' ? window.MotionVideoArenaBridgeHelper : null;
    if (helper && typeof helper.probeBrowserHost === 'function') {
      probe = await helper.probeBrowserHost(8000);
    }
    if (mockRequested && !probe.host) {
      runtime.mock = true;
      runtime.hostProbe = 'none';
      runtime.bridge = mockBridge();
      fetchImpl = mockFetch;
      state.actor = { globalMetaId: 'idmockactor0000000000000000000000000001', name: 'Mock Actor', kind: 'idbots-account' };
    } else {
      if (mockRequested) runtime.mockIgnored = true; // a live host can never be mocked via query
      if (probe.host) {
        runtime.hostProbe = 'live';
        runtime.bridge = window.AgentBrowser;
        state.actor = probe.actor;
        if (window.AgentBrowser && typeof window.AgentBrowser.on === 'function') {
          window.AgentBrowser.on('browser.actor.changed', function (payload) {
            state.actor = (payload && payload.actor) || null;
            renderTopbar();
          });
        }
        refreshActor();
      } else {
        runtime.hostProbe = 'none';
        runtime.bridge = null;
      }
    }
    runtime.booting = false;
    submission = createSubmission();
    renderTopbar();
    renderQueue();
    window.addEventListener('hashchange', onRoute);
    onRoute();
  }

  renderTopbar();
  renderPoolStatus();
  renderQueue();
  renderCompare();
  initRuntime();
})();
