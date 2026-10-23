import type { AppContext } from '../context.js';
import { tenantBaseUrl } from '../docker/client.js';
import { decryptSecret } from '../crypto.js';
import { findContainerId } from './upgrade.js';

/**
 * Shared session → tenant → connection resolution for the proxy routes
 * (REQ-B-15: the tenant is derived ONLY from the session; client-supplied
 * ids/headers never influence it).
 */

export interface ResolvedTenant {
  tenant: {
    id: string;
    user_id: string;
    status: string;
    container_name: string;
    gateway_secret_enc: string;
  };
  /** http://host:port of the tenant's C1 gateway. */
  baseUrl: string;
  /** The tenant's decrypted gateway secret. */
  secret: string;
}

export type TenantLookupCode = 'NO_TENANT' | 'NOT_READY' | 'NO_CONTAINER' | 'SECRET_UNDECRYPTABLE' | 'DOCKER_ERROR';

export type TenantLookupResult =
  | { ok: true; resolved: ResolvedTenant }
  | { ok: false; code: TenantLookupCode; message: string };

export async function resolveTenantForUser(
  app: Pick<AppContext, 'config' | 'db' | 'docker'>,
  userId: string,
): Promise<TenantLookupResult> {
  const tenant = app.db.prepare('SELECT * FROM tenants WHERE user_id = ?').get(userId) as
    | ResolvedTenant['tenant']
    | undefined;
  if (!tenant) {
    return { ok: false, code: 'NO_TENANT', message: 'no tenant for this user' };
  }
  if (tenant.status !== 'ready' && tenant.status !== 'degraded') {
    return { ok: false, code: 'NOT_READY', message: `tenant is ${tenant.status}` };
  }
  let containerId: string | null;
  try {
    containerId = await findContainerId(app, tenant.container_name);
  } catch (err) {
    return {
      ok: false,
      code: 'DOCKER_ERROR',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (!containerId) {
    return { ok: false, code: 'NO_CONTAINER', message: 'tenant container not found' };
  }
  try {
    const inspect = await app.docker.inspectContainer(containerId);
    const baseUrl = tenantBaseUrl(inspect);
    const secret = decryptSecret(app.config.masterKey, tenant.gateway_secret_enc);
    return { ok: true, resolved: { tenant, baseUrl, secret } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/secret/i.test(message)) {
      return { ok: false, code: 'SECRET_UNDECRYPTABLE', message };
    }
    return { ok: false, code: 'DOCKER_ERROR', message };
  }
}
