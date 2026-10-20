/**
 * Electron-facing assembly for the C2 gateway (REQ-A-15/REQ-A-22).
 *
 * `startGatewayFromApp` gathers the real runtime dependencies — env
 * resolution, IPC registry dispatch, broadcast fan-out, store access, and the
 * mnemonic-reveal implementations shared with the `userIdentity:revealMnemonic`
 * and `idbots:getMetaBotMnemonic` handlers — and starts the pure server from
 * server.ts. This is the only gateway module that may import electron.
 *
 * Modes (REQ-A-22):
 * - Desktop dev mode: `IDBOTS_GATEWAY_DEV=1` (never honored in packaged
 *   builds). The secret defaults to a generated random one, printed once to
 *   stdout; the tenant reports `ready` with every onboarding step done/skipped.
 * - Server mode: `IDBOTS_SERVER_MODE=1`. `IDBOTS_GATEWAY_SECRET` is required
 *   (fail fast when missing); listens on 0.0.0.0.
 *
 * Contract: docs/cloud-mobile/01-interface-contracts.md, C1 (environment +
 * paths) and C2.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { app } from 'electron';
import { startGateway, type GatewayHandle } from './server';
import type { ReadinessState } from './readiness';
import type { GatewayPaths } from './restrictions';
import { invokeRegisteredHandler, hasRegisteredIpcHandler } from '../ipc/registry';
import { addBroadcastListener } from '../ipc/broadcast';
import { isServerMode, resolveTenantId } from '../server/serverMode';
import { makeServerLogger } from '../server/logger';

/** Contract version frozen by the owner in 01-interface-contracts.md (M1). */
export const GATEWAY_CONTRACT_VERSION = '1.0.0';
export const GATEWAY_DEFAULT_PORT = 8790;
export const GATEWAY_DEV_TENANT_ID = 't_dev_local';

export interface MnemonicRevealResult {
  success: boolean;
  mnemonic?: string;
  error?: string;
}

/**
 * Runtime pieces that only main.ts can supply: its store singletons and the
 * extracted mnemonic-reveal cores behind the two H-tier IPC handlers. Passing
 * them in keeps wiring.ts free of main.ts imports (no circular dependency)
 * and guarantees the gateway runs the exact same code paths as the desktop
 * handlers.
 */
export interface GatewayAppContext {
  /** Same accessor the `store:get` handler uses (post-initStore). */
  storeGet: (key: string) => unknown;
  /** The actual cowork working directory root (R-cwd root in dev mode). */
  getWorkspaceRoot: () => string;
  revealUserMnemonic: () => Promise<MnemonicRevealResult>;
  revealMetabotMnemonic: (metabotId: number) => Promise<MnemonicRevealResult>;
}

let readinessProviderOverride: (() => ReadinessState) | null = null;

/**
 * Server-mode seam: a later branch replaces the dev `ready` provider with the
 * real bootstrap state machine before starting the gateway.
 */
export function setGatewayReadinessProvider(provider: () => ReadinessState | null): void {
  readinessProviderOverride = provider;
}

/**
 * Runtime pieces of the last started gateway (REQ-A-24). The file-sign channel
 * needs exactly these three values to mint download tokens with the running
 * gateway's secret; null while the gateway is not running (plain desktop).
 */
export interface ActiveGatewayContext {
  secret: string;
  tenantId: string;
  paths: GatewayPaths;
}

let activeGatewayContext: ActiveGatewayContext | null = null;
let activeReadinessProvider: (() => ReadinessState) | null = null;

/** Context of the running gateway, or null when the gateway is not running. */
export function getActiveGatewayContext(): ActiveGatewayContext | null {
  return activeGatewayContext;
}

/**
 * The readiness state the running gateway reports (C1 `/readyz`), used by the
 * `mobile:bootstrap:status` channel. Falls back to the server-mode provider
 * seam, then to the dev default (every step done/skipped) so a plain desktop
 * app still answers with a fully-onboarded shape.
 */
export function getActiveGatewayReadiness(): ReadinessState {
  const provider = readinessProviderOverride ?? activeReadinessProvider;
  if (provider) {
    const state = provider();
    if (state) return state;
  }
  return buildDevReadiness('dev', 'dev');
}

/** Test seam for the file-sign channel (REQ-A-24). */
export function setGatewayContextForTesting(context: ActiveGatewayContext | null): void {
  activeGatewayContext = context;
}

/** Test seam for the bootstrap-status channel (REQ-A-24). */
export function setGatewayReadinessForTesting(provider: (() => ReadinessState) | null): void {
  activeReadinessProvider = provider;
}

function env(name: string): string {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function resolveTier(): 'P1' | 'P2' {
  return env('IDBOTS_GATEWAY_TIER') === 'P2' ? 'P2' : 'P1';
}

function resolvePort(): number {
  const raw = Number(env('IDBOTS_GATEWAY_PORT'));
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : GATEWAY_DEFAULT_PORT;
}

/**
 * Dev-mode readiness (REQ-A-22): the desktop app is fully interactive by the
 * time the gateway hook runs, so the tenant reports `ready` with every
 * onboarding step done or skipped. Server mode swaps this out through
 * `setGatewayReadinessProvider`.
 */
function buildDevReadiness(appVersion: string, commit: string): ReadinessState {
  return {
    phase: 'ready',
    version: appVersion,
    commit,
    contractVersion: GATEWAY_CONTRACT_VERSION,
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
  };
}

/** JSON-lines logger per C1 "Logs" (one object per line; secrets never logged). */
function makeJsonLogger(tenantId: string) {
  return (level: 'info' | 'warn' | 'error', component: string, msg: string, extra?: Record<string, unknown>) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, tenant: tenantId, component, msg, ...extra });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
}

