#!/usr/bin/env node
'use strict';

const { parseArgs } = require('util');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const RPC_BASE = (process.env.IDBOTS_RPC_URL || 'http://127.0.0.1:31200').replace(/\/+$/, '');
const RPC_TOKEN = process.env.IDBOTS_RPC_TOKEN || '';
function rpcHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (RPC_TOKEN) headers.Authorization = `Bearer ${RPC_TOKEN}`;
  return headers;
}
const UPLOAD_URL = `${RPC_BASE}/api/idbots/files/upload-largefile`;
const CREATE_PIN_URL = `${RPC_BASE}/api/metaid/create-pin`;
const SET_HOMEPAGE_METAAPP_URL = `${RPC_BASE}/api/idbots/metabot/homepage/set-metaapp`;

const METAAPP_PROTOCOL_PATH = '/protocols/metaapp';
const HOMEPAGE_PATH = '/info/homepage';
const DEFAULT_NETWORK = 'mvc';
const ZIP_CONTENT_TYPE = 'application/zip';
const HOMEPAGE_RENDERER = 'metaapp';
const HOMEPAGE_SOURCE_CONTENT_TYPE = 'application/vnd.metaapp';

const METAAPP_PIN_ID_PATTERN = /^[0-9a-f]{64}i0$/i;
const METAAPP_METAFILE_REFERENCE_PATTERN = /^([0-9a-f]{64}i0)(?:\.[a-z0-9][a-z0-9+-]{0,31})?$/i;

const METAAPP_RUNTIME_OPTIONS = new Set(['browser', 'android', 'ios', 'windows', 'macOS', 'linux']);
const METAAPP_CONTENT_TYPE_OPTIONS = new Set([
  'application/zip',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/gzip',
  'application/json',
  'application/xml',
  'text/plain',
  'text/html',
  'text/css',
  'application/javascript',
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/svg+xml',
  'image/webp',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/wav',
  'application/octet-stream',
]);
const METAAPP_CODE_TYPE_OPTIONS = new Set([
  'application/zip',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/gzip',
  'application/json',
  'application/xml',
  'text/html',
  'text/css',
  'application/javascript',
]);

const MIME_MAP = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.zip': ZIP_CONTENT_TYPE,
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
};

const CONTENT_TYPE_EXTENSION_MAP = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/x-icon': '.ico',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'text/html': '.html',
  'text/css': '.css',
  'application/javascript': '.js',
  'application/json': '.json',
  'text/markdown': '.md',
  'text/plain': '.txt',
};

const EXCLUDE_DIRS = new Set([
  '.git',
  '.idea',
  '.vscode',
  '__MACOSX',
  '__pycache__',
  'node_modules',
  'coverage',
  '.cache',
  '.next',
  'dist-electron',
]);
const EXCLUDE_FILE_NAMES = new Set(['.DS_Store']);
const EXCLUDE_EXTENSIONS = new Set(['.zip', '.log']);

function writeStderr(message) {
  process.stderr.write(`${message}\n`);
}

function cleanString(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(cleanString(value));
}

