import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const {
  searchMetaApps,
  listMetaAppForks,
  listPreferenceComparisons,
  MetaAppSearchNotFoundError,
  MetaAppValidatedBasisUnavailableError,
} = require('../dist-electron/main/services/metaAppSearchService.js');

const SAMPLE_ITEM = {
  pinId: 'a'.repeat(64) + 'i0',
  sourcePinId: 'a'.repeat(64) + 'i0',
  chainName: 'mvc',
  title: '番茄钟',
  appName: 'pomodoro',
  intro: '极简番茄钟',
  tags: ['tool', 'timer'],
  runtime: 'browser',
  version: '1.0.0',
  content: 'metafile://x.zip',
  indexFile: 'index.html',
  forkedFrom: '',
  disabled: false,
  publisherGlobalMetaId: 'idq1abc',
  publisherMetaId: 'metaId1',
  publisherAddress: 'addr1',
  publisherName: 'BOT-007',
  publisherAvatarId: 'a275356ai0',
  createdAt: 1768284841,
  updatedAt: 1768284841,
};

function stubFetch(body, capture = {}) {
  return async (url) => {
    capture.url = url;
    return {
      status: 200,
      json: async () => body,
    };
  };
}

test('searchMetaApps builds the list URL and normalizes items', async () => {
  const capture = {};
  const page = await searchMetaApps(
    { keyword: '番茄钟 极简', tag: 'tool', publisher: 'idq1abc', since: 1768000000, size: 8 },
    { fetchImpl: stubFetch({ code: 0, message: 'ok', data: { items: [SAMPLE_ITEM], nextCursor: 'abc', hasMore: true } }, capture) },
  );
  const url = new URL(capture.url);
  assert.equal(url.origin + url.pathname, 'https://so.metaid.io/api/metaapp/list');
  assert.equal(url.searchParams.get('keyword'), '番茄钟 极简');
  assert.equal(url.searchParams.get('tag'), 'tool');
  assert.equal(url.searchParams.get('publisher'), 'idq1abc');
  assert.equal(url.searchParams.get('since'), '1768000000');
  assert.equal(url.searchParams.get('size'), '8');

  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].title, '番茄钟');
  assert.deepEqual(page.items[0].tags, ['tool', 'timer']);
  assert.equal(page.items[0].publisherName, 'BOT-007');
  assert.equal(page.items[0].publisherAvatarId, 'a275356ai0');
  assert.equal(page.nextCursor, 'abc');
  assert.equal(page.hasMore, true);
});

test('searchMetaApps omits empty params and tolerates missing item fields', async () => {
  const capture = {};
  const page = await searchMetaApps({}, {
    fetchImpl: stubFetch({ code: 0, data: { items: [{ pinId: 'x' }] } }, capture),
  });
  assert.equal(capture.url, 'https://so.metaid.io/api/metaapp/list');
  assert.equal(page.items[0].indexFile, 'index.html');
  assert.equal(page.items[0].disabled, false);
  assert.equal(page.hasMore, false);
});

test('searchMetaApps maps API error codes to typed errors', async () => {
  await assert.rejects(
    searchMetaApps({ keyword: 'x' }, { fetchImpl: stubFetch({ code: 40000, message: 'bad cursor' }) }),
    /40000: bad cursor/,
  );
  await assert.rejects(
    searchMetaApps({ keyword: 'x' }, { fetchImpl: stubFetch({ code: 40400, message: 'not here' }) }),
    (error) => error instanceof MetaAppSearchNotFoundError,
  );
});

test('searchMetaApps throws on an invalid response body', async () => {
  await assert.rejects(
    searchMetaApps({}, { fetchImpl: async () => ({ status: 200, json: async () => null }) }),
    /invalid response/,
  );
});

test('listMetaAppForks encodes the pinId and passes size', async () => {
  const capture = {};
  const pinId = 'b'.repeat(64) + 'i0';
  const page = await listMetaAppForks({ pinId, size: 5 }, {
    fetchImpl: stubFetch({ code: 0, data: { items: [SAMPLE_ITEM], hasMore: false } }, capture),
  });
  assert.equal(capture.url, `https://so.metaid.io/api/metaapp/forks/${pinId}?size=5`);
  assert.equal(page.items.length, 1);
});

test('listMetaAppForks requires a pinId', async () => {
  await assert.rejects(listMetaAppForks({ pinId: ' ' }, { fetchImpl: stubFetch({}) }), /pinId is required/);
});

// ---------------------------------------------------------------------------
// Motion-video preference extensions (docs/design/motion-video-preference)
// ---------------------------------------------------------------------------

