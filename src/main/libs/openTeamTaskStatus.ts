/**
 * OpenTeam guest-side host-task status tags. The chair of a group task drives the
 * host-side state machine with `[STATUS:EXECUTING]` / `[STATUS:REVIEW]` group messages
 * (groupTaskDaemon.ts STATUS_TAG), and closeGroupTask posts a deterministic
 * `[STATUS:DONE]` / `[STATUS:CANCELLED]` close-out announcement. A guest machine indexes
 * the same transcript, so the newest chair-sent tag is the guest's source of truth for
 * the host task's status — no extra envelope channel needed.
 *
 * Deliberately separate from the host-side STATUS_TAG (EXECUTING|REVIEW only): a
 * chair-posted [STATUS:DONE] must stay a no-op for the host's own daemon state machine
 * while guest machines do consume it.
 */

export type OpenTeamTaskStatus = 'executing' | 'review' | 'done' | 'cancelled';

export const OPENTEAM_TASK_STATUS_TAG_RE = /\[STATUS:\s*(EXECUTING|REVIEW|DONE|CANCELLED)\s*\]/gi;

/**
 * Extract the status tag from a group message body; null when absent. Total. never throws.
 *
 * G-03: LAST match wins. Chair instruction tags sit at the message end (the
 * host protocol template requires it) while earlier tags in the body are
 * descriptive text quoted from the goal/acceptance criteria — a first-match
 * parse would let a quoted "[STATUS:REVIEW]" flip the guest mirror while the
 * host machine correctly applied the trailing instruction. Deterministic
 * host-authored close-out announcements carry exactly one tag, so last-match
 * reads them unchanged.
 */
export function parseOpenTeamTaskStatusTag(content: string | null | undefined): OpenTeamTaskStatus | null {
  const matches = [...String(content ?? '').matchAll(OPENTEAM_TASK_STATUS_TAG_RE)];
  if (matches.length === 0) return null;
  return matches[matches.length - 1][1].toLowerCase() as OpenTeamTaskStatus;
}

/** Terminal host-task statuses: the guest stops replying and the group leaves the backfill set. */
export function isOpenTeamTaskStatusTerminal(status: OpenTeamTaskStatus | null | undefined): boolean {
  return status === 'done' || status === 'cancelled';
}
