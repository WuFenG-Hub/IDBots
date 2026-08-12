import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { buildMetaFileUploadAgentTools, formatUploadResult } = require('../dist-electron/main/libs/metaFileUploadAgentTools.js');

const SESSION_ID = 'sess-upload-1';
const METABOT_ID = 42;

const SAMPLE_RESULT = {
  success: true,
  pinId: 'pin1i0',
  metafileUri: 'metafile://pin1i0.zip',
  previewUrl: 'https://preview.example/pin1i0',
  downloadUrl: 'https://download.example/pin1i0',
  metawebUrl: 'https://openagentinternet.org/browser/metafile/pin1i0',
  fileName: 'archive.zip',
  size: 2048,
  bytes: 2048,
  extension: '.zip',
  contentType: 'application/zip',
  uploadMode: 'direct',
  network: 'mvc',
  txids: ['tx-a', 'tx-b'],
  globalMetaId: 'idq1alice',
};

function makeHarness(overrides = {}) {
  const calls = { upload: [], resolve: [] };
  const upload = async (params) => {
    calls.upload.push(params);
    if (overrides.uploadError) throw overrides.uploadError;
    return overrides.uploadResult ?? SAMPLE_RESULT;
  };
  const resolveMetabotId = (sessionId) => {
    calls.resolve.push(sessionId);
    // Honor an explicit `metabotId` override (including undefined/null); only
    // fall back to the default when the harness did not specify one.
    return 'metabotId' in overrides ? overrides.metabotId : METABOT_ID;
  };
  const tools = buildMetaFileUploadAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    upload,
    sessionId: SESSION_ID,
    resolveMetabotId,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName };
}

test('builds a single upload_file tool', () => {
  const { byName } = makeHarness();
  assert.ok(byName.upload_file);
  assert.equal(Object.keys(byName).length, 1);
});

test('resolves the session metabotId and forwards absolute path + flags to upload', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.upload_file.handler({
    file_path: '/abs/path/archive.zip',
    content_type: 'application/zip',
    network: 'mvc',
    verify: true,
  });
  assert.deepEqual(calls.resolve, [SESSION_ID]);
  assert.equal(calls.upload.length, 1);
  assert.deepEqual(calls.upload[0], {
    metabotId: METABOT_ID,
    filePath: '/abs/path/archive.zip',
    contentType: 'application/zip',
    network: 'mvc',
    verify: true,
  });
  const text = result.content[0].text;
  assert.equal(result.isError, undefined);
  assert.match(text, /File uploaded to MetaWeb\./);
  assert.match(text, /metafile URI: metafile:\/\/pin1i0\.zip/);
  assert.match(text, /pinId: pin1i0/);
  assert.match(text, /share link \(for other people\): https:\/\/openagentinternet\.org\/browser\/metafile\/pin1i0/);
  assert.match(text, /upload mode: direct/);
  assert.match(text, /network: mvc/);
  assert.match(text, /txids: tx-a, tx-b/);
  // No sponsor marker when feeAssist is absent.
  assert.doesNotMatch(text, /sponsor:/);
});

test('omits contentType/network when not provided so the service applies defaults', async () => {
  const { calls, byName } = makeHarness();
  await byName.upload_file.handler({ file_path: '/abs/photo.png' });
  assert.equal(calls.upload[0].contentType, undefined);
  assert.equal(calls.upload[0].network, undefined);
  assert.equal(calls.upload[0].verify, false);
});

test('rejects a relative path with an explicit ABSOLUTE message', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.upload_file.handler({ file_path: 'relative/photo.png' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ABSOLUTE file path/);
  assert.match(result.content[0].text, /relative\/photo\.png/);
  // Must not reach the upload backend.
  assert.equal(calls.upload.length, 0);
});

test('rejects an empty file_path before resolving the metabotId', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.upload_file.handler({ file_path: '   ' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /file_path/);
  assert.equal(calls.upload.length, 0);
  assert.equal(calls.resolve.length, 0);
});

test('errors when no MetaBot owns the session', async () => {
  const { calls, byName } = makeHarness({ metabotId: undefined });
  const result = await byName.upload_file.handler({ file_path: '/abs/photo.png' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /which MetaBot owns this session/);
  assert.equal(calls.upload.length, 0);
});

test('surfaces backend failures as an error result without throwing', async () => {
  const { byName } = makeHarness({ uploadError: new Error('File not found: /abs/missing') });
  const result = await byName.upload_file.handler({ file_path: '/abs/missing' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /File upload failed: File not found: \/abs\/missing/);
});

test('formatUploadResult marks the sponsor path and reports verification outcome', () => {
  const sponsored = formatUploadResult({
    ...SAMPLE_RESULT,
    feeAssist: { attempted: true, used: true, mode: 'mvc_sponsor_v2', stage: 'done' },
  });
  assert.match(sponsored, /sponsor: applied \(MVC sponsor covered this direct upload\)/);

  // Sponsor attempted but balance insufficient -> fell back to self-paid.
  const fellBack = formatUploadResult({
    ...SAMPLE_RESULT,
    feeAssist: { attempted: true, used: false, mode: 'self_paid', reason: 'insufficient_quota', stage: 'pre' },
  });
  assert.match(fellBack, /sponsor: unavailable, fell back to the bot's own wallet \(reason: insufficient_quota at pre\)/);

  const verified = formatUploadResult({
    ...SAMPLE_RESULT,
    verification: { ok: true, url: 'https://verify.example/pin1i0' },
  });
  assert.match(verified, /verification: available at https:\/\/verify\.example\/pin1i0/);

  const unverified = formatUploadResult({
    ...SAMPLE_RESULT,
    verification: { ok: false, error: 'not indexed yet', url: null },
  });
  assert.match(unverified, /verification: not indexed yet/);
});

test('upload_file surfaces the feeAssist reason when a hard sponsor failure aborts the upload', async () => {
  const hardFail = new Error('sponsor commit rejected');
  hardFail.code = 'mvc_fee_assist_commit_failed';
  hardFail.data = {
    feeAssist: { attempted: true, used: false, reason: 'commit_failed', stage: 'commit', orderId: 'order-1' },
  };
  const { byName } = makeHarness({ uploadError: hardFail });
  const result = await byName.upload_file.handler({ file_path: '/abs/archive.zip' });
  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.match(text, /File upload failed: sponsor commit rejected/);
  assert.match(text, /sponsor commit commit_failed; not retried via the self-paid wallet/);
});
