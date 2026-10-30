import React from 'react';
import { twemojiUrlFor, TWEMOJI_CHARS } from './twemoji';

/**
 * Display-time Twemoji rendering for plain-text chat surfaces.
 *
 * Artwork: Twemoji 14.0.2 (CC-BY 4.0) bundled under ./assets/twemoji/ —
 * see ./twemoji.ts. DISPLAY ONLY: callers pass the display-mapped string
 * (e.g. after mapWechatBracketCodesForDisplay); the stored/sent text is
 * never rewritten, and a char without a bundled asset (a non-catalog emoji
 * such as a persisted recent) falls back to the raw platform-glyph char.
 *
 * Exports:
 * - TwemojiText  — renders a string with catalog emoji as inline <img>.
 * - TwemojiGlyph — one emoji cell (img, or raw-char fallback) for the
 *                  picker grid / recents strip, sized in px.
 */

// Longest-first alternation so a multi-codepoint char (e.g. ✌️ = U+270C
// U+FE0F) always wins over any shorter prefix. Catalog chars contain no
// regex metacharacters, so they are joined verbatim.
const SPLIT_SOURCE = [...TWEMOJI_CHARS]
  .sort((a, b) => b.length - a.length)
  .join('|');

/** True when the string carries at least one catalog emoji. */
export const containsTwemojiChar = (text: string): boolean =>
  new RegExp(SPLIT_SOURCE).test(text);

/** Split a string into plain / catalog-emoji parts (emoji parts captured). */
export const splitTwemojiText = (text: string): string[] =>
  text.split(new RegExp(`(${SPLIT_SOURCE})`, 'g'));

export interface TwemojiTextProps {
  /** Display-mapped text; catalog emoji become inline images, all else verbatim. */
  text: string;
}

/** Inline sizing that tracks the surrounding text scale (markdown bubbles use the same ratio). */
const INLINE_EMOJI_CLASS = 'inline-block h-[1.25em] w-[1.25em] align-[-0.2em] mx-[0.06em]';

export const TwemojiText: React.FC<TwemojiTextProps> = ({ text }) => {
  if (!text) return null;
  if (!containsTwemojiChar(text)) return <>{text}</>;
  return (
    <>
      {splitTwemojiText(text).map((part, index) => {
        if (!part) return null;
        const url = twemojiUrlFor(part);
        if (!url) return <React.Fragment key={index}>{part}</React.Fragment>;
        return (
          <img
            key={index}
            src={url}
            alt={part}
            draggable={false}
            className={INLINE_EMOJI_CLASS}
          />
        );
      })}
    </>
  );
};

export interface TwemojiGlyphProps {
  /** The emoji char to render (picker grid cell / recents chip). */
  char: string;
  /** Square glyph size in px (keeps the pre-Twemoji font-glyph metrics). */
  px: number;
}

export const TwemojiGlyph: React.FC<TwemojiGlyphProps> = ({ char, px }) => {
  const url = twemojiUrlFor(char);
  if (!url) {
    // Non-catalog char (e.g. an older persisted recent): raw platform glyph.
    return <span style={{ fontSize: px, lineHeight: 1 }}>{char}</span>;
  }
  return (
    <img
      src={url}
      alt={char}
      draggable={false}
      style={{ width: px, height: px }}
    />
  );
};

export default TwemojiText;
