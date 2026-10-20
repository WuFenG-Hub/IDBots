import type { AppContext } from '../context.js';
import { tenantBaseUrl, type DockerContainerInspect } from '../docker/client.js';
import { decryptSecret } from '../crypto.js';
import { sendAlert } from '../alerts.js';
import {
  DEFAULT_TIMEOUTS,
  nextStatus,
  type ProbeResult,
  type TenantStatus,
  type Timeouts,
} from './statusMachine.js';

/**
 * Tenant status poller (REQ-B-10): probes each live tenant's /healthz and
 * /readyz through the status machine and persists transitions. Fast tick
 * while booting/onboarding, slow tick otherwise; per-tenant scheduling so a
 * slow tenant never delays a stuck one. Sweeps are serialized and every
 * tenant is isolated in its own try/catch.
 *
 * `provisioning` rows are deliberately NOT probed here — that status belongs
 * to provisionTenant, which moves it to booting or failed.
 */

export interface PollerOptions {
  tickFastMs?: number;
  tickSlowMs?: number;
  timeouts?: Partial<Timeouts>;
  probeTimeoutMs?: number;
  now?: () => number;
}

interface TenantRow {
  id: string;
  container_name: string;
  status: string;
  phase: string | null;
  app_version: string | null;
  contract_version: string | null;
  last_error: string | null;
  gateway_secret_enc: string;
}

const ZERO_STARTED_AT = '0001-01-01';

export class TenantPoller {
  private readonly tickFastMs: number;
  private readonly tickSlowMs: number;
  private readonly timeouts: Timeouts;
  private readonly probeTimeoutMs: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly nextPollAt = new Map<string, number>();

  constructor(
    private readonly app: Pick<AppContext, 'config' | 'db' | 'docker'>,
    opts: PollerOptions = {},
  ) {
    this.tickFastMs = opts.tickFastMs ?? 3000;
    this.tickSlowMs = opts.tickSlowMs ?? 30_000;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
    this.probeTimeoutMs = opts.probeTimeoutMs ?? 2000;
    this.now = opts.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.tickOnce().catch((err) => {
        console.error(JSON.stringify({ level: 'error', component: 'poller', msg: 'sweep failed', error: String(err) }));
      });
    }, this.tickFastMs);
  }

  /** Stops the timer and returns once the in-flight sweep (if any) settles. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.chain;
  }

  /** Enqueue one sweep; awaits its completion (test-friendly). */
  tickOnce(): Promise<void> {
    const run = this.chain.then(() => this.sweep());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async sweep(): Promise<void> {
    const rows = this.app.db
      .prepare("SELECT * FROM tenants WHERE status IN ('booting', 'onboarding', 'ready', 'degraded')")
      .all() as TenantRow[];
    const activeIds = new Set(rows.map((row) => row.id));
    for (const id of [...this.nextPollAt.keys()]) {
      if (!activeIds.has(id)) {
        this.nextPollAt.delete(id);
      }
    }
    for (const row of rows) {
      const now = this.now();
      if (now < (this.nextPollAt.get(row.id) ?? 0)) {
        continue;
      }
      const fast = row.status === 'booting' || row.status === 'onboarding';
      this.nextPollAt.set(row.id, now + (fast ? this.tickFastMs : this.tickSlowMs));
      try {
        await this.probeAndApply(row, now);
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            component: 'poller',
            tenant: row.id,
            msg: 'probe failed',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  }

  private async probeAndApply(row: TenantRow, now: number): Promise<void> {
    const { probe, startedAtMs } = await this.probe(row);
    const firstBoot = row.app_version === null;
    const transition = nextStatus(
      row.status as TenantStatus,
      probe,
      { now, startedAtMs, firstBoot },
      this.timeouts,
    );

    const changed =
      transition.to !== row.status ||
      transition.phase !== row.phase ||
      transition.lastError !== row.last_error ||
      transition.appVersion !== row.app_version ||
      transition.contractVersion !== row.contract_version;
    if (changed) {
      this.app.db
        .prepare(
          `UPDATE tenants
           SET status = ?, phase = ?, last_error = ?, app_version = ?, contract_version = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          transition.to,
          transition.phase,
          transition.lastError,
          transition.appVersion,
          transition.contractVersion,
          now,
          row.id,
        );
      console.log(
        JSON.stringify({
          level: 'info',
          component: 'poller',
          tenant: row.id,
          msg: 'status transition',
          from: row.status,
          to: transition.to,
          phase: transition.phase,
        }),
      );
    }
    if (transition.alert) {
      await sendAlert(this.app.config, `tenant ${row.id}: ${transition.alert}`);
    }
  }

  private async probe(row: TenantRow): Promise<{ probe: ProbeResult; startedAtMs: number | null }> {
    let inspect: DockerContainerInspect;
    try {
      const list = await this.app.docker.listContainers({ namePrefix: row.container_name, all: true });
      const item = list.find((entry) => entry.Names[0] === `/${row.container_name}`);
      if (!item) {
        return { probe: { kind: 'exited', exitCode: null }, startedAtMs: null };
      }
      inspect = await this.app.docker.inspectContainer(item.Id);
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
      const health = await fetch(`${base}/healthz`, {
        signal: AbortSignal.timeout(this.probeTimeoutMs),
      });
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
      secret = decryptSecret(this.app.config.masterKey, row.gateway_secret_enc);
    } catch (err) {
      return {
        probe: { kind: 'probe-error', message: `gateway secret decrypt failed: ${String(err)}` },
        startedAtMs,
      };
    }

    try {
      const readyz = await fetch(`${base}/readyz`, {
        headers: { 'X-IDBots-Gateway-Secret': secret },
        signal: AbortSignal.timeout(this.probeTimeoutMs),
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
}
