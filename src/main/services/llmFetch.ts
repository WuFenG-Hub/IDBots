/**
 * Connection-level fetch resilience for LLM wire calls.
 *
 * All three wire styles (anthropic / openai-compat / deepseek-responses) post
 * through here. Two problems this solves, both surfaced by the 2026-09-25
 * 00:09-03:27 outage (G2 red seat, three hours of llm_unavailable):
 *
 *  1. Undici failures carried zero diagnosable detail — the logged message was
 *     just "fetch failed" while the real transport error (ECONNRESET,
 *     UND_ERR_SOCKET, ...) sat in err.cause, never logged. Every failure in
 *     that window is now permanently unreconstructable. This module logs the
 *     full cause chain on every fetch failure.
 *
 *  2. A mid-connection reset on a reused keep-alive socket failed the attempt
 *     instantly with no retry, even though undici evicts the poisoned socket
 *     on error — a single immediate retry runs on a fresh connection and
 *     would have absorbed most of the observed 1-2s failure pairs.
 */

/** Cause codes worth exactly one immediate retry: the socket died mid-flight
 *  (peer dropped a keep-alive connection we raced into). ECONNREFUSED is
 *  deliberately absent — the endpoint is down and a retry just burns the
 *  attempt window; the fallback brain already covers it. */
const CONNECTION_RETRYABLE_CAUSE_CODES = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Classify a fetch error as retryable connection-level failure; null when
 *  the error is not a fetch-layer failure or carries no retryable cause. */
export function connectionFailureCauseCode(err: unknown): string | null {
  if (!err || (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))) return null;
  if (!(err instanceof TypeError)) return null;
  const code = (err as { cause?: { code?: string } }).cause?.code;
  return code && CONNECTION_RETRYABLE_CAUSE_CODES.has(code) ? code : null;
}

/** Mask a URL for logs (keep scheme + host, hide path/auth). */
function maskURL(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '(invalid URL)';
  }
}

/** Log the FULL cause chain of a fetch failure. The message alone ("fetch
 *  failed") hid the real transport error for the whole 2026-09-25 window.
 *  Keep this permanent. */
export function logFetchFailureCause(kind: string, url: string, err: unknown): void {
  const chain: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 4; depth++) {
    const e = cur as { name?: string; code?: string; message?: string };
    chain.push(e.code ? `${e.name ?? 'Error'}(${e.code}): ${e.message ?? ''}` : `${e.name ?? 'Error'}: ${e.message ?? ''}`);
    cur = (cur as { cause?: unknown }).cause;
  }
  console.error(`[Orchestrator] LLM fetch failure (${kind}) url=${maskURL(url)} causes=${chain.join(' <- ')}`);
}

/** POST helper shared by all three LLM wire styles. On a connection-level
 *  failure retry ONCE immediately (fresh connection — see module doc); never
 *  retry on abort/timeout or dead-endpoint (ECONNREFUSED): fail fast into
 *  the fallback brain. */
export async function fetchLlmPost(
  kind: string,
  url: string,
  headers: Record<string, string>,
  bodyText: string,
  signal: AbortSignal | undefined
): Promise<Response> {
  const init: RequestInit = { method: 'POST', headers, body: bodyText, signal };
  try {
    return await fetch(url, init);
  } catch (err) {
    logFetchFailureCause(kind, url, err);
    if (connectionFailureCauseCode(err) && !signal?.aborted) {
      try {
        return await fetch(url, init);
      } catch (retryErr) {
        logFetchFailureCause(`${kind} retry`, url, retryErr);
        throw retryErr;
      }
    }
    throw err;
  }
}
