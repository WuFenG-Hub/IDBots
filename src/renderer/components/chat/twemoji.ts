import { TWEMOJI_DATA_URLS } from './twemojiAssets.generated';

/**
 * Bundled Twemoji asset manifest — display-only emoji artwork for the chat
 * emoji picker and message bubbles.
 *
 * Graphics: Twemoji 14.0.2 — https://github.com/twitter/twemoji
 * License:  CC-BY 4.0 — https://creativecommons.org/licenses/by/4.0/
 * Notice:   LICENSES/twemoji-NOTICE.md (repository root)
 *
 * The 85 SVGs under ./assets/twemoji/ are the exact catalog
 * subset from emojiData.ts, downloaded verbatim from
 * https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/
 * (upstream asset names strip the FE0F variation selector, e.g. ✌️ ->
 * 270c.svg). Assets are bundled locally: no runtime CDN fetch. Only the
 * display layer changes — the picker still inserts the plain Unicode
 * codepoint and stored/sent text is never rewritten.
 *
 * Artwork delivery is DECOUPLED from the bundler: every value is the full
 * `data:image/svg+xml,...` literal from ./twemojiAssets.generated.ts
 * (embedded strings — no `new URL(..., import.meta.url)`, no vite asset
 * emission, no packager-visible asset files). Rationale: the desktop 1.0.9
 * asar shipped the pipeline code with zero twemoji SVGs, so <img> failed to
 * load and Chromium fell back to the alt codepoint ("dev fine, packaged
 * fallback"). Regenerate both the values module and these lookups with
 * `pnpm generate:twemoji-assets`; do not hand-edit either file.
 */


