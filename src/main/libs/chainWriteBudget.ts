/**
 * Chain-write tool-call budget (task #70 / HOST-FIX-RFP 2026-09-08 R1).
 *
 * The #70 incident: a group_chat send_group_message tool call hung for 30
 * minutes inside the createPin recovery chain (sponsor broadcast failures →
 * stale-funding recovery → an await that never settled). The only thing that
 * broke the freeze was the 30-min skill-turn watchdog — meanwhile the chair
 * session was frozen, the owner's in-group "继续" could not be processed, and
 * production-finished work waited half an hour to enter review.
 *
 * This helper bounds EVERY host-executed chain-write tool call (createPin
 * users: post_buzz / post_simplenote / omni_cast / group_chat sends /
 * uploads / transfers / private-chat sends). It does NOT cancel the underlying
 * operation — a chain write, once broadcast, may still land — so the timeout
 * error text teaches exactly that: verify on-chain before re-sending.
 */

export const CHAIN_WRITE_BUDGET_MS = 3 * 60_000;

export class ChainWriteBudgetExceededError extends Error {
  readonly toolLabel: string;
  readonly waitedMs: number;

  constructor(toolLabel: string, waitedMs: number, budgetMs?: number) {
    const seconds = Math.round((budgetMs ?? waitedMs) / 1000);
    super(
      `Chain-write budget exceeded: ${toolLabel} did not return within ${seconds}s `
      + '(the underlying on-chain operation was abandoned, NOT cancelled — it may still land). '
      + 'Do NOT blindly re-send the same content: first verify whether it arrived (group log / on-chain lookup), '
      + 'then retry only if it is genuinely missing.',
    );
    this.name = 'ChainWriteBudgetExceededError';
    this.toolLabel = toolLabel;
    this.waitedMs = waitedMs;
  }
}

/**
 * Wrap one chain-write tool-call backend with a total deadline. The wrapped
 * promise keeps running after the deadline (chain writes are not safely
 * cancellable) but the tool call returns a structured, teaching failure —
 * the model regains control in minutes instead of freezing for the whole
 * 30-min turn budget.
 */
export function withChainWriteBudget<T>(
  toolLabel: string,
  run: () => Promise<T>,
  timeoutMs: number = CHAIN_WRITE_BUDGET_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false;
    const budgetMs = Math.max(1_000, timeoutMs);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new ChainWriteBudgetExceededError(toolLabel, Date.now() - startedAt, budgetMs));
    }, budgetMs);
    timer.unref?.();
    run().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
