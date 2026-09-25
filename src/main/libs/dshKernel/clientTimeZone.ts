/**
 * The client's IANA time zone, shared by the DSH runtime config (dsh-time-context
 * fallback zone) and every prompt (`clientTimeZone` on the user message source,
 * which resolves the per-request browser-zone line for the model).
 *
 * IDBots is a desktop app, so "the client zone" is the host's system zone —
 * the same zone the user sees in their filesystem and on their clock. The
 * runtime is headless (no browser), and the upstream seam that carries a zone
 * is the user message source, so both places must agree on one value.
 *
 * Canonicalized the way the kernel demands: `UTC` or a canonical IANA
 * `Area/Location` name. Anything else (an abbreviation like `CST`, a stale
 * alias, an engine that reports a different resolved name) resolves to
 * undefined and the caller simply omits the zone — dsh-time-context then
 * reports "unavailable" instead of failing the request assembly, which THROWS
 * on a non-canonical value.
 */

let cached: string | undefined | null = null

export function currentClientTimeZone(): string | undefined {
  if (cached !== null) return cached
  cached = undefined
  try {
    const zone = new Intl.DateTimeFormat('en-US').resolvedOptions().timeZone
    if (typeof zone === 'string' && zone.length > 0) {
      const canonical = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone
      if (canonical === zone) cached = zone
    }
  } catch {
    cached = undefined
  }
  return cached
}