/** char -> bundled asset URL for the whole picker catalog. */
const TWEMOJI_ASSETS: Readonly<Record<string, string>> = {
  "🙂": TWEMOJI_DATA_URLS['1f642'],
  "😕": TWEMOJI_DATA_URLS['1f615'],
  "😍": TWEMOJI_DATA_URLS['1f60d'],
  "😳": TWEMOJI_DATA_URLS['1f633'],
  "😏": TWEMOJI_DATA_URLS['1f60f'],
  "😢": TWEMOJI_DATA_URLS['1f622'],
  "🤐": TWEMOJI_DATA_URLS['1f910'],
  "😴": TWEMOJI_DATA_URLS['1f634'],
  "😭": TWEMOJI_DATA_URLS['1f62d'],
  "😓": TWEMOJI_DATA_URLS['1f613'],
  "😠": TWEMOJI_DATA_URLS['1f620'],
  "😜": TWEMOJI_DATA_URLS['1f61c'],
  "😁": TWEMOJI_DATA_URLS['1f601'],
  "😮": TWEMOJI_DATA_URLS['1f62e'],
  "😔": TWEMOJI_DATA_URLS['1f614'],
  "😎": TWEMOJI_DATA_URLS['1f60e'],
  "😅": TWEMOJI_DATA_URLS['1f605'],
  "😫": TWEMOJI_DATA_URLS['1f62b'],
  "🤮": TWEMOJI_DATA_URLS['1f92e'],
  "🤭": TWEMOJI_DATA_URLS['1f92d'],
  "👃": TWEMOJI_DATA_URLS['1f443'],
  "🤦": TWEMOJI_DATA_URLS['1f926'],
  "🙁": TWEMOJI_DATA_URLS['1f641'],
  "🥰": TWEMOJI_DATA_URLS['1f970'],
  "🙄": TWEMOJI_DATA_URLS['1f644'],
  "😤": TWEMOJI_DATA_URLS['1f624'],
  "💦": TWEMOJI_DATA_URLS['1f4a6'],
  "😥": TWEMOJI_DATA_URLS['1f625'],
  "😃": TWEMOJI_DATA_URLS['1f603'],
  "😌": TWEMOJI_DATA_URLS['1f60c'],
  "🥺": TWEMOJI_DATA_URLS['1f97a'],
  "😿": TWEMOJI_DATA_URLS['1f63f'],
  "😱": TWEMOJI_DATA_URLS['1f631'],
  "😊": TWEMOJI_DATA_URLS['1f60a'],
  "😵": TWEMOJI_DATA_URLS['1f635'],
  "🤯": TWEMOJI_DATA_URLS['1f92f'],
  "😩": TWEMOJI_DATA_URLS['1f629'],
  "💀": TWEMOJI_DATA_URLS['1f480'],
  "🔨": TWEMOJI_DATA_URLS['1f528'],
  "👋": TWEMOJI_DATA_URLS['1f44b'],
  "💪": TWEMOJI_DATA_URLS['1f4aa'],
  "🤬": TWEMOJI_DATA_URLS['1f92c'],
  "❓": TWEMOJI_DATA_URLS['2753'],
  "🤫": TWEMOJI_DATA_URLS['1f92b'],
  "😨": TWEMOJI_DATA_URLS['1f628'],
  "😒": TWEMOJI_DATA_URLS['1f612'],
  "😀": TWEMOJI_DATA_URLS['1f600'],
  "😄": TWEMOJI_DATA_URLS['1f604'],
  "😆": TWEMOJI_DATA_URLS['1f606'],
  "🤣": TWEMOJI_DATA_URLS['1f923'],
  "😂": TWEMOJI_DATA_URLS['1f602'],
  "🤔": TWEMOJI_DATA_URLS['1f914'],
  "🤗": TWEMOJI_DATA_URLS['1f917'],
  "👍": TWEMOJI_DATA_URLS['1f44d'],
  "👎": TWEMOJI_DATA_URLS['1f44e'],
  "🤝": TWEMOJI_DATA_URLS['1f91d'],
  "✌️": TWEMOJI_DATA_URLS['270c'],
  "👊": TWEMOJI_DATA_URLS['1f44a'],
  "✊": TWEMOJI_DATA_URLS['270a'],
  "😘": TWEMOJI_DATA_URLS['1f618'],
  "💋": TWEMOJI_DATA_URLS['1f48b'],
  "👏": TWEMOJI_DATA_URLS['1f44f'],
  "🙇": TWEMOJI_DATA_URLS['1f647'],
  "👌": TWEMOJI_DATA_URLS['1f44c'],
  "⛔": TWEMOJI_DATA_URLS['26d4'],
  "🙏": TWEMOJI_DATA_URLS['1f64f'],
  "🐷": TWEMOJI_DATA_URLS['1f437'],
  "🐔": TWEMOJI_DATA_URLS['1f414'],
  "🌙": TWEMOJI_DATA_URLS['1f319'],
  "☀️": TWEMOJI_DATA_URLS['2600'],
  "🌧": TWEMOJI_DATA_URLS['1f327'],
  "☕": TWEMOJI_DATA_URLS['2615'],
  "🍰": TWEMOJI_DATA_URLS['1f370'],
  "🍺": TWEMOJI_DATA_URLS['1f37a'],
  "🍚": TWEMOJI_DATA_URLS['1f35a'],
  "🍉": TWEMOJI_DATA_URLS['1f349'],
  "⚽": TWEMOJI_DATA_URLS['26bd'],
  "🌹": TWEMOJI_DATA_URLS['1f339'],
  "🥀": TWEMOJI_DATA_URLS['1f940'],
  "❤️": TWEMOJI_DATA_URLS['2764'],
  "💔": TWEMOJI_DATA_URLS['1f494'],
  "🎁": TWEMOJI_DATA_URLS['1f381'],
  "🧧": TWEMOJI_DATA_URLS['1f9e7'],
  "🧨": TWEMOJI_DATA_URLS['1f9e8'],
  "🎉": TWEMOJI_DATA_URLS['1f389'],
};

/** Bundled asset URL for an emoji char, or null when it is not in the catalog. */
export const twemojiUrlFor = (char: string): string | null => TWEMOJI_ASSETS[char] ?? null;

/** Every bundled asset URL — identity set for recognizing emoji <img> in markdown output. */
export const TWEMOJI_ASSET_URLS: ReadonlySet<string> = new Set(Object.values(TWEMOJI_ASSETS));

/** True when a rendered <img> src points at one of the bundled Twemoji assets. */
export const isTwemojiAssetUrl = (url: string): boolean => TWEMOJI_ASSET_URLS.has(url);

/** Chars that carry a bundled asset (catalog order). */
export const TWEMOJI_CHARS: readonly string[] = Object.keys(TWEMOJI_ASSETS);

/** Number of bundled assets (test helper; must equal the catalog size). */
export const TWEMOJI_ASSET_COUNT = TWEMOJI_CHARS.length;
