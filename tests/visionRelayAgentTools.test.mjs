/**
 * describe_image agent-tool unit tests.
 *
 * Covers the tool factory contract: absolute-path validation, the success
 * text shape (description + remaining quota line), and error mapping from the
 * backend's stable error strings to actionable tool text. Uses a captured
 * fake tool() factory; no SDK, no network.
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
          getPath: () => path.join(process.cwd(), '.cowork-temp', 'vision-agent-tools-test-user-data'),
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

const { buildVisionRelayAgentTools, formatVisionRelayError } = loadCompiledModule(
  '../dist-electron/main/libs/visionRelayAgentTools.js',
);

function buildTool(recognize) {
  const captured = [];
  const tools = buildVisionRelayAgentTools({
    tool: (name, description, schema, handler) => {
      const entry = { name, description, schema, handler };
      captured.push(entry);
      return entry;
    },
    visionRelay: {
      recognize,
      recognizeVideo: async () => {
        throw new Error('video not under test here');
      },
      recognizeAudio: async () => ({ content: '', model: '', remainingToday: -1, usage: {} }),
      recognizeVideoAudio: async () => ({ content: '', model: '', remainingToday: -1, usage: {} }),
    },
  });
  return { captured, tools };
}

test('factory registers describe_image and describe_video tools with zod schemas', () => {
  const { captured } = buildTool(async () => ({}));
  assert.equal(captured.length, 3);
  const image = captured.find((t) => t.name === 'describe_image');
  const video = captured.find((t) => t.name === 'describe_video');
  assert.ok(image, 'describe_image registered');
  assert.ok(video, 'describe_video registered');
  const audio = captured.find((t) => t.name === 'describe_audio');
  assert.ok(audio, 'describe_audio registered');
  assert.ok(image.description.length > 100, 'description must follow the tool template');
  assert.ok(image.schema.image_path, 'image_path parameter required');
  assert.ok(video.schema.video_path, 'video_path parameter required');
  assert.ok(audio.schema.audio, 'audio parameter required');
  assert.ok(image.schema.question && video.schema.question, 'question parameter present');
});

test('describe_image and describe_video register on every route (no capability gate)', () => {
  // 2026-09-04 regression: describe_image used to be omitted whenever the
  // session model resolved supportsVision=true, so a misresolved text-only
  // model (uncatalogued glm-5.3-flash defaulting to true) lost the only
  // working vision path. The relay tools must not depend on the session
  // model's multimodality — both register unconditionally now.
  const tools = buildVisionRelayAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    visionRelay: {
      recognize: async () => ({}),
      recognizeVideo: async () => ({}),
      recognizeAudio: async () => ({}),
      recognizeVideoAudio: async () => ({}),
    },
  });
  assert.deepEqual(tools.map((t) => t.name), ['describe_image', 'describe_video', 'describe_audio'],
    'every route keeps both relay vision tools — the catalog never depends on model vision resolution');
});

test('happy path returns the description plus the remaining-quota line', async () => {
  const seen = [];
  const { captured } = buildTool(async (input) => {
    seen.push(input);
    return {
      content: 'a logo reading Cactus Needle',
      model: 'metaid-free-vision',
      remainingToday: 42,
      usage: { promptTokens: 186, completionTokens: 152, totalTokens: 338, imageTokens: 162, estimated: false },
    };
  });

  const result = await captured[0].handler({ image_path: '/tmp/photo.png', question: '图里写了什么？' });

  assert.deepEqual(seen, [{ imagePath: '/tmp/photo.png', prompt: '图里写了什么？' }]);
  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  assert.match(text, /Cactus Needle/);
  assert.match(text, /image reads left today: 42/);
});

test('describe_audio returns transcription text without usage details', async () => {
  const seen = [];
  const { captured } = buildTool(async () => ({}));
  const audio = captured.find((t) => t.name === 'describe_audio');
  audio.handler = async (args) => {
    seen.push(args);
    return { content: [{ type: 'text', text: 'placeholder' }] };
  };
  // The real handler is exercised through a fresh factory so the fake control
  // can capture the exact input shape.
  const calls = [];
  const entries = buildVisionRelayAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    visionRelay: {
      recognize: async () => ({}),
      recognizeVideo: async () => ({}),
      recognizeAudio: async (input) => { calls.push(input); return { content: '完整转写', model: 'metaid-free-audio', remainingToday: 1, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, imageTokens: 0, estimated: true } }; },
      recognizeVideoAudio: async () => ({}),
    },
  });
  const result = await entries.find((t) => t.name === 'describe_audio').handler({ audio: '/tmp/speech.mp3' });
  assert.deepEqual(calls, [{ audioPath: '/tmp/speech.mp3', prompt: undefined }]);
  assert.equal(result.content[0].text, '完整转写');
  assert.equal(result.content[0].text.includes('usage'), false);
});

test('describe_audio extracts a video track when the prompt asks for video speech', async () => {
  const calls = [];
  const entries = buildVisionRelayAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    visionRelay: {
      recognize: async () => ({}),
      recognizeVideo: async () => ({}),
      recognizeAudio: async () => ({}),
      recognizeVideoAudio: async (input) => { calls.push(input); return { content: '字幕文本', model: '', remainingToday: -1, usage: {} }; },
    },
  });
  const result = await entries.find((t) => t.name === 'describe_audio').handler({ audio: '/tmp/clip.mp4', prompt: '识别视频中的语音并生成字幕' });
  assert.deepEqual(calls, [{ videoPath: '/tmp/clip.mp4', prompt: '识别视频中的语音并生成字幕' }]);
  assert.equal(result.content[0].text, '字幕文本');
});

test('relative paths are rejected before any relay call', async () => {
  let calls = 0;
  const { captured } = buildTool(async () => {
    calls += 1;
    return { content: 'x', model: '', remainingToday: -1, usage: {} };
  });

  const result = await captured[0].handler({ image_path: 'photo.png' });

  assert.equal(calls, 0);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ABSOLUTE/);
});

test('quota errors map to actionable tool text', async () => {
  const { captured } = buildTool(async () => {
    const err = new Error('vision relay error: vision daily quota exhausted');
    err.relayMessage = 'vision daily quota exhausted';
    throw err;
  });

  const result = await captured[0].handler({ image_path: '/tmp/photo.png' });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Daily image quota used up/);
  assert.match(result.content[0].text, /resumes tomorrow/);
});

test('unknown relay errors fall through with the original message', async () => {
  const { captured } = buildTool(async () => {
    throw new Error('vision relay error: upstream provider failed, please retry later');
  });

  const result = await captured[0].handler({ image_path: '/tmp/photo.png' });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /upstream provider failed/);
});

test('formatVisionRelayError covers the backend contract strings', () => {
  assert.match(formatVisionRelayError('vision request rate limited'), /rate limited/i);
  assert.match(formatVisionRelayError('request body too large'), /too large/i);
  assert.match(formatVisionRelayError('anything unexpected'), /anything unexpected/);
});
