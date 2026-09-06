'use strict';

/**
 * release-publish-oss-cdn.cjs
 *
 * Upload release artifacts to OSS (immutable installers + mutable YAML) and
 * warm the Aliyun CDN, then verify everything. Runs inside the build.yml
 * `release` job (ubuntu-latest) so the release reaches download.idbots.ai in
 * the same pipeline that produces it — no local manual upload step anymore.
 *
 * Credentials: OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET (already configured
 * as GitHub Actions secrets). Values are only ever read from env and used in
 * signature computation — never printed, never logged.
 *
 * Aliyun APIs implemented here with zero npm dependencies (node:crypto):
 * - OSS PUT object with v1 HMAC-SHA1 signature + per-object headers
 * - CDN PushObjectCache / DescribeRefreshTasks (POP RPC v1 signature)
 *
 * Idempotent: re-running overwrites the same objects; warmup re-push is safe.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const OSS_HOST_SUFFIX = 'oss-cn-hongkong.aliyuncs.com';
const CDN_ENDPOINT = 'cdn.aliyuncs.com';
const CDN_API_VERSION = '2018-05-10';

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const YAML_CACHE = 'no-cache, max-age=0, must-revalidate';

function fail(msg) {
  console.error(`[oss-cdn] ERROR: ${msg}`);
  process.exit(1);
}

function env(name) {
  const v = process.env[name];
  if (!v) fail(`missing env ${name}`);
  return v;
}

function readVersion() {
  const fromArg = process.argv[2];
  if (fromArg) return fromArg.replace(/^v/, '');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  if (!pkg.version) fail('no version argument and package.json has no version');
  return pkg.version;
}

function hmacSha1(key, data) {
  return crypto.createHmac('sha1', key).update(data, 'utf8').digest('base64');
}

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha1Hex(data) {
  return crypto.createHash('sha1').update(data).digest('hex');
}

function pctEncode(str) {
  return encodeURIComponent(str)
    .replace(/\!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

function popSign(canonical) {
  const accessKeySecret = env('OSS_ACCESS_KEY_SECRET');
  // POP RPC v1: stringToSign = METHOD & pctEncode("/") & pctEncode(canonicalQuery).
  // NOTE the canonical query itself is percent-encoded a SECOND time here —
  // this is what the server error "server string to sign" shows as %26/%253A.
  const stringToSign = ['GET', pctEncode('/'), pctEncode(canonical)].join('&');
  return pctEncode(hmacSha1(`${accessKeySecret}&`, stringToSign));
}

async function popCall(action, extraParams) {
  // All params except Signature participate in the canonical query —
  // including the common AccessKeyId/Format/Version/Signature* ones.
  const params = {
    Action: action,
    AccessKeyId: env('OSS_ACCESS_KEY_ID'),
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: CDN_API_VERSION,
    Format: 'JSON',
    RegionId: 'cn-hongkong',
    ...extraParams,
  };
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${pctEncode(k)}=${pctEncode(params[k])}`)
    .join('&');
  const signature = popSign(canonical);
  const url = `https://${CDN_ENDPOINT}/?${canonical}&Signature=${signature}`;
  const res = await fetch(url);
  const body = await res.text();
  if (!res.ok) fail(`${action} HTTP ${res.status}: ${body.slice(0, 400)}`);
  try {
    return JSON.parse(body);
  } catch {
    fail(`${action} non-JSON response: ${body.slice(0, 400)}`);
  }
}

async function cdnWarmup(urls) {
  console.log(`[oss-cdn] warming ${urls.length} CDN urls (overseas)`);
  const push = await popCall('PushObjectCache', {
    ObjectPath: urls.join('\n'),
    Area: 'overseas',
  });
  const pushId = push.PushTaskId;
  if (!pushId) fail(`PushObjectCache returned no PushTaskId: ${JSON.stringify(push).slice(0, 200)}`);
  console.log(`[oss-cdn] PushTaskId=${pushId}`);

  // DescribeRefreshTasks returns tasks under "Tasks.CDNTask" (NOT Tasks.Task).
  for (let attempt = 0; attempt < 45; attempt += 1) {
    await new Promise((r) => setTimeout(r, 20000));
    const desc = await popCall('DescribeRefreshTasks', { TaskId: String(pushId) });
    const tasks = (desc.Tasks && (desc.Tasks.CDNTask || desc.Tasks.Task)) || [];
    if (!tasks.length) {
      console.log(`[oss-cdn] warmup poll ${attempt}: no tasks yet`);
      continue;
    }
    const states = tasks.map((t) => `${t.Status}/${t.Process}`);
    console.log(`[oss-cdn] warmup poll ${attempt}: ${states.join(' ')}`);
    if (tasks.length >= urls.length && tasks.every((t) => t.Status === 'Complete' && String(t.Process).trim() === '100%')) {
      console.log('[oss-cdn] CDN warmup Complete/100%');
      return;
    }
  }
  fail('CDN warmup did not reach Complete/100% within timeout');
}

async function ossPut(bucket, objectName, filePath, headers) {
  const accessKeyId = env('OSS_ACCESS_KEY_ID');
  const accessKeySecret = env('OSS_ACCESS_KEY_SECRET');
  const date = new Date().toUTCString();
  const body = fs.readFileSync(filePath);
  const contentType = headers['Content-Type'];
  const cacheControl = headers['Cache-Control'];
  const contentDisposition = headers['Content-Disposition'];

  // OSS v1 signature rules:
  // - Content-Type goes ONLY in its fixed position (line 3 of stringToSign).
  // - Standard headers (cache-control, content-disposition, ...) are NOT signed.
  // - Only x-oss-* headers enter the CanonicalizedOSSHeaders block.
  const ossHeaders = {
    'x-oss-object-acl': 'public-read',
  };
  const sortedHeaderKeys = Object.keys(ossHeaders).sort();
  const canonicalOssHeaders = sortedHeaderKeys
    .map((k) => `${k}:${ossHeaders[k].trim()}\n`)
    .join('');
  const resource = `/${bucket}/${objectName}`;
  const stringToSign = [
    'PUT',
    '', // Content-MD5
    contentType,
    date,
    canonicalOssHeaders + resource,
  ].join('\n');
  const signature = hmacSha1(accessKeySecret, stringToSign);

  const url = `https://${bucket}.${OSS_HOST_SUFFIX}/${objectName}`;
  const requestHeaders = {
    Authorization: `OSS ${accessKeyId}:${signature}`,
    Date: date,
    'Content-Length': String(body.length),
    'Content-Type': contentType,
    'Cache-Control': cacheControl,
  };
  if (contentDisposition) requestHeaders['Content-Disposition'] = contentDisposition;
  Object.assign(requestHeaders, ossHeaders);
  const res = await fetch(url, {
    method: 'PUT',
    headers: requestHeaders,
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    fail(`OSS PUT ${objectName} HTTP ${res.status}: ${text.slice(0, 400)}`);
  }

  // Read-back verification: object exists, size matches, headers applied.
  const head = await fetch(url, { method: 'HEAD' });
  if (!head.ok) fail(`OSS HEAD ${objectName} HTTP ${head.status}`);
  const remoteSize = Number(head.headers.get('content-length'));
  if (remoteSize !== body.length) {
    fail(`OSS ${objectName} size mismatch: remote=${remoteSize} local=${body.length}`);
  }
  const remoteCache = head.headers.get('cache-control');
  if (remoteCache !== cacheControl) {
    fail(`OSS ${objectName} cache-control mismatch: remote=${remoteCache}`);
  }
  console.log(`[oss-cdn] uploaded ${objectName} (${body.length} bytes, cache=${cacheControl})`);
}

async function main() {
  const version = readVersion();
  const bucket = env('OSS_BUCKET');

  const macDir = 'release-assets/macos';
  const winDir = 'release-assets/windows';

  const items = [
    // local file, oss object name, yaml flag, content type
    [path.join(macDir, `IDBots-${version}-arm64.dmg`), `IDBots-${version}-arm64.dmg`, false, 'application/x-apple-diskimage'],
    [path.join(winDir, `IDBots Setup ${version}.exe`), `IDBots-Setup-${version}.exe`, false, 'application/vnd.microsoft.portable-executable'],
    [path.join(macDir, 'latest-mac.yml'), 'latest-mac.yml', true, 'application/x-yaml'],
    [path.join(winDir, 'oss-latest.yml'), 'latest.yml', true, 'application/x-yaml'],
  ];
  for (const [p] of items) {
    if (!fs.existsSync(p)) fail(`missing artifact: ${p}`);
  }

  for (const [local, objectName, isYaml, contentType] of items) {
    const headers = isYaml
      ? {
          'Cache-Control': YAML_CACHE,
          'Content-Type': contentType,
        }
      : {
          'Cache-Control': IMMUTABLE_CACHE,
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${objectName}"`,
        };
    await ossPut(bucket, objectName, local, headers);
  }

  await cdnWarmup([
    `https://download.idbots.ai/IDBots-${version}-arm64.dmg`,
    `https://download.idbots.ai/IDBots-Setup-${version}.exe`,
  ]);

  console.log('[oss-cdn] ALL_OK');
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