function expandHome(input) {
  const value = cleanString(input);
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function resolveLocalPath(input) {
  return path.resolve(expandHome(input));
}

function normalizePinIdInput(value, fieldName = 'pinId') {
  const pinId = cleanString(value).toLowerCase();
  if (!METAAPP_PIN_ID_PATTERN.test(pinId)) {
    throw new Error(`${fieldName} must be a MetaID pin id.`);
  }
  return pinId;
}

function normalizeMetafileExtension(ext) {
  const normalized = cleanString(ext).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(normalized) ? normalized : '';
}

function getMetafileExtension({ fileName, filePath, contentType } = {}) {
  const fileExt = normalizeMetafileExtension(path.extname(cleanString(fileName || filePath)));
  if (fileExt) return fileExt;
  const normalizedContentType = cleanString(contentType).split(';')[0].trim().toLowerCase();
  return CONTENT_TYPE_EXTENSION_MAP[normalizedContentType] || '';
}

function stripMetafileUriPrefix(value) {
  const text = cleanString(value);
  return text.toLowerCase().startsWith('metafile://') ? text.slice('metafile://'.length).trim() : text;
}

function hasMetafileExtension(pinIdOrUri) {
  const raw = stripMetafileUriPrefix(pinIdOrUri).split('?')[0].split('#')[0].trim();
  const tail = raw.split('/').pop() || raw;
  return Boolean(normalizeMetafileExtension(path.extname(tail)));
}

function buildMetafileUri(pinIdOrUri, options = {}) {
  const pinId = stripMetafileUriPrefix(pinIdOrUri);
  if (!pinId) return '';
  const extension = hasMetafileExtension(pinId) ? '' : getMetafileExtension(options);
  return `metafile://${pinId}${extension}`;
}

function normalizeMetafileReference(value, fieldName = 'resource') {
  const text = cleanString(value);
  if (!text) return '';
  const stripped = stripMetafileUriPrefix(text);
  if (!METAAPP_METAFILE_REFERENCE_PATTERN.test(stripped)) {
    throw new Error(`${fieldName} must be a metafile reference.`);
  }
  return buildMetafileUri(stripped);
}

function normalizeImageReference(value, fieldName = 'image') {
  const text = cleanString(value);
  if (!text) return '';
  if (isHttpUrl(text)) return text;
  return normalizeMetafileReference(text, fieldName);
}

function normalizePinId(response) {
  if (!response || typeof response !== 'object') return '';
  const direct = cleanString(response.pinId).toLowerCase();
  if (direct) return direct;
  const txid = cleanString(response.txid).toLowerCase()
    || (Array.isArray(response.txids) && response.txids.length > 0 ? cleanString(response.txids[0]).toLowerCase() : '');
  return txid ? `${txid}i0` : '';
}

function readJsonFile(filePath) {
  const resolved = resolveLocalPath(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid JSON file: ${resolved} (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!isObject(parsed)) {
    throw new Error(`JSON root must be an object: ${resolved}`);
  }
  return { resolved, parsed };
}

function writeJsonOutput(result, outputPath) {
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) {
    const resolved = resolveLocalPath(outputPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, json);
    writeStderr(`Wrote ${resolved}`);
    return resolved;
  }
  process.stdout.write(json);
  return '';
}

function getMetabotId() {
  const raw = cleanString(process.env.IDBOTS_METABOT_ID);
  if (!raw) {
    throw new Error('IDBOTS_METABOT_ID is required. Set it in IDBots Cowork or your shell.');
  }
  const metabotId = Number.parseInt(raw, 10);
  if (!Number.isInteger(metabotId) || metabotId <= 0) {
    throw new Error('IDBOTS_METABOT_ID must be a positive integer.');
  }
  return metabotId;
}

function inferContentType(filePath) {
  const ext = path.extname(cleanString(filePath)).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: rpcHeaders(),
    body: JSON.stringify(body),
  });
  const rawText = await response.text();
  let parsed = null;
  if (rawText.trim()) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    const err = new Error((parsed && parsed.error) || rawText || `HTTP ${response.status}`);
    err.response = parsed;
    err.status = response.status;
    throw err;
  }
  if (parsed && parsed.success === false) {
    const err = new Error(parsed.error || 'RPC call failed');
    err.response = parsed;
    err.status = response.status;
    throw err;
  }
  return parsed || {};
}

