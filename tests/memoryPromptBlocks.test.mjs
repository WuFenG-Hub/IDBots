import test from 'node:test';
import assert from 'node:assert/strict';

let buildScopedMemoryPromptBlocks;
try {
  ({ buildScopedMemoryPromptBlocks } = await import('../dist-electron/main/memory/memoryPromptBlocks.js'));
} catch {
  ({ buildScopedMemoryPromptBlocks } = await import('../dist-electron/memory/memoryPromptBlocks.js'));
}

test('external sessions do not include owner profile facts', () => {
  const xml = buildScopedMemoryPromptBlocks({
    channel: 'metaweb_private',
    ownerEntries: [
      { text: 'My name is Alice', usageClass: 'profile_fact', visibility: 'local_only' },
      { text: 'Reply in concise bullet points', usageClass: 'operational_preference', visibility: 'external_safe' },
    ],
    contactEntries: [
      { text: 'The client prefers English', usageClass: 'preference', visibility: 'local_only' },
    ],
  });

  assert.match(xml, /<contactMemories>/);
  assert.match(xml, /<ownerOperationalPreferences>/);
  assert.doesNotMatch(xml, /Alice/);
});

test('local sessions render owner memories only', () => {
  const xml = buildScopedMemoryPromptBlocks({
    channel: 'cowork_ui',
    ownerEntries: [
      { text: 'My name is Alice', usageClass: 'profile_fact', visibility: 'local_only' },
    ],
    contactEntries: [
      { text: 'The client prefers English', usageClass: 'preference', visibility: 'local_only' },
    ],
    conversationEntries: [
      { text: 'The order is delayed', usageClass: 'profile_fact', visibility: 'local_only' },
    ],
  });

  assert.match(xml, /<ownerMemories>/);
  assert.doesNotMatch(xml, /<contactMemories>/);
  assert.doesNotMatch(xml, /<conversationMemories>/);
  assert.doesNotMatch(xml, /<ownerOperationalPreferences>/);
});

test('over-budget memory blocks evict the oldest entries first but never the top-ranked one', () => {
  const entry = (text, updatedAt, lastUsedAt = null) => ({
    text,
    usageClass: 'profile_fact',
    visibility: 'local_only',
    updatedAt,
    lastUsedAt,
  });
  // All score 1 (no query tokens match), so rank order = text asc: a-newest,
  // b-mid, c-oldest. ~900 chars each (2712 total) vs the 2000 clamp floor:
  // evicting c-oldest (904) lands at 1808 ≤ 2000.
  const pad = (label) => label + 'x'.repeat(900 - label.length);
  const xml = buildScopedMemoryPromptBlocks({
    channel: 'cowork_ui',
    ownerEntries: [
      entry(pad('c-oldest:'), 1000),
      entry(pad('a-newest:'), 3000),
      entry(pad('b-mid:'), 2000),
    ],
    maxTotalChars: 50, // below the 2000 clamp floor → budget is 2000
  });

  assert.match(xml, /a-newest:/);
  assert.match(xml, /b-mid:/);
  assert.doesNotMatch(xml, /c-oldest:/);
});

test('a single oversized top-ranked entry survives even a tiny budget', () => {
  const xml = buildScopedMemoryPromptBlocks({
    channel: 'cowork_ui',
    ownerEntries: [
      {
        text: 'solo:'.padEnd(2500, 'x'), // 2500 chars alone > the 2000 floor
        usageClass: 'profile_fact',
        visibility: 'local_only',
        updatedAt: 1000,
        lastUsedAt: null,
      },
    ],
    maxTotalChars: 2000,
  });

  assert.match(xml, /<ownerMemories>/);
});
