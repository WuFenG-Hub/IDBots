/**
 * Tenant status machine (REQ-B-10), as a pure transition function so the
 * rules are unit-testable without Docker or HTTP.
 *
 *   provisioning → booting → onboarding → ready
 *                                       ↘ degraded
 *   ready | degraded → upgrading → ready | degraded | failed   (upgrading: next phase)
 *   any → stopped (admin) → booting      (non-polled)
 *   any → suspended (admin)              (non-polled)
 *   provisioning | booting | onboarding → failed (timeout or container exit)
 *
 * Decisions (flagged in the delivery note):
 * - `starting` counts as an onboarding phase (C1 lists it alongside
 *   migrating/bootstrapping).
 * - A degraded tenant keeps `last_error` NULL — the tenants table has no
 *   separate degraded-detail column, so the detail is logs-only.
 * - Container exit (or a vanished container) fails the tenant from any
 *   non-terminal status; the real engine's restart policy owns restarts.
 */

export type TenantStatus =
  | 'provisioning'
  | 'booting'
  | 'onboarding'
  | 'ready'
  | 'degraded'
  | 'upgrading'
  | 'stopped'
  | 'suspended'
  | 'failed';

export const ONBOARDING_PHASES = new Set(['starting', 'migrating', 'bootstrapping']);

export type ProbeResult =
  | {
      kind: 'ok';
      ready: boolean;
      phase: string | null;
      appVersion: string | null;
      contractVersion: string | null;
      /** readyz error payload ({step,message}); set for phase failed/degraded. */
      readyzError: { step: string; message: string } | null;
    }
  | { kind: 'health-down' }
  | { kind: 'probe-error'; message: string }
  | { kind: 'exited'; exitCode: number | null };

export interface Timeouts {
  /** 60 s from container start to healthy. */
  healthyMs: number;
  /** 300 s from container start to ready on first boot. */
  readyFirstMs: number;
  /** 90 s from container start to ready on restarts. */
  readyRestartMs: number;
}

export const DEFAULT_TIMEOUTS: Timeouts = {
  healthyMs: 60_000,
  readyFirstMs: 300_000,
  readyRestartMs: 90_000,
};

export interface Transition {
  to: TenantStatus;
  /** /readyz phase to persist; only meaningful while booting/onboarding. */
  phase: string | null;
  lastError: string | null;
  appVersion: string | null;
  contractVersion: string | null;
  alert: string | null;
}

const NO_CHANGE_BASE = { phase: null as string | null, lastError: null, alert: null };

function stay(current: TenantStatus, appVersion: string | null = null, contractVersion: string | null = null): Transition {
  return { to: current, ...NO_CHANGE_BASE, appVersion, contractVersion };
}

function fail(message: string, appVersion: string | null = null, contractVersion: string | null = null): Transition {
  return { to: 'failed', phase: null, lastError: message, alert: message, appVersion, contractVersion };
}

export interface ClockInfo {
  now: number;
  /** Container StartedAt (ms); null when unknown. */
  startedAtMs: number | null;
  /** First boot = the tenant has never been ready (app_version still null). */
  firstBoot: boolean;
}

export function nextStatus(
  current: TenantStatus,
  probe: ProbeResult,
  clock: ClockInfo,
  timeouts: Timeouts = DEFAULT_TIMEOUTS,
): Transition {
  if (current === 'stopped' || current === 'suspended' || current === 'upgrading' || current === 'failed') {
    return stay(current);
  }

  const startedAt = clock.startedAtMs ?? clock.now;
  const elapsed = clock.now - startedAt;
  const readyBudget = clock.firstBoot ? timeouts.readyFirstMs : timeouts.readyRestartMs;

  if (probe.kind === 'exited') {
    return fail(`container exited (code ${probe.exitCode ?? 'unknown'})`);
  }

  if (probe.kind === 'probe-error') {
    // Transient: budgets still tick for booting/onboarding.
    if ((current === 'booting' || current === 'provisioning') && elapsed > timeouts.healthyMs) {
      return fail(`timed out after ${timeouts.healthyMs} ms waiting for the tenant to become healthy`);
    }
    if (current === 'onboarding' && elapsed > readyBudget) {
      return fail(`timed out after ${readyBudget} ms waiting for the tenant to become ready`);
    }
    return stay(current);
  }

  if (probe.kind === 'health-down') {
    if (current === 'ready' || current === 'degraded') {
      // A running container whose /healthz stopped answering is treated as
      // transient here; flapping guards belong to the poller phase.
      return stay(current);
    }
    if (elapsed > timeouts.healthyMs) {
      return fail(`timed out after ${timeouts.healthyMs} ms waiting for /healthz`);
    }
    if (current === 'onboarding' && elapsed > readyBudget) {
      return fail(`timed out after ${readyBudget} ms waiting for the tenant to become ready`);
    }
    return stay('booting');
  }

  // probe.kind === 'ok'
  const { appVersion, contractVersion } = probe;

  if (probe.phase === 'failed') {
    const detail = probe.readyzError ? `${probe.readyzError.step}: ${probe.readyzError.message}` : 'tenant reported failed';
    return fail(detail, appVersion, contractVersion);
  }

  if (!probe.ready) {
    if (probe.phase !== null && ONBOARDING_PHASES.has(probe.phase)) {
      if (elapsed > readyBudget) {
        return fail(
          `timed out after ${readyBudget} ms waiting for the tenant to become ready (phase ${probe.phase})`,
          appVersion,
          contractVersion,
        );
      }
      return {
        to: 'onboarding',
        phase: probe.phase,
        lastError: null,
        appVersion,
        contractVersion,
        alert: null,
      };
    }
    // Unknown/not-ready phase: hold, but the ready budget still applies.
    if (elapsed > readyBudget) {
      return fail(`timed out after ${readyBudget} ms waiting for the tenant to become ready`, appVersion, contractVersion);
    }
    return stay(current, appVersion, contractVersion);
  }

  if (probe.phase === 'degraded') {
    return { to: 'degraded', phase: null, lastError: null, appVersion, contractVersion, alert: null };
  }
  if (probe.phase === 'ready') {
    return { to: 'ready', phase: null, lastError: null, appVersion, contractVersion, alert: null };
  }
  // ready=true with an unexpected phase: treat as ready (forward-compatible).
  return { to: 'ready', phase: null, lastError: null, appVersion, contractVersion, alert: null };
}
