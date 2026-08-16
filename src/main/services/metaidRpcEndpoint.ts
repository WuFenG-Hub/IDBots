import { randomBytes, timingSafeEqual } from 'node:crypto';

export const DEFAULT_METAID_RPC_HOST = '127.0.0.1';
export const DEFAULT_METAID_RPC_PORT = 31200;
export const METAID_RPC_PORT_ENV = 'IDBOTS_METAID_RPC_PORT';
export const METAID_RPC_TOKEN_ENV = 'IDBOTS_RPC_TOKEN';

let cachedMetaidRpcToken: string | null = null;

/**
 * Per-launch bearer token for the local MetaID RPC server.
 *
 * S1 hardening: every RPC endpoint requires `Authorization: Bearer <token>`.
 * The token is generated once per process (or taken from IDBOTS_RPC_TOKEN so
 * external integrations/tests can pin it) and handed to host-spawned
 * subprocesses via the IDBOTS_RPC_TOKEN env var next to IDBOTS_RPC_URL.
 * Browsers cannot set this header cross-origin, which closes the localhost
 * CSRF/SSRF window on 127.0.0.1:31200 without changing the RPC protocol shape.
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
