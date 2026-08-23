import assert from 'node:assert/strict';
import fs from 'fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = Module.createRequire(import.meta.url);
const { buildPostSimpleNoteAgentTools, formatSimpleNoteResult } = require('../dist-electron/main/libs/postSimpleNoteAgentTools.js');

const SESSION_ID = 'sess-note-1';
const METABOT_ID = 42;

const SAMPLE_PIN_RESULT = { txids: ['tx-note-1'], pinId: 'tx-note-1i0', totalCost: 2100 };

function makeFixtureFile(name = 'cover.png', contents = 'png-bytes') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-simplenote-test-'));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function makeHarness(overrides = {}) {
  const calls = { createPin: [], upload: [], resolve: [] };
  const createPin = async (metabotId, metaidData, options) => {
    calls.createPin.push({ metabotId, metaidData, options });
    if (overrides.createPinError) throw overrides.createPinError;
    return overrides.pinResult ?? SAMPLE_PIN_RESULT;
  };
  const uploadFile = async (params) => {
    calls.upload.push(params);
    if (overrides.uploadError) throw overrides.uploadError;
    return overrides.uploadResult ?? { metafileUri: 'metafile://uploadedi0.png' };
  };
  const resolveMetabotId = (sessionId) => {
    calls.resolve.push(sessionId);
    return 'metabotId' in overrides ? overrides.metabotId : METABOT_ID;
  };
  const tools = buildPostSimpleNoteAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    createPin,
    uploadFile,
    sessionId: SESSION_ID,
    resolveMetabotId,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName };
}

test('registers exactly one post_simplenote tool', () => {
  const { byName } = makeHarness();
  assert.deepEqual(Object.keys(byName), ['post_simplenote']);
});

test('publishes a markdown note with the simplenote 1.0.1 payload shape', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.post_simplenote.handler({
    title: 'auto-editor 上手指南',
    content: '# 指南\n\n正文 ![图](metafile://att1i0.png)',
    tags: ['tutorial', 'video'],
  });
  assert.equal(result.isError, undefined);
  assert.equal(calls.createPin.length, 1);
  const { metabotId, metaidData, options } = calls.createPin[0];
  assert.equal(metabotId, METABOT_ID);
  assert.deepEqual(options, { network: 'mvc' });
  assert.equal(metaidData.operation, 'create');
  assert.equal(metaidData.path, '/protocols/simplenote');
  assert.equal(metaidData.version, '1.0.1');
  assert.equal(metaidData.encryption, '0');
  assert.equal(metaidData.contentType, 'application/json');
  const payload = JSON.parse(metaidData.payload);
  assert.equal(payload.title, 'auto-editor 上手指南');
  assert.equal(payload.subtitle, '');
  assert.equal(payload.coverImg, '');
  assert.equal(payload.contentType, 'text/markdown');
  assert.match(payload.content, /# 指南/);
  assert.equal(payload.encryption, '0');
  assert.equal(typeof payload.createTime, 'number');
  assert.ok(payload.createTime <= Date.now());
  assert.deepEqual(payload.tags, ['tutorial', 'video']);
  assert.deepEqual(payload.attachments, []);
  // Result sheet: pin:// view link, no Web2 URLs.
  const text = result.content[0].text;
  assert.match(text, /Note published on-chain\./);
  assert.match(text, /pinId: tx-note-1i0/);
  assert.match(text, /title: auto-editor 上手指南/);
  assert.match(text, /view link: \[pin:\/\/tx-note-1i0\]\(pin:\/\/tx-note-1i0\)/);
  assert.doesNotMatch(text, /openagentinternet|metaid\.io/);
});

test('uploads a local cover and mixed attachments to metafile URIs', async () => {
  const cover = makeFixtureFile('cover.png');
  const extra = makeFixtureFile('chart.jpg');
  const { calls, byName } = makeHarness();
  const result = await byName.post_simplenote.handler({
    title: 't',
    content: 'c',
    cover,
    attachments: [extra, 'metafile://existingi0.png'],
    subtitle: '副标题',
    content_type: 'text/html',
    network: 'btc',
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.upload.map((call) => call.network), ['btc', 'btc']);
  const payload = JSON.parse(calls.createPin[0].metaidData.payload);
  assert.equal(payload.coverImg, 'metafile://uploadedi0.png');
  assert.deepEqual(payload.attachments, ['metafile://uploadedi0.png', 'metafile://existingi0.png']);
  assert.equal(payload.subtitle, '副标题');
  assert.equal(payload.contentType, 'text/html');
  assert.match(result.content[0].text, /- cover: metafile:\/\/uploadedi0\.png/);
  assert.match(result.content[0].text, /- attachment: metafile:\/\/existingi0\.png/);
});

test('DOGE note write keeps file uploads on MVC', async () => {
  const cover = makeFixtureFile();
  const { calls, byName } = makeHarness();
  await byName.post_simplenote.handler({ title: 't', content: 'c', cover, network: 'doge' });
  assert.equal(calls.upload[0].network, 'mvc');
  assert.equal(calls.createPin[0].options.network, 'doge');
});

test('rejects relative paths, missing files, and empty title/content', async () => {
  const { byName } = makeHarness();
  const relative = await byName.post_simplenote.handler({ title: 't', content: 'c', cover: 'cover.png' });
  assert.equal(relative.isError, true);
  assert.match(relative.content[0].text, /ABSOLUTE local file paths/);
  const missing = await byName.post_simplenote.handler({ title: 't', content: 'c', cover: '/nonexistent/cover.png' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /file not found/);
  const empty = await byName.post_simplenote.handler({ title: '', content: 'c' });
  assert.equal(empty.isError, true);
  assert.match(empty.content[0].text, /requires both `title` and `content`/);
});

test('reports honestly when no MetaBot owns the session or the write fails', async () => {
  const noBot = makeHarness({ metabotId: undefined });
  const noBotResult = await noBot.byName.post_simplenote.handler({ title: 't', content: 'c' });
  assert.equal(noBotResult.isError, true);
  assert.match(noBotResult.content[0].text, /could not determine which MetaBot/);

  const failed = makeHarness({ createPinError: new Error('insufficient balance') });
  const failedResult = await failed.byName.post_simplenote.handler({ title: 't', content: 'c' });
  assert.equal(failedResult.isError, true);
  assert.match(failedResult.content[0].text, /Note publish failed: insufficient balance/);
});

test('formatSimpleNoteResult minimal and full shapes', () => {
  const minimal = formatSimpleNoteResult({ pinId: '', txids: [], totalCost: 0, title: 't', attachments: [] });
  assert.equal(minimal, 'Note published on-chain.\n- title: t\n- cost: 0 sats');
  const full = formatSimpleNoteResult({
    pinId: 'abci0',
    txids: ['tx-1'],
    totalCost: 42,
    title: '标题',
    coverImg: 'metafile://ci0.png',
    attachments: ['metafile://ai0.png'],
  });
  assert.match(full, /view link: \[pin:\/\/abci0\]\(pin:\/\/abci0\)/);
  assert.doesNotMatch(full, /https?:\/\//);
});
