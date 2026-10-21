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
 * live selection OR from one whole message (the per-message reply entry), the
 * composer owns them, both go through these helpers.
 */

import type { CoworkQuotedSelection, CoworkQuotedSelectionRole } from '../../types/cowork';

/** Per-fragment cap. A whole transcript pasted into one quote would crowd out the instruction. */
export const QUOTED_SELECTION_MAX_CHARS = 4000;
/** Cap for the one-line summary shown on a fragment tile. */
export const QUOTED_SELECTION_SUMMARY_CHARS = 96;
/**
 * Cap for the excerpt that rides into the prompt body itself. A whole-message
 * reply quotes a *reference*, not a payload: the model already re-reads the
 * conversation as plain text, so carrying the full message only crowds out the
 * instruction (and produced a wall of blockquote in the transcript). The block
 * therefore stays a compact pointer — role, position, and one short excerpt.
 */
export const QUOTED_SELECTION_BLOCK_CHARS = 160;

/**
 * Band for the quote excerpt as RENDERED in the transcript (WeChat-style: one
 * short line, the speaker's name above it). The actual cap follows the owner's
 * reply length within this band (see adaptQuoteDisplayChars), and CSS clamps
 * the line to a single row regardless of width. Display-only — the submitted
 * prompt body keeps the wider QUOTED_SELECTION_BLOCK_CHARS excerpt, so the
 * model still locates the passage.
 */
export const QUOTED_SELECTION_DISPLAY_CHARS_MIN = 12;
export const QUOTED_SELECTION_DISPLAY_CHARS_MAX = 40;
/** Default when no instruction is known (tiles without a submitted body yet). */
export const QUOTED_SELECTION_DISPLAY_CHARS = QUOTED_SELECTION_DISPLAY_CHARS_MAX;

/**
 * A generated truncation-note blockquote line, e.g. `（已截断：仅保留前 200 字）`
 * / `(truncated: only the first N characters are kept)`. Matched by FORM (a
 * parenthesized note carrying "截断"/"truncated"), so it holds for any shipped
 * dictionary without pinning one literal string.
 */
const TRUNCATION_NOTE_LINE_PATTERN = /^>\s*[（(][^）)]*(?:截断|truncated)[^）)]*[）)][。.]?$/i;

/** i18n keys naming the source side of a quote. */
export const QUOTED_SELECTION_SOURCE_KEYS: Record<CoworkQuotedSelectionRole, string> = {
  user: 'coworkQuoteSourceUser',
  assistant: 'coworkQuoteSourceAssistant',
  other: 'coworkQuoteSourceOther',
};

/**
 * Every transcript element carries `data-message-id`, so a quoted whole-message
 * fragment found by id. One id can be mounted on several layers (an outer turn
 * block plus the single message container), so the INNERMOST match is returned
 * — a jump highlight must wrap the one message, never the whole turn. Returns
 * null when the target is no longer rendered (the window was trimmed, the
 * session changed).
 */
