#!/usr/bin/env node
/**
 * AC-E-2 gateway-backed e2e harness.
 *
 * Proves the mobile app runs against the REAL C2 gateway path (REQ-E-2/3
 * wiring, not the mock): a standalone gateway fixture is built from the
 * compiled dist-electron/main/gateway/server.js with in-memory invoke
 * handlers that echo the mock bridge's cowork protocol (session start →
 * streamed assistant reply over cowork:stream:* events). The dev server runs
 * WITHOUT VITE_MOBILE_MOCK on port 5197; its /ws proxy (REQ-E-9) forwards to
 * the fixture with the secret header the browser WebSocket cannot carry.
 *
 * Steps:
 *   (a) build the electron main bundle if dist-electron is missing/stale
 *   (b) start the gateway fixture on 127.0.0.1:8790 with a generated secret
 *   (c) spawn dev:mobile:real on 5197 with IDBOTS_GATEWAY_SECRET set
 *   (d) run `playwright test --grep @gateway`
 *
 * For a human-driven run instead: start the desktop dev gateway with
 * IDBOTS_GATEWAY_DEV=1 (it prints the generated secret once), then
 * `IDBOTS_GATEWAY_SECRET=<secret> pnpm run dev:mobile:real` and open
 * http://localhost:5176/app/.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATEWAY_PORT = 8790;
const APP_PORT = process.env.E2E_PORT || '5197';
const BASE_URL = `http://localhost:${APP_PORT}`;
const SECRET = process.env.IDBOTS_GATEWAY_SECRET || crypto.randomBytes(32).toString('base64url');
const TENANT = 't_e2egateway0000000001';

// ---------------------------------------------------------------------------
// (a) compiled gateway server
// ---------------------------------------------------------------------------

const serverJs = path.join(repoRoot, 'dist-electron', 'main', 'gateway', 'server.js');
if (!fs.existsSync(serverJs)) {
  console.log('[gateway-e2e] dist-electron/main/gateway/server.js missing — running compile:electron…');
  const compiled = spawnSync('pnpm', ['run', 'compile:electron'], { cwd: repoRoot, stdio: 'inherit' });
  if (compiled.status !== 0 || !fs.existsSync(serverJs)) {
    console.error('[gateway-e2e] compile:electron did not produce the gateway server bundle.');
    process.exit(1);
  }
}
const server = require(serverJs);
const fileSignCore = require(path.join(repoRoot, 'dist-electron', 'main', 'gateway', 'fileSign.js'));

// ---------------------------------------------------------------------------
// (b) in-memory cowork fixture echoing the mock bridge's protocol
// ---------------------------------------------------------------------------

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-gateway-e2e-')));
const paths = {
  dataRoot: path.join(base, 'data'),
  workspaceRoot: path.join(base, 'data', 'workspace'),
  uploadsRoot: path.join(base, 'data', 'workspace', 'uploads'),
};
fs.mkdirSync(paths.uploadsRoot, { recursive: true });

/**
 * F-11 file delivery is enabled by default so the complete gateway matrix
 * cannot be skipped accidentally. Set GW_FIXTURE_FILE=0 only for a deliberate
 * no-file debugging run. The fixture seeds a deterministic document and
 * appends file:// links to the canned reply — exactly the shape a tenant bot
 * produces after generating a docx/pdf. The e2e spec then proves the mobile UI
 * renders a clickable same-origin /files/{token} download link instead of the
 * dead container path.
 */
const GW_FILE_E2E = process.env.GW_FIXTURE_FILE !== '0';
const FIXTURE_FILE_NAME = 'gateway-e2e-report.docx';
/** Mirror of the payload asserted in e2e/mobile/gateway.spec.ts. */
const FIXTURE_FILE_BYTES = Buffer.from('PK\x03\x04 gateway fixture docx payload 0123456789abcdef');

if (GW_FILE_E2E) {
  fs.writeFileSync(path.join(paths.workspaceRoot, FIXTURE_FILE_NAME), FIXTURE_FILE_BYTES);
}

/** Canned reply streamed by the fixture turn (not UI copy). */
const FIXTURE_REPLY =
  '**Gateway fixture online.**\n\nThis reply streamed over a real C2 gateway socket.' +
  (GW_FILE_E2E
    ? `\n\n文件已生成：[${FIXTURE_FILE_NAME}](file://${path.join(paths.workspaceRoot, FIXTURE_FILE_NAME)})\n\n[工作目录](${paths.workspaceRoot})`
    : '');

const sessions = new Map();
const liveMessages = new Map(); // `${sessionId}${messageId}` -> message
const sessionTimers = new Map(); // sessionId -> timer handles
let sessionSeq = 0;
let messageSeq = 0;
let broadcast = null;

const summaryOf = (session) => ({
  id: session.id,
  title: session.title,
  status: session.status,
  pinned: false,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  metabotId: session.metabotId,
  sessionType: session.sessionType,
  autoOrigin: session.autoOrigin,
});

