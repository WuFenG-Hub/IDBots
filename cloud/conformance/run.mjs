#!/usr/bin/env node
/**
 * REQ-A-30 — C2 gateway conformance kit.
 *
 * Runnable suite that checks C2 behavior against ANY running gateway:
 * desktop dev mode, a tenant container, or (WS-B later) the control plane.
 *
 *   node cloud/conformance/run.mjs \
 *     --url ws://127.0.0.1:8790/gateway/v1/ws \
 *     --secret <gateway-secret> \
 *     [--tenant <tenant-id>] [--timeout-ms 20000]
 *
 * One line per check: `PASS|FAIL|SKIP <name> — <detail>`; exit code is
 * non-zero when any check FAILs (SKIP never fails the run).
 *
 * The only dependency is `ws`. It is imported through createRequire so the
 * kit resolves `ws` from the nearest node_modules walking up from THIS file
 * (the repo root's node_modules when run in-tree) — copy cloud/conformance/
 * next to any checkout/install that has `ws` and it keeps working.
 *
 * The secret comes from argv only and is never printed.
 *
 * Contract: docs/cloud-mobile/01-interface-contracts.md (C1 HTTP endpoints,
 * C2 frames/limits/errors) and 02-ipc-allowlist-v1.md (tiers, restrictions).
 */

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

// Resolved against this file's location: repo-root node_modules in-tree, or
// whatever nearby install carries ws when the kit is copied elsewhere.
const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { url: '', secret: '', tenant: '', timeoutMs: 20_000 };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--url') args.url = value ?? '';
    else if (key === '--secret') args.secret = value ?? '';
    else if (key === '--tenant') args.tenant = value ?? '';
    else if (key === '--timeout-ms') args.timeoutMs = Number(value) || 20_000;
    else if (key === '--help' || key === '-h') {
      console.log('usage: node cloud/conformance/run.mjs --url ws://host:port/gateway/v1/ws --secret <secret> [--tenant <id>] [--timeout-ms 20000]');
      process.exit(0);
    }
  }
  if (!args.url || !args.secret) {
    console.error('conformance: --url and --secret are required (see --help)');
    process.exit(2);
  }
  return args;
}

const ARGS = parseArgs(process.argv);
const HTTP_ORIGIN = ARGS.url
  .replace(/^ws:/, 'http:')
  .replace(/^wss:/, 'https:')
  .replace(/\/gateway\/v1\/ws\/?$/, '')
  .replace(/\/ws\/?$/, '');
const SECRET_HEADER = 'X-IDBots-Gateway-Secret';

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const outcomes = [];

function report(status, name, detail) {
  outcomes.push({ status, name });
  console.log(`${status} ${name} — ${detail}`);
}