test('searchMetaApps passes the preference sort parameters through', async () => {
  const capture = {};
  await searchMetaApps(
    {
      tag: 'motion-video',
      chainName: 'mvc',
      sort: 'preference',
      order: 'desc',
      basis: 'open',
      minJudges: 3,
      learning: 'declared',
      cursor: 'cur-1',
    },
    { fetchImpl: stubFetch({ code: 0, data: { items: [] } }, capture) },
  );
  const url = new URL(capture.url);
  assert.equal(url.searchParams.get('sort'), 'preference');
  assert.equal(url.searchParams.get('order'), 'desc');
  assert.equal(url.searchParams.get('basis'), 'open');
  assert.equal(url.searchParams.get('minJudges'), '3');
  assert.equal(url.searchParams.get('learning'), 'declared');
  assert.equal(url.searchParams.get('chainName'), 'mvc');
  assert.equal(url.searchParams.get('cursor'), 'cur-1');
});

test('searchMetaApps keeps preference params out of ordinary queries', async () => {
  const capture = {};
  await searchMetaApps({ keyword: 'x' }, { fetchImpl: stubFetch({ code: 0, data: { items: [] } }, capture) });
  const url = new URL(capture.url);
  for (const param of ['sort', 'order', 'basis', 'minJudges', 'learning']) {
    assert.equal(url.searchParams.get(param), null, `${param} must stay absent`);
  }
});

test('items retain currentPinId/prompt and normalize motionVideo and preference blocks', async () => {
  const item = {
    ...SAMPLE_ITEM,
    currentPinId: 'c'.repeat(64) + 'i0',
    prompt: '  A ukiyo-e motion video  ',
    motionVideo: {
      videoFile: 'metafile://' + 'd'.repeat(64) + 'i0.mp4',
      videoSha256: 'e'.repeat(64),
      durationSec: 10,
      fps: 24,
      resolution: '1920x1080',
      engine: 'lemo-opuscar',
      style: 'ukiyoe',
      learning: { sourceIncluded: true, hasPrompt: true, status: 'declared' },
    },
    preference: {
      open: {
        score: 0.73,
        scoreVersion: 'motion-video-open-pref-v1',
        state: 'established',
        comparisons: 18,
        judges: 5,
        lastComparedAt: 1792832839,
      },
      validated: { score: null, state: 'unavailable' },
    },
  };
  const page = await searchMetaApps(
    { tag: 'motion-video' },
    { fetchImpl: stubFetch({ code: 0, data: { items: [item] } }) },
  );
  const normalized = page.items[0];
  assert.equal(normalized.currentPinId, 'c'.repeat(64) + 'i0');
  assert.equal(normalized.prompt, 'A ukiyo-e motion video');
  assert.equal(normalized.motionVideo.videoFile, 'metafile://' + 'd'.repeat(64) + 'i0.mp4');
  assert.equal(normalized.motionVideo.hasAudio, null);
  assert.equal(normalized.motionVideo.frames, null);
  assert.equal(normalized.motionVideo.learning.status, 'declared');
  assert.equal(normalized.preference.open.score, 0.73);
  assert.equal(normalized.preference.open.state, 'established');
  assert.deepEqual(normalized.preference.validated, { score: null, state: 'unavailable' });
});

test('missing evidence never becomes zero or false', async () => {
  const item = {
    ...SAMPLE_ITEM,
    motionVideo: { videoFile: 'metafile://' + 'f'.repeat(64) + 'i0' },
    preference: {
      open: { score: null, scoreVersion: 'motion-video-open-pref-v1', state: 'unjudged' },
      validated: { score: null, state: 'unavailable' },
    },
  };
  const page = await searchMetaApps({}, { fetchImpl: stubFetch({ code: 0, data: { items: [item] } }) });
  const normalized = page.items[0];
  assert.equal(normalized.motionVideo.hasAudio, null);
  assert.equal(normalized.motionVideo.durationSec, null);
  assert.equal(normalized.motionVideo.learning, null);
  assert.equal(normalized.preference.open.score, null);
  assert.equal(normalized.preference.open.state, 'unjudged');
  // Items without projections keep null blocks, not fabricated zeros.
  const bare = await searchMetaApps({}, { fetchImpl: stubFetch({ code: 0, data: { items: [SAMPLE_ITEM] } }) });
  assert.equal(bare.items[0].motionVideo, null);
  assert.equal(bare.items[0].preference, null);
});

