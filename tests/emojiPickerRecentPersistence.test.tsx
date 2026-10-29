// Emoji picker recents persistence — storage parse/validate contract, the
// real remember path through a stubbed window.localStorage, and restart
// hydration via a FRESH module evaluation (module init runs the same boot
// hydration the renderer runs on every launch).
//
// Harness note (same convention as tests/emojiPickerComposer.test.tsx):
// server-rendered, no DOM/jsdom. The storage stub is installed as
// globalThis.window.localStorage (the module reads window lazily at call
// time), and "app restart" is simulated by dynamic-importing the module
// with a cache-busting query AFTER the stub is in place — the fresh module
// instance re-runs module init exactly like a relaunched renderer.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EmojiMenuButton, {
  parsePersistedRecentChars,
  restoreRecentChars,
  recentEmojiChars,
  rememberRecent,
} from '../src/renderer/components/chat/EmojiPickerPopover';
import { i18nService } from '../src/renderer/services/i18n';

const STORAGE_KEY = 'idbots.chat.emojiRecents.v1';

const makeStorageStub = (): { storage: Storage; map: Map<string, string> } => {
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
  } as Storage;
  return { storage, map };
};

const installWindow = (storage: Storage): void => {
  (globalThis as Record<string, unknown>).window = { localStorage: storage };
};

const removeWindow = (): void => {
  delete (globalThis as Record<string, unknown>).window;
};

test('parsePersistedRecentChars: valid list round-trip; malformed shapes fall back empty; cap 16; dedupe keeps first', () => {
  assert.deepEqual(parsePersistedRecentChars(null), []);
  assert.deepEqual(parsePersistedRecentChars(''), []);
  assert.deepEqual(parsePersistedRecentChars('not json'), []);
  assert.deepEqual(parsePersistedRecentChars('{"a":1}'), []);
  assert.deepEqual(parsePersistedRecentChars('"just a string"'), []);
  // Non-string entries are dropped; strings survive.
  assert.deepEqual(parsePersistedRecentChars(JSON.stringify([1, null, {}, '😀', ''])), ['😀']);
  // Duplicate entries keep the FIRST occurrence (= the most recent slot).
  assert.deepEqual(parsePersistedRecentChars(JSON.stringify(['😀', '😀', '🙂'])), ['😀', '🙂']);
  // The 16-entry cap is enforced on load, not just on write.
  const twenty = Array.from({ length: 20 }, (_, i) => `e${i}`);
  assert.deepEqual(parsePersistedRecentChars(JSON.stringify(twenty)), twenty.slice(0, 16));
});

test('rememberRecent writes MRU-first through the real window.localStorage path (dedupe, cap 16)', () => {
  const { storage, map } = makeStorageStub();
  installWindow(storage);
  try {
    restoreRecentChars(null); // reset module state (fresh app)
    rememberRecent('🥰');
    rememberRecent('😀');
    assert.deepEqual([...recentEmojiChars()], ['😀', '🥰'], 'most-recent-first after two picks');
    rememberRecent('🥰'); // re-pick moves to front, no duplicate
    assert.deepEqual([...recentEmojiChars()], ['🥰', '😀']);
    // Cap: 20 more distinct picks on top of ['🥰','😀'] keep the 16 most
    // recent (e19..e4); 🥰/😀/e3..e0 are the evicted ones.
    for (let i = 0; i < 20; i += 1) rememberRecent(`e${i}`);
    assert.equal(recentEmojiChars().length, 16, 'cap stays 16');
    assert.equal(recentEmojiChars()[15], 'e4', 'oldest beyond the cap evicted');
    // Storage mirrors memory exactly (same order, same members).
    assert.equal(map.get(STORAGE_KEY), JSON.stringify([...recentEmojiChars()]));
  } finally {
    removeWindow();
  }
});

test('storage failures degrade to session-memory behavior (no throw, no write)', () => {
  const throwing: Storage = {
    getItem: () => { throw new Error('quota'); },
    setItem: () => { throw new Error('quota'); },
  } as unknown as Storage;
  installWindow(throwing);
  try {
    restoreRecentChars(throwing); // read path: swallowed, empty
    assert.deepEqual([...recentEmojiChars()], []);
    assert.doesNotThrow(() => rememberRecent('😀'));
    assert.deepEqual([...recentEmojiChars()], ['😀'], 'pick still lands in memory');
  } finally {
    removeWindow();
  }
  // Without a window at all (SSR), restore(null) clears to empty.
  restoreRecentChars(null);
  assert.deepEqual([...recentEmojiChars()], []);
});

test('app restart (fresh module evaluation) restores persisted recents and shows the recents strip immediately', async () => {
  const { storage } = makeStorageStub();
  storage.setItem(STORAGE_KEY, JSON.stringify(['🚀', '🙂', '👍']));
  installWindow(storage);
  try {
    // Fresh module instance = relaunched renderer: module init hydrates
    // from the same localStorage before the first render.
    const fresh = await import(`../src/renderer/components/chat/EmojiPickerPopover?restart=${Date.now()}`);
    assert.deepEqual(
      [...fresh.recentEmojiChars()],
      ['🚀', '🙂', '👍'],
      'boot hydration restores the persisted LRU order',
    );
    const markup = renderToStaticMarkup(
      <fresh.default open buttonRef={{ current: null }} onToggle={() => {}} onPick={() => {}} />,
    );
    // WeChat-style single panel: no tab bar; the persisted recents render
    // as a strip above the main grid, most-recent first.
    assert.doesNotMatch(markup, /role="tab"/, 'single panel must not carry a tab bar');
    assert.ok(
      markup.includes(i18nService.t('emojiCategoryRecent')),
      'recents strip label present right after restart',
    );
    const stripLabelIndex = markup.indexOf(i18nService.t('emojiCategoryRecent'));
    const firstGridEmojiIndex = markup.indexOf('🙂');
    assert.ok(stripLabelIndex < firstGridEmojiIndex, 'strip renders above the main grid');
    assert.ok(markup.indexOf('🚀') < firstGridEmojiIndex, 'strip leads with the most-recent emoji');
    // 3 restored recents + 85 catalog entries.
    const optionCount = (markup.match(/role="option"/g) ?? []).length;
    assert.equal(optionCount, 88, `expected 3 recents + 85 catalog options, got ${optionCount}`);
  } finally {
    removeWindow();
  }
  // Leave module state clean for any test that follows in this process.
  restoreRecentChars(null);
});
