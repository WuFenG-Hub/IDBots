/**
 * Session cookie handling (C3): `idb_session` holds the raw session token;
 * the database stores only its SHA-256. Attributes are
 * `HttpOnly; Secure; SameSite=Strict; Path=/` with a 30-day sliding expiry
 * (Max-Age + Expires refreshed on every use). Also serializes the
 * clear-cookie header used by logout.
 */

export const SESSION_COOKIE_NAME = 'idb_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const ATTRS = 'HttpOnly; Secure; SameSite=Strict; Path=/';

function toCookieDate(now: number): string {
  return new Date(now).toUTCString();
}

export function serializeSessionCookie(token: string, now: number): string {
  const expiresAt = now + SESSION_TTL_MS;
  return (
    `${SESSION_COOKIE_NAME}=${token}; ${ATTRS}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; ` +
    `Expires=${toCookieDate(expiresAt)}`
  );
}

export function clearSessionCookie(now: number): string {
  return (
    `${SESSION_COOKIE_NAME}=; ${ATTRS}; Max-Age=0; Expires=${toCookieDate(now - 1000)}`
  );
}

/** Parse a Cookie request header into a name -> value map. */
export function parseCookieHeader(header: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) {
    return out;
  }
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name !== '') {
      out[name] = value;
    }
  }
  return out;
}

/** Extract the idb_session token from a Cookie header, or null. */
export function sessionTokenFromCookieHeader(header: string | undefined | null): string | null {
  const token = parseCookieHeader(header)[SESSION_COOKIE_NAME];
  return token === undefined ? null : token;
}
