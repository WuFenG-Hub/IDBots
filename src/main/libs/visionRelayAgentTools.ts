import path from 'path';
import { z } from 'zod';

/**
 * Control surface the host (main.ts) provides for the describe_image tool.
 * Backed by recognizeImageViaRelay() in services/visionRelayService.ts — the
 * assist-base-service vision relay (qwen3.5-flash upstream) with per-identity
 * daily image quota. No routing logic lives here.
 */
export type VisionRelayControl = {
  recognize(input: {
    imagePath?: string;
    imageBase64?: string;
    mimeType?: string;
    prompt?: string;
  }): Promise<{
    content: string;
    model: string;
    remainingToday: number;
    usage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      imageTokens: number;
      estimated: boolean;
    };
  }>;
  /** Video path: transcodes locally (bundled ffmpeg) then relays as video/mp4. */
  recognizeVideo(input: {
    videoPath?: string;
    videoBase64?: string;
    prompt?: string;
  }): Promise<{
    content: string;
    model: string;
    remainingToday: number;
    truncated: boolean;
    durationSec: number | null;
    usage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      imageTokens: number;
      estimated: boolean;
    };
  }>;
  recognizeAudio(input: {
    audioPath?: string;
    audioUrl?: string;
    audioBase64?: string;
    mimeType?: string;
    prompt?: string;
  }): Promise<{
    content: string;
    model: string;
    remainingToday: number;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number; imageTokens: number; estimated: boolean };
  }>;
  recognizeVideoAudio(input: { videoPath: string; prompt?: string }): ReturnType<VisionRelayControl['recognizeAudio']>;
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

/**
 * Map relay errors to actionable tool text. Server messages are the stable
 * strings of the backend error contract (LLM 视觉识别中继接口.md §二).
 */
export function formatVisionRelayError(message: string): string {
  switch (message) {
    case 'vision daily quota exhausted':
      return 'Daily image quota used up. The image was NOT read; tell the user image reading resumes tomorrow (or they can switch to a multimodal model).';
    case 'vision request rate limited':
      return 'Image reading is rate limited. Wait about a minute, then retry with the same path.';
    case 'vision daily budget exhausted, try again tomorrow':
      return 'The shared image-reading service hit its daily budget. The image was NOT read; tell the user to try again tomorrow.';
    case 'imageBase64 or imageUrl is required':
    case 'image payload is invalid':
      return 'The image file could not be encoded for the vision service. Verify the path points to a real image (jpeg/png/webp/gif).';
    case 'request body too large':
      return 'The image is too large even after compression. Use a smaller image.';
    case 'vision relay is disabled':
    case 'no vision model configured':
      return 'The image-reading service is not available right now. The image was NOT read.';
    case 'relay key invalid or revoked':
      return 'The image-reading credential was rejected and could not be renewed. The image was NOT read.';
    default:
      return `Image reading failed: ${message}`;
  }
}

export function formatAudioRelayError(message: string): string {
  switch (message) {
    case 'vision daily quota exhausted': return 'Daily audio transcription quota used up. Try again tomorrow.';
    case 'vision request rate limited': return 'Audio transcription is rate limited. Wait briefly, then retry.';
    case 'audio payload is invalid':
    case 'audioBase64 or audioUrl is required': return 'The audio format, base64 payload, or public URL is invalid.';
    case 'request body too large': return 'The audio is too large. Compress it or shorten it, then retry.';
    case 'vision relay is disabled':
    case 'no vision model configured': return 'The audio transcription service is temporarily unavailable.';
    case 'relay key invalid or revoked': return 'The audio transcription credential was rejected and could not be renewed.';
    case 'upstream provider failed, please retry later': return 'The audio transcription provider failed. Please retry later.';
    default: return `Audio transcription failed: ${message}`;
  }
}

/**
 * Inline MCP tools that describe local media through the IDBots vision
 * relay. Registered for every cowork surface when the host provides
 * VisionRelayControl (see coworkRunner). Works regardless of whether the
 * session's model is multimodal — the relay's VLM reads the media and the
 * tool returns plain text, so non-vision models (e.g. the DeepSeek V4 family)
 * gain media understanding without base64 ever entering the session.
 *
 * Both tools register on EVERY model route. describe_image was briefly gated
 * off for vision-capable sessions ("native image blocks are better"), which
 * made the whole vision capability hinge on the model-limits table being
 * right: when an uncatalogued text-only model (glm-5.3-flash, 2026-09-04)
 * defaulted to supportsVision=true, the catalog lost describe_image while
 * the route could not actually carry images. The relay path is the
 * route-independent guarantee; native image blocks remain available as an
 * additional path on vision routes.
 */