async function check(name, fn) {
  try {
    const result = await fn();
    report(result.status, name, result.detail);
  } catch (error) {
    report('FAIL', name, error instanceof Error ? error.message : String(error));
  }
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// WebSocket client
// ---------------------------------------------------------------------------

let invokeCounter = 0;

function connect({ clientId = `conformance-${process.pid}` } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(ARGS.url, {
      headers: {
        [SECRET_HEADER]: ARGS.secret,
        'X-IDBots-Client-Id': clientId,
      },
    });
    const pending = new Map();
    const events = [];
    const unmatchedResults = [];
    const welcomeWaiters = [];
    let welcome = null;
    let open = false;
    const timers = new Set();

    const armTimer = (fn, ms) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        fn();
      }, ms);
      timers.add(timer);
      return timer;
    };

    ws.on('message', (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (frame.type === 'welcome') {
        welcome = frame;
        for (const waiter of welcomeWaiters.splice(0)) waiter(frame);
      } else if (frame.type === 'result') {
        const entry = pending.get(frame.id);
        if (entry) {
          pending.delete(frame.id);
          clearTimeout(entry.timer);
          timers.delete(entry.timer);
          entry.resolve(frame);
        } else {
          unmatchedResults.push(frame);
        }
      } else {
        events.push(frame);
      }
    });
    ws.on('open', () => {
      open = true;
      resolve(client);
    });
    ws.on('error', (error) => {
      if (!open) reject(error);
      // After connect, mid-run errors surface through invoke/event timeouts.
    });

    const client = {
      ws,
      events,
      welcome: () => (welcome ? Promise.resolve(welcome) : new Promise((r) => welcomeWaiters.push(r))),
      invoke(channel, args = [], timeoutMs = ARGS.timeoutMs) {
        const id = `conf-${++invokeCounter}`;
        ws.send(JSON.stringify({ v: 1, type: 'invoke', id, channel, args }));
        return new Promise((resolveInvoke, rejectInvoke) => {
          const timer = armTimer(() => {
            pending.delete(id);
            rejectInvoke(new Error(`timed out after ${timeoutMs}ms waiting for a result on '${channel}'`));
          }, timeoutMs);
          pending.set(id, { resolve: resolveInvoke, timer });
        });
      },
      /** Result frames for ids we never invoked (e.g. the oversize-frame reply). */
      waitForUnmatchedResult(id, timeoutMs = ARGS.timeoutMs) {
        return new Promise((resolveWait) => {
          const deadline = Date.now() + timeoutMs;
          const poll = () => {
            const index = unmatchedResults.findIndex((frame) => frame.id === id);
            if (index >= 0) {
              resolveWait(unmatchedResults.splice(index, 1)[0]);
              return;
            }
            if (Date.now() >= deadline) {
              resolveWait(null);
              return;
            }
            armTimer(poll, 25);
          };
          poll();
        });
      },
      sendRaw(text) {
        ws.send(text);
      },
      waitFor(ms) {
        return new Promise((r) => armTimer(r, ms));
      },
      close() {
        for (const timer of timers) clearTimeout(timer);
        try {
          ws.close(1000);
        } catch {
          // Already closing.
        }
      },
    };
  });
}

/**
 * Attempt a connection expecting the HTTP upgrade to be rejected with a
 * status. `secret: null` sends no secret header at all.
 */
