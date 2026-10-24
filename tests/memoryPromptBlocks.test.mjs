import test from 'node:test';
import assert from 'node:assert/strict';

let buildScopedMemoryPromptBlocks;
let buildScopedMemoryPromptBlocksDetailed;
try {
  ({ buildScopedMemoryPromptBlocks, buildScopedMemoryPromptBlocksDetailed } = await import('../dist-electron/main/memory/memoryPromptBlocks.js'));
} catch {
  ({ buildScopedMemoryPromptBlocks, buildScopedMemoryPromptBlocksDetailed } = await import('../dist-electron/main/memory/memoryPromptBlocks.js'));
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

test('a high-importance old memory is guaranteed injection over newer low-importance fillers', () => {
  const filler = Array.from({ length: 35 }, (_, index) => ({
    text: `aaa-filler-${String(index).padStart(2, '0')}`,
    usageClass: 'profile_fact',
    visibility: 'local_only',
    updatedAt: 5000 + index,
    lastUsedAt: null,
    importance: 0.5,
  }));
  const xml = buildScopedMemoryPromptBlocks({
    channel: 'cowork_ui',
    ownerEntries: [
      ...filler,
      // Ranks dead last by relevance (text tie-break) and by recency — only
      // the guaranteed importance tier can surface it.
      {
        text: 'zzz-old-explicit-instruction',
        usageClass: 'profile_fact',
        visibility: 'local_only',
        updatedAt: 100,
        lastUsedAt: null,
        importance: 0.95,
      },
    ],
    maxOwnerEntries: 12,
  });

  const lines = xml.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(lines.length, 12, 'policy maxItems still caps the final injection count');
  assert.equal(lines[0], '- zzz-old-explicit-instruction', 'guaranteed tier renders first');
});

test('over-budget eviction drops the lowest importance first, not the oldest', () => {
  const entry = (text, updatedAt, importance) => ({
    text,
    usageClass: 'profile_fact',
    visibility: 'local_only',
    updatedAt,
    lastUsedAt: null,
    importance,
  });
  // ~900 chars each (2712 total) vs the 2000 clamp floor: exactly one eviction.
  const pad = (label) => label + 'x'.repeat(900 - label.length);
  const xml = buildScopedMemoryPromptBlocks({
    channel: 'cowork_ui',
    ownerEntries: [
      entry(pad('mid-low:'), 2000, 0.5),
      entry(pad('new-low:'), 3000, 0.5),
      entry(pad('old-high:'), 1000, 0.95),
    ],
    maxTotalChars: 50, // below the 2000 clamp floor → budget is 2000
  });

  assert.match(xml, /old-high:/, 'high-importance entry survives despite being the oldest');
  assert.match(xml, /new-low:/);
  assert.doesNotMatch(xml, /mid-low:/, 'lowest importance evicts first, oldest-among-low goes first');
});

test('detailed builder renders the same xml as the wrapper and reports exactly the rendered ids', () => {
  const input = {
    channel: 'cowork_ui',
    ownerEntries: [
      { id: 'mem-1', text: 'My name is Alice', usageClass: 'profile_fact', visibility: 'local_only', updatedAt: 100, lastUsedAt: null },
      { id: 'mem-2', text: 'I prefer tea over coffee', usageClass: 'preference', visibility: 'local_only', updatedAt: 200, lastUsedAt: null },
    ],
  };

  const detailed = buildScopedMemoryPromptBlocksDetailed(input);

  assert.equal(detailed.xml, buildScopedMemoryPromptBlocks(input), 'wrapper output is byte-identical');
  // injectedIds follow the ranked render order (relevance score, then text),
  // not insertion order.
  assert.deepEqual([...detailed.injectedIds].sort(), ['mem-1', 'mem-2']);
});

test('detailed builder dedupes ids and skips entries without an id', () => {
  const { xml, injectedIds } = buildScopedMemoryPromptBlocksDetailed({
    channel: 'cowork_ui',
    ownerEntries: [
      { id: 'mem-1', text: 'My name is Alice', usageClass: 'profile_fact', visibility: 'local_only', updatedAt: 100, lastUsedAt: null },
      { id: 'mem-1', text: 'My name is Alice', usageClass: 'profile_fact', visibility: 'local_only', updatedAt: 100, lastUsedAt: null },
      { text: 'id-less fixture row', usageClass: 'profile_fact', visibility: 'local_only', updatedAt: 300, lastUsedAt: null },
    ],
  });

  assert.deepEqual(injectedIds, ['mem-1'], 'same id twice collapses to one touch');
  assert.match(xml, /id-less fixture row/, 'id-less entries still render — they just cannot be touched');
});

test('detailed builder excludes char-budget-evicted ids from injectedIds', () => {
  const entry = (id, text, updatedAt) => ({
    id,
    text,
    usageClass: 'profile_fact',
    visibility: 'local_only',
    updatedAt,
    lastUsedAt: null,
  });
  // ~900 chars each (2712 total) vs the 2000 clamp floor: exactly one eviction.
  const pad = (label) => label + 'x'.repeat(900 - label.length);
  const { xml, injectedIds } = buildScopedMemoryPromptBlocksDetailed({
    channel: 'cowork_ui',
    ownerEntries: [
      entry('mem-c', pad('c-oldest:'), 1000),
      entry('mem-a', pad('a-newest:'), 3000),
      entry('mem-b', pad('b-mid:'), 2000),
    ],
    maxTotalChars: 50, // below the 2000 clamp floor → budget is 2000
  });

  assert.match(xml, /a-newest:/);
  assert.match(xml, /b-mid:/);
  assert.doesNotMatch(xml, /c-oldest:/);
  assert.deepEqual([...injectedIds].sort(), ['mem-a', 'mem-b']);
  assert.ok(!injectedIds.includes('mem-c'), 'the evicted row must NOT be reported as injected');
});

test('detailed builder reports the guaranteed-importance tier entry as injected', () => {
  const filler = Array.from({ length: 35 }, (_, index) => ({
    id: `filler-${index}`,
    text: `aaa-filler-${String(index).padStart(2, '0')}`,
    usageClass: 'profile_fact',
    visibility: 'local_only',
    updatedAt: 5000 + index,
    lastUsedAt: null,
    importance: 0.5,
  }));
  const { xml, injectedIds } = buildScopedMemoryPromptBlocksDetailed({
    channel: 'cowork_ui',
    ownerEntries: [
      ...filler,
      // Ranks dead last by relevance (text tie-break) and by recency — only
      // the guaranteed importance tier can surface it.
      {
        id: 'guaranteed-1',
        text: 'zzz-old-explicit-instruction',
        usageClass: 'profile_fact',
        visibility: 'local_only',
        updatedAt: 100,
        lastUsedAt: null,
        importance: 0.95,
      },
    ],
    maxOwnerEntries: 12,
  });

  const lines = xml.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(lines.length, 12, 'policy maxItems still caps the final injection count');
  assert.equal(lines[0], '- zzz-old-explicit-instruction', 'guaranteed tier renders first');
  assert.equal(injectedIds.length, 12, 'injectedIds mirror the rendered entries exactly');
  assert.ok(injectedIds.includes('guaranteed-1'), 'guaranteed tier entry is reported as injected');
  assert.ok(!injectedIds.includes('filler-34'), 'the filler that ranked out of the final 12 is not reported');
});

test('relevanceScoreById overrides the lexical order for scored ids', () => {
  const entry = (id, text) => ({
    id,
    text,
    usageClass: 'profile_fact',
    visibility: 'local_only',
    updatedAt: 100,
    lastUsedAt: null,
  });
  const { xml } = buildScopedMemoryPromptBlocksDetailed({
    channel: 'cowork_ui',
    // Lexically, the tea entry (token match on "tea") beats the cat entry.
    currentUserText: 'tell me about tea',
    ownerEntries: [
      entry('mem-cat', 'the owner has a ragdoll cat'),
      entry('mem-tea', 'the owner drinks tea every morning'),
    ],
    relevanceScoreById: new Map([
      ['mem-cat', 0.95],
      ['mem-tea', 0.02],
    ]),
  });

  const lines = xml.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(lines[0], '- the owner has a ragdoll cat', 'the cerebellum top score renders first');
  assert.equal(lines[1], '- the owner drinks tea every morning');
});

test('entries absent from relevanceScoreById sink below every scored entry', () => {
  const entry = (id, text) => ({
    id,
    text,
    usageClass: 'profile_fact',
    visibility: 'local_only',
    updatedAt: 100,
    lastUsedAt: null,
  });
  const { xml } = buildScopedMemoryPromptBlocksDetailed({
    channel: 'cowork_ui',
    currentUserText: 'tell me about tea',
    ownerEntries: [
      entry('mem-cat', 'the owner has a ragdoll cat'),
      entry('mem-tea', 'the owner drinks tea every morning'),
      entry('mem-dog', 'the owner walks his dog at dawn'),
    ],
    // Only the cat entry is cerebellum-scored. Noul (0..1) and lexical
    // (>= 1) are incompatible scales, so with a live score map the unscored
    // entries must sink to a negative lexical tier below EVERY scored
    // entry — even a noul of 0.02 beats an unscored lexical 4 — while the
    // unscored entries keep their relative lexical order (tea 1+3 before
    // dog 1).
    relevanceScoreById: new Map([['mem-cat', 0.95]]),
  });

  const lines = xml.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(lines[0], '- the owner has a ragdoll cat', 'the scored entry outranks all unscored ones');
  assert.equal(lines[1], '- the owner drinks tea every morning', 'unscored entries keep their relative lexical order');
  assert.equal(lines[2], '- the owner walks his dog at dawn');
});

test('a zero noul still outranks unscored entries while a live map is present', () => {
  const entry = (id, text) => ({
    id,
    text,
    usageClass: 'profile_fact',
    visibility: 'local_only',
    updatedAt: 100,
    lastUsedAt: null,
  });
  const { xml } = buildScopedMemoryPromptBlocksDetailed({
    channel: 'cowork_ui',
    currentUserText: 'tell me about tea',
    ownerEntries: [
      entry('mem-tea', 'the owner drinks tea every morning'),
      entry('mem-cat', 'the owner has a ragdoll cat'),
    ],
    // The ranker explicitly called the tea memory useless (noul 0): it ranks
    // last among scored entries, but the live map still places it above the
    // lexically-perfect unscored cat entry — an explicit verdict, even a
    // rejection, always wins over an unexamined entry.
    relevanceScoreById: new Map([['mem-tea', 0]]),
  });

  const lines = xml.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(lines[0], '- the owner drinks tea every morning', 'an explicit 0-noul verdict stays in the scored tier');
  assert.equal(lines[1], '- the owner has a ragdoll cat');
});

test('the guaranteed-importance tier floats to the front regardless of relevanceScoreById', () => {
  const entry = (id, text, importance) => ({
    id,
    text,
    usageClass: 'profile_fact',
    visibility: 'local_only',
    updatedAt: 100,
    lastUsedAt: null,
    importance,
  });
  const { xml } = buildScopedMemoryPromptBlocksDetailed({
    channel: 'cowork_ui',
    currentUserText: 'tell me about tea',
    ownerEntries: [
      entry('mem-low-scored', 'the owner has a ragdoll cat', 0.5),
      entry('mem-guaranteed', 'never mention the birthday', 0.95),
      entry('mem-high-scored', 'the owner drinks tea every morning', 0.5),
    ],
    relevanceScoreById: new Map([
      ['mem-low-scored', 0.01],
      ['mem-guaranteed', 0.01], // even the lowest noul cannot sink the guaranteed tier
      ['mem-high-scored', 0.99],
    ]),
  });

  const lines = xml.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(lines[0], '- never mention the birthday', 'guaranteed tier renders first regardless of scores');
  assert.equal(lines[1], '- the owner drinks tea every morning');
  assert.equal(lines[2], '- the owner has a ragdoll cat');
});

// ---------------------------------------------------------------------------
// Memory evolution (2026-10-24): bounded proof-count boost — order only, never size.
// ---------------------------------------------------------------------------

test('proof count nudges equally relevant entries but is capped and never outranks relevance', () => {
  const entries = [
    { id: 'once', text: 'owner likes short answers', usageClass: 'preference', visibility: 'local_only', updatedAt: 1, proofCount: 1 },
    { id: 'often', text: 'owner likes concise replies', usageClass: 'preference', visibility: 'local_only', updatedAt: 1, proofCount: 12 },
    { id: 'legacy', text: 'owner likes brief wording', usageClass: 'preference', visibility: 'local_only', updatedAt: 1 },
  ];
  const { injectedIds } = buildScopedMemoryPromptBlocksDetailed({
    channel: 'cowork_ui',
    ownerEntries: entries,
    // No overlap with any entry: every lexical score is the base 1, so only
    // the proof boost separates them.
    currentUserText: 'unrelated question about deployment',
  });
  assert.equal(injectedIds[0], 'often', 'the corroborated memory wins an otherwise tied rank');
  assert.deepEqual(injectedIds.slice(1).sort(), ['legacy', 'once'], 'a missing count is neutral, same as one source');

  const relevant = [
    { id: 'hit', text: 'deployment happens on wednesday', usageClass: 'profile_fact', visibility: 'local_only', updatedAt: 1, proofCount: 1 },
    { id: 'popular-miss', text: 'owner likes concise replies', usageClass: 'preference', visibility: 'local_only', updatedAt: 1, proofCount: 500 },
  ];
  const relevantResult = buildScopedMemoryPromptBlocksDetailed({
    channel: 'cowork_ui',
    ownerEntries: relevant,
    // Tokens must not be substrings of the other entry ("is" ⊂ "concise").
    currentUserText: 'deployment schedule',
  });
  assert.equal(relevantResult.injectedIds[0], 'hit', 'a single token hit (+3) beats a +5% boost on a base score');
});

test('proof count applies inside the cerebellum tier and breaks eviction ties after recency', () => {
  const scored = [
    { id: 'a', text: 'alpha belief', usageClass: 'profile_fact', visibility: 'local_only', updatedAt: 1, proofCount: 1 },
    { id: 'b', text: 'beta belief', usageClass: 'profile_fact', visibility: 'local_only', updatedAt: 1, proofCount: 20 },
  ];
  const nouls = new Map([['a', 0.60], ['b', 0.59]]);
  const ranked = buildScopedMemoryPromptBlocksDetailed({
    channel: 'cowork_ui',
    ownerEntries: scored,
    relevanceScoreById: nouls,
  });
  // 0.59 * (1 + 0.1 * (0.5 + ln(20)/10 - 0.5)) ≈ 0.59 * 1.03 ≈ 0.6077 > 0.60
  assert.deepEqual(ranked.injectedIds, ['b', 'a'], 'a near-tie in noul flips toward the corroborated memory');

  const overBudget = [
    // A token hit pins `top` to rank 0; the other two tie on relevance.
    { id: 'top', text: `alpha ${'x'.repeat(1600)}`, usageClass: 'profile_fact', visibility: 'local_only', updatedAt: 5, proofCount: 1 },
    { id: 'weak', text: 'y'.repeat(300), usageClass: 'profile_fact', visibility: 'local_only', updatedAt: 1, proofCount: 1 },
    { id: 'strong', text: 'z'.repeat(300), usageClass: 'profile_fact', visibility: 'local_only', updatedAt: 1, proofCount: 7 },
  ];
  const evicted = buildScopedMemoryPromptBlocksDetailed({
    channel: 'cowork_ui',
    ownerEntries: overBudget,
    currentUserText: 'alpha',
    // Budget clamps to the 2000-char floor: top (1610) + one 304-char entry fits, not both.
    maxTotalChars: 2000,
  });
  assert.ok(evicted.injectedIds.includes('top'), 'the top-ranked entry is never evicted');
  assert.ok(evicted.injectedIds.includes('strong'), 'at equal importance and recency the better-corroborated row survives');
  assert.ok(!evicted.injectedIds.includes('weak'));
});
