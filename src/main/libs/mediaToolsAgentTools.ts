import path from 'path';
import { z } from 'zod';

/**
 * Control surface the host (main.ts) provides for the local media tools.
 * Backed by mediaToolsService (bundled ffmpeg) — probe / convert / frame
 * extraction, all local-only: no network, no relay key, no quota.
 */
export type MediaToolsControl = {
  probe(filePath: string): Promise<{
    format: string;
    durationSec: number | null;
    video: { codec: string; width: number; height: number; fps: number | null } | null;
    audio: { codec: string; sampleRateHz: number | null; channels: string | null } | null;
    bitrateKbps: number | null;
    fileSizeBytes: number | null;
  }>;
  convert(input: {
    filePath: string;
    target: 'mp4' | 'mp3' | 'jpg';
    quality?: 'high' | 'balanced' | 'small';
  }): Promise<{ outputPath: string; bytes: number; durationSec: number | null }>;
  grabFrame(input: {
    videoPath: string;
    timeSeconds?: number;
    format?: 'jpg' | 'png';
  }): Promise<{ outputPath: string; bytes: number }>;
};

/** Minimal shape of the claude-agent-sdk tool() helper we depend on. */
type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
) => unknown;

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function requireAbsolutePath(toolName: string, fieldName: string, filePath: string): string | null {
  if (!filePath) {
    return `${toolName} requires \`${fieldName}\` (an absolute local path).`;
  }
  if (!path.isAbsolute(filePath)) {
    return `${toolName} requires an ABSOLUTE file path. Received a relative path: "${filePath}". Resolve it to an absolute path first.`;
  }
  return null;
}

function formatDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return 'unknown';
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatBytes(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes)) return '';
  const MIB = 1024 * 1024;
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} bytes`;
}

/** Human-readable probe sheet; exposed for tests. */
export function formatMediaProbe(probe: Awaited<ReturnType<MediaToolsControl['probe']>>): string {
  const lines = [`- format: ${probe.format || 'unknown'}`];
  lines.push(`- duration: ${formatDuration(probe.durationSec)}`);
  if (probe.video) {
    lines.push(
      `- video: ${probe.video.codec} ${probe.video.width}x${probe.video.height}` +
        (probe.video.fps != null ? ` @ ${probe.video.fps} fps` : ''),
    );
  }
  if (probe.audio) {
    lines.push(
      `- audio: ${probe.audio.codec}` +
        (probe.audio.sampleRateHz ? ` ${probe.audio.sampleRateHz} Hz` : '') +
        (probe.audio.channels ? ` ${probe.audio.channels}` : ''),
    );
  } else {
    lines.push('- audio: none');
  }
  if (probe.bitrateKbps != null) lines.push(`- bitrate: ${probe.bitrateKbps} kb/s`);
  if (probe.fileSizeBytes != null) lines.push(`- size: ${formatBytes(probe.fileSizeBytes)}`);
  return lines.join('\n');
}

/**
 * Inline MCP tools over the bundled ffmpeg: media_info (local probe),
 * convert_media (mp4/mp3/jpg conversion beside the input), grab_video_frame
 * (extract one frame as an image file). Registered for every cowork surface
 * when the host provides MediaToolsControl (see coworkRunner).
 */
export function buildMediaToolsAgentTools(deps: {
  tool: SdkToolFactory;
  media: MediaToolsControl;
}): unknown[] {
  const { tool, media } = deps;

  const mediaInfo = tool(
    'media_info',
    [
      'Inspect ONE local media file (audio/video/image) and return its metadata: container format, duration, video codec/resolution/fps, audio codec/sample rate/channels, bitrate, and file size. Fully local — instant, free, uses no image-reading quota.',
      'Use when the user asks basic questions about a media file ("how long is this video?", "what resolution?", "does it have sound?", "what format is this?"), or before spending describe_image/describe_video quota — probe first when only metadata is needed.',
      'When NOT to use: when the user asks what a file SHOWS or SAYS, use describe_image / describe_video instead; do not use it for plain text/code files (use your file tools).',
      'Rules: pass the absolute local path only (copy it from the attachment info); no file contents.',
      'Returns a metadata sheet as plain text.',
    ].join(' '),
    {
      file_path: z.string().min(1).describe('Absolute local path to the media file.'),
    },
    async (args: { file_path: string }) => {
      const filePath = asString(args.file_path);
      const invalid = requireAbsolutePath('media_info', 'file_path', filePath);
      if (invalid) return textResult(invalid, true);
      try {
        const probe = await media.probe(filePath);
        return textResult(formatMediaProbe(probe));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult(`media_info failed: ${message}`, true);
      }
    }
  );

  const convertMedia = tool(
    'convert_media',
    [
      'Convert ONE local media file with the bundled ffmpeg and return the absolute path of the new file (written beside the input, never overwriting it). Targets: mp4 (any video, H.264, audio kept), mp3 (audio track extracted/encoded), jpg (first video frame or a re-encoded image). Quality presets: high / balanced (default) / small.',
      'Use when the user asks to convert or compress a file ("转成 mp4", "compress this video", "make it smaller", "extract the audio as mp3"), or before uploading a file that needs a more portable/smaller format (chain with upload_file).',
      'When NOT to use: do not convert files the user did not ask to change; do not use it to READ content (describe_image/describe_video); one conversion per call — no batch processing.',
      `Rules: absolute input path only; output lands in the same directory as <name>.converted.<ext>; videos longer than 10 minutes are cut at 10 minutes; oversized conversions time out.`,
      'Returns the output absolute path plus size and duration, or a clear error.',
    ].join(' '),
    {
      file_path: z.string().min(1).describe('Absolute local path to the source media file.'),
      target_format: z.enum(['mp4', 'mp3', 'jpg']).describe('Output format.'),
      quality: z
        .enum(['high', 'balanced', 'small'])
        .optional()
        .describe('Size/quality preset; default balanced (small = most compression).'),
    },
    async (args: { file_path: string; target_format: 'mp4' | 'mp3' | 'jpg'; quality?: 'high' | 'balanced' | 'small' }) => {
      const filePath = asString(args.file_path);
      const invalid = requireAbsolutePath('convert_media', 'file_path', filePath);
      if (invalid) return textResult(invalid, true);
      try {
        const result = await media.convert({ filePath, target: args.target_format, quality: args.quality });
        const lines = [
          `Converted to ${args.target_format}.`,
          `- output: ${result.outputPath}`,
          `- size: ${formatBytes(result.bytes)}`,
        ];
        if (result.durationSec != null) lines.push(`- duration: ${formatDuration(result.durationSec)}`);
        return textResult(lines.join('\n'));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult(`convert_media failed: ${message}`, true);
      }
    }
  );

  const grabVideoFrame = tool(
    'grab_video_frame',
    [
      'Extract ONE frame from a local video as an image file (jpg by default, png optional) and return its absolute path. Fully local and free — it does not use the image-reading quota.',
      'Use when the user wants a specific moment as a still ("截图第30秒", "grab the frame at 0:45"), or to capture a frame cheaply before deciding whether to spend describe_image quota on it (describe the extracted frame with describe_image afterwards).',
      'When NOT to use: when the user asks what the WHOLE video shows, use describe_video instead; do not grab many frames one by one when a summary suffices.',
      'Rules: absolute video path only; time must be within the video duration; output lands beside the input as <name>@<t>s.jpg and never overwrites.',
      'Returns the output absolute path and size.',
    ].join(' '),
    {
      video_path: z.string().min(1).describe('Absolute local path to the video file.'),
      time_seconds: z
        .number()
        .min(0)
        .optional()
        .describe('Position to grab (seconds from the start); default 0 = first frame.'),
      format: z.enum(['jpg', 'png']).optional().describe('Output image format; default jpg.'),
    },
    async (args: { video_path: string; time_seconds?: number; format?: 'jpg' | 'png' }) => {
      const videoPath = asString(args.video_path);
      const invalid = requireAbsolutePath('grab_video_frame', 'video_path', videoPath);
      if (invalid) return textResult(invalid, true);
      try {
        const result = await media.grabFrame({
          videoPath,
          timeSeconds: args.time_seconds,
          format: args.format,
        });
        return textResult(
          ['Frame extracted.', `- output: ${result.outputPath}`, `- size: ${formatBytes(result.bytes)}`].join('\n'),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult(`grab_video_frame failed: ${message}`, true);
      }
    }
  );

  return [mediaInfo, convertMedia, grabVideoFrame];
}
