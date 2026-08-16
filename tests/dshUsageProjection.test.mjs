// Unit tests for the DSH usage-projection fold: the official token-meter
// buckets (disjoint: uncached input / output / cache read / cache write) map
// onto the usage chip's per-source display conventions, per-turn attribution
// appends from raw-bucket deltas, and absent projections leave stats alone.
// Run after `npm run compile:electron` (same harness as the other DSH tests).

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'

const require = Module.createRequire(import.meta.url)
const { foldDshUsageProjection } = require('../dist-electron/main/libs/dshUsageProjection.js')

const projection = (tokenUsage, contextPressure) => ({
  available: true,
  asOfSeq: 7,
  tokenUsage,
  contextPressure: contextPressure ?? null,
  contextBreakdown: null,
})

test('non-Anthropic sources restore total-input semantics from disjoint buckets', () => {
  const folded = foldDshUsageProjection({
    projection: projection({
      uncachedInputTokens: 300, outputTokens: 120, cacheReadTokens: 700, cacheWriteTokens: 0,
    }),
    billingSource: 'deepseek',
    prev: null,
  })
  // Proxy-era display: input = TOTAL prompt (uncached + read + write), the
  // miss bucket = everything not served from cache.
  assert.equal(folded.stats.inputTokens, 1000)
  assert.equal(folded.stats.cacheReadTokens, 700)
  assert.equal(folded.stats.cacheCreationTokens, 300)
  assert.equal(folded.stats.outputTokens, 120)
  assert.equal(folded.stats.source, 'deepseek')
  // Fresh session (no previous row): the whole cumulative snapshot is turn 1.
  assert.equal(folded.stats.turnCount, 1)
  assert.deepEqual(folded.stats.turnStats, [{ turn: 1, cacheHitTokens: 700, cacheMissTokens: 300 }])
})

test('Anthropic source keeps fresh-only input with cache writes in creation', () => {
  const folded = foldDshUsageProjection({
    projection: projection({
      uncachedInputTokens: 300, outputTokens: 120, cacheReadTokens: 700, cacheWriteTokens: 90,
    }),
    billingSource: 'anthropic',
    prev: null,
  })
  assert.equal(folded.stats.inputTokens, 300)
  assert.equal(folded.stats.cacheCreationTokens, 90)
  assert.equal(folded.stats.cacheReadTokens, 700)
})

test('per-turn attribution deltas against the previous raw buckets', () => {
  const first = foldDshUsageProjection({
    projection: projection({
      uncachedInputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0,
    }),
    billingSource: 'deepseek',
    prev: null,
  })
  assert.equal(first.stats.turnCount, 1)
  assert.deepEqual(first.stats.turnStats, [{ turn: 1, cacheHitTokens: 0, cacheMissTokens: 1000 }])
  assert.deepEqual(first.stats.cacheMissEvents, [{ turn: 1, reason: 'cold_start', missTokens: 1000 }])
  const second = foldDshUsageProjection({
    projection: projection({
      uncachedInputTokens: 200, outputTokens: 80, cacheReadTokens: 1500, cacheWriteTokens: 0,
    }),
    billingSource: 'deepseek',
    prev: first.stats,
  })
  assert.equal(second.stats.turnCount, 2)
  // Turn 2: the prefix is now cached (1500 hits, negative miss clamped to 0).
  assert.deepEqual(second.stats.turnStats[1], { turn: 2, cacheHitTokens: 1500, cacheMissTokens: 0 })
  // Cumulative counters are REPLACED with the projection's authoritative values.
  assert.equal(second.stats.inputTokens, 1700)
})

