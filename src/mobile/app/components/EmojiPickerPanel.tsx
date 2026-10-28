import { useMemo, useState } from 'react';
import { MagnifyingGlassIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { t } from '../../i18n';
import { EMOJI_CATEGORIES, searchEmoji } from '../chat/emojiData';

/**
 * Chat emoji picker panel (mobile). A touch-first, WeChat-style inline
 * panel that renders ABOVE the composer inside its container (no backdrop,
 * the message list stays visible/scrollable while picking). Standard
 * Unicode emoji only — the catalog lives in app/chat/emojiData.ts and no
 * third-party artwork is bundled or referenced.
 *
 * Interaction contract (mobile-native, zero hover assumptions):
 * - every touch target is at least 36px tall (grid cells 44px);
 * - the panel STAYS OPEN after a pick (chat muscle memory: several emoji
 *   in a row); the ✕ button, or tapping the composer's textarea (handled
 *   by ChatScreen), closes it;
 * - category tabs are a horizontally scrollable row, so narrow screens
 *   never clip them;
 * - search swaps the grid for results and shows a t()-localized empty
 *   state.
 *
 * Recents are session-memory only (same policy as the desktop picker);
 * nothing is persisted to disk or the chain.
 */

const RECENT_LIMIT = 16;
const recentChars: string[] = [];

/** Record a picked emoji as most-recently-used (session memory only). */
export const rememberRecentEmoji = (char: string): void => {
  const next = [char, ...recentChars.filter((c) => c !== char)];
  recentChars.length = 0;
  recentChars.push(...next.slice(0, RECENT_LIMIT));
};

/** Current recents, oldest last (test/inspection helper). */
export const recentEmojiChars = (): readonly string[] => recentChars;

const RECENT_CATEGORY_ID = 'recent';

interface VisibleTab {
  id: string;
  label: string;
}

export function EmojiPickerPanel(props: {
  onSelect: (emoji: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState(EMOJI_CATEGORIES[0].id);

  const searching = query.trim().length > 0;
  const searchResults = useMemo(
    () => (searching ? searchEmoji(query, 96) : null),
    [query, searching],
  );

  // Recents: read per render (picks surface immediately).
  const recents = recentEmojiChars();
  const tabs: VisibleTab[] = useMemo(() => {
    const list: VisibleTab[] = recents.length > 0
      ? [{ id: RECENT_CATEGORY_ID, label: t('mobile.chat.emojiCategoryRecent') }]
      : [];
    for (const category of EMOJI_CATEGORIES) {
      list.push({ id: category.id, label: t(`mobile.chat.${category.labelKey}`) });
    }
    return list;
  }, [recents.length]);

  const activeEntries = useMemo(() => {
    if (searchResults) return searchResults;
    if (activeCategory === RECENT_CATEGORY_ID) {
      return recents.map((char) => ({ char, keywords: '' }));
    }
    return EMOJI_CATEGORIES.find((category) => category.id === activeCategory)?.emojis
      ?? EMOJI_CATEGORIES[0].emojis;
  }, [searchResults, activeCategory, recents]);

  return (
    <div
      id="mobile-chat-emoji-panel"
      data-testid="emoji-panel"
      role="dialog"
      aria-label={t('mobile.chat.emojiPicker')}
      className="shrink-0 border-t border-[var(--border-color)] bg-[var(--bg-panel)]"
    >
      <div className="flex items-center gap-2 px-3 pt-2">
        <div className="flex min-h-[40px] flex-1 items-center gap-2 rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)] px-3">
          <MagnifyingGlassIcon className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" aria-hidden />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('mobile.chat.emojiSearch')}
            aria-label={t('mobile.chat.emojiSearch')}
            className="min-h-[40px] w-full bg-transparent text-sm text-[var(--text-primary)] outline-none"
          />
        </div>
        <button
          type="button"
          onClick={props.onClose}
          aria-label={t('mobile.common.close')}
          className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl text-[var(--text-secondary)] active:bg-[var(--bg-hover)]"
        >
          <XMarkIcon className="h-5 w-5" aria-hidden />
        </button>
      </div>

      <div
        role="tablist"
        aria-label={t('mobile.chat.emojiPicker')}
        className="flex gap-1 overflow-x-auto px-3 py-2"
      >
        {tabs.map((tab) => {
          const active = !searching && tab.id === activeCategory;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                setActiveCategory(tab.id);
                setQuery('');
              }}
              className={`min-h-[36px] shrink-0 rounded-full border px-3 text-xs ${
                active
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-black'
                  : 'border-[var(--border-color)] text-[var(--text-secondary)]'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeEntries.length === 0 ? (
        <p
          data-testid="emoji-no-results"
          className="px-4 pb-4 pt-2 text-center text-sm text-[var(--text-secondary)]"
        >
          {t('mobile.chat.emojiPickerNoResults')}
        </p>
      ) : (
        <div
          role="listbox"
          aria-label={t('mobile.chat.emojiPicker')}
          className="grid grid-cols-8 gap-0.5 overflow-y-auto px-2 pb-2"
          style={{ maxHeight: '34dvh' }}
        >
          {activeEntries.map((entry) => (
            <button
              key={entry.char}
              type="button"
              role="option"
              aria-label={entry.char}
              aria-selected={false}
              onClick={() => props.onSelect(entry.char)}
              className="flex h-[44px] w-full items-center justify-center text-[22px] leading-none active:bg-[var(--bg-hover)]"
            >
              {entry.char}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