async function uploadLocalFile(filePath, contentType, metabotId, network, role, deps = {}) {
  const resolved = resolveLocalPath(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${resolved}`);
  }

  const finalContentType = cleanString(contentType) || inferContentType(resolved);
  const postJsonFn = deps.postJsonFn || postJson;
  writeStderr(`Uploading ${role}: ${path.basename(resolved)} (${finalContentType}, ${stat.size} bytes)`);
  const response = await postJsonFn(UPLOAD_URL, {
    metabot_id: metabotId,
    file_path: resolved,
    content_type: finalContentType,
    network,
  });
  const pinId = normalizePinId(response);
  if (!pinId) {
    throw new Error(`Upload did not return pinId for ${resolved}`);
  }
  const uri = buildMetafileUri(pinId, {
    fileName: response.fileName || path.basename(resolved),
    filePath: resolved,
    contentType: response.contentType || finalContentType,
  });
  return {
    role,
    pinId,
    uri,
    filePath: resolved,
    contentType: finalContentType,
    size: typeof response.size === 'number' ? response.size : stat.size,
    uploadMode: response.uploadMode,
  };
}

const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = crc32Table[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const parts = [];
  const centralDir = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 6 });
    const useDeflate = deflated.length < data.length;
    const compressedData = useDeflate ? deflated : data;
    const compressionMethod = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const localHeader = Buffer.allocUnsafe(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedData.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBytes.copy(localHeader, 30);

    parts.push(localHeader, compressedData);

    const centralHeader = Buffer.allocUnsafe(46 + nameBytes.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(compressionMethod, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressedData.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBytes.copy(centralHeader, 46);

    centralDir.push(centralHeader);
    offset += localHeader.length + compressedData.length;
  }

  const centralDirBuffer = Buffer.concat(centralDir);
  const eocd = Buffer.allocUnsafe(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(centralDir.length, 8);
  eocd.writeUInt16LE(centralDir.length, 10);
  eocd.writeUInt32LE(centralDirBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, centralDirBuffer, eocd]);
}

function shouldExclude(filePath, root) {
  const relative = path.relative(root, filePath);
  const parts = relative.split(path.sep).filter(Boolean);
  for (const part of parts) {
    if (EXCLUDE_DIRS.has(part)) return true;
  }
  const base = path.basename(filePath);
  if (EXCLUDE_FILE_NAMES.has(base)) return true;
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    if (EXCLUDE_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

function createZipArchive(srcRoot, zipPath) {
  const root = resolveLocalPath(srcRoot);
  const output = resolveLocalPath(zipPath);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const entries = [];

  function walk(directory) {
    const items = fs.readdirSync(directory).sort((left, right) => left.localeCompare(right));
    for (const item of items) {
      const fullPath = path.join(directory, item);
      if (shouldExclude(fullPath, root)) continue;
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        const name = path.relative(root, fullPath).replace(/\\/g, '/');
        entries.push({ name, data: fs.readFileSync(fullPath) });
      }
    }
  }

  walk(root);
  if (entries.length === 0) {
    throw new Error(`Directory has no packable files: ${root}`);
  }
  const zipBuffer = buildZip(entries);
  fs.writeFileSync(output, zipBuffer);
  return { zipPath: output, size: zipBuffer.length, fileCount: entries.length };
}

function sanitizeFileName(name) {
  return cleanString(name, 'metaapp').replace(/[^\w.-]+/g, '_') || 'metaapp';
}

function packageDirectory(directory, role) {
  const resolved = resolveLocalPath(directory);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Directory not found: ${resolved}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`Path is not a directory: ${resolved}`);
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-metaapp-'));
  const zipPath = path.join(tempDir, `${sanitizeFileName(path.basename(resolved) || role)}.zip`);
  const result = createZipArchive(resolved, zipPath);
  writeStderr(`Packaged ${role}: ${result.zipPath} (${result.fileCount} files, ${result.size} bytes)`);
  return result;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(resolveLocalPath(filePath)));
  return hash.digest('hex');
}

function resourceInput(request, key) {
  const value = request[key];
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number') return cleanString(value);
  if (isObject(value)) {
    const uri = cleanString(value.uri || value.metafileUri || value.metafile);
    if (uri) return uri;
    const filePath = cleanString(value.path || value.file);
    if (filePath) return filePath;
    if (typeof value.pinId === 'string') {
      return buildMetafileUri(value.pinId, {
        fileName: value.fileName || value.name || value.path || value.file,
        contentType: value.contentType || value.content_type || value.mime,
      });
    }
  }
  return '';
}

function maybeExistingMetafileResource(value) {
  const text = cleanString(value);
  if (!text) return '';
  if (/^metafile:\/\//i.test(text)) {
    return normalizeMetafileReference(text);
  }
  if (METAAPP_METAFILE_REFERENCE_PATTERN.test(text)) {
    return normalizeMetafileReference(text);
  }
  return '';
}

async function resolveZipResource(request, key, metabotId, network, uploads, deps = {}) {
  const value = resourceInput(request, key);
  if (!value) return { uri: '', localFile: '', packaged: false };

  const existingUri = maybeExistingMetafileResource(value);
  if (existingUri) return { uri: existingUri, localFile: '', packaged: false };

  const resolved = resolveLocalPath(value);
  if (!fs.existsSync(resolved)) {
    throw new Error(`${key} path not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  let uploadFile = resolved;
  let packaged = false;

  if (stat.isDirectory()) {
    const result = packageDirectory(resolved, key);
    uploadFile = result.zipPath;
    packaged = true;
  } else if (stat.isFile()) {
    if (path.extname(resolved).toLowerCase() !== '.zip') {
      throw new Error(`${key} must be a directory, a .zip file, or a metafile:// URI: ${resolved}`);
    }
  } else {
    throw new Error(`${key} must be a directory or .zip file: ${resolved}`);
  }

  const upload = await uploadLocalFile(uploadFile, ZIP_CONTENT_TYPE, metabotId, network, key, deps);
  uploads.push(upload);
  return { uri: upload.uri, localFile: uploadFile, packaged };
}

async function resolveImageResource(value, role, metabotId, network, uploads, deps = {}) {
  const input = typeof value === 'string' || typeof value === 'number'
    ? cleanString(value)
    : isObject(value)
      ? resourceInput({ value }, 'value')
      : '';
  if (!input) return '';
  if (isHttpUrl(input)) return input;

  const existingUri = maybeExistingMetafileResource(input);
  if (existingUri) return existingUri;

  const resolved = resolveLocalPath(input);
  if (!fs.existsSync(resolved)) {
    throw new Error(`${role} path not found: ${resolved}`);
  }
  if (!fs.statSync(resolved).isFile()) {
    throw new Error(`${role} must be a local file, metafile:// URI, or https:// URL: ${resolved}`);
  }
  const upload = await uploadLocalFile(resolved, inferContentType(resolved), metabotId, network, role, deps);
  uploads.push(upload);
  return upload.uri;
}

function normalizeTags(value) {
  const raw = Array.isArray(value)
    ? value
    : cleanString(value)
      ? cleanString(value).split(',')
      : [];
  const seen = new Set();
  const tags = [];
  for (const entry of raw) {
    const item = cleanString(entry);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    tags.push(item);
  }
  return tags;
}

function normalizeDisabled(value) {
  if (typeof value === 'boolean') return value;
  const normalized = cleanString(value).toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function normalizeMetadataObject(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return undefined;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`metadata must be valid JSON object: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!isObject(parsed)) {
      throw new Error('metadata must be a JSON object.');
    }
    return parsed;
  }
  if (!isObject(value)) {
    throw new Error('metadata must be a JSON object.');
  }
  return value;
}

function normalizeRuntimeValue(value) {
  const candidates = Array.isArray(value)
    ? value
    : cleanString(value)
      ? cleanString(value).split(/[\/,]/)
      : [];
  const picked = [];
  const seen = new Set();
  for (const item of candidates) {
    const runtime = cleanString(item);
    if (!runtime || seen.has(runtime)) continue;
    if (!METAAPP_RUNTIME_OPTIONS.has(runtime)) continue;
    seen.add(runtime);
    picked.push(runtime);
  }
  return picked.length ? picked.join('/') : 'browser';
}

function normalizeContentTypeValue(value, allowedSet, defaultValue, fieldName) {
  const normalized = cleanString(value) || defaultValue;
  if (!allowedSet.has(normalized)) {
    throw new Error(`Unsupported ${fieldName}: ${normalized}`);
  }
  return normalized;
}

function buildMetaAppManifest(input) {
  if (!isObject(input)) {
    throw new Error('manifest input must be an object.');
  }

  const appName = cleanString(input.appName);
  if (!appName) throw new Error('appName is required.');

  const content = normalizeMetafileReference(input.content, 'content');
  if (!content) throw new Error('content is required.');

  const title = cleanString(input.title) || appName;
  const prompt = cleanString(input.prompt);
  const intro = cleanString(input.intro);
  const version = cleanString(input.version) || 'v1.0.0';
  const indexFile = cleanString(input.indexFile) || 'index.html';
  const contentHash = cleanString(input.contentHash);

  const codeRaw = cleanString(input.code);
  const code = codeRaw ? normalizeMetafileReference(codeRaw, 'code') : undefined;
  const contentType = normalizeContentTypeValue(
    input.contentType,
    METAAPP_CONTENT_TYPE_OPTIONS,
    ZIP_CONTENT_TYPE,
    'contentType'
  );
  const codeTypeRaw = cleanString(input.codeType);
  const codeType = codeTypeRaw
    ? normalizeContentTypeValue(codeTypeRaw, METAAPP_CODE_TYPE_OPTIONS, ZIP_CONTENT_TYPE, 'codeType')
    : undefined;

  const icon = normalizeImageReference(input.icon, 'icon');
  const coverImg = normalizeImageReference(input.coverImg, 'coverImg');
  const introImgs = Array.isArray(input.introImgs)
    ? input.introImgs
        .map((item, index) => normalizeImageReference(item, `introImgs[${index}]`))
        .filter(Boolean)
    : [];

  const metadata = normalizeMetadataObject(input.metadata);
  const manifest = {
    title,
    appName,
    runtime: normalizeRuntimeValue(input.runtime),
    version,
    contentType,
    content,
    indexFile,
    tags: normalizeTags(input.tags),
    disabled: normalizeDisabled(input.disabled),
  };

  if (prompt) manifest.prompt = prompt;
  if (icon) manifest.icon = icon;
  if (coverImg) manifest.coverImg = coverImg;
  if (introImgs.length) manifest.introImgs = introImgs;
  if (intro) manifest.intro = intro;
  if (code) manifest.code = code;
  if (contentHash) manifest.contentHash = contentHash;
  if (metadata) manifest.metadata = metadata;
  if (codeType) manifest.codeType = codeType;

  return manifest;
}

function buildMetaidData(operation, pathValue, manifest) {
  return {
    operation,
    path: pathValue,
    encryption: '0',
    version: '1.0',
    contentType: 'application/json',
    payload: JSON.stringify(manifest),
    encoding: 'utf-8',
  };
}

function buildPreparedWrite({ operation, targetPinId, firstPinId, manifest, uploads, preparedAt, network }) {
  const normalizedOperation = operation === 'modify' ? 'modify' : 'create';
  const normalizedTargetPinId = normalizedOperation === 'modify'
    ? normalizePinIdInput(targetPinId, 'targetPinId')
    : undefined;
  const normalizedFirstPinId = cleanString(firstPinId)
    ? normalizePinIdInput(firstPinId, 'firstPinId')
    : undefined;
  const finalManifest = buildMetaAppManifest(manifest);
  const pathValue = normalizedOperation === 'create'
    ? METAAPP_PROTOCOL_PATH
    : `@${normalizedTargetPinId}`;

  const result = {
    kind: 'metaapp-prepared-write',
    preparedAt: cleanString(preparedAt) || new Date().toISOString(),
    network: cleanString(network) || DEFAULT_NETWORK,
    operation: normalizedOperation,
    path: pathValue,
    manifest: finalManifest,
    metaidData: buildMetaidData(normalizedOperation, pathValue, finalManifest),
    uploads: Array.isArray(uploads) ? uploads : [],
  };
  if (normalizedTargetPinId) result.targetPinId = normalizedTargetPinId;
  if (normalizedFirstPinId) result.firstPinId = normalizedFirstPinId;
  return result;
}

function coercePreparedWrite(prepared) {
  if (!isObject(prepared)) {
    throw new Error('prepared file must be an object.');
  }
  const manifestSource = isObject(prepared.manifest)
    ? prepared.manifest
    : (isObject(prepared.payload) ? prepared.payload : null);
  if (!manifestSource) {
    throw new Error('prepared file must include manifest or payload object.');
  }

  const rawPath = cleanString(prepared.path);
  let operation = cleanString(prepared.operation).toLowerCase();
  let targetPinId = cleanString(prepared.targetPinId);

  if (!operation) {
    if (rawPath === METAAPP_PROTOCOL_PATH || rawPath === '') {
      operation = 'create';
    } else if (rawPath.startsWith('@')) {
      operation = 'modify';
      targetPinId = rawPath.slice(1);
    } else {
      throw new Error('prepared operation is required.');
    }
  }

  if (operation !== 'create' && operation !== 'modify') {
    throw new Error(`Unsupported prepared operation: ${operation}`);
  }
  if (operation === 'modify' && !targetPinId && rawPath.startsWith('@')) {
    targetPinId = rawPath.slice(1);
  }

  return buildPreparedWrite({
    operation,
    targetPinId,
    firstPinId: prepared.firstPinId,
    manifest: manifestSource,
    uploads: Array.isArray(prepared.uploads) ? prepared.uploads : [],
    preparedAt: prepared.preparedAt,
    network: prepared.network,
  });
}

async function prepareMetaAppRequest(request, metabotId, network, operation, deps = {}) {
  if (!isObject(request)) {
    throw new Error('request must be an object.');
  }
  const uploads = [];
  const resolveZipResourceFn = deps.resolveZipResourceFn
    || ((...args) => resolveZipResource(...args));
  const resolveImageResourceFn = deps.resolveImageResourceFn
    || ((...args) => resolveImageResource(...args));
  const nowIso = deps.nowIso || (() => new Date().toISOString());

  const contentResource = await resolveZipResourceFn(request, 'content', metabotId, network, uploads, deps);
  if (!cleanString(contentResource.uri)) {
    throw new Error('content is required.');
  }
  const codeResource = await resolveZipResourceFn(request, 'code', metabotId, network, uploads, deps);

  const icon = await resolveImageResourceFn(request.icon, 'icon', metabotId, network, uploads, deps);
  const coverImg = await resolveImageResourceFn(request.coverImg, 'coverImg', metabotId, network, uploads, deps);
  const introImgInputs = Array.isArray(request.introImgs) ? request.introImgs : [];
  const introImgs = [];
  for (let i = 0; i < introImgInputs.length; i += 1) {
    const uri = await resolveImageResourceFn(introImgInputs[i], `introImgs[${i}]`, metabotId, network, uploads, deps);
    if (uri) introImgs.push(uri);
  }

  const manifestInput = {
    ...request,
    title: cleanString(request.title) || cleanString(request.appName),
    icon: icon || undefined,
    coverImg: coverImg || undefined,
    introImgs,
    content: contentResource.uri,
    code: codeResource.uri || undefined,
    contentHash: contentResource.localFile
      ? sha256File(contentResource.localFile)
      : cleanString(request.contentHash) || undefined,
    contentType: contentResource.localFile ? ZIP_CONTENT_TYPE : (cleanString(request.contentType) || undefined),
    codeType: codeResource.localFile ? ZIP_CONTENT_TYPE : (cleanString(request.codeType) || undefined),
  };

  return buildPreparedWrite({
    operation,
    targetPinId: request.targetPinId,
    firstPinId: request.firstPinId,
    manifest: manifestInput,
    uploads,
    preparedAt: nowIso(),
    network,
  });
}

async function prepareCreateRequest(request, metabotId, network, deps = {}) {
  return prepareMetaAppRequest(request, metabotId, network, 'create', deps);
}

async function prepareUpdateRequest(request, metabotId, network, deps = {}) {
  const targetPinId = cleanString(request.targetPinId);
  if (!targetPinId) {
    throw new Error('targetPinId is required for update.');
  }
  return prepareMetaAppRequest(request, metabotId, network, 'modify', deps);
}

async function publishPrepared(prepared, metabotId, network, deps = {}) {
  const canonical = coercePreparedWrite(prepared);
  const postJsonFn = deps.postJsonFn || postJson;
  const effectiveNetwork = cleanString(network) || cleanString(canonical.network) || DEFAULT_NETWORK;
  writeStderr(`Publishing MetaApp ${canonical.operation}: ${cleanString(canonical.manifest.title)} ${cleanString(canonical.manifest.version)}`);

  const response = await postJsonFn(CREATE_PIN_URL, {
    metabot_id: metabotId,
    network: effectiveNetwork,
    metaidData: canonical.metaidData,
  });

  const pinId = normalizePinId(response);
  const txids = Array.isArray(response.txids) ? response.txids.map((item) => cleanString(item)).filter(Boolean) : [];
  const txid = cleanString(response.txid) || txids[0] || '';
  // R8: for a modify, the STABLE display pin is the create root (firstPinId),
  // NOT the modify write pin — a modify pin is just a change record. Build the
  // user-facing URI/URL from the root so links never drift to the latest write.
  const displayPin = canonical.operation === 'modify'
    ? (canonical.firstPinId || canonical.targetPinId || pinId)
    : pinId;
  const result = {
    success: true,
    operation: canonical.operation,
    path: canonical.path,
    pinId: pinId || undefined,
    txid: txid || undefined,
    txids,
    totalCost: typeof response.totalCost === 'number' ? response.totalCost : undefined,
    metaappUri: displayPin ? `metaapp://${displayPin}` : undefined,
    shareWebUrl: displayPin ? `https://openagentinternet.org/browser/metaapp/${displayPin}` : undefined,
  };
  if (canonical.targetPinId) result.targetPinId = canonical.targetPinId;
  if (canonical.firstPinId) result.firstPinId = canonical.firstPinId;
  return result;
}

async function deleteMetaAppPin(targetPinId, firstPinId, metabotId, network, deps = {}) {
  const normalizedTargetPinId = normalizePinIdInput(targetPinId, 'targetPinId');
  const normalizedFirstPinId = cleanString(firstPinId)
    ? normalizePinIdInput(firstPinId, 'firstPinId')
    : undefined;
  const postJsonFn = deps.postJsonFn || postJson;
  writeStderr(`Revoking MetaApp pin: ${normalizedTargetPinId}`);
  const response = await postJsonFn(CREATE_PIN_URL, {
    metabot_id: metabotId,
    network,
    metaidData: {
      operation: 'revoke',
      path: `@${normalizedTargetPinId}`,
      encryption: '0',
      version: '1.0',
      contentType: 'application/json',
      payload: '',
      encoding: 'utf-8',
    },
  });

  const pinId = normalizePinId(response);
  const txids = Array.isArray(response.txids) ? response.txids.map((item) => cleanString(item)).filter(Boolean) : [];
  const txid = cleanString(response.txid) || txids[0] || '';
  return {
    success: true,
    operation: 'revoke',
    revokedPinId: normalizedTargetPinId,
    firstPinId: normalizedFirstPinId || normalizedTargetPinId,
    pinId: pinId || undefined,
    txid: txid || undefined,
    txids,
    totalCost: typeof response.totalCost === 'number' ? response.totalCost : undefined,
  };
}

function buildShareLinks(pinId, firstPinId) {
  const currentPinId = normalizePinIdInput(pinId, 'pinId');
  const normalizedFirstPinId = cleanString(firstPinId)
    ? normalizePinIdInput(firstPinId, 'firstPinId')
    : currentPinId;
  const sharePinId = normalizedFirstPinId || currentPinId;
  return {
    success: true,
    currentPinId,
    firstPinId: normalizedFirstPinId,
    sharePinId,
    metaappUri: `metaapp://${sharePinId}`,
    shareWebUrl: `https://openagentinternet.org/browser/metaapp/${sharePinId}`,
    currentMetaappUri: `metaapp://${currentPinId}`,
    currentShareWebUrl: `https://openagentinternet.org/browser/metaapp/${currentPinId}`,
    runPath: `/browser/metaapp/${sharePinId}`,
  };
}

function prepareHomepagePayload(pinId) {
  const normalizedPinId = normalizePinIdInput(pinId, 'pinId');
  const homepage = {
    uri: `metaapp://${normalizedPinId}`,
    renderer: HOMEPAGE_RENDERER,
    contentType: HOMEPAGE_SOURCE_CONTENT_TYPE,
  };
  return {
    success: true,
    kind: 'metaapp-homepage-payload',
    pinId: normalizedPinId,
    path: HOMEPAGE_PATH,
    contentType: 'application/json',
    homepage,
    payload: JSON.stringify(homepage),
    nextStep: 'Use the host-side MetaBot homepage sync flow to write this payload to /info/homepage.',
  };
}

async function setHomepageMetaApp(pinId, metabotId, deps = {}) {
  const normalizedPinId = normalizePinIdInput(pinId, 'pinId');
  const normalizedMetabotId = Number.parseInt(String(metabotId), 10);
  if (!Number.isInteger(normalizedMetabotId) || normalizedMetabotId <= 0) {
    throw new Error('metabotId must be a positive integer.');
  }
  const postJsonFn = deps.postJsonFn || postJson;
  const response = await postJsonFn(SET_HOMEPAGE_METAAPP_URL, {
    metabot_id: normalizedMetabotId,
    pin_id: normalizedPinId,
    sync: true,
  });
  const prepared = prepareHomepagePayload(normalizedPinId);
  return {
    success: true,
    kind: 'metaapp-homepage-selected',
    metabotId: normalizedMetabotId,
    pinId: normalizedPinId,
    path: prepared.path,
    contentType: prepared.contentType,
    homepage: isObject(response.homepage) ? response.homepage : prepared.homepage,
    payload: prepared.payload,
    syncRequested: response.sync_requested !== false,
    syncResult: response.sync_result || null,
    txids: Array.isArray(response.sync_result && response.sync_result.txids) ? response.sync_result.txids : [],
    syncedSteps: Array.isArray(response.sync_result && response.sync_result.syncedSteps)
      ? response.sync_result.syncedSteps
      : [],
  };
}

function printHelp() {
  writeStderr(
    'metabot-metaapp: prepare, publish, update, delete, share, and stage homepage payloads for MetaApps.\n\n'
    + 'Usage:\n'
    + '  node index.js --prepare-request <request.json> [--output <prepared.json>] [--network mvc]\n'
    + '  node index.js --prepare-update-request <request.json> [--output <prepared.json>] [--network mvc]\n'
    + '  node index.js --publish-prepared <prepared.json> [--network mvc]\n'
    + '  node index.js --delete-pin <pinId> [--first-pin-id <firstPinId>] [--network mvc]\n'
    + '  node index.js --share-links <pinId> [--first-pin-id <firstPinId>] [--output <json>]\n'
    + '  node index.js --prepare-homepage-payload <pinId> [--output <json>]\n'
    + '  node index.js --set-homepage-metaapp <pinId> [--output <json>]\n\n'
    + 'Env: IDBOTS_METABOT_ID (required for prepare/publish/delete/set-homepage), IDBOTS_RPC_URL (optional).\n'
  );
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      'prepare-request': { type: 'string' },
      'prepare-update-request': { type: 'string' },
      'publish-prepared': { type: 'string' },
      'delete-pin': { type: 'string' },
      'share-links': { type: 'string' },
      'prepare-homepage-payload': { type: 'string' },
      'set-homepage-metaapp': { type: 'string' },
      'first-pin-id': { type: 'string' },
      output: { type: 'string' },
      network: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printHelp();
    return;
  }
  for (const positional of positionals) {
    if (String(positional).startsWith('-')) {
      throw new Error(`Unknown option: ${positional}`);
    }
  }

  const actions = [
    ['prepare-request', cleanString(values['prepare-request'])],
    ['prepare-update-request', cleanString(values['prepare-update-request'])],
    ['publish-prepared', cleanString(values['publish-prepared'])],
    ['delete-pin', cleanString(values['delete-pin'])],
    ['share-links', cleanString(values['share-links'])],
    ['prepare-homepage-payload', cleanString(values['prepare-homepage-payload'])],
    ['set-homepage-metaapp', cleanString(values['set-homepage-metaapp'])],
  ].filter(([, value]) => Boolean(value));

  if (actions.length === 0) {
    printHelp();
    throw new Error('One action is required.');
  }
  if (actions.length > 1) {
    throw new Error('Use exactly one action at a time.');
  }

  const action = actions[0][0];
  const actionValue = actions[0][1];
  const output = cleanString(values.output);
  const network = cleanString(values.network) || DEFAULT_NETWORK;
  const firstPinId = cleanString(values['first-pin-id']);

  if (action === 'prepare-request') {
    const metabotId = getMetabotId();
    const { parsed } = readJsonFile(actionValue);
    const prepared = await prepareCreateRequest(parsed, metabotId, network);
    writeJsonOutput(prepared, output);
    return;
  }

  if (action === 'prepare-update-request') {
    const metabotId = getMetabotId();
    const { parsed } = readJsonFile(actionValue);
    const prepared = await prepareUpdateRequest(parsed, metabotId, network);
    writeJsonOutput(prepared, output);
    return;
  }

  if (action === 'publish-prepared') {
    const metabotId = getMetabotId();
    const { parsed } = readJsonFile(actionValue);
    const result = await publishPrepared(parsed, metabotId, network);
    writeJsonOutput(result, output);
    return;
  }

  if (action === 'delete-pin') {
    const metabotId = getMetabotId();
    const result = await deleteMetaAppPin(actionValue, firstPinId, metabotId, network);
    writeJsonOutput(result, output);
    return;
  }

  if (action === 'share-links') {
    const result = buildShareLinks(actionValue, firstPinId);
    writeJsonOutput(result, output);
    return;
  }

  if (action === 'prepare-homepage-payload') {
    const result = prepareHomepagePayload(actionValue);
    writeJsonOutput(result, output);
    return;
  }

  if (action === 'set-homepage-metaapp') {
    const metabotId = getMetabotId();
    const result = await setHomepageMetaApp(actionValue, metabotId);
    writeJsonOutput(result, output);
    return;
  }

  throw new Error(`Unsupported action: ${action}`);
}

module.exports = {
  METAAPP_PROTOCOL_PATH,
  HOMEPAGE_PATH,
  buildMetaAppManifest,
  buildPreparedWrite,
  buildShareLinks,
  coercePreparedWrite,
  deleteMetaAppPin,
  normalizeMetadataObject,
  normalizePinIdInput,
  prepareCreateRequest,
  prepareHomepagePayload,
  prepareUpdateRequest,
  publishPrepared,
  resolveImageResource,
  resolveZipResource,
  setHomepageMetaApp,
};

if (require.main === module) {
  main().catch((err) => {
    writeStderr(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
