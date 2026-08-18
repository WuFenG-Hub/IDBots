/**
 * Media tools agent-tool unit tests: factory contract (three tools), absolute
 * path validation, result formatting, and error surfacing. Uses a captured
 * fake tool() factory; no SDK, no ffmpeg, no network.
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
          getPath: () => path.join(process.cwd(), '.cowork-temp', 'media-agent-tools-test-user-data'),
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

const { buildMediaToolsAgentTools, formatMediaProbe } = loadCompiledModule(
  '../dist-electron/main/libs/mediaToolsAgentTools.js',
);

function buildTools(overrides = {}) {
  const captured = [];
  const calls = { probe: [], convert: [], grabFrame: [] };
  buildMediaToolsAgentTools({
    tool: (name, description, schema, handler) => {
      const entry = { name, description, schema, handler };
      captured.push(entry);
      return entry;
    },
    media: {
      probe: async (filePath) => {
        calls.probe.push(filePath);
        return (
          overrides.probe?.(filePath) ?? {
            format: 'mov',
            durationSec: 42.5,
            video: { codec: 'h264', width: 1920, height: 1080, fps: 30 },
            audio: { codec: 'aac', sampleRateHz: 44100, channels: 'stereo' },
            bitrateKbps: 3500,
            fileSizeBytes: 18 * 1024 * 1024,
          }
        );
      },
      convert: async (input) => {
        calls.convert.push(input);
        return overrides.convert?.(input) ?? { outputPath: '/tmp/x.converted.mp4', bytes: 2048, durationSec: 42 };
      },
      grabFrame: async (input) => {
        calls.grabFrame.push(input);
        return overrides.grabFrame?.(input) ?? { outputPath: '/tmp/x@1_0s.jpg', bytes: 1024 };
      },
    },
  });
  return { captured, calls };
}

const byName = (captured, name) => captured.find((t) => t.name === name);

test('factory registers media_info, convert_media, grab_video_frame', () => {
  const { captured } = buildTools();
  assert.equal(captured.length, 3);
  for (const name of ['media_info', 'convert_media', 'grab_video_frame']) {
    const tool = byName(captured, name);
    assert.ok(tool, `${name} registered`);
    assert.ok(tool.description.length > 100, `${name} description follows the tool template`);
  }
  assert.ok(byName(captured, 'convert_media').schema.target_format, 'target_format parameter present');
  assert.ok(byName(captured, 'grab_video_frame').schema.time_seconds, 'time_seconds parameter present');
});

test('media_info returns a formatted sheet and passes the path through', async () => {
  const { captured, calls } = buildTools();
  const result = await byName(captured, 'media_info').handler({ file_path: '/tmp/clip.mov' });
  assert.deepEqual(calls.probe, ['/tmp/clip.mov']);
  const text = result.content[0].text;
  assert.match(text, /format: mov/);
  assert.match(text, /h264 1920x1080 @ 30 fps/);
  assert.match(text, /aac 44100 Hz stereo/);
  assert.match(text, /0m 43s|43s/);
  assert.match(text, /17\.17 MiB|18/);
});

test('audio-less probes print "audio: none"', () => {
  const sheet = formatMediaProbe({
    format: 'mp3',
    durationSec: 2.6,
    video: null,
    audio: null,
    bitrateKbps: 64,
    fileSizeBytes: 20817,
  });
  assert.match(sheet, /audio: none/);
});

test('all three tools reject relative paths before any work', async () => {
  const { captured, calls } = buildTools();
  const results = await Promise.all([
    byName(captured, 'media_info').handler({ file_path: 'clip.mov' }),
    byName(captured, 'convert_media').handler({ file_path: 'clip.mov', target_format: 'mp4' }),
    byName(captured, 'grab_video_frame').handler({ video_path: 'clip.mov' }),
  ]);
  for (const result of results) {
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /ABSOLUTE/);
  }
  assert.equal(calls.probe.length + calls.convert.length + calls.grabFrame.length, 0);
});

test('convert_media surfaces the output path for upload chaining', async () => {
  const { captured, calls } = buildTools();
  const result = await byName(captured, 'convert_media').handler({
    file_path: '/tmp/big.mov',
    target_format: 'mp4',
    quality: 'small',
  });
  assert.deepEqual(calls.convert, [{ filePath: '/tmp/big.mov', target: 'mp4', quality: 'small' }]);
  const text = result.content[0].text;
  assert.match(text, /\/tmp\/x\.converted\.mp4/);
  assert.match(text, /2\.0 KiB|2048/);
  assert.match(text, /42s|0m 42s/);
});

test('service errors surface as tool errors with the message', async () => {
  const { captured } = buildTools({
    grabFrame: async () => {
      throw new Error('time 99.0s is beyond the video duration (4.0s)');
    },
  });
  const result = await byName(captured, 'grab_video_frame').handler({ video_path: '/tmp/v.mp4', time_seconds: 99 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /beyond the video duration/);
});

test('grab_video_frame forwards time and format', async () => {
  const { captured, calls } = buildTools();
  await byName(captured, 'grab_video_frame').handler({ video_path: '/tmp/v.mp4', time_seconds: 30, format: 'png' });
  assert.deepEqual(calls.grabFrame, [{ videoPath: '/tmp/v.mp4', timeSeconds: 30, format: 'png' }]);
});
