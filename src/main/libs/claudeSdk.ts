import { app } from 'electron';
import { existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { coworkLog } from './coworkLogger';
import { getClaudeCodePath } from './claudeSettings';

export type ClaudeSdkModule = typeof import('@anthropic-ai/claude-agent-sdk');

let claudeSdkPromise: Promise<ClaudeSdkModule> | null = null;
let prewarmStarted = false;

const CLAUDE_SDK_PATH_PARTS = ['@anthropic-ai', 'claude-agent-sdk'];

function getClaudeSdkPath(): string {
  if (app.isPackaged) {
    return join(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      ...CLAUDE_SDK_PATH_PARTS,
      'sdk.mjs'
    );
  }

  // In development, try to find the SDK in the project root node_modules
  // app.getAppPath() might point to dist-electron or other build output directories
  // We need to look in the project root
  const appPath = app.getAppPath();
  // If appPath ends with dist-electron, go up one level
  const rootDir = appPath.endsWith('dist-electron')
    ? join(appPath, '..')
    : appPath;

  const sdkPath = join(
    rootDir,
    'node_modules',
    ...CLAUDE_SDK_PATH_PARTS,
    'sdk.mjs'
  );

  console.log('[ClaudeSDK] Resolved SDK path:', sdkPath);
  return sdkPath;
}

export function loadClaudeSdk(): Promise<ClaudeSdkModule> {
  if (!claudeSdkPromise) {
    // Use runtime dynamic import so the CJS build can load the SDK's ESM entry.
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string
    ) => Promise<ClaudeSdkModule>;
    const sdkPath = getClaudeSdkPath();
    const sdkUrl = pathToFileURL(sdkPath).href;
    const sdkExists = existsSync(sdkPath);

    coworkLog('INFO', 'loadClaudeSdk', 'Loading Claude SDK', {
      sdkPath,
      sdkUrl,
      sdkExists,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    });

    claudeSdkPromise = dynamicImport(sdkUrl).catch((error) => {
      coworkLog('ERROR', 'loadClaudeSdk', 'Failed to load Claude SDK', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        sdkPath,
        sdkExists,
      });
      claudeSdkPromise = null;
      throw error;
    });
  }

  return claudeSdkPromise;
}

/**
 * Eagerly pre-warms the Claude Agent SDK at app startup so the first cowork
 * session doesn't pay the dynamic-import + native-binary-resolution cost.
 *
 * This triggers two currently-lazy operations in parallel:
 *  1. loadClaudeSdk() — the runtime dynamic import of sdk.mjs (cached in
 *     claudeSdkPromise, reused by every subsequent session).
 *  2. getClaudeCodePath() — probing the platform-specific native binary
 *     candidates (existsSync checks across platform package dirs).
 *
 * Note on SDK startup()/WarmQuery: the SDK's startup() returns a single-use
 * WarmQuery whose options (env, model) are fixed at creation time. IDBots runs
 * multi-provider sessions with per-session env, so a global warm subprocess
 * cannot serve them. Instead we pre-load the module + resolve the binary path
 * — both provider-agnostic — which removes the dominant first-session import
 * cost while keeping per-session env flexibility.
 *
 * Fire-and-forget: failures are logged but never block app startup. The
 * promise is cached so the first real session reuses the in-flight load.
 */
export function prewarmClaudeSdk(): void {
  if (prewarmStarted) return;
  prewarmStarted = true;

  coworkLog('INFO', 'prewarmClaudeSdk', 'Pre-warming Claude Agent SDK (module + binary path)');

  // Module import (cached in claudeSdkPromise).
  void loadClaudeSdk().catch(() => {
    // Errors are already logged inside loadClaudeSdk; nothing more to do.
  });

  // Binary path resolution — run on the next tick to avoid blocking the
  // ready event; the result is not cached explicitly but the filesystem cache
  // and V8 module compilation warm up for the real call in runClaudeCodeLocal.
  setImmediate(() => {
    try {
      const resolved = getClaudeCodePath();
      coworkLog('DEBUG', 'prewarmClaudeSdk', 'Pre-resolved Claude binary path', { resolved });
    } catch (error) {
      coworkLog('WARN', 'prewarmClaudeSdk', 'Binary path pre-resolution failed (non-fatal)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
