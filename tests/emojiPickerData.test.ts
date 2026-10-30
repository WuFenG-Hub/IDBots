// Emoji catalog integrity for the chat emoji picker: pure data invariants
// that keep the panel trustworthy (no broken glyphs, no empty tabs, no
// ASCII junk from hand-editing, working bilingual search).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EMOJI_CATEGORIES,
  countEmojiCatalogEntries,
  searchEmoji,
} from '../src/renderer/components/chat/emojiData';
import { WECHAT_BRACKET_EMOJI_MAP } from '../src/renderer/components/chat/wechatEmojiDisplay';
import {
  TWEMOJI_CHARS,
  TWEMOJI_ASSET_COUNT,
  twemojiUrlFor,
} from '../src/renderer/components/chat/twemoji';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Upstream Twemoji file name for a char: hex codepoints minus fe0f. */
const twemojiFileName = (ch: string): string =>
  [...ch].map((cp) => cp.codePointAt(0)!.toString(16)).filter((h) => h !== 'fe0f').join('-') + '.svg';

test('the catalog is a single WeChat-style first-panel page with valid entries', () => {
  // Owner call 2026-10-29 (final scope): ONE tab — the smileys/emotion page
  // with recents embedded as a strip, like WeChat's own first panel. Exactly
  // 85 entries: the 78 WeChat bracket-code targets (77 unique chars —
  // [得意]/[奸笑] share 😏) plus the curated laugh/think family, 🙏 and 🎉.
  assert.equal(EMOJI_CATEGORIES.length, 1, `expected a single category, got ${EMOJI_CATEGORIES.length}`);
  assert.equal(EMOJI_CATEGORIES[0].id, 'smileys');
  const ids = new Set<string>();
  const labelKeys = new Set<string>();
  for (const category of EMOJI_CATEGORIES) {
    assert.ok(category.id && !ids.has(category.id), `category id empty or duplicated: ${category.id}`);
    ids.add(category.id);
    assert.ok(category.labelKey && !labelKeys.has(category.labelKey), `labelKey empty or duplicated: ${category.labelKey}`);
    labelKeys.add(category.labelKey);
    assert.ok(category.emojis.length >= 10, `category ${category.id} too thin: ${category.emojis.length}`);
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
  const total = countEmojiCatalogEntries();
  assert.equal(total, 85, `catalog must be the 85-entry WeChat first panel, got ${total}`);
});

test('the ordered catalog matches the pinned WeChat-panel sequence (desktop/mobile identity anchor)', () => {
  // The mobile picker vendors this exact catalog; both worktrees pin the
  // same 85-char ordered sequence in their tests, so any drift between the
  // two ends fails one of the two suites.
  const expected = [
    '🙂', '😕', '😍', '😳', '😏', '😢', '🤐', '😴', '😭', '😓',
    '😠', '😜', '😁', '😮', '😔', '😎', '😅', '😫', '🤮', '🤭',
    '👃', '🤦', '🙁', '🥰', '🙄', '😤', '💦', '😥', '😃', '😌',
    '🥺', '😿', '😱', '😊', '😵', '🤯', '😩', '💀', '🔨', '👋',
    '💪', '🤬', '❓', '🤫', '😨', '😒', '😀', '😄', '😆', '🤣',
    '😂', '🤔', '🤗', '👍', '👎', '🤝', '✌️', '👊', '✊', '😘',
    '💋', '👏', '🙇', '👌', '⛔', '🙏', '🐷', '🐔', '🌙', '☀️',
    '🌧', '☕', '🍰', '🍺', '🍚', '🍉', '⚽', '🌹', '🥀', '❤️',
    '💔', '🎁', '🧧', '🧨', '🎉',
  ];
  assert.equal(expected.length, 85, 'the pinned anchor itself must have 85 members');
  const actual = EMOJI_CATEGORIES.flatMap((c) => c.emojis.map((e) => e.char));
  assert.deepEqual(actual, expected, 'catalog order/content drifted from the pinned WeChat-panel sequence');
});

test('every WeChat bracket-code emoji target is pickable in the catalog', () => {
  // The display map (wechatEmojiDisplay.ts) rewrites bracket codes like
  // [微笑] at render time; each mapped emoji must also exist in the picker
  // catalog so users can insert it directly.
  const catalogChars = new Set(EMOJI_CATEGORIES.flatMap((c) => c.emojis.map((e) => e.char)));
  for (const [code, emoji] of Object.entries(WECHAT_BRACKET_EMOJI_MAP)) {
    assert.ok(catalogChars.has(emoji), `[${code}] target ${emoji} missing from the picker catalog`);
  }
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
  assert.equal(thumbs.length, 1, 'search must return 👍 exactly once');
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
  // VS16 sequences must be present verbatim in the catalog; insertion
  // depends on the sequence staying intact. (The trimmed WeChat-scale set
  // carries VS16 sequences — ❤️/✌️ — but no ZWJ joins anymore; the bare vs
  // VS16 distinction below is the truncation guard that matters.)
  const hearts = EMOJI_CATEGORIES.flatMap((c) => c.emojis.map((e) => e.char));
  assert.ok(hearts.includes('❤️'), 'red heart must keep its VS16');
  assert.ok(hearts.includes('✌️'), 'victory hand must keep its VS16');
  for (const ch of hearts) {
    assert.notEqual([...ch].length, 0, `no empty char: ${JSON.stringify(ch)}`);
  }
});

test('every catalog emoji has a bundled Twemoji asset (85-file subset, no CDN)', () => {
  // Display artwork: the picker/bubble images come from the bundled
  // Twemoji 14.0.2 subset (CC-BY 4.0 — see LICENSES/twemoji-NOTICE.md).
  // The manifest must mirror the catalog 1:1 (same chars, same order) and
  // every URL must resolve to a local file — no runtime CDN fetch.
  assert.equal(TWEMOJI_ASSET_COUNT, 85, `expected 85 bundled assets, got ${TWEMOJI_ASSET_COUNT}`);
  const catalogChars = EMOJI_CATEGORIES.flatMap((c) => c.emojis.map((e) => e.char));
  assert.deepEqual(
    [...TWEMOJI_CHARS],
    [...new Set(catalogChars)],
    'manifest chars must equal the catalog chars in order',
  );
  for (const char of catalogChars) {
    const url = twemojiUrlFor(char);
    assert.ok(url, `no bundled asset for ${char}`);
    assert.match(url, /\/twemoji\/[0-9a-z-]+\.svg$/, `${char} asset URL must point at the local twemoji dir`);
    assert.ok(!/^https?:/.test(url), `${char} asset must not be a CDN URL`);
  }
  // The assets dir carries exactly the 85-file subset (never the full set).
  const assetsDir = path.join(here, '..', 'src', 'renderer', 'components', 'chat', 'assets', 'twemoji');
  const svgs = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.svg')).sort();
  assert.equal(svgs.length, 85, `assets dir must hold exactly 85 SVGs, got ${svgs.length}`);
  const referenced = new Set(catalogChars.map((ch) => twemojiFileName(ch)));
  for (const file of svgs) {
    assert.ok(referenced.has(file), `orphan asset not referenced by the manifest: ${file}`);
  }
  // VS16 naming: upstream asset names strip fe0f (✌️ -> 270c.svg).
  assert.match(twemojiUrlFor('✌️')!, /270c\.svg$/);
  assert.match(twemojiUrlFor('❤️')!, /2764\.svg$/);
  // Non-catalog chars fall back to the raw glyph (no asset, no throw).
  assert.equal(twemojiUrlFor('🚀'), null);
});
