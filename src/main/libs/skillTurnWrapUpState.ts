/**
 * Pure timer state machine for the ACTIVE skill-turn wrap-up mechanism
 * (Twin→Worker delegations).
 *
 * Motivation (2026-10-21 real case): a delegated worker burned its whole
 * 30-min budget mid-investigation and was killed silently — the host only had
 * a PASSIVE late-completion window, so the worker never learned it was in
 * overtime and its findings died with the turn. When a caller opts in via
 * `wrapUpSignal`, the bridge now INJECTS a wrap-up cross-session message at
 * budget exhaustion ("stop exploring, write your handoff NOW, optionally
 * request ONE extension"), then drives the grace/extension timers through
 * this state machine.
 *
 * WHY a pure module: every timer transition must be unit-testable and
 * documented. The bridge only maps effects (inject / start timer / resolve /
 * timeout) to real side effects; ALL decisions — marker parsing, extension
 * capping, phase transitions — live here as pure functions.
 *
 * ── The 45-min hard cap ──────────────────────────────────────────────────
 * The group-task daemon documents a 45-min hard in-flight cap for one turn
 * (groupTaskDaemon.ts: DEFAULT_TICK_WATCHDOG_MS = 45 * 60_000 and the
 * TURN_LATCH_MAX_MS in-flight guard). No wrap-up timer sequence may exceed
 * it, otherwise the daemon guard force-settles the attempt before the
 * wrap-up can deliver its handoff. With the Twin delegation defaults
 * (budget 30 min, grace 5 min, extensionRatio 0.5):
 *
 *   no-extension path:  30 (budget) + 5 (grace)                     = 35 ≤ 45
 *   extension path:     30 (budget) + min(0.5×30, 45−30−5) + 5      = 45 ≤ 45
 *                                      └── extension = 10 min ──┘
 *
 * The extension amount is capped by WATCHDOG HEADROOM at grant time:
 *   extensionMs = min(extensionRatio × originalBudget,
 *                     cap − elapsedAtGrant − finalGrace)
 * so a late extension request inside the grace window gets a SMALLER
 * extension and the sequence still ends at exactly the cap. The grace window
 * itself is clamped to (cap − budget) in resolveWrapUpRuntimeConfig, so the
 * invariant holds for ANY config, not just the defaults.
 */

/**
 * Hard wall-clock cap every wrap-up timer sequence must respect. Mirrors the
 * group-task daemon's 45-min in-flight cap (DEFAULT_TICK_WATCHDOG_MS /
 * TURN_LATCH_MAX_MS in groupTaskDaemon.ts) — kept as its own constant so the
 * arithmetic above is checkable in tests without importing the daemon.
 */
export const SKILL_TURN_DAEMON_WATCHDOG_CAP_MS = 45 * 60_000;

/** Default wrap-up grace window after the budget watchdog fires. */
export const DEFAULT_WRAP_UP_GRACE_MS = 5 * 60_000;

/** Default requested extension, as a ratio of the original budget. */
export const DEFAULT_WRAP_UP_EXTENSION_RATIO = 0.5;

export interface SkillTurnWrapUpSignalConfig {
  /** Grace window (ms) the worker gets to answer the wrap-up signal. */
  graceMs?: number;
  /** Requested extension as a ratio of the original budget (0..1). */
  extensionRatio?: number;
}

export interface WrapUpRuntimeConfig {
  /** The skill-turn watchdog budget this turn started with (ms). */
  originalBudgetMs: number;
  /**
   * Effective grace window (ms), already clamped so budget + grace ≤ cap.
   * Used both for the wrap-up grace and the final grace after an extension.
   */
  graceMs: number;
  extensionRatio: number;
  daemonWatchdogCapMs: number;
}

export type WrapUpPhase =
  | 'running' // budget still running, watchdog armed
  | 'wrap' // wrap-up signal injected, grace window running, extension available
  | 'extension' // one extension granted, extension watchdog running
  | 'final-wrap' // final wrap-up injected, final grace running, NO extension
  | 'settled'; // resolved or timed out; ignore everything

