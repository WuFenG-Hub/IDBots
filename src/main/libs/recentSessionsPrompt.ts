import { stripLoneSurrogates, truncateUtf16Units } from './llmSafeText';

/**
 * Recent-sessions pulse — ambient cross-session awareness for cowork bots.
 *
 * A bot's other conversations used to be reachable only through tool calls
 * (`recent_chats`, `idbots_session_read_all`), which is retrieval: the model
 * must first DECIDE to look, and reliably fails exactly when it matters (the
 * "you already gave me that in the other chat" class of misses). Ambient
 * awareness — the human "I remember what we did in the other room" reflex —
 * has to ride the context itself. This module renders a compact, budget-
 * capped digest of the bot's N most recent OTHER sessions (relative age,
 * IDBots:// link, title, latest owner/bot exchange) for the per-turn volatile
 * tail. Snippets are intentionally raw-truncated, not summarized: the pulse
 * answers "what happened where, roughly where did it land" — depth comes
 * from drilling into the link with idbots_session_read_all.
 *
 * Pure module: no I/O, no Electron imports. All trimming goes through the
 * llmSafeText helpers so an unpaired surrogate can never enter an LLM
 * request body.
 */

export const RECENT_SESSIONS_PROMPT_LIMIT = 8;
export const RECENT_SESSIONS_SNIPPET_MAX_CHARS = 80;
export const RECENT_SESSIONS_TITLE_MAX_CHARS = 28;
/** Guardrail for the whole rendered block — the pulse must stay ambient, never crowd the tail. */
export const RECENT_SESSIONS_BLOCK_MAX_CHARS = 2400;

export interface RecentSessionPulseEntry {
  sessionId: string;
  title: string;
  /** Last activity timestamp in epoch ms; used for the relative age tag. */
  activityAt: number;
  /** Latest user (owner-side) message snippet; may be empty. */
  human: string;
  /** Latest visible assistant reply snippet; may be empty. */
  assistant: string;
}

const escapePromptText = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const normalizeSnippet = (text: string, maxChars: number): string =>
  escapePromptText(
    truncateUtf16Units(
      stripLoneSurrogates((text || '').replace(/\s+/g, ' ').trim()),
      maxChars,
    ),
  );

export function formatRecentSessionAge(activityAt: number, nowMs: number): string {
  const deltaMs = Math.max(0, nowMs - activityAt);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function renderRecentSessionLine(entry: RecentSessionPulseEntry, nowMs: number): string {
  const human = normalizeSnippet(entry.human, RECENT_SESSIONS_SNIPPET_MAX_CHARS);
  const assistant = normalizeSnippet(entry.assistant, RECENT_SESSIONS_SNIPPET_MAX_CHARS);
  // A session whose latest exchange is invisible (empty on both sides) says
  // nothing about its state — noise, not awareness.
  if (!human && !assistant) return '';
  const parts: string[] = [];
  if (human) parts.push(`owner: ${human}`);
  if (assistant) parts.push(`you: ${assistant}`);
  const title = normalizeSnippet(entry.title, RECENT_SESSIONS_TITLE_MAX_CHARS);
  return `- (${formatRecentSessionAge(entry.activityAt, nowMs)}) IDBots://${entry.sessionId} "${title}" ${parts.join(' | ')}`;
}

export function buildRecentSessionsPromptBlock(
  entries: RecentSessionPulseEntry[],
  nowMs: number = Date.now(),
): string {
  const usable = Array.isArray(entries)
    ? entries.filter((entry) => entry && typeof entry.sessionId === 'string' && entry.sessionId)
    : [];
  const lines: string[] = [];
  for (const entry of usable) {
    const line = renderRecentSessionLine(entry, nowMs);
    if (line) lines.push(line);
  }
  if (lines.length === 0) return '';

  const header =
    `Your ${lines.length} most recent other conversations, newest first ` +
    '(open an IDBots:// link with idbots_session_read_all). Live awareness of your own recent work: ' +
    'before asking the owner to do or provide anything, or reporting anything as still pending, cross-check here first.';
  const overhead = `<recent_sessions>\n${header}\n`.length + '\n</recent_sessions>'.length;

  // Budget guard: keep lines newest-first while the block fits. The newest
  // line is always kept; a pathological over-budget single line is hard-cut
  // rather than dropping awareness entirely.
  let body = '';
  let kept = 0;
  for (const line of lines) {
    if (kept > 0 && overhead + body.length + line.length + 1 > RECENT_SESSIONS_BLOCK_MAX_CHARS) break;
    body += (kept > 0 ? '\n' : '') + line;
    kept += 1;
  }
  if (overhead + body.length > RECENT_SESSIONS_BLOCK_MAX_CHARS) {
    body = truncateUtf16Units(body, Math.max(0, RECENT_SESSIONS_BLOCK_MAX_CHARS - overhead));
  }

  return `<recent_sessions>\n${header}\n${body}\n</recent_sessions>`;
}
