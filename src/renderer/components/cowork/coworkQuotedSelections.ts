/**
 * Quoted transcript selections ("reply to this specific part").
 *
 * The owner selects text in the transcript and adds it to the composer as a
 * quoted fragment; the fragment then rides into the prompt body of the next
 * message. That last step is the whole point: the bot re-reads the
 * conversation as plain text on every turn, so a visual highlight reaches it
 * with nothing attached — the excerpt has to be written into the text handed
 * to `onSubmit`.
 *
 * Pure module (no React, no DOM): the transcript view creates fragments from a
 * live selection, the composer owns them, both go through these helpers.
 */

import type { CoworkQuotedSelection, CoworkQuotedSelectionRole } from '../../types/cowork';

/** Per-fragment cap. A whole transcript pasted into one quote would crowd out the instruction. */
export const QUOTED_SELECTION_MAX_CHARS = 4000;
/** Cap for the one-line summary shown on a fragment tile. */
export const QUOTED_SELECTION_SUMMARY_CHARS = 96;

/** i18n keys naming the source side of a quote. */
export const QUOTED_SELECTION_SOURCE_KEYS: Record<CoworkQuotedSelectionRole, string> = {
  user: 'coworkQuoteSourceUser',
  assistant: 'coworkQuoteSourceAssistant',
  other: 'coworkQuoteSourceOther',
};

let quotedSelectionSequence = 0;

/** Ids only need to be unique within one composer's fragment list. */
export const nextQuotedSelectionId = (): string => {
  quotedSelectionSequence += 1;
  return `quote-${Date.now().toString(36)}-${quotedSelectionSequence.toString(36)}`;
};

/**
 * Normalize raw selection text. Returns '' for an empty/whitespace-only
 * selection — callers treat that as "nothing was selected" and produce no
 * fragment, no tile and no action at all.
 */
export const normalizeQuotedSelectionText = (raw: string): string => (
  typeof raw === 'string' ? raw.replace(/\r\n?/g, '\n').trim() : ''
);

/**
 * Build a fragment from a raw selection. Returns null when the selection
 * carries no text, so an empty selection can never create UI.
 */
export const createQuotedSelection = (
  raw: string,
  role: CoworkQuotedSelectionRole,
  id: string = nextQuotedSelectionId(),
): CoworkQuotedSelection | null => {
  const text = normalizeQuotedSelectionText(raw);
  if (!text) return null;
  const truncated = text.length > QUOTED_SELECTION_MAX_CHARS;
  return {
    id,
    role,
    text: truncated ? text.slice(0, QUOTED_SELECTION_MAX_CHARS) : text,
    truncated,
  };
};

/** Which side of the transcript a selected block belongs to. */
export const resolveQuotedSelectionRole = (
  exportRole: string | null | undefined,
): CoworkQuotedSelectionRole => {
  if (exportRole === 'user-message') return 'user';
  if (exportRole === 'assistant-block' || exportRole === 'assistant-message') return 'assistant';
  return 'other';
};

/** A selection that is still floating in the transcript (not added yet). */
export interface PendingQuotedSelection {
  text: string;
  role: CoworkQuotedSelectionRole;
}

/**
 * Turn a live browser selection into the pending shape, or null when nothing
 * is selected — an empty (or whitespace-only) selection must never produce an
 * action bar, a tile, or any prompt text.
 */
export const createPendingQuotedSelection = (
  raw: string,
  exportRole: string | null | undefined,
): PendingQuotedSelection | null => {
  const text = normalizeQuotedSelectionText(raw);
  if (!text) return null;
  return { text, role: resolveQuotedSelectionRole(exportRole) };
};

/** The minimum a rect needs for placement; DOMRect satisfies it. */
export interface QuoteAnchorRect {
  width: number;
  height: number;
}

/**
 * Prefer the live selection rect (the bar floats next to the passage the owner
 * actually selected) and fall back to the containing block's rect when the
 * range has collapsed to nothing — e.g. a streamed chunk re-rendered the turn
 * the range pointed into.
 */
