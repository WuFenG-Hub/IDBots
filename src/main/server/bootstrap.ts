/**
 * REQ-A-8 server bootstrap — the main-side state machine that brings a fresh
 * tenant to ready on every start.
 *
 * Phases (C1 `/readyz`): `starting` → `migrating` (first-run DB migrations,
 * here the bootstrap table ensure) → `bootstrapping` → `ready` | `degraded`
 * | `failed`, plus `stopping` on shutdown. Steps 1–4 (`identity`,
 * `llmProvider`, `twinMetabot`, `workspace`) are critical: a failure sets
 * phase `failed` and is retried with backoff at most every 5 minutes.
 * Steps 5–7 (`trafficAccount`, `redeemCode`, `listener`) are optional: a
 * failure marks the step `failed`, records `error {step, message}`, and sets
 * phase `degraded` (ready for chat).
 *
 * Every run resumes from the first step whose persisted state is neither
 * `done` nor `skipped`; the `server_bootstrap_steps` table is the source of
 * truth, so an interrupted bootstrap (crash, SIGKILL) continues on the next
 * start and no completed step re-runs its side effect.
 *
 * This module is pure (no electron imports, no service imports): the real
 * step executors are injected by src/main/server/bootstrapSteps.ts, and plain
 * node tests drive the core with fakes plus a real temp SQLite.
 *
 * Contract: docs/cloud-mobile/10-ws-a-idbots-server-mode.md (REQ-A-8/29),
 * docs/cloud-mobile/01-interface-contracts.md (C1 `/readyz`).
 */

import type { SqliteDatabase } from '../sqliteTypes';
import type {
  OnboardingState,
  OnboardingStepState,
  ReadinessError,
  ReadinessState,
  TenantPhase,
} from '../gateway/readiness';

// ---------------------------------------------------------------------------
// Steps + retry schedule
// ---------------------------------------------------------------------------

/** Ordered REQ-A-8 step ids. `listener` is intentionally not a C1 onboarding key. */
export const SERVER_BOOTSTRAP_STEP_IDS = [
  'identity',
  'llmProvider',
  'twinMetabot',
  'workspace',
  'trafficAccount',
  'redeemCode',
  'listener',
] as const;

export type ServerBootstrapStepId = (typeof SERVER_BOOTSTRAP_STEP_IDS)[number];

export const SERVER_BOOTSTRAP_STEP_ID_SET: ReadonlySet<string> = new Set(SERVER_BOOTSTRAP_STEP_IDS);

/** Steps whose failure fails the tenant (retried with backoff). */
export const SERVER_BOOTSTRAP_CRITICAL_STEPS: ReadonlySet<ServerBootstrapStepId> = new Set([
  'identity',
  'llmProvider',
  'twinMetabot',
  'workspace',
]);

/** C1 `/readyz` onboarding keys, in step order (no `listener`). */
export const SERVER_BOOTSTRAP_ONBOARDING_STEP_IDS: readonly ServerBootstrapStepId[] = [
  'identity',
  'llmProvider',
  'twinMetabot',
  'workspace',
  'trafficAccount',
  'redeemCode',
];

/** First retry delay after a critical-step failure. */
export const BOOTSTRAP_RETRY_BASE_MS = 30_000;
/** Retry backoff cap: a failed critical step is retried at most every 5 minutes. */
export const BOOTSTRAP_RETRY_MAX_MS = 300_000;

/**
 * Critical-step retry schedule: 30s → 60s → 120s → 300s, then constant at
 * the 5-minute cap (REQ-A-8 "retried with backoff, at most every 5 minutes").
 * `failedAttempts` counts consecutive failed passes, starting at 1.
 */
export function computeBootstrapRetryDelayMs(failedAttempts: number): number {
  const attempts = Number.isFinite(failedAttempts) ? Math.max(1, Math.floor(failedAttempts)) : 1;
  return Math.min(BOOTSTRAP_RETRY_MAX_MS, BOOTSTRAP_RETRY_BASE_MS * 2 ** (attempts - 1));
}

