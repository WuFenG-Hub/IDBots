import path from 'path';
import { z } from 'zod';

/** Upload result produced by uploadMetaFile (see services/metaFileUploadShared.js buildUploadSuccessPayload). */
export type MetaFileUploadResult = Record<string, unknown>;

/**
 * Control surface the host (main.ts) provides for the upload_file tool. Backed
 * by uploadMetaFile() in services/metaFileUploadService.ts — the same function
 * the RPC endpoint and several IPC handlers call. The service already decides
 * direct vs chunked mode (5 MiB threshold), resolves network/contentType, and
 * runs MVC sponsor-first direct upload with a self-paid fallback when the
 * sponsor balance is insufficient. No routing logic lives here.
 */
export type MetaFileUploadControl = {
  upload(params: {
    metabotId: number;
    filePath?: string;
    contentType?: string;
    network?: string;
    verify?: boolean;
  }): Promise<MetaFileUploadResult>;
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

function formatBytes(bytes: unknown): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return String(bytes ?? '');
  const MIB = 1024 * 1024;
  if (n >= MIB) return `${(n / MIB).toFixed(2)} MiB (${n} bytes)`;
  const KIB = 1024;
  if (n >= KIB) return `${(n / KIB).toFixed(1)} KiB (${n} bytes)`;
  return `${n} bytes`;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Human-readable success sheet mirroring the retired metabot-upload-file skill's
 * "Success Result" section. Exposed for tests.
 */
export function formatUploadResult(result: MetaFileUploadResult): string {
  const lines: string[] = ['File uploaded to MetaWeb.'];

  const metafileUri = asString(result.metafileUri);
  const pinId = asString(result.pinId);
  if (metafileUri) lines.push(`- metafile URI: ${metafileUri}`);
  if (pinId) lines.push(`- pinId: ${pinId}`);

  const metawebUrl = asString(result.metawebUrl);
  if (metawebUrl) lines.push(`- share link (for other people): ${metawebUrl}`);
  const previewUrl = asString(result.previewUrl);
  if (previewUrl) lines.push(`- preview URL: ${previewUrl}`);
  const downloadUrl = asString(result.downloadUrl);
  if (downloadUrl) lines.push(`- download URL: ${downloadUrl}`);

  const fileName = asString(result.fileName);
  if (fileName) lines.push(`- file: ${fileName}`);
  const sizeStr = formatBytes(result.size ?? result.bytes);
  if (sizeStr) lines.push(`- size: ${sizeStr}`);
  const contentType = asString(result.contentType);
  if (contentType) lines.push(`- content type: ${contentType}`);

  const uploadMode = asString(result.uploadMode);
  if (uploadMode) lines.push(`- upload mode: ${uploadMode}`);
  const network = asString(result.network);
  if (network) lines.push(`- network: ${network}`);

  // feeAssist records how the direct MVC upload was paid for. `used: true`
  // means the sponsor covered it; `attempted && !used` means the sponsor link
  // was down or the balance/traffic was insufficient, so the service fell back
  // to the bot's own wallet. Surface both so the bot/user knows the payment
  // path and any degradation.
  const feeAssist = result.feeAssist;
  if (feeAssist != null && typeof feeAssist === 'object') {
    const fa = feeAssist as Record<string, unknown>;
    if (fa.used === true) {
      lines.push('- sponsor: applied (MVC sponsor covered this direct upload)');
    } else if (fa.attempted === true) {
      const reason = asString(fa.reason) || 'unknown';
      const stage = asString(fa.stage);
      lines.push(
        `- sponsor: unavailable, fell back to the bot's own wallet (reason: ${reason}${stage ? ` at ${stage}` : ''})`,
      );
    }
  }

  const txids = Array.isArray(result.txids) ? result.txids.filter(Boolean) : [];
  if (txids.length) lines.push(`- txids: ${txids.join(', ')}`);

  const verification = result.verification;
  if (verification != null && typeof verification === 'object') {
    const v = verification as Record<string, unknown>;
    if (v.ok === true) {
      lines.push(`- verification: available at ${asString(v.url) || 'the resolved URL'}`);
    } else {
      lines.push(`- verification: ${asString(v.error) || 'not available yet'}`);
    }
  }

  return lines.join('\n');
}

/**
 * Inline MCP tool that uploads one local file to MetaWeb. Registered for every
 * cowork surface when the host provides MetaFileUploadControl (see coworkRunner).
 * Replaces the external metabot-upload-file skill; the on-chain semantics
 * (direct/chunked, MVC sponsor-first with self-paid fallback, network selection,
 * verification) are owned by uploadMetaFile() and unchanged.
 */
export function buildMetaFileUploadAgentTools(deps: {
  tool: SdkToolFactory;
  upload: MetaFileUploadControl['upload'];
  sessionId: string;
  resolveMetabotId: (sessionId: string) => number | undefined;
}): unknown[] {
  const { tool, upload, sessionId, resolveMetabotId } = deps;

  const uploadFile = tool(
    'upload_file',
    [
      'Upload ONE local file to MetaWeb and return its metafile:// URI plus preview, download, and share links. The runtime streams bytes from disk — never pass file contents, only the absolute local path.',
      'Use when the user asks the local MetaBot/Bot to upload a file, or a downstream step (buzz attachment, service icon/document, MetaApp asset, A2A delivery artifact) needs a metafile:// URI.',
      'When NOT to use: do not upload files the user did not ask to publish on-chain (uploads are permanent and publicly readable); do not use this for plain local file reads/writes (use your file tools); and never pass file contents into the tool — only the absolute local path.',
      'Routing is automatic: direct upload at or below 5 MiB, chunked upload above 5 MiB (MVC-only). For eligible direct MVC uploads the sponsor link is tried first and falls back to the bot\'s own on-chain wallet when the sponsor balance is insufficient — the user does not choose.',
      'Limits: 50 MiB hard cap; DOGE is unsupported; BTC/OPCAT are direct-only (below 5 MiB). Pass `network` only when the human explicitly names a chain; omit it otherwise.',
      'Returns pinId, metafileUri, metawebUrl (share link for other people), preview/download URLs, size, content type, upload mode, and verification status when requested.',
    ].join(' '),
    {
      file_path: z
        .string()
        .min(1)
        .describe('Absolute local path to the file to upload. Relative paths are rejected.'),
      content_type: z
        .string()
        .optional()
        .describe('MIME type when known; omit to let the runtime infer it from the file name.'),
      network: z
        .enum(['mvc', 'btc', 'opcat'])
        .optional()
        .describe('Chain override. Omit unless the human explicitly asks for a specific chain. DOGE is unsupported.'),
      verify: z
        .boolean()
        .optional()
        .describe('Request post-upload availability verification when supported by the runtime.'),
    },
    async (args: {
      file_path: string;
      content_type?: string;
      network?: 'mvc' | 'btc' | 'opcat';
      verify?: boolean;
    }) => {
      const filePath = asString(args.file_path);
      if (!filePath) {
        return textResult('upload_file requires `file_path` (an absolute local path).', true);
      }
      if (!path.isAbsolute(filePath)) {
        return textResult(
          `upload_file requires an ABSOLUTE file path. Received a relative path: "${filePath}". Resolve it to an absolute path first.`,
          true,
        );
      }

      const metabotId = resolveMetabotId(sessionId);
      if (metabotId == null) {
        return textResult(
          'upload_file could not determine which MetaBot owns this session, so there is no wallet/identity to upload with. Ask the user which MetaBot should perform the upload.',
          true,
        );
      }

      try {
        const result = await upload({
          metabotId,
          filePath,
          contentType: asString(args.content_type) || undefined,
          network: args.network,
          verify: args.verify === true,
        });
        return textResult(formatUploadResult(result));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // Hard sponsor failures (pre_rejected / commit_failed) carry structured
        // feeAssist diagnostics on error.data. Surface the reason/stage so the
        // bot gets a clear, actionable failure instead of a bare message.
        const feeAssist = (error as { data?: { feeAssist?: Record<string, unknown> } } | null)
          ?.data?.feeAssist;
        const reason = feeAssist && typeof feeAssist === 'object' ? asString(feeAssist.reason) : '';
        const stage = feeAssist && typeof feeAssist === 'object' ? asString(feeAssist.stage) : '';
        const detail = reason
          ? ` (sponsor ${stage ? `${stage} ` : ''}${reason}; not retried via the self-paid wallet)`
          : '';
        return textResult(`File upload failed: ${msg}${detail}`, true);
      }
    }
  );

  return [uploadFile];
}
