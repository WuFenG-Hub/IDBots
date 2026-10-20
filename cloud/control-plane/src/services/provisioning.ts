import type { AppContext } from '../context.js';
import { DockerError } from '../docker/client.js';
import { decryptSecret, encryptSecret } from '../crypto.js';
import { newGatewaySecret } from '../ids.js';
import { sendAlert } from '../alerts.js';

/**
 * Tenant provisioning (REQ-B-9): create the data volume and the container
 * through the Docker API with the full C1 setting set, then start it and
 * move the tenant to `booting`. The gateway secret is generated here and
 * stored encrypted BEFORE any Docker call; only the env passed to the
 * container ever sees the plaintext. Never throws — failures land in
 * tenants.last_error plus an operator alert.
 */

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const GATEWAY_PORT = 8790;

interface TenantRow {
  id: string;
  user_id: string;
  status: string;
  container_name: string;
  volume_name: string;
  gateway_secret_enc: string | null;
}

interface UserRow {
  id: string;
  display_name: string;
  locale: string;
}

function markFailed(app: AppContext, tenantId: string, message: string): void {
  app.db
    .prepare("UPDATE tenants SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?")
    .run(message.slice(0, 512), Date.now(), tenantId);
}

export async function provisionTenant(app: AppContext, tenantId: string): Promise<void> {
  const log = (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level, component: 'provisioning', tenant: tenantId, msg, ...extra }));

  const tenant = app.db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId) as
    | TenantRow
    | undefined;
  if (!tenant) {
    log('error', 'tenant row missing');
    return;
  }
  if (tenant.status !== 'provisioning') {
    log('warn', `skip: status is ${tenant.status}, expected provisioning`);
    return;
  }
  const user = app.db.prepare('SELECT * FROM users WHERE id = ?').get(tenant.user_id) as
    | UserRow
    | undefined;
  if (!user) {
    markFailed(app, tenantId, 'user row missing');
    await sendAlert(app.config, `tenant ${tenantId}: user row missing, provisioning aborted`);
    return;
  }

  // Secret first: the database must hold it before any Docker call happens,
  // so a crashed provision still leaves the tenant attachable.
  const gatewaySecret = newGatewaySecret();
  app.db
    .prepare('UPDATE tenants SET gateway_secret_enc = ?, updated_at = ? WHERE id = ?')
    .run(encryptSecret(app.config.masterKey, gatewaySecret), Date.now(), tenantId);

  try {
    await app.docker.createVolume(tenant.volume_name, {
      'org.idbots.tenant-id': tenantId,
      'org.idbots.user-id': user.id,
    });
  } catch (err) {
    if (!(err instanceof DockerError && err.status === 409)) {
      const message = `volume create failed: ${err instanceof Error ? err.message : String(err)}`;
      markFailed(app, tenantId, message);
      log('error', message);
      await sendAlert(app.config, `tenant ${tenantId}: ${message}`);
      return;
    }
    log('info', 'volume already exists, reusing');
  }

  const env: Record<string, string> = {
    IDBOTS_SERVER_MODE: '1',
    IDBOTS_TENANT_ID: tenantId,
    IDBOTS_GATEWAY_SECRET: gatewaySecret,
    IDBOTS_GATEWAY_PORT: String(GATEWAY_PORT),
    IDBOTS_GATEWAY_TIER: 'P1',
    IDBOTS_USER_DATA_PATH: '/data/userdata',
    IDBOTS_APP_DATA_PATH: '/data/appdata',
    IDBOTS_WORKSPACE_PATH: '/data/workspace',
    IDBOTS_BOOTSTRAP_DISPLAY_NAME: user.display_name || 'IDBots User',
    IDBOTS_BOOTSTRAP_LOCALE: user.locale || 'zh',
    TZ: 'Asia/Shanghai',
  };

  const redeem = app.db
    .prepare('SELECT code_enc FROM redeem_codes WHERE assigned_user_id = ?')
    .get(user.id) as { code_enc: string } | undefined;
  if (redeem) {
    try {
      env.IDBOTS_BOOTSTRAP_TRAFFIC_REDEEM_CODE = decryptSecret(app.config.masterKey, redeem.code_enc);
    } catch (err) {
      const message = `redeem code decrypt failed: ${err instanceof Error ? err.message : String(err)}`;
      markFailed(app, tenantId, message);
      await sendAlert(app.config, `tenant ${tenantId}: ${message}`);
      return;
    }
  } else {
    log('warn', 'redeem pool empty for this tenant; provisioning without a code');
    await sendAlert(app.config, `tenant ${tenantId}: redeem code pool empty, tenant provisioning without a code`);
  }
  for (const [key, value] of Object.entries(app.config.tenantEnv)) {
    env[key] = value;
  }

  const memoryBytes = app.config.tenantMemoryMb * MIB;
  try {
    const created = await app.docker.createContainer({
      name: tenant.container_name,
      image: app.config.tenantImage,
      env,
      labels: {
        'org.idbots.tenant-id': tenantId,
        'org.idbots.user-id': user.id,
      },
      exposedPorts: [`${GATEWAY_PORT}/tcp`],
      hostConfig: {
        Memory: memoryBytes,
        MemorySwap: memoryBytes,
        NanoCpus: app.config.tenantCpus * 1e9,
        PidsLimit: 2048,
        ShmSize: GIB,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        RestartPolicy: { Name: 'unless-stopped' },
        LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '5' } },
        Binds: [`${tenant.volume_name}:/data`],
        NetworkMode: app.config.tenantNetwork,
        Init: true,
      },
    });
    await app.docker.startContainer(created.Id);
  } catch (err) {
    const message = `container create/start failed: ${err instanceof Error ? err.message : String(err)}`;
    markFailed(app, tenantId, message);
    log('error', message);
    await sendAlert(app.config, `tenant ${tenantId}: ${message}`);
    return;
  }

  app.db
    .prepare(
      "UPDATE tenants SET status = 'booting', phase = NULL, last_error = NULL, updated_at = ? WHERE id = ?",
    )
    .run(Date.now(), tenantId);
  log('info', 'container started, tenant is booting');
}
