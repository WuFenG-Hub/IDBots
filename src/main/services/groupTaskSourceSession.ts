/**
 * P1/P4 (v1.1): unambiguous fallback for the group-task source-session linkage.
 *
 * Task #21 evidence: twin-created tasks arrived via the metabot-group-task
 * skill without `source_session_id`, so `group_tasks.source_session_id`
 * stayed NULL and the R2 acceptance relay ("哪里发起哪里结束") silently
 * degraded to the owner-private channel — the originating CoWork session
 * never received the close-out notice.
 *
 * The create call itself runs inside the Twin session's turn, so that session
 * is by definition the freshest Twin standard session. Resolve it ONLY when
 * exactly one candidate exists within the window; zero or multiple candidates
 * return null (never guess wrong-session attribution).
 */

export type GroupTaskSourceSessionExec = (
  sql: string,
  params: unknown[],
) => Array<{ values?: unknown[][] }>;

export const TWIN_SOURCE_SESSION_WINDOW_MS = 15 * 60 * 1000;

/**
 * R2 hotfix: session types allowed as the group-task source ("where the human
 * started this"). The original R2 gate accepted only `standard` sessions, but
 * since the bot-internet composer (2026-08-25) a `browser` session IS a
 * first-class human conversation surface — users start group tasks there and
 * expect the lifecycle relays (create/dispatch/checkpoint/acceptance) to land
 * back in that same room. The relay pipe itself (coworkCrossSession
 * insertUserMessage) already delivers to browser targets (only a2a is
 * write-protected), so accepting browser here completes the loop without any
 * pipe change. a2a/group_task stay rejected: a2a is a read-only remote peer
 * channel, and a group_task session is not where a human starts a task.
 */
export const GROUP_TASK_SOURCE_SESSION_TYPES: ReadonlySet<string> = new Set([
  'standard',
  'browser',
]);

export function resolveTwinSourceSessionFallback(
  exec: GroupTaskSourceSessionExec,
  twinMetabotId: number,
  nowMs: number,
  windowMs: number = TWIN_SOURCE_SESSION_WINDOW_MS,
): { sessionId: string } | { ambiguous: number } | null {
  if (!Number.isInteger(twinMetabotId) || twinMetabotId <= 0) return null;
  const since = nowMs - windowMs;
  const rows = exec(
    `SELECT id FROM cowork_sessions
     WHERE metabot_id = ? AND session_type = 'standard' AND updated_at >= ?
     ORDER BY updated_at DESC`,
    [twinMetabotId, since],
  );
  const ids = (rows[0]?.values ?? [])
    .map((row) => String(row[0]))
    .filter((id) => id.trim().length > 0);
  if (ids.length === 1) return { sessionId: ids[0] };
  if (ids.length > 1) return { ambiguous: ids.length };
  return null;
}
