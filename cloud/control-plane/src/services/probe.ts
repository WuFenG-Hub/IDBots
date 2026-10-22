import type { AppContext } from '../context.js';
import { tenantBaseUrl, type DockerContainerInspect } from '../docker/client.js';
import { decryptSecret } from '../crypto.js';
import type { ProbeResult } from './statusMachine.js';

/**
 * Shared tenant probing used by both the status poller and the upgrade
 * service: resolve the container, then walk /healthz and /readyz with the
 * tenant's decrypted gateway secret. Pure side-effect free HTTP — callers
 * own persistence decisions.
 */

export interface ProbeOutcome {
  probe: ProbeResult;
  startedAtMs: number | null;
}

export interface TenantProbeRow {
  container_name: string;
  gateway_secret_enc: string;
}

const ZERO_STARTED_AT = '0001-01-01';

export async function probeTenant(
  app: Pick<AppContext, 'config' | 'docker'>,
  row: TenantProbeRow,
  probeTimeoutMs = 2000,
): Promise<ProbeOutcome> {
  let inspect: DockerContainerInspect;
  try {
    const list = await app.docker.listContainers({ namePrefix: row.container_name, all: true });
    const item = list.find((entry) => entry.Names[0] === `/${row.container_name}`);
    if (!item) {
      return { probe: { kind: 'exited', exitCode: null }, startedAtMs: null };
    }
    inspect = await app.docker.inspectContainer(item.Id);
  } catch (err) {
    return {
      probe: { kind: 'probe-error', message: err instanceof Error ? err.message : String(err) },
      startedAtMs: null,
    };
  }

  const startedAtMs =
    !inspect.State.StartedAt || inspect.State.StartedAt.startsWith(ZERO_STARTED_AT)
      ? null
      : Date.parse(inspect.State.StartedAt);
  if (!inspect.State.Running) {
    return { probe: { kind: 'exited', exitCode: inspect.State.ExitCode }, startedAtMs };
  }

  let base: string;
  try {
    base = tenantBaseUrl(inspect);
  } catch (err) {
    return {
      probe: { kind: 'probe-error', message: err instanceof Error ? err.message : String(err) },
      startedAtMs,
    };
  }

  try {
    const health = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(probeTimeoutMs) });
    if (health.status !== 200) {
      return { probe: { kind: 'health-down' }, startedAtMs };
    }
  } catch (err) {
    return {
      probe: { kind: 'probe-error', message: err instanceof Error ? err.message : String(err) },
      startedAtMs,
    };
  }

  let secret: string;
  try {
    secret = decryptSecret(app.config.masterKey, row.gateway_secret_enc);
  } catch (err) {
    return {
      probe: { kind: 'probe-error', message: `gateway secret decrypt failed: ${String(err)}` },
      startedAtMs,
    };
  }

  try {
    const readyz = await fetch(`${base}/readyz`, {
      headers: { 'X-IDBots-Gateway-Secret': secret },
      signal: AbortSignal.timeout(probeTimeoutMs),
    });
    const text = await readyz.text();
    interface ReadyzBody {
      ready?: boolean;
      phase?: string | null;
      version?: string | null;
      contractVersion?: string | null;
      error?: { step: string; message: string } | null;
    }
    let body: ReadyzBody | null = null;
    try {
      body = JSON.parse(text) as ReadyzBody;
    } catch {
      body = null;
    }
    if (!body || typeof body.ready !== 'boolean') {
      return { probe: { kind: 'probe-error', message: 'readyz returned no usable body' }, startedAtMs };
    }
    return {
      probe: {
        kind: 'ok',
        ready: body.ready,
        phase: body.phase ?? null,
        appVersion: body.version ?? null,
        contractVersion: body.contractVersion ?? null,
        readyzError: body.error ?? null,
      },
      startedAtMs,
    };
  } catch (err) {
    return {
      probe: { kind: 'probe-error', message: err instanceof Error ? err.message : String(err) },
      startedAtMs,
    };
  }
}

export type ReadyOutcome = 'ready' | 'degraded' | 'exited' | 'timeout';

/**
 * Poll a tenant until /readyz reports ready or degraded (or the container
 * exits / the budget runs out). Used by the upgrade service's post-start
 * wait; returns the last successful probe so callers can persist versions.
 */
export async function waitForTenantReady(
  app: Pick<AppContext, 'config' | 'docker'>,
  row: TenantProbeRow,
  opts: { timeoutMs?: number; intervalMs?: number; probeTimeoutMs?: number } = {},
): Promise<{ outcome: ReadyOutcome; lastOk: Extract<ProbeResult, { kind: 'ok' }> | null }> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const intervalMs = opts.intervalMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  let lastOk: Extract<ProbeResult, { kind: 'ok' }> | null = null;
  for (;;) {
    const { probe } = await probeTenant(app, row, opts.probeTimeoutMs);
    if (probe.kind === 'ok') {
      lastOk = probe;
      if (probe.phase === 'ready') {
        return { outcome: 'ready', lastOk };
      }
      if (probe.phase === 'degraded') {
        return { outcome: 'degraded', lastOk };
      }
      if (probe.phase === 'failed') {
        return { outcome: 'exited', lastOk };
      }
    } else if (probe.kind === 'exited') {
      return { outcome: 'exited', lastOk };
    }
    if (Date.now() >= deadline) {
      return { outcome: 'timeout', lastOk };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