test('preference_validated_basis_unavailable maps to a typed error, not a generic one', async () => {
  const fetchImpl = stubFetch({ code: 40000, message: 'preference_validated_basis_unavailable' });
  await assert.rejects(
    searchMetaApps({ sort: 'preference', chainName: 'mvc', basis: 'validated' }, { fetchImpl }),
    (error) => error instanceof MetaAppValidatedBasisUnavailableError,
  );
  // Any other 40000 message stays a generic API error.
  await assert.rejects(
    searchMetaApps({ sort: 'preference', chainName: 'mvc' }, { fetchImpl: stubFetch({ code: 40000, message: 'other' }) }),
    (error) => !(error instanceof MetaAppValidatedBasisUnavailableError),
  );
});

test('listPreferenceComparisons builds the evidence query and normalizes items', async () => {
  const capture = {};
  const sha = 'b8113ccc77c592466f8c67b7ff775cb9c57927a516c34989e8611a1d09f81674';
  const feedbackPin = 'a'.repeat(64) + 'i5';
  const page = await listPreferenceComparisons(
    {
      chainName: 'mvc',
      subject: sha,
      outcome: 'rejected',
      includeMempool: true,
      size: 20,
      cursor: 'cmp-2',
    },
    {
      fetchImpl: stubFetch({
        code: 0,
        data: {
          items: [{
            feedbackPinId: feedbackPin,
            chainName: 'mvc',
            basis: 'open',
            isMempool: false,
            confirmedAt: 1792832839,
            a: {
              chainName: 'mvc',
              app: 'metaapp://' + '1'.repeat(64) + 'i0',
              version: 'metaapp://' + '2'.repeat(64) + 'i0',
              video: 'metafile://' + '3'.repeat(64) + 'i0.mp4',
              videoSha256: sha,
            },
            b: {
              chainName: 'mvc',
              app: 'metaapp://' + '4'.repeat(64) + 'i0',
              version: 'metaapp://' + '5'.repeat(64) + 'i0',
              video: 'metafile://' + '6'.repeat(64) + 'i0',
              videoSha256: '9'.repeat(64),
            },
            pick: 'b',
            reason: ' left side motion was jittery ',
            dims: { visual: 'b', storytelling: 'tie' },
            signerGlobalMetaId: 'idq1judge',
            client: { artifact: 'metaapp://arena', mode: 'arena' },
            subject: sha,
            outcome: 'rejected',
          }],
          nextCursor: 'cmp-3',
          hasMore: true,
        },
      }, capture),
    },
  );
  const url = new URL(capture.url);
  assert.equal(url.origin + url.pathname, 'https://so.metaid.io/api/preference/comparisons');
  assert.equal(url.searchParams.get('chainName'), 'mvc');
  assert.equal(url.searchParams.get('category'), 'motion-video');
  assert.equal(url.searchParams.get('basis'), 'open');
  assert.equal(url.searchParams.get('subject'), sha);
  assert.equal(url.searchParams.get('outcome'), 'rejected');
  assert.equal(url.searchParams.get('includeMempool'), '1');
  assert.equal(url.searchParams.get('size'), '20');
  assert.equal(url.searchParams.get('cursor'), 'cmp-2');

  const item = page.items[0];
  assert.equal(item.feedbackPinId, feedbackPin);
  assert.equal(item.reason, 'left side motion was jittery');
  assert.equal(item.a.videoSha256, sha);
  assert.equal(item.b.app, 'metaapp://' + '4'.repeat(64) + 'i0');
  assert.deepEqual(item.dims, { visual: 'b', storytelling: 'tie' });
  assert.equal(item.signerGlobalMetaId, 'idq1judge');
  assert.equal(item.clientArtifact, 'metaapp://arena');
  assert.equal(item.clientMode, 'arena');
  assert.equal(item.excluded, false);
  assert.equal(item.excludedReason, null);
  assert.equal(page.nextCursor, 'cmp-3');
});

test('listPreferenceComparisons validates required params', async () => {
  await assert.rejects(
    listPreferenceComparisons({ chainName: '' }),
    /chainName is required/,
  );
  await assert.rejects(
    listPreferenceComparisons({ chainName: 'mvc', outcome: 'preferred' }),
    /subject/,
  );
});

test('listPreferenceComparisons maps validated basis to the unavailable error', async () => {
  await assert.rejects(
    listPreferenceComparisons(
      { chainName: 'mvc', basis: 'validated' },
      { fetchImpl: stubFetch({ code: 40000, message: 'preference_validated_basis_unavailable' }) },
    ),
    (error) => error instanceof MetaAppValidatedBasisUnavailableError,
  );
});
