import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// Usage-accounting honesty: the chip's numbers drive the user's cost
// perception for DeepSeek sessions. These tests pin the two accounting
// fixes — the totalCostUsd accumulation precedence bug and the per-model
// (subagent-inclusive) usage breakdown.

test('totalCostUsd accumulates across turns (operator precedence fix)', () => {
  const source = read('src/main/libs/coworkRunner.ts');

  // `+` binds tighter than `??`, so the old form `prev ?? 0 + cost` stopped
  // accumulating after turn 1. The parenthesized form must be present and the
  // buggy form must be gone.
  assert.match(source, /\? \(prev\.totalCostUsd \?\? 0\) \+ payload\.total_cost_usd/);
  assert.ok(!source.includes('prev.totalCostUsd ?? 0 + payload.total_cost_usd'),
    'unparenthesized ??/+ mix must not come back');
});

test('modelUsage (subagent/side-job traffic) is accumulated per model', () => {
  const source = read('src/main/libs/coworkRunner.ts');

  assert.match(source, /payload\.modelUsage/);
  assert.match(source, /perModelUsage\[model\] = \{/);
  assert.match(source, /entry\.cacheReadInputTokens/);
  assert.match(source, /entry\.cacheCreationInputTokens/);
  // nextStats must carry the accumulated map so it persists to the store.
  assert.match(source, /turnStats,\s*\n\s*perModelUsage,/);
});

test('perModelUsage is declared on the usage stats types', () => {
  const mainSource = read('src/main/libs/coworkRunner.ts');
  const contextUsageSource = read('src/main/libs/coworkContextUsage.ts');
  const rendererTypes = read('src/renderer/types/cowork.ts');

  for (const [name, source] of [
    ['coworkRunner.ts', mainSource],
    ['coworkContextUsage.ts', contextUsageSource],
    ['types/cowork.ts', rendererTypes],
  ]) {
    assert.match(source, /perModelUsage\?: Record<string, \{/, `${name} must declare perModelUsage`);
  }
});

test('UsageStatsChip renders the per-model breakdown with i18n in zh and en', () => {
  const chip = read('src/renderer/components/cowork/UsageStatsChip.tsx');
  const i18n = read('src/renderer/services/i18n.ts');

  assert.match(chip, /usageStats\.perModelUsage/);
  assert.match(chip, /i18nService\.t\('coworkUsagePerModelTitle'\)/);
  const occurrences = i18n.split('coworkUsagePerModelTitle:').length - 1;
  assert.ok(occurrences >= 2, 'coworkUsagePerModelTitle must exist in both zh and en dictionaries');
});

test('DeepSeek cost/totals never double-count input_tokens (it already includes cache tokens)', () => {
  const chip = read('src/renderer/components/cowork/UsageStatsChip.tsx');

  // The proxy maps DeepSeek usage so input_tokens = hit + miss (verified
  // against a live session: 15.1M + 2.4M = 17.5M exactly). The cost formula
  // must therefore bill ONLY hit + miss + output.
  const costFn = chip.slice(chip.indexOf('function estimateDeepSeekCostCNY'));
  assert.ok(!costFn.slice(0, 700).includes('stats.inputTokens'),
    'estimateDeepSeekCostCNY must not add inputTokens on top of hit+miss');
  // Totals and the per-model breakdown branch on the same semantics: every
  // non-Anthropic source (deepseek AND openai-compat gateways) reports
  // input_tokens already containing the cache tokens.
  assert.match(chip, /const cacheIncludedInInput = usageStats\.source !== 'anthropic'/);
  assert.match(chip, /const totalTokens = cacheIncludedInInput\s*\?\s*usageStats\.inputTokens \+ usageStats\.outputTokens/);
  assert.match(chip, /const modelInput = cacheIncludedInInput\s*\?\s*u\.inputTokens/);
});

test('accumulateResultUsage normalizes a partial prev (context-snapshot seed) instead of producing NaN', () => {
  const source = read('src/main/libs/coworkRunner.ts');

  // persistRealContextUsage can seed the in-memory stats map with a partial
  // object (lastRealContextUsage only) BEFORE the first turn's usage
  // accumulates. prev.inputTokens would then be undefined and undefined + n
  // = NaN — which JSON.stringify persists as null, poisoning the session row
  // so the usage chip renders NaN for input/output/cache rows (regression
  // from ad61a168). The accumulation must normalize the counters no matter
  // where prev came from.
  assert.match(source, /finiteOrZero\(prev\.inputTokens\)/);
  assert.match(source, /finiteOrZero\(prev\.outputTokens\)/);
  assert.match(source, /finiteOrZero\(prev\.cacheReadTokens\)/);
  assert.match(source, /finiteOrZero\(prev\.cacheCreationTokens\)/);
});

test('accumulateResultUsage aggregates modelUsage (turn-cumulative) as the authoritative counters', () => {
  const source = read('src/main/libs/coworkRunner.ts');

  // SDK semantics (verified end-to-end against the bundled 0.3.x agent SDK):
  // top-level result `usage` holds only the LAST request of the turn, while
  // `modelUsage` accumulates EVERY request. A tool loop issues several
  // requests per turn; summing modelUsage is the only way the panel totals
  // and the cache-hit rate reflect the whole turn instead of the worst
  // (final, most-new-content) request alone.
  assert.match(source, /const modelUsage = payload\.modelUsage/);
  assert.match(source, /Object\.keys\(modelUsage\)\.length > 0/);
  assert.match(source, /for \(const entry of Object\.values\(modelUsage\)\)/);
  assert.match(source, /inputTokens \+= typeof entry\.inputTokens === 'number' \? entry\.inputTokens : 0/);
  assert.match(source, /outputTokens \+= typeof entry\.outputTokens === 'number' \? entry\.outputTokens : 0/);
  assert.match(source, /cacheReadTokens \+= typeof entry\.cacheReadInputTokens === 'number'/);
  assert.match(source, /cacheCreationTokens \+= typeof entry\.cacheCreationInputTokens === 'number'/);
  // The top-level usage remains the fallback for SDK builds without modelUsage.
  assert.match(source, /cache_read_input_tokens === 'number'\s*\?\s*usage\.cache_read_input_tokens/);
  // lastTurnInputTokens keeps the top-level (last-request) value: it feeds the
  // compaction budget as the REAL context size of the most recent request.
  assert.match(source, /const lastTurnInputRaw = usage && typeof usage\.input_tokens === 'number' \? usage\.input_tokens : 0/);
});
