import type { AppContext } from '../context.js';
import { sendAlert } from '../alerts.js';
import { decryptSecret } from '../crypto.js';
import { markFailed, provisionTenant } from './provisioning.js';
import { findContainerId, recreateContainer } from './upgrade.js';

/**
 * Tenant recovery for rows orphaned by a control-plane restart (review
 * finding S2-1/S2-2). Runs at startup from reconcileAtStartup and, for
 * `provisioning`, also as the poller's stale-row safety net.
 *
 * - `provisioning`: container exists → back to `booting` (poller resumes);
 *   container missing → re-run provisionTenant (idempotent: same secret,
 *   409-tolerant volume/adopt).
 * - `upgrading`: orphaned by definition at startup (the upgrading process is
 *   gone) → stop/remove any current container, recreate on the same volume
 *   with the same secret from `tenants.image` — which is the PRE-upgrade
 *   image (image/previous_image only swap on upgrade success) — then hand
 *   off at `booting` so the poller's restart budget + failure alert cover a
 *   bad rollback. Recreation failure → `failed` + alert.
 *
 * Recovery steps never block on readiness; `booting` handoff is enough.
 */

export interface RecoverableTenant {
  id: string;
  status: string;
  user_id: string;
  container_name: string;
  volume_name: string;
  image: string;
  gateway_secret_enc: string;
}

export type RecoveryOutcome = 'booting' | 'reprovisioned' | 'rolled-back' | 'failed';

export function auditSystem(
  app: Pick<AppContext, 'db'>,
  action: string,
  target: string,
  detail: Record<string, unknown> = {},
): void {
  app.db
    .prepare('INSERT INTO audit_log (at, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), 'system', action, target, JSON.stringify(detail));
}

export async function recoverTenant(
  app: Pick<AppContext, 'config' | 'db' | 'docker'>,
  tenant: RecoverableTenant,
): Promise<RecoveryOutcome> {
  if (tenant.status === 'provisioning') {
    const existing = await findContainerId(app, tenant.container_name);
    if (existing) {
      app.db
        .prepare("UPDATE tenants SET status = 'booting', updated_at = ? WHERE id = ?")
        .run(Date.now(), tenant.id);
      auditSystem(app, 'tenant.recovery.booting', tenant.id, {
        reason: 'container exists; poller resumes readiness',
      });
      return 'booting';
    }
    auditSystem(app, 'tenant.recovery.reprovision', tenant.id, {
      reason: 'container missing; re-running provisioning',
    });
    await provisionTenant(app, tenant.id);
    return 'reprovisioned';
  }

  if (tenant.status === 'upgrading') {
    let secret: string;
    try {
      secret = decryptSecret(app.config.masterKey, tenant.gateway_secret_enc);
    } catch (err) {
      const message = `recovery rollback failed: gateway secret undecryptable: ${err instanceof Error ? err.message : String(err)}`;
      markFailed(app, tenant.id, message);
      auditSystem(app, 'tenant.recovery.failed', tenant.id, { detail: message });
      await sendAlert(app.config, `tenant ${tenant.id}: ${message}`);
      return 'failed';
    }
    try {
      await recreateContainer(app, tenant, tenant.image, secret);
    } catch (err) {
      const message = `recovery rollback failed: ${err instanceof Error ? err.message : String(err)}`;
      markFailed(app, tenant.id, message);
      auditSystem(app, 'tenant.recovery.failed', tenant.id, { detail: message });
      await sendAlert(app.config, `tenant ${tenant.id}: ${message}`);
      return 'failed';
    }
    app.db
      .prepare("UPDATE tenants SET status = 'booting', updated_at = ? WHERE id = ?")
      .run(Date.now(), tenant.id);
    auditSystem(app, 'tenant.recovery.rollback', tenant.id, {
      image: tenant.image,
      reason: 'orphaned upgrading row; rolled back to the pre-upgrade image',
    });
    return 'rolled-back';
  }

  return 'booting';
}
