#!/usr/bin/env node
/**
 * generate-twemoji-manifest.mjs — regenerate src/renderer/components/chat/twemoji.ts
 *
 * The Twemoji artwork must ship as SOURCE-EMBEDDED data URI string literals,
 * decoupled from every bundler asset-emission mechanism (`new URL(…,
 * import.meta.url)` / vite asset emission / assetsInlineLimit behavior).
 * Rationale: the shipped 1.0.9 package carried the pipeline code but NOT the
 * artwork (emojiImages + sizing class present in app.asar; zero twemoji SVGs,
 * zero twemoji data URIs in the whole package) — a bundler/packager-dependent
 * delivery let the assets silently vanish between build environments and
 * runtime <img> fell back to alt text (system glyphs). A source-embedded
 * literal cannot disappear without the code disappearing with it.
 *
 * Key order is taken from the existing twemoji.ts (itself the test-pinned
 * catalog order) so regeneration never reorders the panel. The 85 SVG files
 * under assets/twemoji/ remain the byte-level source of truth; this script
 * embeds their exact bytes, Vite-svgToDataURL-style percent-encoded, as data
 * URI literals. Idempotent: run any time assets change.
 *
 * Usage: node scripts/generate-twemoji-manifest.mjs
 * Exit codes: 0 = written/verified, 1 = invariant violated (no write on fail).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(repoRoot, 'src/renderer/components/chat/twemoji.ts');
const ASSETS_DIR = path.join(repoRoot, 'src/renderer/components/chat/assets/twemoji');

const die = (message) => {
  console.error(`✗ generate-twemoji-manifest: ${message}`);
  process.exit(1);
};

// Mirrors Vite's svgToDataURL non-text branch exactly (the encoding the
// verify-twemoji-bundle gate reconstructs), so dev/prod/SSR all see byte-identical URIs.
const svgToDataUri = (content) => {
  if (content.includes('<text') || content.includes('<foreignObject')) {
    die('svg carries <text>/<foreignObject> — needs the encodeURIComponent branch, not supported by this generator');
  }
  const encoded = content
    .replace(/"/g, "'")
    .replace(/%/g, '%25')
    .replace(/#/g, '%23')
    .replace(/</g, '%3c')
    .replace(/>/g, '%3e')
    .replace(/\?/g, '%3f')
    .replace(/\[/g, '%5b')
    .replace(/\]/g, '%5d')
    .replace(/\\/g, '%5c')
    .replace(/\{/g, '%7b')
    .replace(/\}/g, '%7d')
    .replace(/\|/g, '%7c')
    .replace(/\^/g, '%5e')
    .replace(/`/g, '%60')
    .replace(/\s/g, '%20');
  if (/["\\`]/.test(encoded)) die('encoded form contains a quote-unsafe char — literal would corrupt the module');
  return `data:image/svg+xml,${encoded}`;
};

// 1) Ordered key list from the existing manifest (old new-URL form OR current literal form).
const manifestSrc = fs.readFileSync(MANIFEST, 'utf-8');
const entryRe = /"((?:[^"\\]|\\.)+)"\s*:\s*(?:new URL\('\.\/assets\/twemoji\/([0-9a-z-]+\.svg)',\s*import\.meta\.url\)|"data:image\/svg\+xml,([^"]*)")/g;
const entries = [...manifestSrc.matchAll(entryRe)].map((m) => ({ char: m[1], file: m[2] }));
if (entries.length !== 85) die(`existing manifest parse found ${entries.length} entries, expected 85`);
const chars = entries.map((e) => e.char);
if (new Set(chars).size !== entries.length) die('existing manifest carries duplicate emoji chars');

// 2) Assets dir must cover the manifest exactly (no orphans, no missing files).
const onDisk = fs.readdirSync(ASSETS_DIR).filter((f) => f.endsWith('.svg'));
for (const e of entries) {
  if (!onDisk.includes(e.file)) die(`manifest references a missing asset file: ${e.file}`);
}
const stray = onDisk.filter((f) => !entries.some((e) => e.file === f));
if (stray.length) die(`assets dir carries files outside the manifest: ${stray.join(', ')}`);

// 3) Build the literal table from the on-disk bytes.
const lines = entries.map((e) => {
  const uri = svgToDataUri(fs.readFileSync(path.join(ASSETS_DIR, e.file), 'utf-8'));
  return `  "${e.char}": "${uri}",`;
});

// 4) Emit the module (key order preserved; exports unchanged).
const output = `/**
 * Bundled Twemoji asset manifest — display-only emoji artwork for the chat
 * emoji picker and message bubbles.
 *
 * Graphics: Twemoji 14.0.2 — https://github.com/twitter/twemoji
 * License:  CC-BY 4.0 — https://creativecommons.org/licenses/by/4.0/
 * Notice:   LICENSES/twemoji-NOTICE.md (repository root)
 *
 * DELIVERY CONTRACT: the 85 artworks are embedded HERE as data URI string
 * literals (raw svg bytes from ./assets/twemoji/, Vite-svgToDataURL-encoded),
 * NOT through bundler asset mechanisms (\`new URL(…, import.meta.url)\` / vite
 * asset emission). A bundler/packager-dependent delivery shipped the 1.0.9
 * release with the pipeline code but WITHOUT the artwork (zero twemoji SVGs
 * in app.asar) — runtime <img> silently fell back to alt text / system
 * glyphs. Source-embedded literals cannot vanish without the code vanishing
 * too; scripts/verify-twemoji-bundle.mjs re-proves the full set inside every
 * built chunk (85/85 byte-identical + 85/85 manifest keys).
 *
 * The files under ./assets/twemoji/ stay the byte-level source of truth and
 * the CC-BY provenance record. Only the display layer changes — the picker
 * still inserts the plain Unicode codepoint and stored/sent text is never
 * rewritten.
 *
 * GENERATED by scripts/generate-twemoji-manifest.mjs — regenerate from the
 * assets dir, do not hand-edit.
 */

/** char -> embedded data URI for the whole picker catalog. */
const TWEMOJI_ASSETS: Readonly<Record<string, string>> = {
${lines.join('\n')}
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
`;

// 5) Self-verify the generated text parses back to the same 85 entries before writing.
const roundTrip = [...output.matchAll(/"((?:[^"\\]|\\.)+)"\s*:\s*"data:image\/svg\+xml,([^"]*)"/g)];
if (roundTrip.length !== 85) die(`generated module self-check failed: ${roundTrip.length} entries`);
for (let i = 0; i < entries.length; i += 1) {
  if (roundTrip[i][1] !== entries[i].char) die(`generated module self-check: key order drifted at index ${i}`);
}

fs.writeFileSync(MANIFEST, output);
console.log(`✓ twemoji.ts regenerated: 85 data URI literals embedded (source: assets/twemoji/ on-disk bytes), key order preserved.`);
