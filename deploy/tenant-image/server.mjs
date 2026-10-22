#!/usr/bin/env node
// WS-C C1 — STAND-IN tenant server. Implements the C1/C2 contract surface so
// CI, the control plane, and network-isolation checks have something real to
// talk to before WS-A ships the actual tenant image. NOT the IDBots backend.
// Dependency-free (Node >= 24) so the image stays tiny and scannable.

import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.IDBOTS_GATEWAY_PORT || 8790);
const TENANT_ID = process.env.IDBOTS_TENANT_ID || '';
const GATEWAY_SECRET = process.env.IDBOTS_GATEWAY_SECRET || '';
const VERSION = process.env.IDBOTS_IMAGE_VERSION || '0.0.0';
const COMMIT = process.env.IDBOTS_IMAGE_COMMIT || 'unknown';
const CONTRACT = process.env.IDBOTS_CONTRACT_VERSION || '1.0.0';
const MAX_FRAME = 1024 * 1024; // C2: 1 MiB inbound frame limit
const MAX_CLIENTS = 3; // C2: a fourth socket is closed with 4009

function log(level, component, msg, extra) {
  const line = { ts: new Date().toISOString(), level, tenant: TENANT_ID || 't_unset', component, msg };
  if (extra) line.detail = extra;
  process.stdout.write(JSON.stringify(line) + '\n');
}

// C1: required environment. Fail fast like the real image must.
const missing = [];
if (process.env.IDBOTS_SERVER_MODE !== '1') missing.push('IDBOTS_SERVER_MODE=1');
if (!TENANT_ID) missing.push('IDBOTS_TENANT_ID');
if (!GATEWAY_SECRET) missing.push('IDBOTS_GATEWAY_SECRET');
if (missing.length) {
  log('error', 'boot', 'missing required environment', { missing });
  process.exit(1);
}

function secretOk(value) {
  const a = crypto.createHash('sha256').update(String(value || '')).digest();
  const b = crypto.createHash('sha256').update(GATEWAY_SECRET).digest();
  return crypto.timingSafeEqual(a, b);
}

function readyPayload() {
  return {
    ready: true,
    phase: 'ready',
    version: VERSION,
    commit: COMMIT,
    contractVersion: CONTRACT,
    onboarding: {
      identity: 'done',
      llmProvider: 'done',
      twinMetabot: 'done',
      workspace: 'done',
      trafficAccount: 'done',
      redeemCode: 'skipped',
      globalMetaId: 'idstand-in',
      twinMetabotId: 1,
    },
    error: null,
  };
}

// ---------------------------------------------------------------- WebSocket --
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const sockets = new Set();

function wsSend(sock, obj) {
  if (sock.destroyed) return;
  const payload = Buffer.from(JSON.stringify(obj));
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  sock.write(Buffer.concat([header, payload]));
}

function wsClose(sock, code, reason = '') {
  if (sock.destroyed) return;
  const r = Buffer.from(reason);
  const frame = Buffer.alloc(4 + r.length);
  frame[0] = 0x88;
  frame[1] = 2 + r.length;
  frame.writeUInt16BE(code, 2);
  r.copy(frame, 4);
  try { sock.write(frame); } catch { /* closing anyway */ }
  sock.end();
}

function wsPong(sock, payload) {
  if (sock.destroyed) return;
  const len = payload.length;
  const header = len < 126 ? Buffer.from([0x8a, len]) : null;
  if (!header) return; // control frames are <= 125 by spec; ignore abuse
  sock.write(Buffer.concat([header, payload]));
}