function clearTurnTimers(sessionId) {
  for (const timer of sessionTimers.get(sessionId) ?? []) clearTimeout(timer);
  sessionTimers.delete(sessionId);
}

/** Streams the canned reply through the same cowork:stream:* events the mock emits. */
function startFixtureTurn(session, userText) {
  const message = {
    id: `gw-msg-${++messageSeq}`,
    type: 'assistant',
    content: '',
    timestamp: Date.now(),
  };
  session.messages.push(message);
  session.status = 'running';
  liveMessages.set(`${session.id}${message.id}`, message);
  if (process.env.GW_FIXTURE_DEBUG) {
    console.log(`[fixture] stream:message ${session.id}/${message.id} (text=${JSON.stringify(userText)})`);
  }
  broadcast('cowork:stream:message', [{ sessionId: session.id, message: { ...message } }]);

  const chunks = [];
  for (let i = 0; i < FIXTURE_REPLY.length; i += 8) chunks.push(FIXTURE_REPLY.slice(i, i + 8));
  // Tests can slow the stream to exercise reload/reconnect recovery without
  // changing the default 40 ms cadence used by the acceptance matrix.
  const streamTokenIntervalMs = Number(process.env.GW_FIXTURE_STREAM_INTERVAL_MS ?? 40);
  const timers = [];
  let accumulated = '';
  chunks.forEach((chunk, index) => {
    timers.push(
      setTimeout(() => {
        if (session.status !== 'running') return;
        accumulated += chunk;
        message.content = accumulated;
        if (index === 0) {
          broadcast('cowork:stream:messageUpdate', [
            { sessionId: session.id, messageId: message.id, content: chunk },
          ]);
        } else {
          broadcast('cowork:stream:messageUpdate', [
            { sessionId: session.id, messageId: message.id, delta: chunk, baseLength: accumulated.length - chunk.length },
          ]);
        }
      }, streamTokenIntervalMs * (index + 1)),
    );
  });
  timers.push(
    setTimeout(() => {
      if (session.status !== 'running') return;
      session.status = 'completed';
      broadcast('cowork:stream:complete', [{ sessionId: session.id, claudeSessionId: session.claudeSessionId }]);
    }, streamTokenIntervalMs * (chunks.length + 1)),
  );
  sessionTimers.set(session.id, timers);
}

const appConfigStore = {
  app_config: { language: 'en', theme: 'system', providers: {}, memoryEnabled: true },
};

async function invokeHandler(channel, clientId, args) {
  if (process.env.GW_FIXTURE_DEBUG) {
    console.log(`[fixture] invoke ${channel} ${JSON.stringify(args)?.slice(0, 120)}`);
  }
  switch (channel) {
    case 'cowork:session:start': {
      const options = args[0] ?? {};
      const now = Date.now();
      const session = {
        id: `gw-session-${++sessionSeq}`,
        title: options.title || 'Gateway chat',
        claudeSessionId: `claude-${sessionSeq}`,
        status: 'idle',
        pinned: false,
        cwd: paths.workspaceRoot,
        systemPrompt: '',
        executionMode: 'auto',
        activeSkillIds: [],
        messages: [],
        createdAt: now,
        updatedAt: now,
        metabotId: options.metabotId ?? null,
        sessionType: 'standard',
        autoOrigin: null,
      };
      sessions.set(session.id, session);
      const text = options.prompt || '';
      if (text) {
        session.messages.push({ id: `gw-msg-${++messageSeq}`, type: 'user', content: text, timestamp: now });
      }
      startFixtureTurn(session, text);
      return { success: true, session: { ...session, messages: [...session.messages] } };
    }
    case 'cowork:session:submitInput': {
      const input = args[0] ?? {};
      const session = sessions.get(input.sessionId);
      if (!session) return { success: false, code: 'session_not_found', error: 'session not found' };
      session.messages.push({ id: `gw-msg-${++messageSeq}`, type: 'user', content: input.text || '', timestamp: Date.now() });
      startFixtureTurn(session, input.text || '');
      return { success: true, mode: 'steer' };
    }
    case 'cowork:session:get': {
      const session = sessions.get(args[0]);
      if (!session) return { success: false, error: 'session not found' };
      const limit = args[1]?.messageLimit ?? 200;
      return { success: true, session: { ...session, messages: session.messages.slice(-limit) } };
    }
    case 'cowork:session:list':
      return { success: true, sessions: [...sessions.values()].map(summaryOf) };
    case 'cowork:session:stop': {
      const session = sessions.get(args[0]);
      if (session) session.status = 'idle';
      return { success: true };
    }
    case 'cowork:stream:liveContent': {
      const key = `${args[0]?.sessionId}${args[0]?.messageId}`;
      return { success: true, content: liveMessages.get(key)?.content ?? '' };
    }
    case 'gateway:file:sign': {
      // Real signing against the compiled pure core (mirrors
      // src/main/gateway/fileSignChannel.ts) so the spec exercises the same
      // url/disposition semantics production mobile clients get.
      const input = args[0] ?? {};
      const result = fileSignCore.signFileDownload(
        { secret: SECRET, tenantId: TENANT, paths, realpathSync: fs.realpathSync },
        {
          path: typeof input.path === 'string' ? input.path : '',
          disposition: input.disposition === 'inline' ? 'inline' : 'attachment',
        },
      );
      return fileSignCore.isSignedFileDownload(result)
        ? result
        : { success: false, error: result.message, code: result.code };
    }
    case 'cowork:permission:respond':
      return { success: false, error: 'no pending permission in the fixture' };
    case 'mobile:permission:listPending':
      return [];
    case 'mobile:bootstrap:status':
      return {
        identity: 'done',
        llmProvider: 'done',
        twinMetabot: 'done',
        workspace: 'done',
        trafficAccount: 'done',
        redeemCode: 'skipped',
        globalMetaId: null,
        twinMetabotId: null,
      };
    case 'store:get':
    case 'store:getStrict':
      return appConfigStore[args[0]] ?? null;
    case 'store:set':
      appConfigStore[args[0]] = { ...appConfigStore[args[0]], ...args[1] };
      return { success: true };
    case 'app:getVersion':
      return '0.0.0-gateway-e2e';
    case 'app:getSystemLocale':
      return 'en-US';
    case 'metabot:list':
      return { success: true, list: [] };
    case 'startup:rendererInitialized':
      return { success: true, elapsedMs: 0, startedAt: Date.now() };
    default:
      return { ok: true, channel, clientId };
  }
}

