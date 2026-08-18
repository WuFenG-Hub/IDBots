/**
 * Classification helpers for Claude Code CLI `result` events.
 *
 * The CLI tags internal diagnostics with a `[ede_diagnostic]` prefix inside
 * SDK `error_during_execution` result events. These entries are NOT
 * user-facing failures: they describe why a turn ended internally. The most
 * common one for this app is the runtime-steer interrupt:
 *
 *   [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use
 *
 * which is the CLI reporting that a turn was cut short because a new user
 * instruction arrived (the steer) — the in-flight tool_use was abandoned and
 * no assistant reply followed yet. The query itself keeps running and the CLI
 * processes the steer as the next turn, so the host must treat this result as
 * a benign steer boundary, not a fatal error.
 *
 * The CLI's own result-to-user converter (`IDT` in the bundled binary)
 * follows exactly this policy: it filters out every `[ede_diagnostic]` entry
 * and, when nothing real remains, shows nothing at all. The host mirrors that
 * behavior so steer interrupts never surface as session errors.
 */
export const SDK_INTERNAL_DIAGNOSTIC_PREFIX = '[ede_diagnostic]';

/** True when the given error string is a CLI-internal `[ede_diagnostic]` entry. */
export function isSdkInternalDiagnostic(error: string): boolean {
  return typeof error === 'string' && error.trim().startsWith(SDK_INTERNAL_DIAGNOSTIC_PREFIX);
}

/**
 * Drops CLI-internal `[ede_diagnostic]` entries from an SDK result's `errors`
 * array, keeping only errors that are real and worth surfacing to the user.
 */
export function filterSdkInternalDiagnostics(errors: string[]): string[] {
  return errors.filter((error) => !isSdkInternalDiagnostic(error));
}

/**
 * True when the error text is the CLI's runtime-steer interrupt signature: the
 * turn ended because a new user instruction (steer) superseded it mid-tool.
 */
export function isSteerInterruptDiagnostic(error: string): boolean {
  return isSdkInternalDiagnostic(error) && error.includes('result_type=user');
}