export interface WrapUpMachineState {
  phase: WrapUpPhase;
  /** Whether the single allowed extension has been granted. */
  extensionUsed: boolean;
  /** Granted extension amount (ms) once an extension was granted. */
  grantedExtensionMs: number | null;
  /** Terminal outcome once phase === 'settled'. */
  settledAs: 'resolved' | 'timeout' | null;
}

export type WrapUpEvent =
  /** The main budget watchdog fired (elapsedMs = wall-clock since turn start). */
  | { type: 'budget-exhausted'; elapsedMs: number }
  /** An assistant turn completed (elapsedMs = wall-clock since turn start). */
  | { type: 'turn-completed'; replyText: string; elapsedMs: number }
  /**
   * The current grace/extension window expired with no completion
   * (elapsedMs = wall-clock since turn start; needed to clamp any following
   * final grace inside the daemon cap).
   */
  | { type: 'window-expired'; elapsedMs: number };

export type WrapUpEffect =
  /** Nothing to do (event not applicable in this phase). */
  | { kind: 'none'; reason: string }
  /** Inject the wrap-up message (extension offer) and start the grace timer. */
  | { kind: 'inject-wrap-up'; graceMs: number }
  /** Inject "extension granted" and start the extension watchdog (extensionMs). */
  | { kind: 'grant-extension'; extensionMs: number }
  /**
   * Extension request denied (no headroom left): inject the FINAL wrap-up
   * (no extension offer) and start the final grace timer.
   */
  | { kind: 'deny-extension'; graceMs: number }
  /** Extension watchdog expired: inject the FINAL wrap-up, start final grace. */
  | { kind: 'inject-final-wrap-up'; graceMs: number }
  /** Resolve the caller's promise normally with this reply (the handoff). */
  | { kind: 'resolve'; replyText: string }
  /** Settle as the legacy watchdog failure (SkillTurnTimeoutError + recovery). */
  | { kind: 'timeout' };

export const EXTENSION_REQUEST_MARKER = 'EXTENSION_REQUEST:';
export const WRAP_UP_MARKER = 'WRAP_UP:';

export function initialWrapUpMachineState(): WrapUpMachineState {
  return {
    phase: 'running',
    extensionUsed: false,
    grantedExtensionMs: null,
    settledAs: null,
  };
}

/**
 * Normalize + clamp the caller's wrap-up config and fold in the original
 * budget. The grace window is clamped to (cap − budget) so that even the
 * FIRST sequence (budget + grace) can never exceed the daemon cap, whatever
 * the caller passed.
 */
export function resolveWrapUpRuntimeConfig(
  signal: SkillTurnWrapUpSignalConfig,
  originalBudgetMs: number,
): WrapUpRuntimeConfig {
  const cap = SKILL_TURN_DAEMON_WATCHDOG_CAP_MS;
  const budget = Math.max(0, Math.trunc(originalBudgetMs));
  const requestedGrace = Number.isFinite(signal.graceMs)
    ? Math.max(0, Math.trunc(signal.graceMs as number))
    : DEFAULT_WRAP_UP_GRACE_MS;
  const ratio = Number.isFinite(signal.extensionRatio)
    ? Math.min(1, Math.max(0, signal.extensionRatio as number))
    : DEFAULT_WRAP_UP_EXTENSION_RATIO;
  // WHY the clamp: budget + grace must stay inside the daemon cap even before
  // any extension is considered (see the arithmetic in the header comment).
  const graceMs = Math.min(requestedGrace, Math.max(0, cap - budget));
  return { originalBudgetMs: budget, graceMs, extensionRatio: ratio, daemonWatchdogCapMs: cap };
}

export type WrapUpReplyMarker =
  | { marker: 'extension-request'; reason: string }
  | { marker: 'wrap-up' }
  | { marker: 'none' };

/**
 * Parse the worker's reply against the wrap-up protocol. The protocol told
 * the worker: reply's FIRST line must be exactly
 * `EXTENSION_REQUEST: <one-line reason>` to ask for the one extension, else
 * start with `WRAP_UP:`. Only the first non-empty line counts; matching is
 * case-sensitive on the marker prefix.
 */
