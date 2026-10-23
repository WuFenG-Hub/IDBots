import crypto from 'node:crypto';
import type { AppContext } from '../context.js';
import { HttpError, requireStringField, writeError, writeJson, type RequestCtx, type Route } from '../http.js';
import { issueSmsCode, consumeSmsCode } from './auth.js';
import { resolveTenantForUser } from '../services/tenantLookup.js';

/**
 * Sensitive operations (REQ-B-16): SMS re-verification against the user's
 * OWN phone, a single-use 120 s reverifyId, and the mnemonic export that
 * mints the C2 reverify token and calls the tenant's sensitive route.
 *
 * The mnemonic passes through memory only: never logged, never stored. The
 * audit row records target kind/metabotId — never the mnemonic.
 */

const REVERIFY_PURPOSE = 'reveal-mnemonic';
const REVERT_TTL_MS = 120_000;
const C2_TOKEN_TTL_MS = 120_000;

interface ReverifyRow {
  id: number;
  user_id: string;
  purpose: string;
  expires_at: number;
  consumed_at: number | null;
}

async function reverifySend(app: AppContext, reqCtx: RequestCtx, body: unknown): Promise<void> {
  const purpose = requireStringField(body, 'purpose');
  if (purpose !== REVERIFY_PURPOSE) {
    throw new HttpError(400, 'INVALID_PURPOSE', `purpose must be "${REVERIFY_PURPOSE}"`);
  }
  // Always the session user's own phone — never a client-supplied number.
  await issueSmsCode(app, reqCtx, reqCtx.user!.phone_e164, 'reverify');
  writeJson(reqCtx.res, 200, { resendAfterSec: 60 });
}

async function reverifyVerify(app: AppContext, reqCtx: RequestCtx, body: unknown): Promise<void> {
  const purpose = requireStringField(body, 'purpose');
  const code = requireStringField(body, 'code');
  if (purpose !== REVERIFY_PURPOSE) {
    throw new HttpError(400, 'INVALID_PURPOSE', `purpose must be "${REVERIFY_PURPOSE}"`);
  }
  consumeSmsCode(app, reqCtx.user!.phone_e164, 'reverify', code);
  const now = Date.now();
  const info = app.db
    .prepare(
      `INSERT INTO reverify (user_id, purpose, expires_at, consumed_at)
       VALUES (?, ?, ?, NULL)`,
    )
    .run(reqCtx.user!.id, REVERIFY_PURPOSE, now + REVERT_TTL_MS);
  reqCtx.log('info', 'reverify granted', { userId: reqCtx.user!.id });
  writeJson(reqCtx.res, 200, { reverifyId: Number(info.lastInsertRowid), expiresAt: now + REVERT_TTL_MS });
}

