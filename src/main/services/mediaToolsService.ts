/**
 * Generic local-media tools layer on top of the bundled ffmpeg.
 *
 * Owns the ffmpeg executable resolution (env override -> packaged binary ->
 * dev resources -> system PATH), process execution with timeouts, and the
 * three bot-facing operations: probe (media_info), convert (convert_media),
 * and frame extraction (grab_video_frame). The vision relay's recognition
 * transcoder also builds on this layer; recognition-specific argument
 * recipes stay in visionRelayService.
 *
 * Everything here is local-only: no network, no quota, no relay key.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

/** Bundled ffmpeg asset names per platform (scripts/setup-ffmpeg.js). */
const FFMPEG_PLATFORM_ASSETS: Record<string, Record<string, string>> = {
  darwin: { arm64: 'ffmpeg-darwin-arm64', x64: 'ffmpeg-darwin-x64' },
  win32: { x64: 'ffmpeg-win32-x64.exe' },
};

const PROBE_TIMEOUT_MS = 15_000;
const CONVERT_TIMEOUT_MS = 300_000;
const FRAME_TIMEOUT_MS = 60_000;
/** Conversions are capped so a bot cannot burn CPU on feature-length rips. */
export const MEDIA_CONVERT_MAX_SECONDS = 600;

export class MediaToolsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaToolsError';
  }
}

let cachedFfmpegPath: string | null | undefined;

/**
 * Resolve the ffmpeg executable: env override (IDBOTS_FFMPEG_PATH), bundled
 * binary (packaged resourcesPath, then dev project resources), then a system
 * ffmpeg on PATH. Returns 'ffmpeg' as the PATH fallback (never null on
 * known platforms) — spawn failure surfaces a clear error at call time.
 */
export function resolveFfmpegPath(): string | null {
  if (cachedFfmpegPath !== undefined) return cachedFfmpegPath;
  cachedFfmpegPath = null;
  const envPath = (process.env.IDBOTS_FFMPEG_PATH || '').trim();
  if (envPath) {
    cachedFfmpegPath = envPath;
    return cachedFfmpegPath;
  }
  const asset = FFMPEG_PLATFORM_ASSETS[process.platform]?.[process.arch];
  if (!asset) {
    cachedFfmpegPath = 'ffmpeg';
    return cachedFfmpegPath;
  }
  // Packaged app: <resourcesPath>/ffmpeg/<asset> (extraResources)
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  // Dev: project resources/ffmpeg/<asset> (dist-electron/main/services -> root)
  const candidates = [
    ...(resourcesPath ? [path.join(resourcesPath, 'ffmpeg', asset)] : []),
    path.join(__dirname, '..', '..', '..', 'resources', 'ffmpeg', asset),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        cachedFfmpegPath = candidate;
        return cachedFfmpegPath;
      }
    } catch {
      // try next candidate
    }
  }
  // Last resort: system ffmpeg on PATH (dev machines with homebrew etc.)
  cachedFfmpegPath = 'ffmpeg';
  return cachedFfmpegPath;
}

/** Test seam: forget the cached ffmpeg resolution. */
export function resetFfmpegPathCacheForTests(): void {
  cachedFfmpegPath = undefined;
}

/**
 * Run one ffmpeg invocation, capturing stderr. Rejects on timeout or spawn
 * failure; a non-zero exit code resolves normally (callers interpret it —
 * probes exit non-zero by design, conversions treat it as failure).
 */
