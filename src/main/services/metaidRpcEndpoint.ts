import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_METAID_RPC_HOST = '127.0.0.1';
export const DEFAULT_METAID_RPC_PORT = 31200;
export const METAID_RPC_PORT_ENV = 'IDBOTS_METAID_RPC_PORT';
export const METAID_RPC_TOKEN_ENV = 'IDBOTS_RPC_TOKEN';
export const METAID_RPC_AUTHFILE_ENV = 'IDBOTS_RPC_AUTHFILE';
export const METAID_RPC_TOKEN_FILENAME = 'metaid-rpc-token';

let cachedMetaidRpcToken: string | null = null;

/** Shape of a host-generated token: randomBytes(24) hex. */
const METAID_RPC_GENERATED_TOKEN_RE = /^[0-9a-f]{48}$/;

/**
 * Local-gateway bearer token for the MetaID RPC server.
 *
 * S1 hardening: every RPC endpoint requires `Authorization: Bearer <token>`.
 * The token comes from IDBOTS_RPC_TOKEN when pinned (external integrations/
 * tests), otherwise it is stable per userData dir: the first launch generates
 * it, later launches and sibling instances sharing the userData dir ADOPT the
 * mirrored token file (see writeMetaidRpcTokenFile) instead of rotating it.
 * Stability matters because every instance binds the same fixed gateway port —
 * whichever instance owns the port at a given moment must accept the tokens
 * its siblings already handed to their SKILL scripts, and a second instance
 * must never clobber the mirror file out from under the port owner's clients.
 * The token is handed to host-spawned subprocesses via the IDBOTS_RPC_TOKEN
 * env var next to IDBOTS_RPC_URL. Browsers cannot set this header cross-origin
 * (nor read the 0600 mirror file), which closes the localhost CSRF/SSRF window
 * on 127.0.0.1:31200 without changing the RPC protocol shape.
 */
export function getMetaidRpcToken(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[METAID_RPC_TOKEN_ENV]?.trim();
  if (fromEnv) {
    cachedMetaidRpcToken = fromEnv;
    return fromEnv;
  }
  if (cachedMetaidRpcToken) {
    return cachedMetaidRpcToken;
  }
  cachedMetaidRpcToken = randomBytes(24).toString('hex');
  return cachedMetaidRpcToken;
}

/** Constant-time check of an `Authorization: Bearer <token>` header. */
export function isMetaidRpcTokenAuthorized(
  providedAuthHeader: string | undefined,
  expectedToken: string,
): boolean {
  const header = (providedAuthHeader ?? '').trim();
  if (!header.startsWith('Bearer ')) {
    return false;
  }
  const provided = header.slice('Bearer '.length).trim();
  const expectedBuffer = Buffer.from(expectedToken);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

/** Path of the per-launch token mirror file inside the Electron userData dir. */
export function getMetaidRpcTokenFilePath(userDataPath: string): string {
  return join(userDataPath, METAID_RPC_TOKEN_FILENAME);
}

/**
 * Mirror the bearer token into a 0600 file under userData.
 *
 * Layer 2 fallback for DSH sessions: the DSH bash tool erases env names
 * matching /KEY|PASSWORD|SECRET|TOKEN/i from model-visible subprocesses, so
 * IDBOTS_RPC_TOKEN never reaches SKILL scripts executed via bash there. The
 * file's path rides the scrub-proof IDBOTS_RPC_AUTHFILE env name and skill
 * RPC clients fall back to reading it when the env-borne token is absent.
 *
 * Adopt-before-write: when the env does not pin a token and a valid mirrored
 * token already exists (previous launch, or a sibling instance currently
 * owning the gateway port), reuse it verbatim instead of rotating — rotating
 * would break every client of the instance that still owns the port. An
 * env-pinned token always wins and is re-mirrored. Best-effort: on write
 * failure the env injection remains the only channel.
 */
export function writeMetaidRpcTokenFile(
  userDataPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const filePath = getMetaidRpcTokenFilePath(userDataPath);
  if (!env[METAID_RPC_TOKEN_ENV]?.trim()) {
    try {
      const existing = readFileSync(filePath, 'utf8').trim();
      if (METAID_RPC_GENERATED_TOKEN_RE.test(existing)) {
        cachedMetaidRpcToken = existing;
        try {
          chmodSync(filePath, 0o600);
        } catch {
          // Windows and some network FS ignore POSIX modes.
        }
        return filePath;
      }
    } catch {
      // Missing or unreadable mirror: generate a fresh token below.
    }
  }
  try {
    writeFileSync(filePath, `${getMetaidRpcToken(env)}\n`, 'utf8');
    chmodSync(filePath, 0o600);
    return filePath;
  } catch {
    return null;
  }
}

/**
 * Origins allowed to talk to the local RPC server.
 *
 * Browser-originated requests (the localhost-CSRF attack class) must carry an
 * app-owned origin. Native host-spawned clients (SKILL scripts, cowork
 * sessions) send no Origin header and are admitted by the bearer token instead.
 * `file://` covers the packaged renderer should it ever call the RPC directly
 * (today it does not; it uses IPC).
 */
const ALLOWED_METAID_RPC_ORIGIN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/;
const ALLOWED_METAID_RPC_FILE_ORIGIN_RE = /^file:\/\//;

export function isAllowedMetaidRpcOrigin(origin: string | undefined | null): boolean {
  const trimmed = (origin ?? '').trim();
  if (!trimmed || trimmed === 'null') {
    return false;
  }
  return (
    ALLOWED_METAID_RPC_ORIGIN_RE.test(trimmed) ||
    ALLOWED_METAID_RPC_FILE_ORIGIN_RE.test(trimmed)
  );
}

export function resolveMetaidRpcPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[METAID_RPC_PORT_ENV]?.trim();
  if (!raw) {
    return DEFAULT_METAID_RPC_PORT;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return DEFAULT_METAID_RPC_PORT;
  }

  return parsed;
}

export function getMetaidRpcBase(env: NodeJS.ProcessEnv = process.env): string {
  return `http://${DEFAULT_METAID_RPC_HOST}:${resolveMetaidRpcPort(env)}`;
}
