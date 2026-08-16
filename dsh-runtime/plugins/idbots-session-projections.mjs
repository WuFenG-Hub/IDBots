// idbots-session-projections: installs the official DSH session-projection
// registry (ctx.sessionProjections) so domain plugins can contribute
// log-derived projections. Without this seam, @deepseek-ai/dsh-token-meter
// keeps its internal ctx.tokenMeter service (compaction still works) but
// registers NO session-projection units — the host then has no durable usage
// surface to read. The registry class is library-only upstream (no apply
// export), so this three-liner is the supported composition form.
//
// Ordering is free: token-meter registers its units through reactive
// ctx.inject(['sessionProjections']), so mounting this plugin before or after
// token-meter both end with the three units (tokenUsage, contextPressure,
// contextBreakdown) registered.

import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'

export const name = 'idbots-session-projections'

export function apply(ctx) {
  new SessionProjectionRegistry(ctx)
}