export function runFfmpegProcess(
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stderr: string }> {
  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) {
    return Promise.reject(new MediaToolsError('ffmpeg is not available'));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new MediaToolsError('ffmpeg operation timed out'));
    }, timeoutMs);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new MediaToolsError(`ffmpeg failed to start: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// Probe (media_info)
// ---------------------------------------------------------------------------

export interface MediaProbeResult {
  /** Container/format name as reported by ffmpeg (e.g. mov, mp3, jpeg_pipe). */
  format: string;
  durationSec: number | null;
  video: { codec: string; width: number; height: number; fps: number | null } | null;
  audio: { codec: string; sampleRateHz: number | null; channels: string | null } | null;
  /** Overall bitrate as printed by ffmpeg, in kb/s. */
  bitrateKbps: number | null;
  fileSizeBytes: number | null;
}

/** Parse the source duration (seconds) out of an `ffmpeg -i` stderr probe. */
export function parseFfmpegDuration(stderr: string): number | null {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/**
 * Parse an `ffmpeg -i` stderr probe into a MediaProbeResult. Pure; exported
 * for tests. Unknown fields stay null rather than guessed.
 */
export function parseFfmpegProbe(stderr: string): Omit<MediaProbeResult, 'fileSizeBytes'> {
  const formatMatch = /Input #0,\s*([A-Za-z0-9_]+)/.exec(stderr);
  const bitrateMatch = /bitrate:\s*(\d+)\s*kb\/s/.exec(stderr);
  // Pixel-format segments may contain commas (e.g. "yuv420p(pc, bt709)"),
  // so the dimension scan runs lazily across the whole Video: line instead of
  // splitting on commas.
  const videoMatch = /Stream #\d+:\d+.*?:\s*Video:\s*([A-Za-z0-9_]+)[^\n]*?(\d{2,5})x(\d{2,5})/.exec(stderr);
  const fpsMatch = /([\d.]+)\s*fps/.exec(stderr);
  const audioMatch = /Stream #\d+:\d+.*?:\s*Audio:\s*([A-Za-z0-9_]+)[^\n]*?(\d+)\s*Hz/.exec(stderr);
  const channelsMatch = /(\d+)\s*Hz,\s*(?:[^,\n]+,\s*)?(mono|stereo|\d+\s*channels)/.exec(stderr);
  return {
    format: formatMatch ? formatMatch[1] : '',
    durationSec: parseFfmpegDuration(stderr),
    video: videoMatch
      ? {
          codec: videoMatch[1],
          width: Number(videoMatch[2]),
          height: Number(videoMatch[3]),
          fps: fpsMatch ? Number(fpsMatch[1]) : null,
        }
      : null,
    audio: audioMatch
      ? {
          codec: audioMatch[1],
          sampleRateHz: Number(audioMatch[2]),
          channels: channelsMatch ? channelsMatch[2].replace(/\s+/g, ' ') : null,
        }
      : null,
    bitrateKbps: bitrateMatch ? Number(bitrateMatch[1]) : null,
  };
}

/** Probe one local media file (any audio/video/image ffmpeg can read). */
export async function probeMediaFile(filePath: string): Promise<MediaProbeResult> {
  let size: number | null = null;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    throw new MediaToolsError(`file not found or unreadable: ${filePath}`);
  }
  // `ffmpeg -i` without an output exits non-zero after printing the header.
  let run: { code: number; stderr: string };
  try {
    run = await runFfmpegProcess(['-hide_banner', '-i', filePath], PROBE_TIMEOUT_MS);
  } catch (error) {
    throw error instanceof MediaToolsError
      ? error
      : new MediaToolsError(`ffmpeg probe failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = parseFfmpegProbe(run.stderr);
  if (!parsed.format && !parsed.video && !parsed.audio) {
    throw new MediaToolsError(
      `could not probe media file (not a recognizable media format?): ${path.basename(filePath)}`,
    );
  }
  return { ...parsed, fileSizeBytes: size };
}

// ---------------------------------------------------------------------------
// Convert (convert_media)
// ---------------------------------------------------------------------------

export type MediaConvertTarget = 'mp4' | 'mp3' | 'jpg';
export type MediaConvertQuality = 'high' | 'balanced' | 'small';

const VIDEO_QUALITY: Record<MediaConvertQuality, { crf: string; maxWidth: number }> = {
  high: { crf: '23', maxWidth: 1920 },
  balanced: { crf: '28', maxWidth: 1280 },
  small: { crf: '32', maxWidth: 854 },
};
const AUDIO_QUALITY: Record<MediaConvertQuality, string> = {
  high: '192k',
  balanced: '128k',
  small: '64k',
};
const JPEG_QUALITY: Record<MediaConvertQuality, string> = {
  high: '2',
  balanced: '4',
  small: '8',
};

/**
 * Build the ffmpeg argument list for one conversion. Pure; exported for
 * tests. Videos are capped at MEDIA_CONVERT_MAX_SECONDS and always
 * faststart; mp3 targets extract/encode the audio track; jpg targets grab
 * the first video frame.
 */
export function buildMediaConvertArgs(input: {
  inputPath: string;
  outputPath: string;
  target: MediaConvertTarget;
  quality: MediaConvertQuality;
  maxSeconds: number;
}): string[] {
  const base = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input.inputPath];
  if (input.target === 'mp4') {
    const profile = VIDEO_QUALITY[input.quality];
    return [
      ...base,
      '-t', String(Math.max(1, Math.floor(input.maxSeconds))),
      '-vf', `scale='min(${profile.maxWidth},iw)':-2`,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', profile.crf,
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', AUDIO_QUALITY[input.quality],
      '-movflags', '+faststart',
      input.outputPath,
    ];
  }
  if (input.target === 'mp3') {
    return [
      ...base,
      '-t', String(Math.max(1, Math.floor(input.maxSeconds))),
      '-vn',
      '-c:a', 'libmp3lame',
      '-b:a', AUDIO_QUALITY[input.quality],
      input.outputPath,
    ];
  }
  // jpg: first frame of a video, or a re-encoded/compressed image
  return [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', input.inputPath,
    '-frames:v', '1',
    '-q:v', JPEG_QUALITY[input.quality],
    input.outputPath,
  ];
}

