/**
 * [POSITION] protocol lines (R9, OpenTeam chat scenario 2026-09): a
 * discussion artifact a group member puts on the record — an objection, a
 * boundary statement, or an agreed conclusion. Task-mode ledger discipline
 * only counts [DELIVERABLE] artifacts; a discussion's decisions were
 * previously invisible to the ledger unless someone shipped a file.
 *
 * Line shape (mirrors [PLAN_CHANGE: …]):
 *   [POSITION: <one-line statement>]
 *
 * - The tag must START the line; the statement is the bracket's content.
 * - Mid-line mentions are citations, never positions (same leading-tag rule
 *   as the deliverable parser).
 * - Fenced code blocks are stripped by the caller before parsing (citations
 *   in docs/examples never count).
 *
 * Host-side this is pure line parsing — deciding WHAT is a position worth
 * recording stays with the model (the playbook teaches the tag); the host
 * only records, dedupes and cites the source pin.
 */

export interface ParsedPositionLine {
  /** The statement text (trimmed; may be empty for a degenerate tag). */
  text: string;
  /** 1-based line number in the source content. */
  line: number;
}

const POSITION_LINE_RE = /^\[POSITION:\s*(.*?)\]\s*$/;

/** Parse every [POSITION: …] line (one row per line, order preserved). */
export function parsePositionLines(content: string): ParsedPositionLine[] {
  const positions: ParsedPositionLine[] = [];
  const lines = String(content ?? '').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]!.trim().match(POSITION_LINE_RE);
    if (!match) continue;
    const text = String(match[1] ?? '').trim();
    if (!text) continue; // a bare [POSITION:] carries nothing to record
    positions.push({ text, line: index + 1 });
  }
  return positions;
}
