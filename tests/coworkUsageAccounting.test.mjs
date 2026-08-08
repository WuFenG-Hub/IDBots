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
  // Totals and the per-model breakdown branch on the same semantics.
  assert.match(chip, /const totalTokens = isDeepSeek\s*\?\s*usageStats\.inputTokens \+ usageStats\.outputTokens/);
  assert.match(chip, /const modelInput = isDeepSeek\s*\?\s*u\.inputTokens/);
});