export const findTranscriptMessageElement = (
  root: ParentNode | null,
  messageId: string,
): HTMLElement | null => {
  if (!root || !messageId) return null;
  const selector = `[data-message-id="${CSS.escape(messageId)}"]`;
  const matches = Array.from(root.querySelectorAll<HTMLElement>(selector));
  if (matches.length === 0) return null;
  // Document order runs outermost-first; the innermost match is the one with
  // no match nested inside it.
  return matches.find((candidate) => !candidate.querySelector(selector))
    ?? matches[matches.length - 1];
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

/** What the per-message reply entry knows about its target message. */
export interface QuotedMessageTarget {
  /** The message body as it reads at capture time (the excerpt snapshot). */
  content: string;
  role: CoworkQuotedSelectionRole;
  /** Id of the quoted message — the durable jump anchor. */
  messageId?: string;
  /** 1-based position among the transcript's rendered messages. */
  ordinal: number;
  /** Whether the message was still being generated at capture time. */
  streaming: boolean;
}

/**
 * Build a fragment that quotes one whole transcript message (the reply entry
 * on each message's action bar). The body is a snapshot taken at click time:
 * a still-generating message contributes what it has written so far, together
 * with a frozen `streaming` mark, so the excerpt can never change under the
 * owner's eyes afterwards. Returns null when the message carries no text.
 */
export const createMessageQuotedSelection = (
  target: QuotedMessageTarget,
  id: string = nextQuotedSelectionId(),
): CoworkQuotedSelection | null => {
  const fragment = createQuotedSelection(target.content, target.role, id);
  if (!fragment) return null;
  return {
    ...fragment,
    messageRef: { messageId: target.messageId, ordinal: target.ordinal, streaming: target.streaming },
  };
};

/** Whether a message carries text the reply entry could quote. */
export const hasQuotableText = (raw: string): boolean => (
  normalizeQuotedSelectionText(raw).length > 0
);

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

/**
 * The quoted messages' ids, in fragment order, deduped. Rides alongside the
 * composed prompt at submit time (CoworkSubmitInput.quotedMessageIds) so the
 * persisted user message can anchor its sent quote blocks by id — the ordinal
 * baked into the block label is window-relative copy that shifts whenever an
 * older history page loads. Empty for hand-picked selections (no target).
 */
export const collectQuotedMessageIds = (
  selections: readonly CoworkQuotedSelection[],
): string[] => {
  const ids: string[] = [];
  for (const selection of selections) {
    const messageId = selection.messageRef?.messageId;
    if (messageId && !ids.includes(messageId)) ids.push(messageId);
  }
  return ids;
};

export interface QuotedSelectionBlockLabels {
  /** Heading of the excerpt block. */
  header: string;
  /** Per-excerpt template containing `{source}`, e.g. "Quoted from {source}:". */
  item: string;
  /** Localized name of each side of the conversation. */
  sourceLabel: Record<CoworkQuotedSelectionRole, string>;
  /**
   * Reply copy, used when a fragment quotes one whole message. `replyBlockItem`
   * is the per-message line — role, position and an optional generating mark,
   * e.g. "Reply to {source} (message #{ordinal}{streaming}):". A block that
   * quotes exactly one message is led by its own item line; `replyBlockHeader`
   * opens a block that quotes several. `replyStreamingMark` fills the
   * `{streaming}` slot (a " · " joiner is prepended), and `replySourceLabel`
   * supersedes `sourceLabel` for reply fragments when provided.
   */
  replyBlockHeader?: string;
  replyBlockItem?: string;
  replyStreamingMark?: string;
  replySourceLabel?: Partial<Record<CoworkQuotedSelectionRole, string>>;
  /**
   * Note appended at the excerpt's tail when the text had to be capped:
   * contains `{max}` (the per-fragment cap). Truncation must never be silent
   * in the prompt body.
   */
  truncatedNote?: string;
}

/** Fill the reply item template for one quoted message. */
const buildReplyItemLabel = (
  template: string,
  source: string,
  ref: NonNullable<CoworkQuotedSelection['messageRef']>,
  streamingMark: string | undefined,
): string => template
  .replace('{source}', source)
  .replace('{ordinal}', String(ref.ordinal))
  .replace('{streaming}', ref.streaming && streamingMark ? ` · ${streamingMark}` : '');

/**
 * Render the excerpt block that is prepended to the submitted prompt. A
 * blockquote keeps each excerpt visibly distinct from the owner's own
 * instruction while staying plain text for the model.
 *
 * Reply fragments (whole-message quotes) label themselves with the message's
 * role + position; a block that quotes exactly one message is led by that
 * label line alone, while multi-message blocks (the model supports N even
 * though the composer slot is single-target today) open with the reply
 * header so every item line stays a per-message label.
 */
export const buildQuotedSelectionsBlock = (
  selections: readonly CoworkQuotedSelection[],
  labels: QuotedSelectionBlockLabels,
): string => {
  if (selections.length === 0) return '';
  const parts = selections.map((selection) => {
    const ref = selection.messageRef;
    const source = (ref && labels.replySourceLabel?.[selection.role])
      ?? labels.sourceLabel[selection.role]
      ?? labels.sourceLabel.other;
    // Reply fragments collapse to a single pointer line: the bulk of a quoted
    // message stays out of the prompt (the model re-reads the transcript), so
    // the block is one short excerpt, never the whole message. A hand-picked
    // passage keeps its own text — the owner chose those exact words.
    if (ref && labels.replyBlockItem) {
      const label = buildReplyItemLabel(labels.replyBlockItem, source, ref, labels.replyStreamingMark);
      const excerpt = summarizeQuotedSelectionText(selection.text, QUOTED_SELECTION_BLOCK_CHARS);
      // The excerpt is deliberately short, so say so when it was cut — a silent
      // cut reads as "the message was this short".
      const cut = selection.text.trim().length > QUOTED_SELECTION_BLOCK_CHARS
        && labels.truncatedNote
        ? `\n> ${labels.truncatedNote.replace('{max}', String(QUOTED_SELECTION_BLOCK_CHARS))}`
        : '';
      return `> ${label}\n> ${excerpt}${cut}`;
    }
    const label = labels.item.replace('{source}', source);
    const lines = selection.text
      .split('\n')
      .map((line) => (line ? `> ${line}` : '>'));
    if (selection.truncated && labels.truncatedNote) {
      lines.push(`> ${labels.truncatedNote.replace('{max}', String(QUOTED_SELECTION_MAX_CHARS))}`);
    }
    return `> ${label}\n${lines.join('\n')}`;
  });
  const replyOnly = selections.every((selection) => Boolean(selection.messageRef));
  if (replyOnly && selections.length === 1) return parts[0];
  const header = replyOnly && labels.replyBlockHeader ? labels.replyBlockHeader : labels.header;
  return `> ${header}\n>\n${parts.join('\n>\n')}`;
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

/**
 * Structural shape of the rendered turns the transcript passes in (the
 * ConversationTurn[] of CoworkSessionDetail, kept structural so this module
 * stays import-free).
 */
export interface TranscriptTurnLike {
  userMessage: { id: string } | null;
  assistantItems: ReadonlyArray<{ type: string; message?: { id: string } }>;
}

/**
 * 1-based positions of the transcript's conversational messages — user and
 * assistant messages in rendered order; tool chrome and system notices do not
 * count — keyed by message id. The reply entry writes the target's position
 * into the quoted fragment's label, so "第 N 条" always matches what the
 * transcript rendered at capture time.
 */
export const buildTranscriptMessagePositions = (
  turns: readonly TranscriptTurnLike[],
): Map<string, number> => {
  const positions = new Map<string, number>();
  let position = 0;
  for (const turn of turns) {
    if (turn.userMessage) {
      position += 1;
      positions.set(turn.userMessage.id, position);
    }
    for (const item of turn.assistantItems) {
      if (item.type === 'assistant' && item.message) {
        position += 1;
        positions.set(item.message.id, position);
      }
    }
  }
  return positions;
};

/**
 * The reverse of `buildTranscriptMessagePositions`: ordinal → message id. A
 * sent reply block only carries the quoted message's position (its label), so
 * this is the lookup a jump back from the block takes; a position the map does
 * not hold means the message is not inside the rendered window.
 */
export const buildTranscriptMessageIdsByOrdinal = (
  positions: ReadonlyMap<string, number>,
): Map<number, string> => {
  const idsByOrdinal = new Map<number, string>();
  for (const [id, ordinal] of positions) {
    idsByOrdinal.set(ordinal, id);
  }
  return idsByOrdinal;
};

/**
 * The first quoted-message id recorded on a sent user message's metadata —
 * the jump anchor for its reply block (the block's own label names the first
 * quoted message, so ids[0] is the same target the label points at). Null for
 * messages sent before the anchor existed or for hand-picked selections; the
 * caller then falls back to ordinal resolution.
 */
export const readQuotedJumpMessageId = (metadata: unknown): string | null => {
  const ids = (metadata as { quotedMessageIds?: unknown } | null | undefined)?.quotedMessageIds;
  return Array.isArray(ids) && typeof ids[0] === 'string' && ids[0] !== '' ? ids[0] : null;
};

/** A sent reply block split off the head of a message body, for its jump control. */
export interface SentQuoteBlock {
  /** 1-based position of the quoted message, as written into the block label. */
  ordinal: number;
  /** The raw blockquote lines (label + excerpt + optional truncation note). */
  block: string;
  /** Everything after the block — the owner's instruction, '' when none. */
  rest: string;
}

/**
 * Split the generated reply block off the head of a sent message body, so the
 * transcript can render it as a jump control while the rest renders as before.
 *
 * Only the exact generated form matches: the body starts with the reply item
 * line (`> #<ordinal> <side><streaming>：`, either colon) followed by at least
 * one more blockquote line. A blockquote the owner typed themselves — not at
 * the body's head, or without the `#<ordinal>` label — never matches, so a
 * hand-written quote stays plain markdown. Returns null when the body carries
 * no such block.
 */
export const parseSentQuoteBlock = (
  content: string,
  displaySources?: Record<CoworkQuotedSelectionRole, string>,
): SentQuoteBlock | null => {
  if (typeof content !== 'string' || content.length === 0) return null;
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const label = /^> #([1-9]\d*)\s(.*?)\s*[：:]\s*$/.exec(lines[0] ?? '');
  if (!label) return null;
  let end = 1;
  while (end < lines.length && lines[end].startsWith('>')) end += 1;
  // The generated block always carries the excerpt line under its label.
  if (end < 2) return null;
  return {
    ordinal: Number(label[1]),
    block: shortenSentQuoteBlockForDisplay(lines.slice(0, end), label[2], displaySources),
    rest: lines.slice(end).join('\n').trim(),
  };
};

/**
 * Shorten a sent reply block for the transcript, WeChat-style: `> #<ordinal>
 * <side>：` becomes the speaker's own short name (`你：` / `我：`), and the
 * excerpt under it is capped to QUOTED_SELECTION_DISPLAY_CHARS with an
 * ellipsis so the quote reads as one short line. Any truncation-note line is
 * dropped (the ellipsis already says the text continues). `side` is the label
 * as generated ("助手消息" / "你的消息"), mapped through `displaySources`.
 * Display-only — the submitted prompt body keeps the generated label and the
 * wider excerpt the model needs.
 */
const shortenSentQuoteBlockForDisplay = (
  lines: readonly string[],
  side: string,
  displaySources?: Record<CoworkQuotedSelectionRole, string>,
): string => {
  let label = lines[0] ?? '';
  if (displaySources && side) {
    // Which side the quoted message is on, read from its generated label. The
    // shipped dictionaries name the sides differently per language and per
    // label family ("Bot 回复" / "助手消息" / "the assistant message" / …), so
    // match on the side each family uses for assistant and the user, and treat
    // anything left as the neutral "other" bucket.
    const role: CoworkQuotedSelectionRole = /assistant|bot|助手/i.test(side)
      ? 'assistant'
      : /对话|conversation|quoted/i.test(side)
        ? 'other'
        : 'user';
    label = `> ${displaySources[role]}`;
  }
  const out: string[] = [label];
  let excerptSeen = false;
  for (const line of lines.slice(1)) {
    if (TRUNCATION_NOTE_LINE_PATTERN.test(line.trimEnd())) continue;
    if (!excerptSeen) {
      excerptSeen = true;
      // Keep the whole excerpt here. The rendered line is clamped to ONE row
      // with a CSS ellipsis (see .cowork-sent-quote-line), which needs the real
      // text to measure against the real width — truncating here as well cut
      // the line a second time with no ellipsis, leaving a half character.
      out.push(`> ${line.replace(/^>\s?/, '')}`);
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
};

/** One shipped dictionary's labels for the generated selection block. */
export interface SentSelectionQuoteLabelSet {
  /** The block header (coworkQuoteBlockHeader) — stripped from the display. */
  header: string;
  /** The per-excerpt template containing `{source}` (coworkQuoteBlockItem). */
  item: string;
  /** The source names as written into the block (coworkQuoteSource*). */
  sourceLabel: Record<CoworkQuotedSelectionRole, string>;
  /**
   * Display-only, humanized source lines for the sent block
   * (coworkQuoteSentSource*). The prompt body keeps the generated form; only
   * the transcript renders these.
   */
  displayLabel: Record<CoworkQuotedSelectionRole, string>;
}

/** A sent selection block split off the head of a message body, for display. */
export interface SentSelectionQuoteBlock {
  /** The display blockquote: header stripped, source lines humanized. */
  block: string;
  /** Everything after the block — the owner's instruction, '' when none. */
  rest: string;
}

const QUOTED_SELECTION_ROLES: readonly CoworkQuotedSelectionRole[] = ['user', 'assistant', 'other'];

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Match one excerpt label line (`> 引自{source}：` / `> Quoted from {source}:`)
 * against a dictionary's template, returning the role it names — or null when
 * the line is not a label of that dictionary.
 */
const matchSelectionItemLine = (
  line: string,
  set: SentSelectionQuoteLabelSet,
): CoworkQuotedSelectionRole | null => {
  const pattern = new RegExp(`^> ${escapeRegExp(set.item).replace('\\{source\\}', '(.+)')}$`);
  const match = pattern.exec(line.trimEnd());
  if (!match) return null;
  return QUOTED_SELECTION_ROLES.find((role) => set.sourceLabel[role] === match[1]) ?? null;
};

/**
 * Split the generated selection block off the head of a sent message body and
 * return it in the transcript's quote-bar language: the header line ("从对话
 * 中引用的片段…" — a system-prompt voice, not a person talking) is dropped and
 * each "引自{source}：" line is swapped for its humanized display copy.
 *
 * Display-only: the submitted prompt body keeps the generated block verbatim
 * (the model locates the excerpt by it), so this runs at render time against
 * the body it was written into. `labelSets` are the shipped dictionaries'
 * labels — a message written under any of them still matches after a language
 * switch. Only the exact generated form matches: the body opens with a header
 * line, its empty `>` separator, then at least one recognizable label line. A
 * hand-written blockquote never matches and stays plain markdown. Returns null
 * when the body carries no such block.
 */
export const parseSentSelectionQuoteBlock = (
  content: string,
  labelSets: readonly SentSelectionQuoteLabelSet[],
): SentSelectionQuoteBlock | null => {
  if (typeof content !== 'string' || content.length === 0) return null;
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const head = (lines[0] ?? '').trimEnd();
  const set = labelSets.find((candidate) => head === `> ${candidate.header}`);
  if (!set) return null;
  // The generated form always separates the header from its items with an
  // empty blockquote line.
  if ((lines[1] ?? '') !== '>') return null;
  let end = 1;
  while (end < lines.length && lines[end].startsWith('>')) end += 1;
  // header + separator + at least one item line
  if (end < 3) return null;
  let recognized = 0;
  const body = lines.slice(2, end).map((line) => {
    const role = matchSelectionItemLine(line, set);
    if (!role) return line;
    recognized += 1;
    return `> ${set.displayLabel[role]}`;
  });
  // Not the generated form after all (no label line matched): keep the body
  // untouched rather than stripping a header off hand-written content.
  if (recognized === 0) return null;
  return {
    block: shortenSentSelectionQuoteForDisplay(body),
    rest: lines.slice(end).join('\n').trim(),
  };
};

/**
 * Shorten a sent selection block for the transcript, WeChat-style: the
 * source line (`你：` / `我：`) stays, the excerpt under it is capped to
 * QUOTED_SELECTION_DISPLAY_CHARS with an ellipsis, and the remaining excerpt
 * lines are dropped — so a selection quote reads as one short line too. The
 * full text stays in the prompt body. Display-only.
 */
const shortenSentSelectionQuoteForDisplay = (body: readonly string[]): string => {
  const [label, ...rest] = body;
  const excerpt = rest.find((line) => !TRUNCATION_NOTE_LINE_PATTERN.test(line.trimEnd()));
  if (!excerpt) return label ?? '';
  // Keep the whole excerpt; the rendered row clamps it to one line with a CSS
  // ellipsis (see .cowork-sent-quote-line).
  return [
    label,
    `> ${excerpt.replace(/^>\s?/, '')}`,
  ].join('\n');
};
