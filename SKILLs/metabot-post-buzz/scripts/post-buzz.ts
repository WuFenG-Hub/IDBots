#!/usr/bin/env node
/**
 * IDBots metabot-post-buzz: Send SimpleBuzz to MetaWeb via local RPC gateway.
 * Supports text-only buzz and buzz with file attachments (images, documents, etc.).
 *
 * Requires: Node.js 18+ (for fetch). Env: IDBOTS_METABOT_ID (required), IDBOTS_RPC_URL (optional).
 *
 * Usage:
 *   node post-buzz.js --request-file <request.json> [--content "<content>"] [--attachment <file-or-metafile-uri>]... [--content-type "<mime>"] [--network mvc|doge|btc]
 */

import { parseArgs } from 'util';
import fs from 'fs';
import pathMod from 'path';

const RPC_BASE = (process.env.IDBOTS_RPC_URL || 'http://127.0.0.1:31200').replace(/\/+$/, '');
const RPC_TOKEN = process.env.IDBOTS_RPC_TOKEN || '';
function rpcHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (RPC_TOKEN) headers.Authorization = `Bearer ${RPC_TOKEN}`;
  return headers;
}
const CREATE_PIN_URL = `${RPC_BASE}/api/metaid/create-pin`;
const UPLOAD_URL = `${RPC_BASE}/api/idbots/files/upload-largefile`;

function writeStderr(message: string): void {
  process.stderr.write(message + '\n');
}

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
};

function inferContentType(filePath: string): string {
  const ext = pathMod.extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

function getFileExtension(filePath: string): string {
  return pathMod.extname(filePath).toLowerCase();
}

interface CreatePinResponse {
  success?: boolean;
  error?: string;
  txid?: string;
  txids?: string[];
  pinId?: string;
  totalCost?: number;
}

interface BuzzRequestFile {
  content?: unknown;
  attachments?: unknown;
  contentType?: unknown;
  network?: unknown;
  quotePin?: unknown;
}

function readBuzzRequestFile(filePath: string): BuzzRequestFile {
  const resolved = pathMod.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Request file not found: ${resolved}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid request file JSON: ${resolved}: ${message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid request file: ${resolved} must contain a JSON object.`);
  }

  return parsed as BuzzRequestFile;
}

function optionalString(value: unknown, fieldName: string): string | undefined {
  if (typeof value === 'undefined') return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Invalid request file field: ${fieldName} must be a string.`);
  }
  return value;
}

function normalizeAttachmentList(value: unknown, fieldName: string): string[] {
  if (typeof value === 'undefined') return [];
  if (!Array.isArray(value)) {
    throw new Error(`Invalid request file field: ${fieldName} must be an array of strings.`);
  }

  return value.map((item, index) => {
    if (typeof item !== 'string') {
      throw new Error(`Invalid request file field: ${fieldName}[${index}] must be a string.`);
    }
    return item.trim();
  }).filter((item) => item.length > 0);
}

function normalizeNetwork(value: string | undefined): string {
  const networkRaw = value?.toLowerCase?.()?.trim() ?? '';
  return networkRaw === 'doge' || networkRaw === 'btc' ? networkRaw : 'mvc';
}

function isMetafileUri(value: string): boolean {
  return value.trim().toLowerCase().startsWith('metafile://');
}

