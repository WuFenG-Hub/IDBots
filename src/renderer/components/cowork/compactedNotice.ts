import { i18nService } from '../../services/i18n';

/**
 * Compaction checkpoints render as one brief localized line. The summary text
 * the kernel produces is the model's new context, not chat content — before
 * this module existed the full blob was dumped into the transcript and read as
 * leaked internal state, so the display layer deliberately never falls back to
 * the stored message body.
 *
 * Counts come from the structured metadata the mappers write today. Legacy
 * transcripts (stored before the mapper stopped inlining the summary) carry
 * only the old English header line, so the header is parsed as a fallback to
 * keep those checkpoints informative too.
 */

export interface CompactedCounts {
  items: number | null;
  tokens: number | null;
}

const LEGACY_COMPACTED_HEADER_RE = /Compacted (\d+) history items \(~([\d,]+) tokens\)\./;

export const formatCompactTokens = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
};

export const extractCompactedCounts = (
  metadata: Record<string, unknown> | null | undefined,
  content: string | null | undefined,
): CompactedCounts => {
  const metaItems = metadata && typeof metadata.compactedItems === 'number'
    ? metadata.compactedItems
    : null;
  const metaTokens = metadata && typeof metadata.compactedTokens === 'number'
    ? metadata.compactedTokens
    : null;
  if (metaItems !== null && metaTokens !== null) {
    return { items: metaItems, tokens: metaTokens };
  }
  const match = typeof content === 'string' ? LEGACY_COMPACTED_HEADER_RE.exec(content) : null;
  return {
    items: metaItems ?? (match ? Number(match[1]) : null),
    tokens: metaTokens ?? (match ? Number(match[2].replace(/,/g, '')) : null),
  };
};

export const buildCompactedNoticeText = ({ items, tokens }: CompactedCounts): string => {
  if (items === null && tokens === null) {
    return i18nService.t('coworkCompactedContext');
  }
  return i18nService.t('coworkCompactedContextDetail')
    .replace('{items}', items === null ? '—' : String(items))
    .replace('{tokens}', tokens === null ? '—' : formatCompactTokens(tokens));
};