function handleWsFrame(state, frame) {
  const { fin, opcode, payload } = frame;
  if (!fin) { wsClose(state.sock, 1003, 'fragmentation unsupported'); return; }
  if (opcode === 0x8) { // close
    wsClose(state.sock, 1000);
    cleanupSocket(state);
    return;
  }
  if (opcode === 0x9) { wsPong(state.sock, payload); return; }
  if (opcode === 0xa) { state.lastPong = Date.now(); return; }
  if (opcode !== 0x1) { wsClose(state.sock, 1003, 'text frames only'); return; }

  let msg;
  try { msg = JSON.parse(payload.toString('utf8')); } catch {
    wsSend(state.sock, { v: 1, type: 'result', id: null, ok: false, error: { code: 'INVALID_FRAME', message: 'not valid JSON', retryable: false } });
    return;
  }
  if (msg?.v !== 1 || typeof msg?.type !== 'string') {
    wsSend(state.sock, { v: 1, type: 'result', id: msg?.id ?? null, ok: false, error: { code: 'INVALID_FRAME', message: 'missing v/type', retryable: false } });
    return;
  }
  if (msg.type === 'ping') {
    wsSend(state.sock, { v: 1, type: 'pong', ts: msg.ts });
    return;
  }
  if (msg.type === 'invoke') {
    // Stand-in echo: the real image dispatches to allowlisted IPC handlers.
    wsSend(state.sock, { v: 1, type: 'result', id: msg.id, ok: true, value: { echo: true, channel: msg.channel, args: msg.args ?? [] } });
    return;
  }
}

// Incremental frame parser: accumulates until a full frame is available.
function feedWsData(state, chunk) {
  state.buf = state.buf ? Buffer.concat([state.buf, chunk]) : chunk;
  for (;;) {
    const buf = state.buf;
    if (!buf || buf.length < 2) return;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return;
      len = Number(buf.readBigUInt64BE(2)); off = 10;
    }
    if (len > MAX_FRAME) {
      wsSend(state.sock, { v: 1, type: 'event', channel: 'gateway:error', args: [{ code: 'PAYLOAD_TOO_LARGE', message: 'frame over 1 MiB', retryable: false }] });
      // Skip the oversized frame when fully buffered; otherwise drop the
      // connection's buffer and wait for it to drain (socket stays open).
      const total = off + (masked ? 4 : 0) + len;
      if (buf.length >= total) { state.buf = buf.subarray(total); continue; }
      state.skipBytes = total - buf.length;
      state.buf = null;
      return;
    }
    if (state.skipBytes > 0) return;
    const maskLen = masked ? 4 : 0;
    if (buf.length < off + maskLen + len) return;
    let payload = buf.subarray(off + maskLen, off + maskLen + len);
    if (masked) {
      const mask = buf.subarray(off, off + 4);
      const unmasked = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ mask[i & 3];
      payload = unmasked;
    }
    state.buf = buf.subarray(off + maskLen + len);
    handleWsFrame(state, { fin, opcode, payload });
  }
}