async function createPin(metabotId: number, network: string, metaidData: Record<string, unknown>): Promise<CreatePinResponse> {
  const res = await fetch(CREATE_PIN_URL, {
    method: 'POST',
    headers: rpcHeaders(),
    body: JSON.stringify({ metabot_id: metabotId, network, metaidData }),
  });

  const rawText = await res.text();
  let parsed: CreatePinResponse | null = null;
  if (rawText.trim()) {
    try {
      const maybe = JSON.parse(rawText) as unknown;
      parsed = maybe && typeof maybe === 'object' ? (maybe as CreatePinResponse) : null;
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    const errMsg = parsed?.error || rawText;
    throw new Error(`HTTP ${res.status}: ${errMsg}`);
  }
  if (parsed && parsed.success === false) {
    throw new Error(parsed.error || 'Unknown RPC error');
  }
  return parsed ?? {};
}

function resolvePinId(resp: CreatePinResponse): string {
  const txid = resp.txid ?? resp.txids?.[0] ?? '';
  return resp.pinId ?? (txid ? `${txid}i0` : '');
}

interface UploadRpcResponse {
  success?: boolean;
  error?: string;
  pinId?: string;
  metafileUri?: string;
  uploadMode?: string;
}

/**
 * Upload a local attachment through the unified file upload flow
 * (/api/idbots/files/upload-largefile). The flow picks direct vs chunked
 * from file size and returns the canonical result (metafileUri, previewUrl,
 * downloadUrl, metawebUrl, uploadMode). DOGE is not supported for file
 * upload, so the caller maps DOGE attachments to the MVC path while keeping
 * DOGE for the final buzz write.
 */
async function uploadFile(filePath: string, metabotId: number, network: string): Promise<{ pinId: string; ext: string; metafileUri: string }> {
  const resolved = pathMod.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  const stat = fs.statSync(resolved);
  const contentType = inferContentType(resolved);
  const ext = getFileExtension(resolved);

  writeStderr(`Uploading: ${pathMod.basename(resolved)} (${contentType}, ${stat.size} bytes)...`);

  const res = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: rpcHeaders(),
    body: JSON.stringify({
      metabot_id: metabotId,
      file_path: resolved,
      content_type: contentType,
      network,
    }),
  });

  const rawText = await res.text();
  let parsed: UploadRpcResponse | null = null;
  if (rawText.trim()) {
    try {
      const maybe = JSON.parse(rawText) as unknown;
      parsed = maybe && typeof maybe === 'object' ? (maybe as UploadRpcResponse) : null;
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    const errMsg = parsed?.error || rawText;
    throw new Error(`HTTP ${res.status}: ${errMsg}`);
  }
  if (!parsed || parsed.success === false) {
    throw new Error(parsed?.error || 'Unknown upload RPC error');
  }

  const pinId = resolvePinId(parsed);
  if (!pinId) {
    throw new Error(`Failed to get pinId for uploaded file: ${resolved}`);
  }
  const metafileUri = typeof parsed.metafileUri === 'string' && parsed.metafileUri.trim()
    ? parsed.metafileUri.trim()
    : `metafile://${pinId}${ext}`;

  writeStderr(`  -> pinId: ${pinId} (mode: ${parsed.uploadMode ?? 'direct'})`);

  return { pinId, ext, metafileUri };
}