function consumeReverifyRow(app: AppContext, row: ReverifyRow, now: number): void {
  const info = app.db
    .prepare('UPDATE reverify SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
    .run(now, row.id);
  if (info.changes === 0) {
    // Lost a race against a concurrent reveal with the same id.
    throw new HttpError(403, 'REVERIFY_REQUIRED', 'reverification is required');
  }
}

async function revealMnemonic(app: AppContext, reqCtx: RequestCtx, body: unknown): Promise<void> {
  const reverifyId = (body as { reverifyId?: unknown }).reverifyId;
  if (typeof reverifyId !== 'number' || !Number.isInteger(reverifyId)) {
    throw new HttpError(400, 'INVALID_BODY', 'field "reverifyId" must be an integer');
  }
  const target = requireStringField(body, 'target');
  if (target !== 'user' && target !== 'metabot') {
    throw new HttpError(400, 'INVALID_BODY', 'field "target" must be "user" or "metabot"');
  }
  const metabotId =
    target === 'metabot' ? (body as { metabotId?: unknown }).metabotId : undefined;
  if (target === 'metabot' && (typeof metabotId !== 'number' || !Number.isInteger(metabotId))) {
    throw new HttpError(400, 'INVALID_BODY', 'field "metabotId" must be an integer for metabot targets');
  }

  // 1. Reverify row must exist, belong to this user, match the purpose, and
  //    be fresh and unconsumed.
  const now = Date.now();
  const row = app.db.prepare('SELECT * FROM reverify WHERE id = ?').get(reverifyId) as
    | ReverifyRow
    | undefined;
  if (
    !row ||
    row.user_id !== reqCtx.user!.id ||
    row.purpose !== REVERIFY_PURPOSE ||
    row.consumed_at !== null ||
    row.expires_at <= now
  ) {
    throw new HttpError(403, 'REVERIFY_REQUIRED', 'a fresh reverification is required');
  }

  // 2. The tenant must be able to serve the call BEFORE we burn the single
  //    use (a not-ready tenant must not consume the reverifyId).
  const lookup = await resolveTenantForUser(app, reqCtx.user!.id);
  if (!lookup.ok) {
    if (lookup.code === 'NOT_READY') {
      throw new HttpError(409, 'TENANT_NOT_READY', lookup.message);
    }
    throw new HttpError(502, 'UPSTREAM_ERROR', 'tenant unavailable');
  }

  // 3. Consume atomically; a lost race is a 403.
  consumeReverifyRow(app, row, now);

  // 4. Mint the C2 token exactly per contract.
  const payload = JSON.stringify({
    t: lookup.resolved.tenant.id,
    p: REVERIFY_PURPOSE,
    e: now + C2_TOKEN_TTL_MS,
    n: crypto.randomBytes(16).toString('base64url'),
  });
  const signature = crypto.createHmac('sha256', lookup.resolved.secret).update(payload).digest();
  const token = `${Buffer.from(payload, 'utf8').toString('base64url')}.${signature.toString('base64url')}`;

  // 5. Call the tenant's sensitive route; the mnemonic only passes through.
  let upstream: Response;
  try {
    upstream = await fetch(`${lookup.resolved.baseUrl}/gateway/v1/sensitive/reveal-mnemonic`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-IDBots-Gateway-Secret': lookup.resolved.secret,
        'X-IDBots-Reverify': token,
      },
      body: JSON.stringify(target === 'user' ? { target: 'user' } : { target: 'metabot', metabotId }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new HttpError(502, 'UPSTREAM_ERROR', `tenant connection failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!upstream.ok) {
    const message =
      upstream.status === 401
        ? 'the tenant rejected the reverify token'
        : 'the tenant sensitive route failed';
    writeError(reqCtx.res, upstream.status, upstream.status === 401 ? 'REVERIFY_REJECTED' : 'UPSTREAM_ERROR', message);
    return;
  }
  const { mnemonic } = (await upstream.json()) as { mnemonic: string };
  if (typeof mnemonic !== 'string' || mnemonic.length === 0) {
    writeError(reqCtx.res, 502, 'UPSTREAM_ERROR', 'the tenant returned no mnemonic');
    return;
  }

  // 6. Respond without caching; audit WITHOUT the mnemonic.
  app.db
    .prepare('INSERT INTO audit_log (at, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)')
    .run(
      Date.now(),
      `user:${reqCtx.user!.id}`,
      'sensitive.reveal-mnemonic',
      lookup.resolved.tenant.id,
      JSON.stringify(target === 'user' ? { target: 'user' } : { target: 'metabot', metabotId }),
    );
  reqCtx.res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  reqCtx.res.end(JSON.stringify({ mnemonic }));
}

export const sensitiveRoutes: Route[] = [
  { method: 'POST', path: '/api/v1/reverify/send', auth: true, handler: reverifySend },
  { method: 'POST', path: '/api/v1/reverify/verify', auth: true, handler: reverifyVerify },
  { method: 'POST', path: '/api/v1/sensitive/reveal-mnemonic', auth: true, handler: revealMnemonic },
];