export function parseWrapUpReplyMarker(replyText: string): WrapUpReplyMarker {
  const firstLine =
    String(replyText ?? '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  if (firstLine.startsWith(EXTENSION_REQUEST_MARKER)) {
    return {
      marker: 'extension-request',
      reason: firstLine.slice(EXTENSION_REQUEST_MARKER.length).trim(),
    };
  }
  if (firstLine.startsWith(WRAP_UP_MARKER) || firstLine === WRAP_UP_MARKER.slice(0, -1)) {
    return { marker: 'wrap-up' };
  }
  return { marker: 'none' };
}

/**
 * Extension amount for a grant at a given point in time:
 *   min(extensionRatio × originalBudget, watchdog headroom − final grace)
 * where watchdog headroom = cap − elapsedAtGrant. Returns a value > 0 when an
 * extension is grantable; ≤ 0 means there is no headroom and the request must
 * be DENIED (the worker gets the final wrap-up instead).
 *
 * Because the extension is capped by headroom MINUS the final grace, the
 * whole tail sequence (extension + final grace) always lands exactly at the
 * cap, never past it — even when the request arrives late inside the grace
 * window (setTimeout can also fire late, so elapsed is measured, not assumed).
 */
export function computeExtensionBudgetMs(input: {
  originalBudgetMs: number;
  extensionRatio: number;
  daemonWatchdogCapMs: number;
  finalGraceMs: number;
  elapsedMs: number;
}): number {
  const requested = Math.trunc(input.extensionRatio * input.originalBudgetMs);
  const headroomMinusGrace = Math.trunc(
    input.daemonWatchdogCapMs - input.elapsedMs - input.finalGraceMs,
  );
  return Math.min(requested, headroomMinusGrace);
}

/**
 * The pure transition function. `state` is never mutated; the next state is
 * returned alongside the effect the bridge must perform.
 *
 * Transition table (design §2–§3):
 *   running  + budget-exhausted → wrap          / inject-wrap-up
 *   wrap     + turn-completed   → settled       / resolve            (WRAP_UP or anything else)
 *   wrap     + turn-completed   → extension     / grant-extension    (EXTENSION_REQUEST, first time, headroom > 0)
 *   wrap     + turn-completed   → final-wrap    / deny-extension     (EXTENSION_REQUEST but no headroom)
 *   wrap     + window-expired   → settled       / timeout
 *   extension+ turn-completed   → settled       / resolve            (second EXTENSION_REQUEST ignored — resolves like any reply)
 *   extension+ window-expired   → final-wrap    / inject-final-wrap-up
 *   final-wrap+ turn-completed  → settled       / resolve            (extension requests ignored in the final wrap-up)
 *   final-wrap+ window-expired  → settled       / timeout
 *   settled  + anything         → settled       / none
 */