function connectExpectingRejection({ secret, status, clientId }) {
  return new Promise((resolve) => {
    const headers = { 'X-IDBots-Client-Id': clientId };
    if (secret !== null) headers[SECRET_HEADER] = secret;
    const ws = new WebSocket(ARGS.url, { headers });
    let done = false;
    const finish = (ok, detail) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      resolve({ ok, detail });
    };
    const timer = setTimeout(
      () => finish(false, `no rejection: connection stayed open (expected HTTP ${status})`),
      ARGS.timeoutMs,
    );
    ws.on('open', () => {
      finish(false, `connection opened (expected HTTP ${status})`);
    });
    ws.on('error', (error) => {
      const text = error instanceof Error ? error.message : String(error);
      if (text.includes(String(status))) finish(true, `upgrade rejected with HTTP ${status}`);
      else finish(false, `expected HTTP ${status}, got: ${text}`);
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP helpers (gateway HTTP routes live on the same origin as the WS)
// ---------------------------------------------------------------------------

async function httpRequest(method, pathname, { headers = {}, body } = {}) {
  return fetch(`${HTTP_ORIGIN}${pathname}`, {
    method,
    headers: {
      [SECRET_HEADER]: ARGS.secret,
      ...headers,
    },
    body,
  });
}

/** C2 File Download returns a tenant- or control-plane-relative URL; both forms resolve here. */
function resolveFileUrl(url) {
  if (/^https?:\/\//.test(url)) return url;
  let pathname = url;
  if (pathname.startsWith('/files/')) {
    // Control-plane-relative form (C3): the tenant route is
    // /gateway/v1/files/{token}.
    pathname = `/gateway/v1/files/${pathname.slice('/files/'.length)}`;
  }
  return `${HTTP_ORIGIN}${pathname}`;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function main() {
  console.log(`conformance: target ${ARGS.url} (http ${HTTP_ORIGIN}), timeout ${ARGS.timeoutMs}ms`);

  // -- 1. auth ---------------------------------------------------------------
  await check('auth', async () => {
    const missing = await connectExpectingRejection({
      secret: null,
      status: 401,
      clientId: `conformance-nosecret-${process.pid}`,
    });
    if (!missing.ok) return { status: 'FAIL', detail: `missing secret: ${missing.detail}` };
    const wrong = await connectExpectingRejection({
      secret: `${ARGS.secret}wrong`,
      status: 401,
      clientId: `conformance-wrongsecret-${process.pid}`,
    });
    if (!wrong.ok) return { status: 'FAIL', detail: `wrong secret: ${wrong.detail}` };
    return { status: 'PASS', detail: `${missing.detail}; ${wrong.detail}` };
  });

  // -- 2. welcome --------------------------------------------------------------
  const client = await connect();
  await check('welcome', async () => {
    const welcome = await client.welcome();
    const problems = [];
    if (welcome.v !== 1) problems.push(`v is ${JSON.stringify(welcome.v)}, expected 1`);
    for (const field of ['contractVersion', 'appVersion', 'tenantId', 'phase']) {
      if (typeof welcome[field] !== 'string' || !welcome[field]) problems.push(`${field} missing/not a string`);
    }
    if (typeof welcome.serverTime !== 'number' || welcome.serverTime <= 0) problems.push('serverTime missing/not a number');
    if (typeof welcome.ready !== 'boolean') problems.push('ready is not a boolean');
    if (ARGS.tenant && welcome.tenantId !== ARGS.tenant) {
      problems.push(`tenantId '${welcome.tenantId}' does not match --tenant '${ARGS.tenant}'`);
    }
    if (problems.length > 0) return { status: 'FAIL', detail: problems.join('; ') };
    return { status: 'PASS', detail: `contract ${welcome.contractVersion}, app ${welcome.appVersion}, phase ${welcome.phase}, ready=${welcome.ready}` };
  });

  // -- 3. invoke-allowed ---------------------------------------------------------
  await check('invoke-allowed', async () => {
    const result = await client.invoke('app:getVersion');
    if (!result.ok) return { status: 'FAIL', detail: `unexpected gateway error: ${result.error.code}: ${result.error.message}` };
    return { status: 'PASS', detail: `app:getVersion ok, value=${JSON.stringify(result.value)}` };
  });

  // -- 4. invoke-denied ------------------------------------------------------------
  await check('invoke-denied', async () => {
    const failures = [];
    const denied = [
      ['cowork:session:exportTranscript', 'N tier'],
      ['window:isMaximized', 'S tier'],
    ];
    for (const [channel, tier] of denied) {
      const result = await client.invoke(channel, [{ sessionId: 'conformance' }]);
      if (result.ok) failures.push(`${channel} (${tier}) was ALLOWED (value=${JSON.stringify(result.value)?.slice(0, 80)})`);
      else if (result.error.code !== 'CHANNEL_NOT_ALLOWED') {
        failures.push(`${channel} (${tier}) gave ${result.error.code}, expected CHANNEL_NOT_ALLOWED`);
      }
    }
    if (failures.length > 0) return { status: 'FAIL', detail: failures.join('; ') };
    return { status: 'PASS', detail: 'N-tier cowork:session:exportTranscript and S-tier window:isMaximized both rejected with CHANNEL_NOT_ALLOWED' };
  });

  // -- 5. invoke-not-found ------------------------------------------------------------
  report('SKIP', 'invoke-not-found', 'a correct server has no allowlisted-but-unregistered channel (CHANNEL_NOT_FOUND is covered by tests/gatewayServer.test.mjs)');

  // -- 6. arg-restricted (AC-A-6 negative) ------------------------------------------------
  await check('arg-restricted', async () => {
    const result = await client.invoke('cowork:session:start', [{ cwd: '/etc', prompt: 'noop' }]);
    if (result.ok) return { status: 'FAIL', detail: `cwd '/etc' was accepted (value=${JSON.stringify(result.value)?.slice(0, 80)})` };
    if (result.error.code !== 'ARG_RESTRICTED') {
      return { status: 'FAIL', detail: `expected ARG_RESTRICTED, got ${result.error.code}: ${result.error.message}` };
    }
    return { status: 'PASS', detail: `cwd outside the workspace rejected: ${result.error.message}` };
  });

  // -- 7. payload-limit ---------------------------------------------------------------------
  await check('payload-limit', async () => {
    const pad = 'x'.repeat(1024 * 1024 + 1024);
    client.sendRaw(JSON.stringify({ v: 1, type: 'invoke', id: 'conf-oversize', channel: 'app:getVersion', args: [pad] }));
    const oversized = await client.waitForUnmatchedResult('conf-oversize');
    if (!oversized) return { status: 'FAIL', detail: 'no result returned for the >1 MiB frame' };
    if (oversized.ok) return { status: 'FAIL', detail: 'oversized frame was executed instead of rejected' };
    if (oversized.error.code !== 'PAYLOAD_TOO_LARGE') {
      return { status: 'FAIL', detail: `expected PAYLOAD_TOO_LARGE, got ${oversized.error.code}: ${oversized.error.message}` };
    }
    const after = await client.invoke('app:getVersion');
    if (!after.ok) return { status: 'FAIL', detail: `socket unusable after oversize frame: ${after.error.code}: ${after.error.message}` };
    return { status: 'PASS', detail: '>1 MiB frame rejected with PAYLOAD_TOO_LARGE; socket still answers app:getVersion' };
  });

  // -- 8. file-roundtrip ------------------------------------------------------------------------
  await check('file-roundtrip', async () => {
    const content = `conformance upload ${Date.now()}\nline two\n`;
    const sha256 = sha256Hex(Buffer.from(content, 'utf8'));

    const upload = await httpRequest('POST', `/gateway/v1/upload?name=${encodeURIComponent('conformance.txt')}`, {
      headers: { 'Content-Type': 'text/plain' },
      body: content,
    });
    if (upload.status !== 200) return { status: 'FAIL', detail: `upload answered HTTP ${upload.status}, expected 200` };
    const uploaded = await upload.json();

    const sign = await client.invoke('gateway:file:sign', [{ path: uploaded.path, disposition: 'attachment' }]);
    if (!sign.ok) return { status: 'FAIL', detail: `gateway:file:sign failed: ${sign.error.code}: ${sign.error.message}` };
    if (typeof sign.value?.url !== 'string' || !sign.value.url) {
      return { status: 'FAIL', detail: `gateway:file:sign returned no url: ${JSON.stringify(sign.value)?.slice(0, 120)}` };
    }
    const fileUrl = new URL(resolveFileUrl(sign.value.url));

    const full = await httpRequest('GET', fileUrl.pathname + fileUrl.search);
    if (full.status !== 200) return { status: 'FAIL', detail: `GET ${sign.value.url} answered HTTP ${full.status}` };
    const fullBytes = Buffer.from(await full.arrayBuffer());
    if (sha256Hex(fullBytes) !== sha256) return { status: 'FAIL', detail: 'downloaded bytes differ from the uploaded file (sha256 mismatch)' };

    const tamperedPath = fileUrl.pathname.replace(/[^/]$/, (c) => (c === 'a' ? 'b' : 'a'));
    const tampered = await httpRequest('GET', tamperedPath);
    if (tampered.status !== 404) return { status: 'FAIL', detail: `tampered token answered HTTP ${tampered.status}, expected 404` };

    const ranged = await httpRequest('GET', fileUrl.pathname, { headers: { Range: 'bytes=0-3' } });
    if (ranged.status !== 206) return { status: 'FAIL', detail: `Range request answered HTTP ${ranged.status}, expected 206` };
    const rangedBytes = Buffer.from(await ranged.arrayBuffer());
    if (rangedBytes.length !== 4 || !fullBytes.subarray(0, 4).equals(rangedBytes)) {
      return { status: 'FAIL', detail: `Range body mismatch: got ${rangedBytes.length} bytes` };
    }
    return { status: 'PASS', detail: `upload → sign → GET round-trip sha256 verified (${content.length} bytes), tampered token 404, Range → 206` };
  });

  // -- 9. upload-limits ----------------------------------------------------------------------------
  await check('upload-limits', async () => {
    const blocked = await httpRequest('POST', `/gateway/v1/upload?name=${encodeURIComponent('evil.exe')}`, {
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('MZ fake'),
    });
    if (blocked.status !== 415) return { status: 'FAIL', detail: `.exe upload answered HTTP ${blocked.status}, expected 415` };
    return { status: 'PASS', detail: '.exe upload rejected with 415 (413 is covered by unit tests; no 25 MB body sent)' };
  });

  // -- 10. event-during-chat --------------------------------------------------------------------------
  await check('event-during-chat', async () => {
    const windowMs = Math.min(ARGS.timeoutMs, 20_000);
    let result;
    try {
      result = await client.invoke('cowork:session:start', [{ prompt: 'Say OK' }], ARGS.timeoutMs);
    } catch (error) {
      return { status: 'FAIL', detail: `cowork:session:start produced no result: ${error instanceof Error ? error.message : error}` };
    }
    if (!result.ok) {
      const message = `${result.error.code}: ${result.error.message}`;
      if (/provider|model|config|llm|quota/i.test(message)) {
        return { status: 'SKIP', detail: `session start failed with a provider/config error (no LLM configured?): ${message}` };
      }
      return { status: 'FAIL', detail: `session start failed: ${message}` };
    }
    if (result.value && typeof result.value === 'object' && result.value.success === false) {
      const message = String(result.value.error ?? '');
      if (/provider|model|config|llm|quota/i.test(message)) {
        return { status: 'SKIP', detail: `session start returned a provider/config failure (no LLM configured?): ${message.slice(0, 160)}` };
      }
    }
    const deadline = Date.now() + windowMs;
    let sawStreamEvent = false;
    while (Date.now() < deadline) {
      const frame = client.events.find((f) => f.type === 'event' && typeof f.channel === 'string' && f.channel.startsWith('cowork:stream:'));
      if (frame) {
        sawStreamEvent = true;
        break;
      }
      await client.waitFor(100);
    }
    if (!sawStreamEvent) {
      return { status: 'FAIL', detail: `no cowork:stream:* event arrived within ${windowMs}ms of session start` };
    }
    return { status: 'PASS', detail: `cowork:stream:* event delivered within ${windowMs}ms of session start` };
  });

  // -- 11. reconnect-resync ------------------------------------------------------------------------------
  await check('reconnect-resync', async () => {
    const second = await connect({ clientId: `conformance-second-${process.pid}` });
    await second.welcome();
    second.close();
    await client.waitFor(150);

    const third = await connect({ clientId: `conformance-third-${process.pid}` });
    const welcomeAgain = await third.welcome();
    if (!welcomeAgain || welcomeAgain.type !== 'welcome') {
      return { status: 'FAIL', detail: 'reconnect did not produce a second welcome frame' };
    }

    const pending = await third.invoke('mobile:permission:listPending');
    if (!pending.ok) return { status: 'FAIL', detail: `mobile:permission:listPending failed: ${pending.error.code}: ${pending.error.message}` };

    const live = await third.invoke('cowork:stream:liveContent', [{ sessionId: 'conformance-bogus', messageId: 'conformance-bogus' }]);
    if (!live.ok) return { status: 'FAIL', detail: `cowork:stream:liveContent (bogus ids) crashed the server: ${live.error.code}: ${live.error.message}` };

    third.close();
    return { status: 'PASS', detail: 'second socket welcomed, reconnect welcomed again, resync channels answer (bogus liveContent produced a result)' };
  });

  // -- 12. invoke-timeout -------------------------------------------------------------------------------------
  report('SKIP', 'invoke-timeout', 'covered by unit tests (tests/gatewayServer.test.mjs); the frozen allowlist offers no channel a client can legitimately force past its timeout');

  // -- Summary ----------------------------------------------------------------------------------------------------
  client.close();
  const pass = outcomes.filter((o) => o.status === 'PASS').length;
  const fail = outcomes.filter((o) => o.status === 'FAIL').length;
  const skip = outcomes.filter((o) => o.status === 'SKIP').length;
  console.log(`conformance: ${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`conformance: fatal: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
