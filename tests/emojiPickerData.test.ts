// Emoji catalog integrity for the chat emoji picker: pure data invariants
// that keep the panel trustworthy (no broken glyphs, no empty tabs, no
// ASCII junk from hand-editing, working bilingual search).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMOJI_CATEGORIES,
  countEmojiCatalogEntries,
  searchEmoji,
} from '../src/renderer/components/chat/emojiData';

test('the catalog has a full set of non-empty categories with valid entries', () => {
  assert.ok(EMOJI_CATEGORIES.length >= 8, `expected >= 8 categories, got ${EMOJI_CATEGORIES.length}`);
  const ids = new Set<string>();
  const labelKeys = new Set<string>();
  for (const category of EMOJI_CATEGORIES) {
    assert.ok(category.id && !ids.has(category.id), `category id empty or duplicated: ${category.id}`);
    ids.add(category.id);
    assert.ok(category.labelKey && !labelKeys.has(category.labelKey), `labelKey empty or duplicated: ${category.labelKey}`);
    labelKeys.add(category.labelKey);
    assert.ok(category.emojis.length >= 24, `category ${category.id} too thin: ${category.emojis.length}`);
    const seen = new Set<string>();
    for (const emoji of category.emojis) {
      // Every entry is a real Unicode glyph (no ASCII-only junk, no empty
      // strings) with searchable keywords.
      assert.ok(emoji.char.length > 0, `empty char in ${category.id}`);
      assert.ok(
        [...emoji.char].every((ch) => ch.codePointAt(0)! > 0x1f000 || [...emoji.char].some((c) => c.codePointAt(0)! > 0x2000)),
        `non-emoji char "${emoji.char}" in ${category.id}`,
      );
      assert.ok([...emoji.char].some((ch) => ch.codePointAt(0)! > 0x2000), `ascii-only char "${emoji.char}" in ${category.id}`);
      assert.ok(emoji.keywords.trim().length > 0, `empty keywords for ${emoji.char}`);
      assert.ok(!seen.has(emoji.char), `duplicate ${emoji.char} inside ${category.id}`);
      seen.add(emoji.char);
    }
  }
  assert.ok(countEmojiCatalogEntries() >= 600, `catalog too small: ${countEmojiCatalogEntries()}`);
});

test('search matches English and Chinese keywords and dedupes across categories', () => {
  const smileZh = searchEmoji('微笑');
  assert.ok(smileZh.some((e) => e.char === '🙂'), '微笑 should find 🙂');

  const smileEn = searchEmoji('smile');
  assert.ok(smileEn.some((e) => e.char === '😀'), 'smile should find 😀');

  const rose = searchEmoji('玫瑰');
  assert.equal(rose.length, 1);
  assert.equal(rose[0].char, '🌹');

  const thumbs = searchEmoji('点赞');
  assert.equal(thumbs.length, 1, '👍 lives in several categories; search must dedupe');
  assert.equal(thumbs[0].char, '👍');

  // Case-insensitive and whitespace-tolerant.
  assert.ok(searchEmoji('  COFFEE ').some((e) => e.char === '☕'));

  // No matches -> empty, never junk.
  assert.deepEqual(searchEmoji('qqqqzzz'), []);

  // Multi-codepoint sequences are searchable by their own char.
  assert.ok(searchEmoji('✌️').length >= 1);

  // Limit is respected.
  assert.ok(searchEmoji('e', 3).length <= 3);
});

test('emoji chars include full multi-codepoint sequences (never truncated)', () => {
  // VS16 sequences and ZWJ joins must be present verbatim in the catalog;
  // insertion depends on the sequence staying intact.
  const hearts = EMOJI_CATEGORIES.flatMap((c) => c.emojis.map((e) => e.char));
  assert.ok(hearts.includes('❤️'), 'red heart must keep its VS16');
  assert.ok(hearts.includes('✌️'), 'victory hand must keep its VS16');
  assert.ok(hearts.some((c) => c.includes('\u200d')), 'catalog should carry at least one ZWJ sequence');
});