test('a warm healthy turn labels append_only; a broken prefix labels unknown', () => {
  const cold = foldDshUsageProjection({
    projection: projection({ uncachedInputTokens: 1000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    billingSource: 'deepseek',
    prev: null,
  })
  // Warm append-only growth: mostly hits, some new tail.
  const warm = foldDshUsageProjection({
    projection: projection({ uncachedInputTokens: 1100, outputTokens: 20, cacheReadTokens: 1200, cacheWriteTokens: 0 }),
    billingSource: 'deepseek',
    prev: cold.stats,
  })
  assert.equal(warm.stats.cacheMissEvents.at(-1).reason, 'append_only')
  // Near-total miss on a later turn = untracked prefix break.
  const broken = foldDshUsageProjection({
    projection: projection({ uncachedInputTokens: 2100, outputTokens: 30, cacheReadTokens: 1250, cacheWriteTokens: 0 }),
    billingSource: 'deepseek',
    prev: warm.stats,
  })
  assert.equal(broken.stats.cacheMissEvents.at(-1).reason, 'unknown')
  assert.equal(broken.stats.turnCount, 3)
})

test('pressure fields feed lastTurnInputTokens and the persisted context ring', () => {
  const folded = foldDshUsageProjection({
    projection: projection(
      { uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 500, cacheWriteTokens: 0 },
      { pressureTokens: 600, projectedTokens: 640, contextWindow: 8000 },
    ),
    billingSource: 'deepseek',
    prev: null,
    contextWindowFallback: 64000,
  })
  assert.equal(folded.stats.lastTurnInputTokens, 600)
  assert.deepEqual(folded.stats.lastRealContextUsage, {
    usedTokens: 640, contextWindow: 8000, usageRatio: 0.08, isRealUsage: true,
  })
})

test('unavailable or empty projections return null — stats stay untouched', () => {
  assert.equal(foldDshUsageProjection({ projection: { available: false, reason: 'x' }, billingSource: 'other', prev: null }), null)
  assert.equal(foldDshUsageProjection({
    projection: projection({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    billingSource: 'other',
    prev: null,
  }), null)
})

test('no-delta snapshots do not append spurious turns', () => {
  const first = foldDshUsageProjection({
    projection: projection({ uncachedInputTokens: 400, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    billingSource: 'other',
    prev: null,
  })
  assert.equal(first.stats.turnStats.length, 1)
  // A second identical fold (delta 0) must not append another turn row.
  const again = foldDshUsageProjection({
    projection: projection({ uncachedInputTokens: 400, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    billingSource: 'other',
    prev: first.stats,
  })
  assert.equal(again.stats.turnStats.length, 1)
  assert.equal(again.stats.turnCount, 1)
  // Non-finite legacy values in a prev row heal to zero instead of NaN-poisoning.
  const healed = foldDshUsageProjection({
    projection: projection({ uncachedInputTokens: 400, outputTokens: 60, cacheReadTokens: 10, cacheWriteTokens: 0 }),
    billingSource: 'other',
    prev: { ...first.stats, inputTokens: null, dshRawBuckets: { uncachedInputTokens: null, outputTokens: 'x', cacheReadTokens: undefined, cacheWriteTokens: NaN } },
  })
  assert.ok(Number.isFinite(healed.stats.inputTokens))
  assert.deepEqual(healed.stats.turnStats[1], { turn: 2, cacheHitTokens: 10, cacheMissTokens: 400 })
})

test('a Claude-kernel stats row (no raw buckets) refreshes counters without fabricated turns', () => {
  const claudeRow = {
    inputTokens: 5000, outputTokens: 900, cacheReadTokens: 3000, cacheCreationTokens: 2000,
    source: 'other', turnCount: 4,
    turnStats: [{ turn: 1, cacheHitTokens: 0, cacheMissTokens: 2000 }],
  }
  const folded = foldDshUsageProjection({
    projection: projection({ uncachedInputTokens: 500, outputTokens: 80, cacheReadTokens: 400, cacheWriteTokens: 0 }),
    billingSource: 'other',
    prev: claudeRow,
  })
  // Cumulative counters take the projection's authoritative values; turn
  // bookkeeping stays exactly as the Claude path left it.
  assert.equal(folded.stats.inputTokens, 900)
  assert.equal(folded.stats.turnCount, 4)
  assert.equal(folded.stats.turnStats.length, 1)
})