export const resolveQuoteActionBarAnchorRect = <T extends QuoteAnchorRect>(
  liveSelectionRect: T | null,
  anchorRect: T | null,
): T | null => (
  liveSelectionRect && liveSelectionRect.width > 0 && liveSelectionRect.height > 0
    ? liveSelectionRect
    : anchorRect
);

/** One-line preview of an excerpt for its tile (and its hover title). */
export const summarizeQuotedSelectionText = (
  text: string,
  maxChars: number = QUOTED_SELECTION_SUMMARY_CHARS,
): string => {
  const flat = normalizeQuotedSelectionText(text).replace(/\s+/g, ' ');
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, maxChars).trimEnd()}…`;
};

/** Drop one fragment; the rest keep their order (and their own ids). */
export const removeQuotedSelection = (
  selections: readonly CoworkQuotedSelection[],
  id: string,
): CoworkQuotedSelection[] => selections.filter((selection) => selection.id !== id);

export interface QuotedSelectionBlockLabels {
  /** Heading of the excerpt block. */
  header: string;
  /** Per-excerpt template containing `{source}`, e.g. "Quoted from {source}:". */
  item: string;
  /** Localized name of each side of the conversation. */
  sourceLabel: Record<CoworkQuotedSelectionRole, string>;
}

/**
 * Render the excerpt block that is prepended to the submitted prompt. A
 * blockquote keeps each excerpt visibly distinct from the owner's own
 * instruction while staying plain text for the model.
 */
export const buildQuotedSelectionsBlock = (
  selections: readonly CoworkQuotedSelection[],
  labels: QuotedSelectionBlockLabels,
): string => {
  if (selections.length === 0) return '';
  const parts = selections.map((selection) => {
    const source = labels.sourceLabel[selection.role] ?? labels.sourceLabel.other;
    const label = labels.item.replace('{source}', source);
    const body = selection.text
      .split('\n')
      .map((line) => (line ? `> ${line}` : '>'))
      .join('\n');
    return `> ${label}\n${body}`;
  });
  return `> ${labels.header}\n>\n${parts.join('\n>\n')}`;
};

export interface CoworkPromptBodyParts {
  /** What the owner typed. */
  instruction?: string;
  /** Quoted excerpt block, when the message answers a selected passage. */
  quotedBlock?: string;
  /** One `label: path` line per file attachment. */
  attachmentLines?: string;
}

/**
 * Compose the prompt handed to `onSubmit`. This is the baseline composition
 * (instruction plus attachment lines, blank-line separated) with the quoted
 * excerpt block in front — the excerpt is context for the instruction, so it
 * reads first.
 */
export const composeCoworkPromptBody = ({
  instruction = '',
  quotedBlock = '',
  attachmentLines = '',
}: CoworkPromptBodyParts): string => (
  [quotedBlock.trim(), instruction.trim(), attachmentLines.trim()].filter(Boolean).join('\n\n')
);

export interface CoworkSubmittedPromptInput {
  /** Raw composer text (the owner's instruction). */
  value: string;
  /** The excerpts still in the composer at submit time. */
  quotedSelections: readonly CoworkQuotedSelection[];
  /** One `label: path` line per file attachment. */
  attachmentLines?: string;
  /** Localized labels for the excerpt block. */
  labels: QuotedSelectionBlockLabels;
}

/**
 * What the composer hands to `onSubmit` for a normal (non-steer) submit:
 * excerpt block first, then the owner's instruction, then the attachment
 * lines. With no excerpts this is byte-identical to the plain composition.
 */
export const composeSubmittedCoworkPrompt = ({
  value,
  quotedSelections,
  attachmentLines,
  labels,
}: CoworkSubmittedPromptInput): string => composeCoworkPromptBody({
  instruction: value,
  quotedBlock: buildQuotedSelectionsBlock(quotedSelections, labels),
  attachmentLines,
});