const USAGE =
  'Usage: node post-buzz.js --request-file <request.json> [--content "<content>"] [--attachment <file-or-metafile-uri>]... [--content-type "<mime>"] [--network mvc|doge|btc]';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      'request-file': { type: 'string' },
      content: { type: 'string' },
      attachment: { type: 'string', multiple: true },
      'content-type': { type: 'string' },
      network: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stderr.write(
      'metabot-post-buzz: Send SimpleBuzz to MetaWeb via local RPC.\n\n' +
        USAGE +
        '\n\n' +
        'Options:\n' +
        '  --request-file <json>           (recommended) JSON request file with content, attachments, contentType, network, quotePin.\n' +
        '  --content <string>              Text to post. Optional when request file provides content.\n' +
        '  --attachment <file|metafile://> (optional, repeatable) Local file path to upload, or existing metafile URI to attach directly.\n' +
        '  --content-type <string>         (optional) Content MIME type, default: text/plain;utf-8\n' +
        '  --network <string>              (optional) Buzz write network: mvc (default), doge, btc. Attachments always upload via the file upload flow (DOGE unsupported for files; DOGE attachments upload on mvc).\n' +
        '  -h, --help                      Show this message.\n' +
        '\nEnv: IDBOTS_METABOT_ID (required), IDBOTS_RPC_URL (optional).\n'
    );
    process.exit(0);
  }

  for (const p of positionals) {
    if (p.startsWith('-')) {
      writeStderr(`Unknown option: ${p}`);
      process.exit(1);
    }
  }

  const requestFile = values['request-file'];
  const request = requestFile ? readBuzzRequestFile(requestFile) : {};
  const requestContent = optionalString(request.content, 'content');
  const requestContentType = optionalString(request.contentType, 'contentType');
  const requestNetwork = optionalString(request.network, 'network');
  const quotePin = optionalString(request.quotePin, 'quotePin') ?? '';

  const content = values.content ?? requestContent ?? '';
  const contentType = values['content-type'] ?? requestContentType ?? 'text/plain;utf-8';
  const attachmentInputs = [
    ...normalizeAttachmentList(request.attachments, 'attachments'),
    ...(values.attachment ?? []).map((item) => item.trim()).filter((item) => item.length > 0),
  ];
  const network = normalizeNetwork(values.network ?? requestNetwork);
  // File upload does not support DOGE; keep DOGE only for the final buzz write.
  const attachmentNetwork = network === 'doge' ? 'mvc' : network;

  if (typeof content !== 'string' || content.trim() === '') {
    writeStderr('Error: content is required and must not be empty. Use --request-file or --content.');
    writeStderr(USAGE);
    process.exit(1);
  }

  const metabotIdStr = process.env.IDBOTS_METABOT_ID;
  if (!metabotIdStr || metabotIdStr.trim() === '') {
    writeStderr('Error: IDBOTS_METABOT_ID is required. Set it when running from IDBots Cowork or manually.');
    process.exit(1);
  }
  const metabotId = parseInt(metabotIdStr.trim(), 10);
  if (Number.isNaN(metabotId) || metabotId < 1) {
    writeStderr('Error: IDBOTS_METABOT_ID must be a positive integer.');
    process.exit(1);
  }

  // Phase 1: upload local attachments and collect metafile:// URIs.
  const attachments: string[] = [];
  let uploadedAttachmentCount = 0;
  let directMetafileCount = 0;

  for (const attachment of attachmentInputs) {
    if (isMetafileUri(attachment)) {
      attachments.push(attachment);
      directMetafileCount += 1;
      continue;
    }

    const { metafileUri } = await uploadFile(attachment, metabotId, attachmentNetwork);
    attachments.push(metafileUri);
    uploadedAttachmentCount += 1;
  }

  if (uploadedAttachmentCount > 0) {
    writeStderr(`Uploaded ${uploadedAttachmentCount} local attachment(s).`);
  }
  if (directMetafileCount > 0) {
    writeStderr(`Using ${directMetafileCount} existing metafile attachment(s).`);
  }

  // Phase 2: post the SimpleBuzz with attachments
  const buzzPayload = {
    content,
    contentType,
    attachments,
    quotePin,
  };

  const resp = await createPin(metabotId, network, {
    operation: 'create',
    path: '/protocols/simplebuzz',
    encryption: '0',
    version: '1.0',
    contentType: 'application/json',
    payload: JSON.stringify(buzzPayload),
  });

  const txid = resp.txid ?? resp.txids?.[0] ?? '';
  const pinId = resolvePinId(resp);

  const result: Record<string, unknown> = {
    success: true,
    message: pinId ? `Buzz posted: ${pinId}` : 'Buzz posted successfully.',
  };
  if (txid) result.txid = txid;
  if (pinId) result.pinId = pinId;
  if (attachments.length > 0) result.attachments = attachments;
  if (typeof resp.totalCost === 'number') {
    result.totalCost = resp.totalCost;
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (typeof resp.totalCost === 'number') {
    writeStderr(`Cost: ${resp.totalCost} satoshis`);
  }
}

main().catch((e) => {
  writeStderr(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
