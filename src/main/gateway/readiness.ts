/**
 * C1 readiness — the `/readyz` response shape and the ready/degraded → 200
 * mapping. Pure module (no imports at all), loadable from plain node; the
 * server layer fills `ReadinessState` from the bootstrap state machine.
 *
 * Contract: docs/cloud-mobile/01-interface-contracts.md, C1 "HTTP Endpoints"
 * (`GET /readyz`).
 */

export type TenantPhase =
  | 'starting'
  | 'migrating'
  | 'bootstrapping'
  | 'ready'
  | 'degraded'
  | 'stopping'
  | 'failed';

export type OnboardingStepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface OnboardingState {
  identity: OnboardingStepState;
  llmProvider: OnboardingStepState;
  twinMetabot: OnboardingStepState;
  workspace: OnboardingStepState;
  trafficAccount: OnboardingStepState;
  redeemCode: OnboardingStepState;
  globalMetaId?: string | null;
  twinMetabotId?: number | null;
}

export interface ReadinessError {
  step: string;
  message: string;
}

/** The `/readyz` JSON shape (C1), used as the builder input. */
export interface ReadinessState {
  phase: TenantPhase;
  version: string;
  commit: string;
  contractVersion: string;
  onboarding: OnboardingState;
  error?: ReadinessError | null;
}

export interface ReadinessBody {
  ready: boolean;
  phase: TenantPhase;
  version: string;
  commit: string;
  contractVersion: string;
  onboarding: OnboardingState;
  error: ReadinessError | null;
}

export interface ReadinessResponse {
  status: 200 | 503;
  body: ReadinessBody;
}

/**
 * 200 iff the tenant is `ready` or `degraded` (C1: "degraded means ready for
 * chat but an optional step failed"); 503 otherwise. The body is always the
 * full readiness object.
 */
export function buildReadinessResponse(state: ReadinessState): ReadinessResponse {
  const ready = state.phase === 'ready' || state.phase === 'degraded';
  return {
    status: ready ? 200 : 503,
    body: {
      ready,
      phase: state.phase,
      version: state.version,
      commit: state.commit,
      contractVersion: state.contractVersion,
      onboarding: state.onboarding,
      error: state.error ?? null,
    },
  };
}