export interface MediaConvertResult {
  outputPath: string;
  bytes: number;
  durationSec: number | null;
}

/** Convert one local media file to mp4/mp3/jpg beside the input. */
export async function convertMediaFile(input: {
  filePath: string;
  target: MediaConvertTarget;
  quality?: MediaConvertQuality;
}): Promise<MediaConvertResult> {
  const quality = input.quality ?? 'balanced';
  let stat: fs.Stats;
  try {
    stat = fs.statSync(input.filePath);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    throw new MediaToolsError(`file not found or unreadable: ${input.filePath}`);
  }
  let durationSec: number | null = null;
  try {
    const probe = await probeMediaFile(input.filePath);
    durationSec = probe.durationSec;
  } catch {
    durationSec = null; // probe failure is not fatal for images
  }
  const ext = path.extname(input.filePath);
  const stem = path.basename(input.filePath, ext);
  const outputPath = unusedOutputPath(path.join(path.dirname(input.filePath), `${stem}.converted.${input.target}`));
  const args = buildMediaConvertArgs({
    inputPath: input.filePath,
    outputPath,
    target: input.target,
    quality,
    maxSeconds: MEDIA_CONVERT_MAX_SECONDS,
  });
  const run = await runFfmpegProcess(args, CONVERT_TIMEOUT_MS);
  if (run.code !== 0) {
    throw new MediaToolsError(`conversion failed: ${run.stderr.slice(-300)}`);
  }
  let bytes = 0;
  try {
    bytes = fs.statSync(outputPath).size;
  } catch {
    throw new MediaToolsError('conversion produced no output');
  }
  if (bytes === 0) {
    throw new MediaToolsError('conversion produced an empty file');
  }
  const truncated = durationSec != null && durationSec > MEDIA_CONVERT_MAX_SECONDS;
  return { outputPath, bytes, durationSec: truncated ? MEDIA_CONVERT_MAX_SECONDS : durationSec };
}

// ---------------------------------------------------------------------------
// Frame extraction (grab_video_frame)
// ---------------------------------------------------------------------------

export interface MediaFrameResult {
  outputPath: string;
  bytes: number;
}

/** Extract one frame at timeSeconds (default first frame) as jpg/png. */
export async function grabVideoFrame(input: {
  videoPath: string;
  timeSeconds?: number;
  format?: 'jpg' | 'png';
}): Promise<MediaFrameResult> {
  const format = input.format ?? 'jpg';
  const at = Math.max(0, input.timeSeconds ?? 0);
  try {
    const probe = await probeMediaFile(input.videoPath);
    if (!probe.video) {
      throw new MediaToolsError('the file has no video stream');
    }
    if (probe.durationSec != null && at >= probe.durationSec) {
      throw new MediaToolsError(
        `time ${at.toFixed(1)}s is beyond the video duration (${probe.durationSec.toFixed(1)}s)`,
      );
    }
  } catch (error) {
    if (error instanceof MediaToolsError) throw error;
    throw new MediaToolsError(`could not probe video: ${error instanceof Error ? error.message : String(error)}`);
  }
  const ext = path.extname(input.videoPath);
  const stem = path.basename(input.videoPath, ext);
  const safeAt = at.toFixed(1).replace('.', '_');
  const outputPath = unusedOutputPath(
    path.join(path.dirname(input.videoPath), `${stem}@${safeAt}s.${format}`),
  );
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', String(at),
    '-i', input.videoPath,
    '-frames:v', '1',
    ...(format === 'jpg' ? ['-q:v', '3'] : []),
    outputPath,
  ];
  const run = await runFfmpegProcess(args, FRAME_TIMEOUT_MS);
  if (run.code !== 0) {
    throw new MediaToolsError(`frame extraction failed: ${run.stderr.slice(-300)}`);
  }
  let bytes = 0;
  try {
    bytes = fs.statSync(outputPath).size;
  } catch {
    throw new MediaToolsError('frame extraction produced no output');
  }
  return { outputPath, bytes };
}

/** First free path with a numeric suffix, so conversions never overwrite. */
function unusedOutputPath(candidate: string): string {
  if (!fs.existsSync(candidate)) return candidate;
  const parsed = path.parse(candidate);
  for (let i = 2; i < 1000; i += 1) {
    const next = path.join(parsed.dir, `${parsed.name}-${i}${parsed.ext}`);
    if (!fs.existsSync(next)) return next;
  }
  return path.join(parsed.dir, `${parsed.name}-${Date.now()}${parsed.ext}`);
}