/**
 * REQ-A-10: in server mode the gateway logs through the shared server logger
 * so every line is one redacted JSON object (the console is also wrapped;
 * logging via console here would double-encode). Desktop dev mode keeps the
 * plain JSON console logger above.
 */
function makeGatewayLogger(serverMode: boolean, tenantId: string) {
  if (!serverMode) return makeJsonLogger(tenantId);
  const serverLog = makeServerLogger({ tenantId });
  return (level: 'info' | 'warn' | 'error', component: string, msg: string, extra?: Record<string, unknown>) => {
    serverLog(level, component || 'gateway', msg, extra);
  };
}

/**
 * Start the mobile gateway from the running Electron app. Call only after
 * `app.whenReady()` and store init, with every IPC handler registered.
 */
export async function startGatewayFromApp(context: GatewayAppContext): Promise<GatewayHandle> {
  const serverMode = isServerMode();

  // Desktop dev mode requires the explicit env var and is never enabled in
  // packaged builds (REQ-A-22).
  const devMode = env('IDBOTS_GATEWAY_DEV') === '1' && !app.isPackaged;
  if (!serverMode && !devMode) {
    throw new Error('Gateway start requested without IDBOTS_GATEWAY_DEV=1 or IDBOTS_SERVER_MODE=1.');
  }

  const tenantId = resolveTenantId();

  let secret = env('IDBOTS_GATEWAY_SECRET');
  if (!secret) {
    if (serverMode) {
      // C1: the secret is required in server mode — fail fast.
      throw new Error('IDBOTS_GATEWAY_SECRET is required in server mode (IDBOTS_SERVER_MODE=1).');
    }
    secret = randomBytes(32).toString('base64url');
    // Dev convenience: print the generated secret exactly once so a local
    // phone client can be configured; server mode never takes this path.
    console.log(`[Gateway] generated dev gateway secret: ${secret}`);
  }

  const appVersion = app.getVersion();
  const commit = env('IDBOTS_COMMIT') || 'dev';
  const host = serverMode ? '0.0.0.0' : '127.0.0.1';
  const port = resolvePort();
  const tier = resolveTier();

  // Paths (C1 layout in server mode; the desktop equivalents in dev mode):
  // - dev userData: app.getPath('userData') — configureUserDataPath() in
  //   main.ts already applied the IDBOTS_USER_DATA_PATH / IDBOTS_APP_DATA_PATH
  //   overrides (src/main/libs/runtimeDataPaths.ts), so this is the same
  //   directory the store opened.
  // - dev workspace root: the actual cowork working directory root
  //   (getCoworkStore().getConfig().workingDirectory, falling back to
  //   ~/idbots/project per src/main/coworkStore.ts) — the same resolution the
  //   cowork session handlers use, so R-cwd accepts exactly what the desktop
  //   session start accepts.
  // - dev dataRoot: userData (the desktop analog of the /data volume).
  const userDataPath = app.getPath('userData');
  const workspaceRoot = serverMode
    ? path.resolve(env('IDBOTS_WORKSPACE_PATH') || '/data/workspace')
    : path.resolve(context.getWorkspaceRoot());
  const paths = {
    dataRoot: serverMode ? path.resolve(workspaceRoot, '..') : userDataPath,
    // Desktop dev mode: the cowork workspace (e.g. ~/idbots/project) lives
    // outside userData, and uploaded files land under the workspace — accept
    // it as a second R-path root so the upload -> file:sign round-trip works.
    // Server mode keeps the single /data root (the workspace lives inside it).
    dataRoots: serverMode ? undefined : [workspaceRoot],
    workspaceRoot,
    uploadsRoot: path.join(workspaceRoot, 'uploads'),
  };

  // dist-mobile bundle: explicit env first; in server mode also look next to
  // the app path (baked into the tenant image). Absent → /app/* answers 404.
  const bundleOverride = env('IDBOTS_MOBILE_BUNDLE_PATH');
  const bundleCandidate = bundleOverride || path.join(app.getAppPath(), 'dist-mobile');
  const staticBundleDir = bundleOverride
    ? bundleOverride
    : fs.existsSync(bundleCandidate) && fs.statSync(bundleCandidate).isDirectory()
      ? bundleCandidate
      : undefined;

  const devReadiness = buildDevReadiness(appVersion, commit);
  const readiness = readinessProviderOverride ?? (() => devReadiness);
  activeReadinessProvider = readiness;
  activeGatewayContext = { secret, tenantId, paths };

  return startGateway({
    host,
    port,
    secret,
    tenantId,
    tier,
    contractVersion: GATEWAY_CONTRACT_VERSION,
    appVersion,
    commit,
    paths,
    staticBundleDir,
    readiness,
    invokeHandler: invokeRegisteredHandler,
    hasHandler: hasRegisteredIpcHandler,
    addBroadcastListener,
    storeGet: context.storeGet,
    revealMnemonic: async (target) => {
      const result = target.target === 'user'
        ? await context.revealUserMnemonic()
        : await context.revealMetabotMnemonic(target.metabotId);
      if (!result.success || typeof result.mnemonic !== 'string') {
        throw new Error(result.error || 'Mnemonic reveal failed');
      }
      return result.mnemonic;
    },
    logger: makeGatewayLogger(serverMode, tenantId),
  });
}
