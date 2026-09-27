import assert from 'node:assert/strict';
import test from 'node:test';

// Compiled-output tests: run `pnpm run compile:electron` first; self-skip
// when the compiled module is absent (mirrors sibling suites).

let tier;
try {
  tier = await import('../dist-electron/main/libs/metawebPromptTier.js');
} catch {
  tier = undefined;
}

test('shouldIncludeMetawebDeepSections honors the three profile modes', async (t) => {
  if (!tier) return t.skip('dist-electron not compiled');

  // 'tiered' (the default): Tier 0 omits, Tier 1 includes.
  assert.equal(tier.shouldIncludeMetawebDeepSections('tiered', 0), false);
  assert.equal(tier.shouldIncludeMetawebDeepSections('tiered', 1), true);
  // 'full': escape hatch, always mounted (pre-tiering behavior).
  assert.equal(tier.shouldIncludeMetawebDeepSections('full', 0), true);
  assert.equal(tier.shouldIncludeMetawebDeepSections('full', 1), true);
  // 'compact': never mounted.
  assert.equal(tier.shouldIncludeMetawebDeepSections('compact', 0), false);
  assert.equal(tier.shouldIncludeMetawebDeepSections('compact', 1), false);
});

test('nextMetawebPromptTier bumps on MetaWeb tool calls and never drops back', async (t) => {
  if (!tier) return t.skip('dist-electron not compiled');

  assert.equal(tier.nextMetawebPromptTier(0, 'search_metaweb'), 1);
  assert.equal(tier.nextMetawebPromptTier(0, 'read_metaweb_pin'), 1);
  assert.equal(tier.nextMetawebPromptTier(0, 'post_simplenote'), 1);
  assert.equal(tier.nextMetawebPromptTier(0, 'search_qa'), 1);
  assert.equal(tier.nextMetawebPromptTier(0, 'search_social_posts'), 1);
  // Memory/knowledge tools are deliberately NOT triggers.
  assert.equal(tier.nextMetawebPromptTier(0, 'knowledge_recall'), 0);
  assert.equal(tier.nextMetawebPromptTier(0, 'knowledge_upsert'), 0);
  assert.equal(tier.nextMetawebPromptTier(0, 'conversation_search'), 0);
  assert.equal(tier.nextMetawebPromptTier(0, 'bash'), 0);
  // Monotonic: Tier 1 stays even on later non-MetaWeb calls.
  assert.equal(tier.nextMetawebPromptTier(1, 'bash'), 1);
  assert.equal(tier.nextMetawebPromptTier(1, 'read'), 1);
  // Unknown/empty names never bump.
  assert.equal(tier.nextMetawebPromptTier(0, ''), 0);
  assert.equal(tier.nextMetawebPromptTier(0, 'not_a_tool'), 0);
});

test('the cowork runner wires the tier helpers and the default profile is tiered', async (t) => {
  if (!tier) return t.skip('dist-electron not compiled');

  const runnerSource = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../dist-electron/main/libs/coworkRunner.js', import.meta.url), 'utf8'));
  assert.match(runnerSource, /metawebMode: 'tiered'/, 'default profile mounts deep sections lazily');
  assert.match(runnerSource, /metawebMode: 'compact'/, 'A2A profile stays compact');
  assert.match(runnerSource, /noteHostToolCallForMetawebTier/, 'host tool dispatch bumps the tier');
  assert.match(runnerSource, /shouldIncludeMetawebDeepSections/, 'compose call sites gate on the tier');
});
