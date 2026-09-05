/**
 * Vision video unit tests: transcode argument building, ffmpeg duration
 * parsing, the video recognize relay path (with an injected transcode stub
 * and fake fetch), and the describe_video tool contract. One integration
 * case exercises the real local ffmpeg when one is resolvable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';

const require = Module.createRequire(import.meta.url);

function loadCompiledModule(modulePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => path.join(process.cwd(), '.cowork-temp', 'vision-video-test-user-data'),
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

const service = loadCompiledModule('../dist-electron/main/services/visionRelayService.js');
const {
  initVisionRelayService,
  resetVisionRelayServiceForTests,
  recognizeVideoViaRelay,
  transcodeVideoForVision,
  buildVideoTranscodeArgs,
  parseFfmpegDuration,
  VISION_VIDEO_MAX_SECONDS,
} = service;

const tools = loadCompiledModule('../dist-electron/main/libs/visionRelayAgentTools.js');
const { buildVisionRelayAgentTools } = tools;

const CHAT_BASE = 'https://www.metaso.network/assist-open-api/v2/assist/llm/v1';

function makeStore(kv = new Map()) {
  return {
    get: (key) => (kv.has(key) ? kv.get(key) : null),
    set: (key, value) => kv.set(key, value),
    delete: (key) => kv.delete(key),
  };
}

function setupService(overrides = {}) {
  const calls = { fetches: [] };
  initVisionRelayService({
    getStore: () => overrides.store ?? makeStore(new Map([
      ['visionRelay.apiKey', 'mrk_test'],
      ['visionRelay.baseUrl', CHAT_BASE],
    ])),
    fetchImpl: async (url, init) => {
      calls.fetches.push({ url, init });
      return overrides.fetchImpl
        ? overrides.fetchImpl(url, init)
        : new Response(
            JSON.stringify({
              code: 0,
              data: {
                content: 'a 4 second clip showing color bars',
                model: 'metaid-free-vision',
                remainingToday: 95,
                usage: { promptTokens: 923, completionTokens: 564, totalTokens: 1487, videoTokens: 882 },
              },
            }),
            { status: 200 },
          );
    },
    transcodeVideoImpl: overrides.transcodeVideoImpl,
    ...overrides.deps,
  });
  return calls;
}

test.beforeEach(() => {
  resetVisionRelayServiceForTests();
});

test('buildVideoTranscodeArgs: standard pass targets 480px/crf32 with duration cap', () => {
  const args = buildVideoTranscodeArgs({
    inputPath: '/tmp/in.mov',
    outputPath: '/tmp/out.mp4',
    maxSeconds: 180,
    pass: 'standard',
  });
  assert.ok(args.includes('-y'));
  assert.equal(args[args.indexOf('-t') + 1], '180');
  assert.ok(args.join(' ').includes("scale='min(480,iw)':-2"));
  assert.equal(args[args.indexOf('-crf') + 1], '32');
  assert.ok(args.includes('-an'), 'audio must be dropped');
  assert.ok(args.includes('+faststart'));
});

test('buildVideoTranscodeArgs: hard pass is smaller', () => {
  const args = buildVideoTranscodeArgs({
    inputPath: '/tmp/in.mov',
    outputPath: '/tmp/out.mp4',
    maxSeconds: 180,
    pass: 'hard',
  });
  assert.ok(args.join(' ').includes("scale='min(360,iw)':-2"));
  assert.equal(args[args.indexOf('-crf') + 1], '38');
});

test('parseFfmpegDuration reads the Duration header from -i probes', () => {
  assert.equal(parseFfmpegDuration('  Duration: 00:03:25.61, start: 0.000000'), 205.61);
  assert.equal(parseFfmpegDuration('  Duration: 00:00:04.00, start: 0.000000'), 4);
  assert.equal(parseFfmpegDuration('no header here'), null);
});

test('recognizeVideoViaRelay sends videoBase64 + video/mp4 and returns truncation info', async () => {
  const calls = setupService({
    transcodeVideoImpl: async () => ({
      base64: 'bXA0ZGF0YQ==',
      bytes: 1024,
      durationSec: 42,
      truncated: false,
    }),
  });

  const result = await recognizeVideoViaRelay({ videoPath: '/tmp/clip.mov', prompt: '视频里发生了什么？' });

  const body = JSON.parse(calls.fetches[0].init.body);
  assert.equal(body.videoBase64, 'bXA0ZGF0YQ==');
  assert.equal(body.mimeType, 'video/mp4');
  assert.equal(body.prompt, '视频里发生了什么？');
  assert.equal(body.imageBase64, undefined);
  assert.equal(result.truncated, false);
  assert.equal(result.content, 'a 4 second clip showing color bars');
});

test('recognizeVideoViaRelay rejects oversized transcoded payloads', async () => {
  setupService({
    transcodeVideoImpl: async () => ({
      base64: 'eA=='.repeat(2 * 1024 * 1024),
      bytes: 9 * 1024 * 1024,
      durationSec: 300,
      truncated: true,
    }),
  });
  await assert.rejects(
    () => recognizeVideoViaRelay({ videoPath: '/tmp/big.mov' }),
    /still too large after compression/,
  );
});

test('recognizeVideoViaRelay requires a video source', async () => {
  setupService({});
  await assert.rejects(() => recognizeVideoViaRelay({ prompt: 'x' }), /videoPath or videoBase64/);
});

test('describe_video tool validates paths and formats results', async () => {
  const seen = [];
  const captured = [];
  buildVisionRelayAgentTools({
    tool: (name, description, schema, handler) => {
      captured.push({ name, description, schema, handler });
      return { name };
    },
    visionRelay: {
      recognize: async () => {
        throw new Error('not under test');
      },
      recognizeVideo: async (input) => {
        seen.push(input);
        return {
          content: 'a person walks a dog',
          model: 'metaid-free-vision',
          remainingToday: 90,
          truncated: true,
          durationSec: 400,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, imageTokens: 0, estimated: false },
        };
      },
      recognizeAudio: async () => ({ content: '', model: '', remainingToday: -1, usage: {} }),
      recognizeVideoAudio: async () => ({ content: '', model: '', remainingToday: -1, usage: {} }),
    },
  });

  assert.equal(captured.length, 3, 'factory must register describe_image, describe_video AND describe_audio');
  const video = captured.find((t) => t.name === 'describe_video');
  assert.ok(video, 'describe_video registered');

  const result = await video.handler({ video_path: '/tmp/clip.mp4', question: '谁在遛狗？' });
  assert.deepEqual(seen, [{ videoPath: '/tmp/clip.mp4', prompt: '谁在遛狗？' }]);
  const text = result.content[0].text;
  assert.match(text, /person walks a dog/);
  assert.match(text, /first 3 minutes/);
  assert.match(text, /quota units left today: 90/);

  const relative = await video.handler({ video_path: 'clip.mp4' });
  assert.equal(relative.isError, true);
  assert.match(relative.content[0].text, /ABSOLUTE/);
});

test('integration: transcodeVideoForVision compresses a real clip with local ffmpeg', { timeout: 60_000 }, async (t) => {
  // Uses the real ffmpeg when one resolves (bundled dev copy or system PATH);
  // skipped otherwise so CI without ffmpeg stays green.
  const fs = await import('node:fs');
  const input = '/tmp/test_video_4s.mp4';
  if (!fs.existsSync(input)) {
    t.skip('test fixture /tmp/test_video_4s.mp4 not present');
    return;
  }
  initVisionRelayService({
    getStore: () => makeStore(),
    // no transcodeVideoImpl: exercise the real pipeline
  });
  try {
    const result = await transcodeVideoForVision(input);
    assert.ok(result.base64.length > 0);
    assert.ok(result.bytes < 1024 * 1024, '4s 640x360 clip must compress under 1MB');
    assert.equal(result.truncated, false);
    assert.ok(result.durationSec == null || Math.abs(result.durationSec - 4) < 1.5);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ffmpeg (is not available|failed to start)/.test(message)) {
      t.skip(`no local ffmpeg: ${message}`);
      return;
    }
    throw error;
  }
});