export function advanceWrapUpMachine(
  state: WrapUpMachineState,
  event: WrapUpEvent,
  config: WrapUpRuntimeConfig,
): { state: WrapUpMachineState; effect: WrapUpEffect } {
  if (state.phase === 'settled') {
    return { state, effect: { kind: 'none', reason: 'already settled' } };
  }

  if (state.phase === 'running') {
    if (event.type === 'budget-exhausted') {
      return {
        state: { ...state, phase: 'wrap' },
        effect: { kind: 'inject-wrap-up', graceMs: config.graceMs },
      };
    }
    return { state, effect: { kind: 'none', reason: `budget still running (${event.type})` } };
  }

  if (state.phase === 'wrap') {
    if (event.type === 'turn-completed') {
      const parsed = parseWrapUpReplyMarker(event.replyText);
      if (parsed.marker === 'extension-request' && !state.extensionUsed) {
        const extensionMs = computeExtensionBudgetMs({
          originalBudgetMs: config.originalBudgetMs,
          extensionRatio: config.extensionRatio,
          daemonWatchdogCapMs: config.daemonWatchdogCapMs,
          finalGraceMs: config.graceMs,
          elapsedMs: event.elapsedMs,
        });
        if (extensionMs > 0) {
          return {
            state: {
              ...state,
              phase: 'extension',
              extensionUsed: true,
              grantedExtensionMs: extensionMs,
            },
            effect: { kind: 'grant-extension', extensionMs },
          };
        }
        // No headroom for a meaningful extension: deny and go straight to the
        // final wrap-up. The final grace is re-clamped to the remaining
        // headroom so even this path cannot run past the cap.
        const remaining = Math.max(
          0,
          Math.min(config.graceMs, config.daemonWatchdogCapMs - event.elapsedMs),
        );
        if (remaining <= 0) {
          return {
            state: { ...state, phase: 'settled', settledAs: 'timeout' },
            effect: { kind: 'timeout' },
          };
        }
        return {
          state: { ...state, phase: 'final-wrap' },
          effect: { kind: 'deny-extension', graceMs: remaining },
        };
      }
      // WRAP_UP (or anything else): resolve normally with the handoff as the
      // result — this also covers the original turn finishing late inside the
      // grace window (the passive-window behavior preserved).
      return {
        state: { ...state, phase: 'settled', settledAs: 'resolved' },
        effect: { kind: 'resolve', replyText: event.replyText },
      };
    }
    if (event.type === 'window-expired') {
      return {
        state: { ...state, phase: 'settled', settledAs: 'timeout' },
        effect: { kind: 'timeout' },
      };
    }
    return { state, effect: { kind: 'none', reason: `wrap phase ignores ${event.type}` } };
  }

  if (state.phase === 'extension') {
    if (event.type === 'turn-completed') {
      // Any completion during the extension resolves — including a second
      // EXTENSION_REQUEST: the one extension was already granted, the second
      // request is ignored (not honored) and the reply settles as-is.
      return {
        state: { ...state, phase: 'settled', settledAs: 'resolved' },
        effect: { kind: 'resolve', replyText: event.replyText },
      };
    }
    if (event.type === 'window-expired') {
      // Extension watchdog expired: repeat the wrap-up signal once more with
      // the final grace. Extension requests in the final wrap-up are ignored.
      const remaining = Math.max(
        0,
        Math.min(config.graceMs, config.daemonWatchdogCapMs - event.elapsedMs),
      );
      if (remaining <= 0) {
        return {
          state: { ...state, phase: 'settled', settledAs: 'timeout' },
          effect: { kind: 'timeout' },
        };
      }
      return {
        state: { ...state, phase: 'final-wrap' },
        effect: { kind: 'inject-final-wrap-up', graceMs: remaining },
      };
    }
    return { state, effect: { kind: 'none', reason: `extension phase ignores ${event.type}` } };
  }

  // state.phase === 'final-wrap'
  if (event.type === 'turn-completed') {
    // Extension requests are ignored at this point — any reply resolves.
    return {
      state: { ...state, phase: 'settled', settledAs: 'resolved' },
      effect: { kind: 'resolve', replyText: event.replyText },
    };
  }
  if (event.type === 'window-expired') {
    return {
      state: { ...state, phase: 'settled', settledAs: 'timeout' },
      effect: { kind: 'timeout' },
    };
  }
  return { state, effect: { kind: 'none', reason: `final-wrap phase ignores ${event.type}` } };
}

/** Build the wrap-up injection text (design §2, verbatim protocol). */
export function buildWrapUpMessage(input: { budgetMinutes: number; offerExtension: boolean }): string {
  const lines = [
    `[ORCH-WRAP-UP] Your delegation budget (${input.budgetMinutes} min) is exhausted.`,
    'Stop all new exploration and tool work NOW.',
    'Write your handoff NOW per the handoff_contract: summary, deliverables, verification evidence, blockers.',
  ];
  if (input.offerExtension) {
    lines.push(
      "If you need ONE extension, your reply's FIRST line must be exactly `EXTENSION_REQUEST: <one-line reason>`; otherwise start your reply with `WRAP_UP:`.",
    );
  } else {
    lines.push(
      "No further extension is available: start your reply with `WRAP_UP:` (extension requests are ignored now).",
    );
  }
  return lines.join('\n');
}

/** Build the extension-granted injection text (design §3). */
export function buildExtensionGrantedMessage(input: { extensionMs: number }): string {
  const minutes = Math.max(1, Math.round(input.extensionMs / 60_000));
  return [
    `[ORCH-EXTENSION-GRANTED] Extension granted: ${minutes} additional minutes (the only one).`,
    'Continue the delegated work, but treat this as your final stretch.',
    "When the extension ends you will be asked once more to write your handoff — plan so you can finish with `WRAP_UP:` as your reply's first line.",
  ].join('\n');
}
