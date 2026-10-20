import type { AppContext } from '../context.js';
import { sendAlert } from '../alerts.js';

/**
 * Startup reconcile (REQ-B-11): match the tenants table against the
 * containers that actually exist before the poller resumes. Tenants whose
 * container vanished fail (ready/degraded also alert); containers the table
 * does not know are reported and NEVER deleted. `upgrading` rows are left
 * for the upgrade phase; stopped/suspended/failed rows are not touched.
 *
 * When the Docker API is unreachable the reconcile is skipped entirely
 * (transient outage — statuses must not flap on a dead engine).
 */

interface TenantRow {
  id: string;
  container_name: string;
  status: string;
}

export async function reconcileAtStartup(app: Pick<AppContext, 'config' | 'db' | 'docker'>): Promise<string[]> {
  const log = (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level, component: 'reconcile', msg, ...extra }));

  let containers;
  try {
    containers = await app.docker.listContainers({ namePrefix: 'idb-', all: true });
  } catch (err) {
    log('warn', 'docker unreachable, reconcile skipped', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const byName = new Map(containers.map((c) => [c.Names[0].replace(/^\//, ''), c]));
  const tenants = app.db.prepare('SELECT id, container_name, status FROM tenants').all() as TenantRow[];
  const tenantNames = new Set(tenants.map((t) => t.container_name));
  const reported: string[] = [];

  for (const tenant of tenants) {
    if (tenant.status === 'upgrading' || tenant.status === 'stopped' || tenant.status === 'suspended' || tenant.status === 'failed') {
      continue;
    }
    if (byName.has(tenant.container_name)) {
      continue;
    }
    const wasServing = tenant.status === 'ready' || tenant.status === 'degraded';
    app.db
      .prepare("UPDATE tenants SET status = 'failed', last_error = 'container missing on startup', updated_at = ? WHERE id = ?")
      .run(Date.now(), tenant.id);
    const message = `tenant ${tenant.id}: container missing on startup`;
    log('warn', 'tenant container missing on startup', { tenant: tenant.id, status: tenant.status });
    reported.push(message);
    if (wasServing) {
      await sendAlert(app.config, message);
    }
  }

  for (const [name, container] of byName) {
    if (tenantNames.has(name)) {
      continue;
    }
    const message = `unknown container ${name} reported (id ${container.Id.slice(0, 12)}); left running, not deleted`;
    log('warn', 'unknown container reported, not deleted', { name });
    await sendAlert(app.config, message);
    reported.push(message);
  }

  return reported;
}