async function startFixture() {
  const handle = await server.startGateway({
    host: '127.0.0.1',
    port: Number(GATEWAY_PORT),
    secret: SECRET,
    tenantId: TENANT,
    tier: 'P1',
    contractVersion: '1.0.0',
    appVersion: '0.0.0-gateway-e2e',
    commit: 'e2e',
    paths,
    readiness: () => ({
      phase: 'ready',
      version: '0.0.0-gateway-e2e',
      commit: 'e2e',
      contractVersion: '1.0.0',
      onboarding: {
        identity: 'done',
        llmProvider: 'done',
        twinMetabot: 'done',
        workspace: 'done',
        trafficAccount: 'done',
        redeemCode: 'skipped',
        globalMetaId: null,
        twinMetabotId: null,
      },
      error: null,
    }),
    invokeHandler,
    hasHandler: () => true,
    addBroadcastListener: (listener) => {
      broadcast = listener;
      return () => {
        broadcast = null;
      };
    },
    storeGet: (key) => appConfigStore[key],
    revealMnemonic: async () => 'word1 word2 word3',
    logger: () => {},
  });
  return handle;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

const viteBin = path.join(repoRoot, 'node_modules', '.bin', 'vite');
const playwrightCli = path.join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js');

function waitForServer(url, timeoutMs = 45_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`${url}/app/`, { cache: 'no-store' });
        if (res.ok) {
          resolve();
          return;
        }
      } catch {
        // not up yet
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`timed out waiting for ${url}/app/`));
        return;
      }
      setTimeout(tick, 300);
    };
    tick();
  });
}

const children = [];
function cleanup() {
  for (const child of children.splice(0)) {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
}
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});

async function main() {
  let fixture;
  try {
    fixture = await startFixture();
  } catch (error) {
    console.error(
      `[gateway-e2e] could not start the fixture gateway on 127.0.0.1:${GATEWAY_PORT}: ${error.message}\n` +
        '[gateway-e2e] free the port (another gateway running?) and retry.',
    );
    process.exit(1);
  }
  console.log(`[gateway-e2e] fixture gateway up on 127.0.0.1:${GATEWAY_PORT} (tenant ${TENANT})`);

  const vite = spawn(viteBin, ['--config', 'vite.mobile.config.ts', '--port', APP_PORT, '--strictPort'], {
    cwd: repoRoot,
    env: { ...process.env, IDBOTS_GATEWAY_SECRET: SECRET, MOBILE_FORCE_COLOR: '0' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.push(vite);
  vite.stderr.on('data', (chunk) => process.stderr.write(`[vite] ${chunk}`));

  let exitCode = 1;
  try {
    await waitForServer(BASE_URL);
    console.log(`[gateway-e2e] dev:mobile:real up at ${BASE_URL} (real bridge, no mock)`);

    const run = spawn(
      process.execPath,
      [playwrightCli, 'test', '--grep', '@gateway', ...process.argv.slice(2)],
      {
        cwd: repoRoot,
        env: { ...process.env, E2E_BASE_URL: BASE_URL, E2E_GATEWAY: '1' },
        stdio: 'inherit',
      },
    );
    children.push(run);
    exitCode = await new Promise((resolve) => {
      run.on('exit', (code) => resolve(code ?? 1));
      run.on('error', () => resolve(1));
    });
  } finally {
    cleanup();
    for (const sessionId of [...sessionTimers.keys()]) clearTurnTimers(sessionId);
    await fixture.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

main().catch((error) => {
  console.error('[gateway-e2e]', error);
  cleanup();
  process.exit(1);
});
