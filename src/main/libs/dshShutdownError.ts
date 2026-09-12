/**
 * Distinct error for "the DSH runtime is being shut down" (app quit, host
 * storage recovery). Turns that fail with it must fail SOFT: no session
 * error status, no persisted `Error:` transcript message, no burned retry
 * attempts — the work is simply retried after the next boot.
 *
 * The 2026-09-12 incident: app cleanup closed the DSH kernels while the
 * private-chat daemon was still polling (it was never stopped); every A2A
 * turn launched inside the ~60s shutdown window crashed with
 * `DshKernel: closed`, and each crash marked its conversation session
 * `error` with a persisted error bubble, which the A2A banner then showed
 * on a dozen historical conversations.
 */
export class DshShutdownError extends Error {
  constructor(message = 'DshTurnHub: shutting down') {
    super(message);
    this.name = 'DshShutdownError';
  }
}

export function isDshShutdownError(error: unknown): boolean {
  if (error instanceof DshShutdownError) return true;
  const text = error instanceof Error ? error.message : String(error ?? '');
  return text.includes('DshKernel: closed') || text.includes('DshTurnHub: shutting down');
}