// ---------------------------------------------------------------------------
// Persistence (REQ-A-28: additive, idempotent; never deletes user data)
// ---------------------------------------------------------------------------

export type ServerBootstrapStepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface ServerBootstrapStepRecord {
  step: ServerBootstrapStepId;
  state: ServerBootstrapStepState;
  updatedAt: number;
  error: string | null;
}

const VALID_STEP_STATES: ReadonlySet<string> = new Set(['pending', 'running', 'done', 'skipped', 'failed']);

function isStepId(value: unknown): value is ServerBootstrapStepId {
  return typeof value === 'string' && SERVER_BOOTSTRAP_STEP_ID_SET.has(value);
}

function isStepState(value: unknown): value is ServerBootstrapStepState {
  return typeof value === 'string' && VALID_STEP_STATES.has(value);
}

/**
 * REQ-A-28 migration: additive `CREATE TABLE IF NOT EXISTS` + state CHECK,
 * the same idiom as every other store schema in this repo. Safe to run on
 * every start, including against databases created before server mode existed.
 */
export function ensureServerBootstrapSchema(db: SqliteDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS server_bootstrap_steps (
      step TEXT PRIMARY KEY,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'running', 'done', 'skipped', 'failed')),
      updated_at INTEGER NOT NULL,
      error TEXT
    );
  `);
}

interface StepRow {
  step: string;
  state: string;
  updated_at: number;
  error: string | null;
}

/**
 * Thin persistence layer over the existing SQLite database (the SqliteStore's
 * db + save function are injected so the same code path persists in
 * production and in plain-node tests against a real temp SQLite).
 */
export class ServerBootstrapStore {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly saveDb: () => void,
  ) {
    ensureServerBootstrapSchema(db);
  }

  private getOne<T>(sql: string, params: unknown[] = []): T | null {
    const result = this.db.exec(sql, params);
    const columns = result[0]?.columns ?? [];
    const values = result[0]?.values?.[0];
    if (!values) return null;
    return Object.fromEntries(columns.map((column, index) => [column, values[index]])) as T;
  }

  /** One row per known step; unknown persisted steps are ignored (forward compat). */
  listStepStates(): ServerBootstrapStepRecord[] {
    const result = this.db.exec('SELECT step, state, updated_at, error FROM server_bootstrap_steps');
    const columns = result[0]?.columns ?? [];
    const rows = (result[0]?.values ?? []).map(
      (values) =>
        Object.fromEntries(columns.map((column, index) => [column, values[index]])) as unknown as StepRow,
    );
    const byStep = new Map<string, ServerBootstrapStepRecord>();
    for (const row of rows) {
      if (!isStepId(row.step) || !isStepState(row.state)) continue;
      byStep.set(row.step, {
        step: row.step,
        state: row.state,
        updatedAt: Number(row.updated_at) || 0,
        error: row.error ?? null,
      });
    }
    return SERVER_BOOTSTRAP_STEP_IDS.map((step) => byStep.get(step) ?? {
      step,
      state: 'pending',
      updatedAt: 0,
      error: null,
    });
  }

  getStepState(step: ServerBootstrapStepId): ServerBootstrapStepRecord {
    return this.listStepStates().find((record) => record.step === step) ?? {
      step,
      state: 'pending',
      updatedAt: 0,
      error: null,
    };
  }

  /** Persist a step transition; every write goes through saveDb so a crash never loses it. */
  setStepState(step: ServerBootstrapStepId, state: ServerBootstrapStepState, error: string | null = null): void {
    this.db.run(
      `INSERT INTO server_bootstrap_steps (step, state, updated_at, error)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(step) DO UPDATE SET
         state = excluded.state,
         updated_at = excluded.updated_at,
         error = excluded.error`,
      [step, state, Date.now(), error],
    );
    this.saveDb();
  }
}

// ---------------------------------------------------------------------------
// Facts + readiness mapping (C1 `/readyz`)
// ---------------------------------------------------------------------------

/** Live identity facts for the readiness object, read fresh on every call. */
export interface ServerBootstrapFacts {
  globalMetaId?: string | null;
  twinMetabotId?: number | null;
}

export interface ServerBootstrapVersion {
  version: string;
  commit: string;
  contractVersion: string;
}

function toOnboardingStepState(record: ServerBootstrapStepRecord | undefined): OnboardingStepState {
  return record?.state ?? 'pending';
}

/** The 6 C1 onboarding keys (step `listener` is internal state, not C1). */
export function buildOnboardingState(
  records: readonly ServerBootstrapStepRecord[],
): OnboardingState {
  const byStep = new Map(records.map((record) => [record.step, record]));
  return {
    identity: toOnboardingStepState(byStep.get('identity')),
    llmProvider: toOnboardingStepState(byStep.get('llmProvider')),
    twinMetabot: toOnboardingStepState(byStep.get('twinMetabot')),
    workspace: toOnboardingStepState(byStep.get('workspace')),
    trafficAccount: toOnboardingStepState(byStep.get('trafficAccount')),
    redeemCode: toOnboardingStepState(byStep.get('redeemCode')),
    globalMetaId: null,
    twinMetabotId: null,
  };
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * One executable step; must be check-then-act idempotent (safe to re-run).
 * Return `{ skipped: true }` when the step has nothing to do this run (the
 * state is persisted as `skipped` and later passes treat it as complete).
 */
export type ServerBootstrapStepExecutor = () => Promise<{ skipped?: boolean } | void>;

export type ServerBootstrapStepExecutors = Record<ServerBootstrapStepId, ServerBootstrapStepExecutor>;

export interface ServerBootstrapDeps {
  bootstrapStore: ServerBootstrapStore;
  executors: ServerBootstrapStepExecutors;
  version: ServerBootstrapVersion;
  /** Live identity facts for the readiness object (identity/metabot stores). */
  getFacts?: () => ServerBootstrapFacts;
  /** Observes every state change (phase + step records + error). */
  onStateChange?: (snapshot: ServerBootstrapSnapshot) => void;
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface ServerBootstrapSnapshot {
  phase: TenantPhase;
  steps: ServerBootstrapStepRecord[];
  error: ReadinessError | null;
}

export type ServerBootstrapOutcome =
  | { phase: 'ready' }
  | { phase: 'degraded'; error: ReadinessError }
  | { phase: 'failed'; error: ReadinessError }
  | { phase: 'stopping' };

export interface ServerBootstrapRun {
  /** Idempotent; kicks the first pass and any backoff retries. */
  start: () => void;
  /** Cancels pending retry timers; the in-flight pass winds down quietly. */
  stop: () => void;
  /** Shutdown hook (REQ-A-3): phase becomes `stopping`, retries stop. */
  markStopping: () => void;
  /** Resolves when a pass reaches a terminal phase (ready/degraded/failed/stopping). */
  finished: Promise<ServerBootstrapOutcome>;
  getSnapshot: () => ServerBootstrapSnapshot;
  getReadinessState: () => ReadinessState;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/**
 * REQ-A-8 core. A pass walks the steps in order and stops at the first
 * critical failure; optional failures are recorded and the pass continues.
 * The pass result (phase + error) is derived from what happened THIS pass, so
 * a later successful retry of a previously-failed optional step flips the
 * tenant back to `ready` with `error: null`.
 */
export function runServerBootstrap(deps: ServerBootstrapDeps): ServerBootstrapRun {
  const now = deps.now ?? Date.now;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  const log = deps.log ?? (() => {});

  let phase: TenantPhase = 'starting';
  let stepRecords: ServerBootstrapStepRecord[] = [];
  let error: ReadinessError | null = null;
  let started = false;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failedAttempts = 0;
  let resolveFinished!: (outcome: ServerBootstrapOutcome) => void;
  const finished = new Promise<ServerBootstrapOutcome>((resolve) => {
    resolveFinished = resolve;
  });

  const snapshot = (): ServerBootstrapSnapshot => ({
    phase,
    steps: stepRecords.map((record) => ({ ...record })),
    error,
  });

  const emit = (): void => {
    try {
      deps.onStateChange?.(snapshot());
    } catch {
      // Observer failures must never break the bootstrap.
    }
  };

  const setPhase = (next: TenantPhase): void => {
    if (phase === next) return;
    phase = next;
    emit();
  };

  const setStepRecord = (step: ServerBootstrapStepId, state: ServerBootstrapStepState, stepError: string | null = null): void => {
    deps.bootstrapStore.setStepState(step, state, stepError);
    stepRecords = stepRecords.map((record) =>
      record.step === step ? { step, state, updatedAt: now(), error: stepError } : record,
    );
    emit();
  };

  const getReadinessState = (): ReadinessState => {
    const facts = deps.getFacts?.() ?? {};
    return {
      phase,
      version: deps.version.version,
      commit: deps.version.commit,
      contractVersion: deps.version.contractVersion,
      onboarding: {
        ...buildOnboardingState(stepRecords),
        globalMetaId: facts.globalMetaId ?? null,
        twinMetabotId: Number.isInteger(facts.twinMetabotId) ? facts.twinMetabotId : null,
      },
      error,
    };
  };

  const scheduleRetry = (): void => {
    failedAttempts += 1;
    const delayMs = computeBootstrapRetryDelayMs(failedAttempts);
    log('warn', `critical bootstrap step failed; retrying in ${Math.round(delayMs / 1000)}s`, {
      failedAttempts,
      phase,
      error,
    });
    retryTimer = setTimeoutFn(() => {
      retryTimer = null;
      void runPass();
    }, delayMs);
    retryTimer.unref?.();
  };

  const runPass = async (): Promise<void> => {
    if (stopped) return;
    stepRecords = deps.bootstrapStore.listStepStates();
    setPhase('bootstrapping');
    let firstOptionalError: ReadinessError | null = null;

    for (const step of SERVER_BOOTSTRAP_STEP_IDS) {
      if (stopped) return;
      const record = stepRecords.find((item) => item.step === step);
      if (record && (record.state === 'done' || record.state === 'skipped')) continue;

      log('info', `bootstrap step begin: ${step}`);
      setStepRecord(step, 'running', null);
      try {
        const outcome = await deps.executors[step]();
        const skipped = typeof outcome === 'object' && outcome !== null && outcome.skipped === true;
        setStepRecord(step, skipped ? 'skipped' : 'done', null);
        log('info', `bootstrap step ${skipped ? 'skipped' : 'done'}: ${step}`);
      } catch (stepError) {
        const message = errorMessage(stepError);
        if (SERVER_BOOTSTRAP_CRITICAL_STEPS.has(step)) {
          setStepRecord(step, 'failed', message);
          error = { step, message };
          setPhase('failed');
          scheduleRetry();
          return;
        }
        setStepRecord(step, 'failed', message);
        firstOptionalError ??= { step, message };
        log('warn', `optional bootstrap step failed: ${step}`, { error: message });
      }
    }

    failedAttempts = 0;
    if (firstOptionalError) {
      error = firstOptionalError;
      setPhase('degraded');
      resolveFinished({ phase: 'degraded', error: firstOptionalError });
    } else {
      error = null;
      setPhase('ready');
      resolveFinished({ phase: 'ready' });
    }
  };

  return {
    finished,
    start: () => {
      if (started) return;
      started = true;
      // `migrating`: the bootstrap's own first-run schema ensure happened in
      // the store constructor; the app's DB migrations ran in initStore before
      // this. The phase exists in the C1 list and lasts until the first pass.
      setPhase('migrating');
      void runPass();
    },
    stop: () => {
      stopped = true;
      if (retryTimer) {
        clearTimeoutFn(retryTimer);
        retryTimer = null;
      }
    },
    markStopping: () => {
      stopped = true;
      if (retryTimer) {
        clearTimeoutFn(retryTimer);
        retryTimer = null;
      }
      setPhase('stopping');
      resolveFinished({ phase: 'stopping' });
    },
    getSnapshot: snapshot,
    getReadinessState,
  };
}
