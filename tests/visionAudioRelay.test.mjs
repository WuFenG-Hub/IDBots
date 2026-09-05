import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import Module from 'node:module';
import path from 'node:path';

const require = Module.createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return { app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => '/tmp' } };
  return originalLoad.apply(this, arguments);
};
const service = require('../dist-electron/main/services/visionRelayService.js');
Module._load = originalLoad;

const {
  buildAudioExtractArgs,
  inferAudioMimeType,
  initVisionRelayService,
  recognizeAudioViaRelay,
  recognizeVideoAudioViaRelay,
  resetVisionRelayServiceForTests,
} = service;
const CHAT_BASE = 'https://www.metaso.network/assist-open-api/v2/assist/llm/v1';

function setup(overrides = {}) {
  const calls = { fetches: [], bootstrap: 0 };
  initVisionRelayService({
    ...overrides,
    getStore: () => ({
      get: (key) => key === 'visionRelay.apiKey' ? 'relay-key' : key === 'visionRelay.baseUrl' ? CHAT_BASE : null,
      set() {}, delete() {},
    }),
    bootstrapImpl: async () => { calls.bootstrap += 1; return { apiKey: 'boot-key', baseUrl: CHAT_BASE }; },
    fetchImpl: async (url, init) => {
      calls.fetches.push({ url, init });
      return (overrides.fetchImpl ? overrides.fetchImpl(url, init) : null) ?? new Response(JSON.stringify({
        code: 0, message: 'success', data: { content: '这是生产语音识别测试。', model: 'metaid-free-audio', remainingToday: 599, usage: {} },
      }));
    },
  });
  return calls;
}

test.beforeEach(() => resetVisionRelayServiceForTests());

test('wav file becomes audioBase64 and uses the existing relay key', async () => {
  const file = '/tmp/idbots-audio-test.wav';
  await fs.writeFile(file, Buffer.from('RIFFfakewav'));
  const calls = setup();
  await recognizeAudioViaRelay({ audioPath: file });
  const body = JSON.parse(calls.fetches[0].init.body);
  assert.equal(body.audioBase64, Buffer.from('RIFFfakewav').toString('base64'));
  assert.equal(body.mimeType, 'audio/wav');
  assert.equal(body.prompt, '请完整转写这段音频，保留原语言、标点和说话内容，不要总结。');
  assert.equal(calls.fetches[0].init.headers.Authorization, 'Bearer relay-key');
});

test('mp3 and m4a MIME types are inferred', () => {
  assert.equal(inferAudioMimeType('/tmp/speech.mp3'), 'audio/mpeg');
  assert.equal(inferAudioMimeType('/tmp/speech.m4a'), 'audio/m4a');
});

test('URL audio uses audioUrl and preserves a custom prompt', async () => {
  const calls = setup();
  await recognizeAudioViaRelay({ audioUrl: 'https://example.com/speech.mp3', prompt: '保留说话人原话' });
  const body = JSON.parse(calls.fetches[0].init.body);
  assert.equal(body.audioUrl, 'https://example.com/speech.mp3');
  assert.equal(body.mimeType, 'audio/mpeg');
  assert.equal(body.prompt, '保留说话人原话');
});

test('relay errors are surfaced and invalid/empty/oversized audio is rejected before fetch', async () => {
  const calls = setup({ fetchImpl: async () => new Response(JSON.stringify({ code: 1, message: 'vision daily quota exhausted' })) });
  await assert.rejects(() => recognizeAudioViaRelay({ audioBase64: 'eA==' }), /vision daily quota exhausted/);
  assert.equal(calls.fetches.length, 1);
  const empty = '/tmp/idbots-empty-audio.wav';
  await fs.writeFile(empty, '');
  await assert.rejects(() => recognizeAudioViaRelay({ audioPath: empty }), /audio payload is invalid/);
  await assert.rejects(() => recognizeAudioViaRelay({ audioBase64: 'A'.repeat(10 * 1024 * 1024 + 1) }), /too large|invalid/);
});

test('video audio extraction calls describe_audio with extracted mp3', async () => {
  const seen = [];
  const calls = setup({ extractAudioImpl: async (videoPath) => {
    seen.push(videoPath);
    const file = '/tmp/idbots-extracted.mp3';
    await fs.writeFile(file, 'mp3');
    return { audioPath: file, mimeType: 'audio/mpeg', bytes: 3 };
  } });
  const result = await recognizeVideoAudioViaRelay({ videoPath: '/tmp/video.mp4' });
  assert.equal(result.content, '这是生产语音识别测试。');
  assert.deepEqual(seen, ['/tmp/video.mp4']);
  const body = JSON.parse(calls.fetches[0].init.body);
  assert.equal(body.mimeType, 'audio/mpeg');
  assert.equal(body.audioBase64, Buffer.from('mp3').toString('base64'));
});

test('ffmpeg extraction args remove video and encode mono mp3', () => {
  const args = buildAudioExtractArgs({ inputPath: '/tmp/video.mp4', outputPath: '/tmp/audio.mp3' });
  assert.ok(args.includes('-vn'));
  assert.equal(args[args.indexOf('-ac') + 1], '1');
  assert.equal(args[args.indexOf('-c:a') + 1], 'libmp3lame');
});
