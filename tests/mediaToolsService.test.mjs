/**
 * Media tools service unit tests: ffmpeg probe parsing, conversion argument
 * building, and a real-ffmpeg integration pass (probe + frame grab +
 * conversion) using the bundled/homebrew binary. Pure functions need no
 * ffmpeg; integration cases skip when none resolves.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = Module.createRequire(import.meta.url);

function loadCompiledModule(modulePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => path.join(process.cwd(), '.cowork-temp', 'media-tools-test-user-data'),
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

const service = loadCompiledModule('../dist-electron/main/services/mediaToolsService.js');
const {
  parseFfmpegProbe,
  parseFfmpegDuration,
  buildMediaConvertArgs,
  probeMediaFile,
  convertMediaFile,
  grabVideoFrame,
  MEDIA_CONVERT_MAX_SECONDS,
} = service;

const VIDEO_PROBE_STDERR = [
  'Input #0, mov,mp4,m4a,3gp,3g2,mj2, from \'in.mp4\':',
  '  Metadata:',
  '    major_brand     : isom',
  '  Duration: 00:00:04.00, start: 0.000000, bitrate: 36 kb/s',
  '    Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 640x360 [SAR 1:1 DAR 16:9], 30 kb/s, 10 fps, 10 tbr, 10240 tbn (default)',
  '    Stream #0:1(und): Audio: aac (LC) (mp4a / 0x6D703461), 44100 Hz, stereo, fltp, 128 kb/s (default)',
].join('\n');

const AUDIO_PROBE_STDERR = [
  "Input #0, mp3, from 'in.mp3':",
  '  Duration: 00:00:02.61, start: 0.000000, bitrate: 63 kb/s',
  "    Stream #0:0: Audio: mp3 (mp3float), 44100 Hz, mono, fltp, 64 kb/s",
].join('\n');

test('parseFfmpegProbe reads video+audio metadata', () => {
  const probe = parseFfmpegProbe(VIDEO_PROBE_STDERR);
  assert.equal(probe.format, 'mov');
  assert.equal(probe.durationSec, 4);
  assert.ok(probe.video);
  assert.equal(probe.video.codec, 'h264');
  assert.equal(probe.video.width, 640);
  assert.equal(probe.video.height, 360);
  assert.equal(probe.video.fps, 10);
  assert.ok(probe.audio);
  assert.equal(probe.audio.codec, 'aac');
  assert.equal(probe.audio.sampleRateHz, 44100);
  assert.equal(probe.audio.channels, 'stereo');
  assert.equal(probe.bitrateKbps, 36);
});

test('parseFfmpegProbe handles audio-only files', () => {
  const probe = parseFfmpegProbe(AUDIO_PROBE_STDERR);
  assert.equal(probe.format, 'mp3');
  assert.ok(!probe.video, 'audio-only files have no video stream');
  assert.ok(probe.audio);
  assert.equal(probe.audio.channels, 'mono');
  assert.ok(Math.abs(probe.durationSec - 2.61) < 0.01);
});

test('parseFfmpegDuration parses h:mm:ss.d and rejects garbage', () => {
  assert.equal(parseFfmpegDuration('Duration: 00:03:25.61'), 205.61);
  assert.equal(parseFfmpegDuration('Duration: 01:00:00.00'), 3600);
  assert.equal(parseFfmpegDuration('nothing'), null);
});

test('buildMediaConvertArgs: mp4 balanced caps width and duration', () => {
  const args = buildMediaConvertArgs({
    inputPath: '/tmp/in.mov',
    outputPath: '/tmp/out.mp4',
    target: 'mp4',
    quality: 'balanced',
    maxSeconds: MEDIA_CONVERT_MAX_SECONDS,
  });
  const joined = args.join(' ');
  assert.ok(joined.includes("scale='min(1280,iw)':-2"));
  assert.equal(args[args.indexOf('-crf') + 1], '28');
  assert.equal(args[args.indexOf('-t') + 1], String(MEDIA_CONVERT_MAX_SECONDS));
  assert.ok(joined.includes('+faststart'));
  assert.ok(args.includes('-c:a'), 'mp4 conversion keeps audio');
});

test('buildMediaConvertArgs: mp3 extracts audio at the preset bitrate, small squeezes', () => {
  const args = buildMediaConvertArgs({
    inputPath: '/tmp/in.mov',
    outputPath: '/tmp/out.mp3',
    target: 'mp3',
    quality: 'small',
    maxSeconds: MEDIA_CONVERT_MAX_SECONDS,
  });
  assert.ok(args.includes('-vn'));
  assert.equal(args[args.indexOf('-b:a') + 1], '64k');
  const mp4Small = buildMediaConvertArgs({
    inputPath: '/tmp/in.mov',
    outputPath: '/tmp/out.mp4',
    target: 'mp4',
    quality: 'small',
    maxSeconds: MEDIA_CONVERT_MAX_SECONDS,
  });
  assert.equal(mp4Small[mp4Small.indexOf('-crf') + 1], '32');
});

test('buildMediaConvertArgs: jpg grabs one frame', () => {
  const args = buildMediaConvertArgs({
    inputPath: '/tmp/in.mov',
    outputPath: '/tmp/out.jpg',
    target: 'jpg',
    quality: 'high',
    maxSeconds: MEDIA_CONVERT_MAX_SECONDS,
  });
  assert.ok(args.includes('-frames:v'));
  assert.equal(args[args.indexOf('-q:v') + 1], '2');
});

// ---------------------------------------------------------------------------
// Real-ffmpeg integration (skips when no binary resolves)
// ---------------------------------------------------------------------------

function ffmpegAvailable() {
  return fs.existsSync('/tmp/test_video_4s.mp4');
}

test('integration: probe a real video file', { timeout: 30_000 }, async (t) => {
  if (!ffmpegAvailable()) {
    t.skip('fixture /tmp/test_video_4s.mp4 not present');
    return;
  }
  try {
    const probe = await probeMediaFile('/tmp/test_video_4s.mp4');
    assert.ok(probe.format, 'container detected');
    assert.ok(probe.video, 'video stream detected');
    assert.ok(Math.abs(probe.durationSec - 4) < 1.5, `duration ~4s, got ${probe.durationSec}`);
    assert.ok(!probe.audio, 'testsrc fixture has no audio');
    assert.ok(probe.fileSizeBytes > 0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ffmpeg (is not available|failed to start)/.test(message)) {
      t.skip(`no local ffmpeg: ${message}`);
      return;
    }
    throw error;
  }
});

test('integration: grab a frame at 1s from a real video', { timeout: 30_000 }, async (t) => {
  if (!ffmpegAvailable()) {
    t.skip('fixture not present');
    return;
  }
  const output = '/tmp/test_video_4s@1_0s.jpg';
  try {
    fs.rmSync(output, { force: true });
    const result = await grabVideoFrame({ videoPath: '/tmp/test_video_4s.mp4', timeSeconds: 1 });
    assert.ok(fs.existsSync(result.outputPath), 'frame file exists');
    assert.ok(result.bytes > 0);
    assert.match(path.basename(result.outputPath), /@1_0s\.jpg$/);
    fs.rmSync(result.outputPath, { force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ffmpeg (is not available|failed to start)/.test(message)) {
      t.skip(`no local ffmpeg: ${message}`);
      return;
    }
    throw error;
  }
});

test('integration: grab beyond duration is rejected with the duration in the message', { timeout: 30_000 }, async (t) => {
  if (!ffmpegAvailable()) {
    t.skip('fixture not present');
    return;
  }
  await assert.rejects(
    () => grabVideoFrame({ videoPath: '/tmp/test_video_4s.mp4', timeSeconds: 99 }),
    /beyond the video duration/,
  );
});

test('integration: convert a real video to mp4 beside the input', { timeout: 120_000 }, async (t) => {
  if (!ffmpegAvailable()) {
    t.skip('fixture not present');
    return;
  }
  try {
    const result = await convertMediaFile({ filePath: '/tmp/test_video_4s.mp4', target: 'mp4', quality: 'small' });
    assert.match(path.basename(result.outputPath), /\.converted\.mp4$/);
    assert.ok(fs.existsSync(result.outputPath));
    assert.ok(result.bytes > 0 && result.bytes < 1024 * 1024, 'small preset keeps a 4s clip tiny');
    fs.rmSync(result.outputPath, { force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ffmpeg (is not available|failed to start)/.test(message)) {
      t.skip(`no local ffmpeg: ${message}`);
      return;
    }
    throw error;
  }
});