export function buildVisionRelayAgentTools(deps: {
  tool: SdkToolFactory;
  visionRelay: VisionRelayControl;
}): unknown[] {
  const { tool, visionRelay } = deps;

  const describeImage = tool(
    'describe_image',
    [
      'Read ONE local image via the IDBots vision relay: returns a description plus OCR of all visible text. Pass only the absolute local path, never file contents; works for non-vision models.',
      'Use when the user shares an image (attachment line "[附件信息] 路径: <path>") and asks about it. Not for upload/move-only tasks (use file tools); never twice on the same unchanged path per turn.',
      'Omit `question` for the default full description + OCR. jpeg/png/webp/gif; oversized rejected; daily quota applies. Result includes remaining reads today.',
    ].join(' '),
    {
      image_path: z
        .string()
        .min(1)
        .describe('Absolute local path to the image file (copy it from the attachment info or the user message). Relative paths are rejected.'),
      question: z
        .string()
        .optional()
        .describe('Optional question about the image; omit for the default full description + OCR of all visible text.'),
    },
    async (args: { image_path: string; question?: string }) => {
      const imagePath = asString(args.image_path);
      if (!imagePath) {
        return textResult('describe_image requires `image_path` (an absolute local path).', true);
      }
      if (!path.isAbsolute(imagePath)) {
        return textResult(
          `describe_image requires an ABSOLUTE file path. Received a relative path: "${imagePath}". Resolve it to an absolute path first.`,
          true,
        );
      }

      try {
        const result = await visionRelay.recognize({
          imagePath,
          prompt: asString(args.question) || undefined,
        });
        const lines = [result.content];
        if (typeof result.remainingToday === 'number' && result.remainingToday >= 0) {
          lines.push(`(image reads left today: ${result.remainingToday})`);
        }
        return textResult(lines.join('\n'));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Errors carry the backend's stable message; unwrap the
        // "vision relay error: <stable>" transport prefix when present.
        const stable = message.startsWith('vision relay error: ')
          ? message.slice('vision relay error: '.length)
          : message;
        return textResult(formatVisionRelayError(stable), true);
      }
    }
  );

  const describeVideo = tool(
    'describe_video',
    [
      'Watch ONE local video via the IDBots vision relay: returns a summary, timeline, and visible frame text. Pass only the absolute local path, never file contents; works for non-vision models.',
      'Use when the user shares a video (attachment line "[附件信息] 类型: video, 路径: <path>") and asks what happens in it. Not for upload/move-only tasks (use file tools); never twice on the same unchanged path per turn.',
      'Omit `question` for the default full description. Clips over ~3 minutes are truncated to the first 3; very large videos may fail; each call costs 5× the daily image quota.',
    ].join(' '),
    {
      video_path: z
        .string()
        .min(1)
        .describe('Absolute local path to the video file (copy it from the attachment info or the user message). Relative paths are rejected.'),
      question: z
        .string()
        .optional()
        .describe('Optional question about the video; omit for the default full description.'),
    },
    async (args: { video_path: string; question?: string }) => {
      const videoPath = asString(args.video_path);
      if (!videoPath) {
        return textResult('describe_video requires `video_path` (an absolute local path).', true);
      }
      if (!path.isAbsolute(videoPath)) {
        return textResult(
          `describe_video requires an ABSOLUTE file path. Received a relative path: "${videoPath}". Resolve it to an absolute path first.`,
          true,
        );
      }

      try {
        const result = await visionRelay.recognizeVideo({
          videoPath,
          prompt: asString(args.question) || undefined,
        });
        const lines = [result.content];
        if (result.truncated) {
          lines.push('(note: the source video exceeded 3 minutes; only the first 3 minutes were analyzed)');
        }
        if (typeof result.remainingToday === 'number' && result.remainingToday >= 0) {
          lines.push(`(image-read quota units left today: ${result.remainingToday})`);
        }
        return textResult(lines.join('\n'));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stable = message.startsWith('vision relay error: ')
          ? message.slice('vision relay error: '.length)
          : message;
        return textResult(formatVisionRelayError(stable), true);
      }
    }
  );

  const describeAudio = tool(
    'describe_audio',
    [
      'Transcribe ONE audio file or stable public audio URL through the IDBots speech-recognition relay. Returns complete transcription in the original language with punctuation; works for voice messages, recordings, and audio extracted from video.',
      'Pass `audio` as an absolute local path, a public http/https URL, or a data/base64 audio reference. Do not summarize unless the user asks in `prompt`.',
      'Supported formats: wav, mp3, m4a, ogg, webm. For an `.mp4` video path, the host extracts its audio track first; no SRT/VTT timestamps are generated.',
    ].join(' '),
    {
      audio: z.string().min(1).describe('Absolute local audio path, public http/https audio URL, or base64/data audio reference.'),
      prompt: z.string().optional().describe('Optional transcription instruction; default preserves original language, punctuation, and spoken content without summarizing.'),
    },
    async (args: { audio: string; prompt?: string }) => {
      const audio = asString(args.audio);
      if (!audio) return textResult('describe_audio requires `audio`.', true);
      try {
        const isUrl = /^https?:\/\//i.test(audio);
        const isData = /^data:audio\//i.test(audio);
        const asksForVideoAudio = /视频|video|subtitle|字幕/i.test(asString(args.prompt));
        const isVideoPath = path.isAbsolute(audio) && /\.(mp4|mov|mkv|avi|webm)$/i.test(audio) && asksForVideoAudio;
        const result = isUrl
          ? await visionRelay.recognizeAudio({ audioUrl: audio, prompt: asString(args.prompt) || undefined })
          : isData
            ? await visionRelay.recognizeAudio({ audioBase64: audio, prompt: asString(args.prompt) || undefined })
            : isVideoPath
              ? await visionRelay.recognizeVideoAudio({ videoPath: audio, prompt: asString(args.prompt) || undefined })
              : !path.isAbsolute(audio)
                ? (() => { throw new Error(`describe_audio requires an ABSOLUTE file path or public URL. Received: "${audio}"`); })()
                : await visionRelay.recognizeAudio({ audioPath: audio, prompt: asString(args.prompt) || undefined });
        return textResult(result.content);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stable = message.startsWith('vision relay error: ')
          ? message.slice('vision relay error: '.length)
          : message;
        return textResult(formatAudioRelayError(stable), true);
      }
    },
  );

  return [describeImage, describeVideo, describeAudio];
}
