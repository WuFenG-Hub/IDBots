import type { AppContext } from '../context.js';
import { optionalStringField, writeJson, type RequestCtx, type Route } from '../http.js';
import { maskPhone } from '../crypto.js';
import { sendAlert } from '../alerts.js';

/**
 * Account deletion requests (REQ-B-17): records an operator-handled request
 * and alerts. Idempotent — a second call while one is `open` returns the
 * same request id. The alert carries the masked phone and request id, never
 * the full phone; the reason is user-supplied text and is not echoed to the
 * webhook.
 */

async function deletionRequest(app: AppContext, reqCtx: RequestCtx, body: unknown): Promise<void> {
  const reason = optionalStringField(body, 'reason');

  const existing = app.db
    .prepare("SELECT id FROM deletion_requests WHERE user_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1")
    .get(reqCtx.user!.id) as { id: number } | undefined;
  let requestId: number;
  if (existing) {
    requestId = existing.id;
    reqCtx.log('info', 'deletion request already open', { requestId });
  } else {
    const info = app.db
      .prepare(
        `INSERT INTO deletion_requests (user_id, reason, status, created_at)
         VALUES (?, ?, 'open', ?)`,
      )
      .run(reqCtx.user!.id, reason, Date.now());
    requestId = Number(info.lastInsertRowid);
    app.db
      .prepare('INSERT INTO audit_log (at, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)')
      .run(
        Date.now(),
        `user:${reqCtx.user!.id}`,
        'account.deletion-request',
        String(requestId),
        JSON.stringify({ reason: reason ?? null }),
      );
  }

  await sendAlert(
    app.config,
    `deletion request #${requestId} from ${maskPhone(reqCtx.user!.phone_e164)}`,
  );
  writeJson(reqCtx.res, 202, { requestId });
}

export const accountRoutes: Route[] = [
  { method: 'POST', path: '/api/v1/account/deletion-request', auth: true, handler: deletionRequest },
];