function cleanupSocket(state) {
  clearInterval(state.pingTimer);
  sockets.delete(state);
  log('info', 'ws', 'client disconnected', { clients: sockets.size });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (code, obj, headers = {}) => {
    res.writeHead(code, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(obj));
  };

  if (url.pathname === '/healthz' && req.method === 'GET') {
    return json(200, { ok: true }); // C1: never gated, never blocks on DB
  }
  if (!secretOk(req.headers['x-idbots-gateway-secret'])) {
    res.writeHead(401); // C1: no body detail
    return res.end();
  }
  if (url.pathname === '/readyz' && req.method === 'GET') {
    return json(200, readyPayload());
  }
  if (url.pathname.startsWith('/gateway/v1/files/')) {
    res.writeHead(404); // C2: bad/expired/foreign token is a 404
    return res.end();
  }
  if (url.pathname === '/gateway/v1/upload' && req.method === 'POST') {
    // C2: max 25 MB, stored under /data/workspace/uploads/{yyyy-mm-dd}/.
    const name = (url.searchParams.get('name') || 'file').replace(/[^\w.-]+/g, '_').slice(-80);
    const day = new Date().toISOString().slice(0, 10);
    const dir = `${process.env.IDBOTS_WORKSPACE_PATH || '/data/workspace'}/uploads/${day}`;
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${crypto.randomUUID()}-${name}`);
    const MAX = 25 * 1000 * 1000; // C2 "25 MB" (SI) — matches the edge's 26MB outer gate
    let size = 0;
    let tooBig = false;
    const out = fs.createWriteStream(dest);
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX) { tooBig = true; break; }
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      }
    } catch (err) {
      // The edge (or the client) aborted the body mid-stream — the caller is
      // already gone; clean up and move on, never crash the process.
      out.destroy();
      fs.rmSync(dest, { force: true });
      log('warn', 'upload', 'request body aborted mid-stream', { received: size, error: String(err?.code || err) });
      return;
    }
    if (tooBig) {
      out.destroy();
      fs.rmSync(dest, { force: true });
      return json(413, { error: { code: 'PAYLOAD_TOO_LARGE', message: 'upload exceeds 25 MB' } });
    }
    out.end();
    await new Promise((r) => out.on('finish', r));
    if (res.writableEnded) return;
    return json(200, { path: dest, size, mime: req.headers['content-type'] || 'application/octet-stream' });
  }
  if (url.pathname.startsWith('/app/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end('<!doctype html><title>IDBots stand-in tenant</title><h1>IDBots stand-in tenant</h1><p>Waiting for the WS-A image.</p>');
  }
  res.writeHead(404);
  res.end();
});

server.on('upgrade', (req, sock) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/gateway/v1/ws' ||
      (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    sock.destroy();
    return;
  }
  if (!secretOk(req.headers['x-idbots-gateway-secret'])) {
    sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    sock.destroy();
    return;
  }
  if (sockets.size >= MAX_CLIENTS) {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    wsClose(sock, 4009, 'too many clients');
    return;
  }
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock.setNoDelay(true);

  const state = { sock, buf: null, skipBytes: 0, lastPong: Date.now(), pingTimer: null };
  sockets.add(state);
  log('info', 'ws', 'client connected', { clients: sockets.size });

  wsSend(sock, {
    v: 1, type: 'welcome',
    contractVersion: CONTRACT, appVersion: VERSION, tenantId: TENANT_ID,
    serverTime: Date.now(), ready: true, phase: 'ready',
  });

  // C2: server pings every 25 s, closes a socket silent for 60 s.
  state.pingTimer = setInterval(() => {
    if (Date.now() - state.lastPong > 60_000) {
      log('warn', 'ws', 'client keepalive timeout');
      sock.destroy();
      cleanupSocket(state);
      return;
    }
    if (sock.destroyed) return;
    const payload = Buffer.alloc(4).fill(0);
    sock.write(Buffer.concat([Buffer.from([0x89, payload.length]), payload]));
  }, 25_000);

  sock.on('data', (chunk) => {
    if (state.skipBytes > 0) {
      const skip = Math.min(state.skipBytes, chunk.length);
      state.skipBytes -= skip;
      if (skip < chunk.length) feedWsData(state, chunk.subarray(skip));
      return;
    }
    try { feedWsData(state, chunk); } catch (err) {
      log('error', 'ws', 'frame handling error', { error: String(err) });
      wsClose(sock, 1011);
      cleanupSocket(state);
    }
  });
  sock.on('close', () => cleanupSocket(state));
  sock.on('error', () => cleanupSocket(state));
});

server.listen(PORT, '0.0.0.0', () => {
  log('info', 'boot', `stand-in tenant listening on 0.0.0.0:${PORT}`, {
    version: VERSION, commit: COMMIT, contractVersion: CONTRACT,
  });
});

let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    log('info', 'lifecycle', `${sig} received — closing with 4012`);
    server.close();
    for (const state of [...sockets]) {
      wsClose(state.sock, 4012, 'server restarting');
      cleanupSocket(state);
    }
    // C1: exit within 20 s; the stand-in has nothing to checkpoint.
    setTimeout(() => process.exit(0), 250).unref();
  });
}
