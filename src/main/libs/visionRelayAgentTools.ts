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

/**
 * Inline MCP tool that describes one local image through the IDBots vision
 * relay. Registered for every cowork surface when the host provides
 * VisionRelayControl (see coworkRunner). Works regardless of whether the
 * session's model is multimodal — the relay's VLM reads the image and the
 * tool returns plain text, so non-vision models (e.g. the DeepSeek V4 family)
 * gain image understanding without base64 ever entering the session.
 */
export function buildVisionRelayAgentTools(deps: {
  tool: SdkToolFactory;
  visionRelay: VisionRelayControl;
}): unknown[] {
  const { tool, visionRelay } = deps;

  const describeImage = tool(
    'describe_image',
    [
      'Read ONE local image file and return what it shows: a detailed description plus every piece of text visible in the image (OCR), as plain text. The runtime sends the file to the IDBots vision relay — never pass image contents, only the absolute local path.',
      'Use when the user shares an image (chat attachments arrive as "[附件信息] 路径: <path>" lines) and asks what is in it, what text it contains, or anything requiring the image content. Works even when your own model cannot see images.',
      'When NOT to use: do not use it for image files the user only asked to upload or move (use the file tools); do not call it twice on the same unchanged path in one turn; and never pass file contents into the tool — only the absolute local path.',
      'Pass `question` only when the user asks something specific about the image; omit it to get the default full description + OCR.',
      'Limits: one image per call; jpeg/png/webp/gif; oversized files are rejected. Daily quota per user applies — reading the same path repeatedly wastes it.',
      'Returns the image description/answer text, the remaining reads today, and token usage metadata.',
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

  return [describeImage];
}
