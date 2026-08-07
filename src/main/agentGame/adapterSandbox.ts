/**
 * Adapter sandbox (docs/08 §Sandbox, docs/14 §4).
 *
 * A game `adapter.js` is third-party code: it runs inside a `worker_threads`
 * Worker with a frozen host API, no network/fs/wallet/host-bridge access, and
 * per-call time / output-size limits. The `adapterHash` is verified once at
 * load and pinned for the Session lifetime — reload is rejected.
 *
 * The Worker owns the module instance; the main thread sends RPC requests and
 * enforces all limits (the Worker cannot be trusted to self-limit). Adapter
 * functions are required to be deterministic and side-effect free, so it does
 * not need a clock or randomness source.
 */

import { Worker } from 'worker_threads';
import { createHash, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';
import type {
  AdapterConfig,
  GameEvent,
  TurnInfo,
  MatchResult,
  ParseResult,
  ValidationResult,
} from './abi';

/** Default per-call wall-clock timeout for an adapter function. */
export const ADAPTER_CALL_TIMEOUT_MS = 5_000;
/** Default hard cap on the JSON-serialized size of an adapter return value. */
export const ADAPTER_MAX_OUTPUT_BYTES = 1 * 1024 * 1024;
/** Worker CPU/memory caps (docs/08 §Sandbox). */
export const ADAPTER_RESOURCE_LIMITS = {
  maxOldGenerationSizeMb: 64,
  maxYoungGenerationSizeMb: 16,
  codeRangeSizeMb: 16,
  stackSizeMb: 8,
} as const;

/** Failure categories surfaced to the runtime. */
export class AdapterError extends Error {
  constructor(
    public readonly code: 'adapter_invalid' | 'adapter_timeout' | 'adapter_error',
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

/** Compute the canonical adapter hash used for pinning (sha256 of the raw source). */
export function computeAdapterHash(adapterPath: string): string {
  const source = readFileSync(adapterPath);
  const digest = createHash('sha256').update(source).digest('hex');
  return `sha256:${digest}`;
}

interface RpcRequest {
  id: string;
  fn: string;
  args: unknown[];
}

interface RpcResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { message: string; code?: string };
}

/**
 * Sandbox handle. Created via `loadAdapterSandbox(...)`. Methods map 1:1 to the
 * frozen ABI and enforce timeout + output-size limits. Dispose on Session stop.
 */
export interface AdapterSandbox {
  readonly adapterHash: string;
  /** ABI smoke test: initialState → serializeState + getTurn must succeed. */
  smokeTest(config: AdapterConfig): Promise<void>;
  initialState(config: AdapterConfig): Promise<unknown>;
  reduce(state: unknown, event: GameEvent): Promise<unknown>;
  getTurn(state: unknown): Promise<TurnInfo>;
  getObservation(state: unknown, seat: string): Promise<unknown>;
  getActionSchema(state: unknown, seat: string): Promise<unknown>;
  parseAction(llmText: string, context: { schema: unknown; observation: unknown; seat: string }): Promise<ParseResult>;
  validateAction(state: unknown, action: unknown, context: { schema: unknown; observation: unknown; seat: string }): Promise<ValidationResult>;
  serializeState(state: unknown): Promise<string>;
  getResult(state: unknown): Promise<MatchResult>;
  /** Terminate the Worker. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Verify `adapterHash`, spawn the Worker, and ABI smoke-load the adapter.
 * Rejects with `adapter_invalid` on hash mismatch, missing exports, or a
 * malformed module.
 */
export async function loadAdapterSandbox(
  adapterPath: string,
  expectedHash: string,
  options: { callTimeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<AdapterSandbox> {
  const callTimeoutMs = options.callTimeoutMs ?? ADAPTER_CALL_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? ADAPTER_MAX_OUTPUT_BYTES;

  // Hash is verified on the main thread before the Worker even starts: the
  // Worker cannot be trusted to attest its own hash.
  const actualHash = computeAdapterHash(adapterPath);
  if (actualHash !== expectedHash) {
    throw new AdapterError(
      'adapter_invalid',
      `adapterHash mismatch: expected ${expectedHash}, got ${actualHash}`,
    );
  }

  const workerPath = resolveWorkerPath();
  const worker = new Worker(workerPath, {
    workerData: { adapterPath },
    resourceLimits: ADAPTER_RESOURCE_LIMITS,
  });
  worker.unref();

  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

  // Wait for the Worker's __load__ ack (import + ABI shape validation) before
  // any call. Import/shape failures surface here as adapter_invalid, synchronously.
  const loaded = new Promise<void>((resolveLoad, rejectLoad) => {
    const onFirst = (msg: RpcResponse | { id: string; ok: boolean; result?: unknown; error?: { message: string; code?: string } }) => {
      if (msg.id !== '__load__') return;
      worker.off('message', onFirst);
      if (msg.ok) {
        resolveLoad();
      } else {
        rejectLoad(
          new AdapterError(
            (msg.error?.code as AdapterError['code']) || 'adapter_invalid',
            msg.error?.message ?? 'adapter failed to load',
          ),
        );
      }
    };
    worker.on('message', onFirst);
    worker.once('error', (err) => rejectLoad(new AdapterError('adapter_error', `worker crashed: ${err.message}`, err)));
  });

  worker.on('message', (msg: RpcResponse) => {
    if (msg.id === '__load__') return; // handled by the one-time loader above
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok) {
      entry.resolve(msg.result);
    } else {
      entry.reject(new AdapterError('adapter_error', msg.error?.message ?? 'adapter call failed'));
    }
  });
  worker.on('error', (err) => {
    for (const entry of pending.values()) {
      entry.reject(new AdapterError('adapter_error', `worker crashed: ${err.message}`, err));
    }
    pending.clear();
  });
  worker.on('exit', (code) => {
    if (code !== 0) {
      for (const entry of pending.values()) {
        entry.reject(new AdapterError('adapter_error', `worker exited with code ${code}`));
      }
      pending.clear();
    }
  });

  await loaded;

  function call(fn: string, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new AdapterError('adapter_timeout', `adapter ${fn} timed out after ${callTimeoutMs}ms`));
      }, callTimeoutMs);
      timer.unref();
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          // Enforce output size on the main thread (untrusted worker).
          try {
            if (v !== undefined && Buffer.byteLength(JSON.stringify(v), 'utf8') > maxOutputBytes) {
              reject(new AdapterError('adapter_error', `adapter ${fn} output exceeded ${maxOutputBytes} bytes`));
              return;
            }
          } catch {
            reject(new AdapterError('adapter_error', `adapter ${fn} returned non-serializable output`));
            return;
          }
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      worker.postMessage({ id, fn, args } satisfies RpcRequest);
    });
  }

  const sandbox: AdapterSandbox = {
    adapterHash: actualHash,
    async smokeTest(config) {
      // A conforming adapter must produce a serializable initial state and a
      // turn descriptor. Missing exports surface as adapter_error from the
      // worker (which validates the module shape on import).
      const state = await call('initialState', [config]);
      await call('serializeState', [state]);
      await call('getTurn', [state]);
    },
    initialState: (config) => call('initialState', [config]),
    reduce: (state, event) => call('reduce', [state, event]),
    getTurn: (state) => call('getTurn', [state]) as Promise<TurnInfo>,
    getObservation: (state, seat) => call('getObservation', [state, seat]),
    getActionSchema: (state, seat) => call('getActionSchema', [state, seat]),
    parseAction: (llmText, context) => call('parseAction', [llmText, context]) as Promise<ParseResult>,
    validateAction: (state, action, context) =>
      call('validateAction', [state, action, context]) as Promise<ValidationResult>,
    serializeState: (state) => call('serializeState', [state]) as Promise<string>,
    getResult: (state) => call('getResult', [state]) as Promise<MatchResult>,
    async dispose() {
      pending.clear();
      await worker.terminate().catch(() => {});
    },
  };

  return sandbox;
}

