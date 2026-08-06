// Helpers for extracting the decoded JSON body from a MAN indexer pin row.
//
// Background: the MAN indexer exposes a pin's payload through several fields,
// and their meaning has shifted over time. Currently:
//   - `contentSummary` holds the decoded payload as a JSON string (or sometimes
//     a pre-parsed object).
//   - `contentBody` may hold the base64-encoded payload.
//   - `content` is a download URL (`https://manapi.metaid.io/content/<pinId>`)
//     rather than the JSON body. Older responses sometimes put the JSON here,
//     so it is still a useful last-resort fallback — but ONLY when it actually
//     looks like JSON, never when it is a URL.
//
// Selecting a URL as the content source makes JSON.parse fail silently, which
// previously caused owner MetaApps to lose their title/cover/intro and left
// community apps / official skills silently dropped from their lists.

const CONTENT_URL_RE = /^https?:\/\/[^/\s]+\/content\//i;

/** True when `value` looks like a MAN content-download URL (not a JSON body). */
export function looksLikeContentUrl(value: unknown): boolean {
  return typeof value === 'string' && CONTENT_URL_RE.test(value.trim());
}

/**
 * Select the most likely "real content" value from a MAN pin row, in priority
 * order, skipping any candidate that is a content-download URL. Returns the raw
 * value (string or object) without parsing — callers parse/validate as needed.
 *
 * Mirrors the battle-tested JS implementation in
 * `serviceOrderSessionResolution.js#selectProtocolPinContent` so every MAN
 * consumer in the app agrees on what counts as the pin body.
 */
export function selectProtocolPinContent(item: Record<string, unknown> | null | undefined): unknown {
  if (!item || typeof item !== 'object') return null;

  const candidates: unknown[] = [
    item.contentSummary,
    item.contentBody,
    item.content,
    item.data,
    item.originalContentBody,
    item.originalContentSummary,
  ];

  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (typeof candidate === 'object') return candidate;
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (!trimmed) continue;
      // A content-download URL is never the JSON body — skip it so the next
      // candidate (or nothing) is used instead.
      if (looksLikeContentUrl(trimmed)) continue;
      // `contentBody` / `originalContentBody` may be base64-encoded; try to
      // decode so downstream JSON.parse sees plain text.
      if (candidate === item.contentBody || candidate === item.originalContentBody) {
        const decoded = decodeBase64Utf8(trimmed);
        if (decoded) return decoded;
      }
      return trimmed;
    }
  }

  return null;
}

function decodeBase64Utf8(value: string): string | null {
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Parse a MAN pin row's content into a plain object. Returns null when there is
 * no content, when it is a URL, or when it is not valid JSON. Convenience wrapper
 * around {@link selectProtocolPinContent} for the common "I just want the object"
 * case.
 */
export function parseProtocolPinContent(item: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const value = selectProtocolPinContent(item);
  if (value == null) return null;
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}
