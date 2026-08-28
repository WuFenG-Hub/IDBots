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

export const OPENTEAM_TASK_STATUS_TAG_RE = /\[STATUS:\s*(EXECUTING|REVIEW|DONE|CANCELLED)\s*\]/i;

/** Extract the status tag from a group message body; null when absent. Total: never throws. */
export function parseOpenTeamTaskStatusTag(content: string | null | undefined): OpenTeamTaskStatus | null {
  const match = OPENTEAM_TASK_STATUS_TAG_RE.exec(String(content ?? ''));
  if (!match) return null;
  return match[1].toLowerCase() as OpenTeamTaskStatus;
}

/** Terminal host-task statuses: the guest stops replying and the group leaves the backfill set. */
export function isOpenTeamTaskStatusTerminal(status: OpenTeamTaskStatus | null | undefined): boolean {
  return status === 'done' || status === 'cancelled';
}