/**
 * Resolve the Worker entry. The worker is a `.cjs` (not bundled by tsc/rollup),
 * so it must be located from a stable root:
 *  - packaged app: process.resourcesPath/agentGame/adapterSandboxWorker.cjs
 *    (shipped via electron-builder extraResources)
 *  - dev: the source file under app.getAppPath()/src/main/agentGame/
 * Falls back to __dirname (tsc-compiled dist-electron) for the unit-test path.
 */
function resolveWorkerPath(): string {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'agentGame', 'adapterSandboxWorker.cjs')]
    : [
        join(app.getAppPath(), 'src', 'main', 'agentGame', 'adapterSandboxWorker.cjs'),
        join(__dirname, 'adapterSandboxWorker.cjs'),
      ];
  for (const candidate of candidates) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  // Last resort: return the first candidate so the Worker error surfaces clearly.
  return candidates[0];
}

/** Convenience: shape-check a loaded adapter module's exports (used by tests). */
export function assertAdapterShape(mod: Record<string, unknown>): void {
  const required = [
    'createMatch',
    'initialState',
    'reduce',
    'getTurn',
    'getObservation',
    'getActionSchema',
    'parseAction',
    'validateAction',
    'serializeState',
    'getResult',
  ] as const;
  const missing = required.filter((fn) => typeof mod[fn] !== 'function');
  if (missing.length > 0) {
    throw new AdapterError('adapter_invalid', `adapter missing exports: ${missing.join(', ')}`);
  }
}
