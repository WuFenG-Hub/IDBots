// DSH usage-projection mapping: folds the official token-meter session
// projections (read over the wire via idbots/usage) into the CoworkUsageStats
// shape the renderer's usage chip consumes. Pure functions only — coworkRunner
// owns persistence and side effects.
//
// Bucket semantics: the projection's four token buckets are DISJOINT
// (uncached input excludes cache read/write; reasoning is already inside
// output). The chip's display semantics differ by billing source — non-
// Anthropic upstreams report input_tokens as the TOTAL prompt (cache
// included) and partition it into hit/miss, Anthropic reports fresh-only
// input with cache writes in the creation bucket — so the mapping restores
// each source's convention from the disjoint buckets.

import type { DshUsageProjectionResult, DshUsageSnapshot } from './dshKernel/types'
import type { CoworkContextUsage } from './coworkContextUsage'

/** Raw disjoint projection buckets, persisted on the stats row for delta math. */
export interface DshRawBuckets {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/**
 * The usage-row shape this fold produces — structurally the superset the
 * cowork session stats carry (ActiveSession['usageStats'] accepts it as-is;
 * CoworkUsageStats consumers read the subset they know).
 */
export interface DshUsageStatsRow {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalCostUsd?: number
  source: 'deepseek' | 'anthropic' | 'other' | 'none'
  upstreamProvider?: string
  upstreamBaseURL?: string
  turnCount?: number
  lastTurnInputTokens?: number
  cacheMissEvents?: Array<{ turn: number; reason: string; missTokens: number }>
  turnStats?: Array<{ turn: number; cacheHitTokens: number; cacheMissTokens: number }>
  perModelUsage?: Record<string, {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
  }>
  thinkingTokensEstimate?: number
  /**
   * Heuristic composition of the CURRENT context (token-meter
   * contextBreakdown projection: system prompt + tool schemas from the
   * newest request header, conversation from the live surface; chars/4-style
   * estimator, so treat as approximate). NOT cumulative — the sum tracks the
   * context ring, unlike the billing counters above.
   */
  contextBreakdown?: {
    systemTokens: number
    toolsTokens: number
    messageTokens: number
  } | null
  /** Real context snapshot for the ring after the active session is cleaned up. */
  lastRealContextUsage?: CoworkContextUsage | null
  /** Private: last raw projection buckets seen (delta baseline; survives restarts via the persisted row). */
  dshRawBuckets?: DshRawBuckets
}

export interface DshUsageFoldInput {
  projection: DshUsageProjectionResult
  billingSource: DshUsageStatsRow['source']
  upstreamProvider?: string
  upstreamBaseURL?: string
  /** Prefix-break reason recorded at the point that reset the cache prefix. */
  pendingCacheBreakReason?: string | null
  /** Previously accumulated stats (persisted row or in-memory). */
  prev: DshUsageStatsRow | null
  /** Context-window fallback when the projection's route advertises none. */
  contextWindowFallback?: number
}

export interface DshUsageFoldResult {
  stats: DshUsageStatsRow
  /** Updated pendingCacheBreakReason (pass-through today; see fold comment). */
  pendingCacheBreakReason: string | null
}

const finiteOrZero = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

/**
 * Prompt-side pressure of one raw per-request usage snapshot: uncached input
 * plus cache read/write, output excluded — the same semantics the official
 * contextPressure.pressureTokens carries. Instant live approximation for the
 * context ring before the projection round-trip refines it.
 */
export function dshPromptSideTokens(usage: DshUsageSnapshot): number {
  return finiteOrZero(usage.inputTokens)
    + finiteOrZero(usage.cacheReadTokens)
    + finiteOrZero(usage.cacheWriteTokens)
}

/**
 * Context-ring value from the official contextPressure projection.
 * projectedTokens is the occupancy display value (provider-anchored estimate
 * of what the NEXT request's prompt would cost); pressureTokens (the last
 * request's real prompt size) is the fallback. The window prefers the
 * runtime's own contextWindow record, falling back to the caller's
 * model-config value. Undefined when the projection carries no sample yet.
 */
export function dshContextUsageFromPressure(
  pressure: DshUsageProjectionResult['contextPressure'],
  contextWindowFallback?: number
): CoworkContextUsage | undefined {
  if (!pressure) return undefined
  const ringTokens = Number.isFinite(pressure.projectedTokens) ? pressure.projectedTokens
    : Number.isFinite(pressure.pressureTokens) ? pressure.pressureTokens
    : undefined
  const contextWindow = Number.isFinite(pressure.contextWindow)
    ? pressure.contextWindow
    : (Number.isFinite(contextWindowFallback) ? contextWindowFallback : undefined)
  if (ringTokens === undefined || contextWindow === undefined) return undefined
  return {
    usedTokens: ringTokens,
    contextWindow,
    usageRatio: Math.min(1, ringTokens / Math.max(1, contextWindow)),
    isRealUsage: true,
  }
}

const rawOf = (stats: DshUsageStatsRow | null): DshRawBuckets | null => {
  const raw = stats?.dshRawBuckets
  if (!raw || typeof raw !== 'object') return null
  return {
    uncachedInputTokens: finiteOrZero(raw.uncachedInputTokens),
    outputTokens: finiteOrZero(raw.outputTokens),
    cacheReadTokens: finiteOrZero(raw.cacheReadTokens),
    cacheWriteTokens: finiteOrZero(raw.cacheWriteTokens),
  }
}

/**
 * Fold one projection snapshot into the session's usage stats.
 *
 * The projection is replay-derived and cumulative over the whole session log,
 * so the cumulative counters are REPLACED with the authoritative values (never
 * incremented). Per-turn attribution (turnStats + cacheMissEvents) comes from
 * the delta against the previous snapshot's raw buckets; without a previous
 * raw baseline (first observation, or a stats row written before this
 * feature) only the cumulative counters refresh — no fabricated turn rows.
 *
 * Returns null when the projection carries no usable usage (unavailable, or
 * all-zero buckets) so the caller keeps the previous stats untouched.
 */
export function foldDshUsageProjection(input: DshUsageFoldInput): DshUsageFoldResult | null {
  const { projection, billingSource } = input
  const tokenUsage = projection.tokenUsage
  if (projection.available !== true || !tokenUsage) return null

  const raw: DshRawBuckets = {
    uncachedInputTokens: finiteOrZero(tokenUsage.uncachedInputTokens),
    outputTokens: finiteOrZero(tokenUsage.outputTokens),
    cacheReadTokens: finiteOrZero(tokenUsage.cacheReadTokens),
    cacheWriteTokens: finiteOrZero(tokenUsage.cacheWriteTokens),
  }
  if (raw.uncachedInputTokens <= 0 && raw.outputTokens <= 0 && raw.cacheReadTokens <= 0 && raw.cacheWriteTokens <= 0) {
    return null
  }

  // Restore the chip's per-source input/cache conventions from the disjoint
  // buckets (see the header comment).
  const isAnthropic = billingSource === 'anthropic'
  const inputTokens = isAnthropic
    ? raw.uncachedInputTokens
    : raw.uncachedInputTokens + raw.cacheReadTokens + raw.cacheWriteTokens
  const cacheCreationTokens = isAnthropic
    ? raw.cacheWriteTokens
    : raw.uncachedInputTokens + raw.cacheWriteTokens

  const prev = input.prev
  // Heuristic current-context composition from the token-meter breakdown
  // projection (system/tools from the newest request header, messages from
  // the live surface). Carried forward when this projection lacks it.
  const breakdown = projection.contextBreakdown
  const contextBreakdown = breakdown
    ? {
      systemTokens: finiteOrZero(breakdown.systemTokens),
      toolsTokens: finiteOrZero(breakdown.toolsTokens),
      messageTokens: finiteOrZero(breakdown.messageTokens),
    }
    : prev?.contextBreakdown
  // Delta baseline: the previous fold's raw buckets. A session with NO
  // previous row at all (fresh DSH session, first settlement) baselines at
  // zero — the whole cumulative snapshot is turn 1, which a fresh session's
  // first turn genuinely is (cold start). A row WITHOUT raw buckets (written
  // by the Claude kernel before a mid-life kernel switch) baselines at null:
  // cumulative counters refresh, but no per-turn attribution is fabricated.
  const ZERO_BUCKETS: DshRawBuckets = {
    uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  }
  const prevRaw = rawOf(prev) ?? (prev === null ? ZERO_BUCKETS : null)
  const turnStats = prev?.turnStats ? [...prev.turnStats] : []
  const cacheMissEvents = prev?.cacheMissEvents ? [...prev.cacheMissEvents] : []
  const prevTurnCount = typeof prev?.turnCount === 'number' && Number.isFinite(prev.turnCount)
    ? prev.turnCount
    : 0

  // Per-turn attribution only with a raw baseline to delta against.
  let nextTurnCount = prevTurnCount
  if (prevRaw) {
    const dHit = raw.cacheReadTokens - prevRaw.cacheReadTokens
    const dMiss = cacheCreationTokens - (isAnthropic
      ? prevRaw.cacheWriteTokens
      : prevRaw.uncachedInputTokens + prevRaw.cacheWriteTokens)
    const dOutput = raw.outputTokens - prevRaw.outputTokens
    if (dHit > 0 || dMiss > 0 || dOutput > 0) {
      nextTurnCount = prevTurnCount + 1
      // Same attribution ladder as the Claude path: T1 is a cold start by
      // definition; later turns consume a recorded prefix-break reason, else
      // the turn's own hit ratio labels an untracked break ('unknown') vs
      // normal append-only growth.
      const turnInputTotal = dHit + dMiss
      const turnHitRatio = turnInputTotal > 0 ? dHit / turnInputTotal : 1
      const untrackedMissReason = turnHitRatio < 0.3 ? 'unknown' : 'append_only'
      if (dMiss > 0) {
        cacheMissEvents.push({
          turn: nextTurnCount,
          reason: nextTurnCount === 1
            ? 'cold_start'
            : (input.pendingCacheBreakReason ?? untrackedMissReason),
          missTokens: dMiss,
        })
      }
      turnStats.push({
        turn: nextTurnCount,
        cacheHitTokens: Math.max(0, dHit),
        cacheMissTokens: Math.max(0, dMiss),
      })
    }
  }

  // lastTurnInputTokens feeds the compaction budget as the REAL prompt size of
  // the most recent request — exactly what contextPressure.pressureTokens
  // reports (uncached input + cache read/write, output excluded).
  const pressure = projection.contextPressure
  const pressureTokens = Number.isFinite(pressure?.pressureTokens) ? pressure?.pressureTokens : undefined
  const lastTurnInputTokens = pressureTokens !== undefined
    ? pressureTokens
    : prev?.lastTurnInputTokens

  // Persisted real-context snapshot for the ring (the Claude path stores the
  // same slot via persistRealContextUsage).
  const lastRealContextUsage = dshContextUsageFromPressure(pressure,
    input.contextWindowFallback ?? prev?.lastRealContextUsage?.contextWindow)

  const stats: DshUsageStatsRow = {
    inputTokens,
    outputTokens: raw.outputTokens,
    cacheReadTokens: raw.cacheReadTokens,
    cacheCreationTokens,
    totalCostUsd: prev?.totalCostUsd,
    source: billingSource,
    upstreamProvider: input.upstreamProvider ?? prev?.upstreamProvider,
    upstreamBaseURL: input.upstreamBaseURL ?? prev?.upstreamBaseURL,
    turnCount: nextTurnCount,
    lastTurnInputTokens,
    lastRealContextUsage: lastRealContextUsage ?? prev?.lastRealContextUsage,
    cacheMissEvents,
    turnStats,
    perModelUsage: prev?.perModelUsage,
    contextBreakdown,
    dshRawBuckets: raw,
  }
  return {
    stats,
    // The DSH path records no prefix-break reasons today (that machinery is
    // Claude-proxy-specific); pass the pending value through untouched so a
    // future recorder survives this fold.
    pendingCacheBreakReason: input.pendingCacheBreakReason ?? null,
  }
}
