import * as fs from 'fs';
import * as path from 'path';

/**
 * Per-bot dated workspace directories.
 *
 * Each MetaBot gets its own workspace subtree so that artifacts produced by
 * different bots no longer mix inside the shared global working directory:
 *
 *   <baseWorkingDirectory>/bots/<metabotId>/<YYYY-MM-DD>
 *
 * The metabotId (stable integer PK) is used instead of the bot name so that
 * renaming a bot never strands existing directories. The date folder uses the
 * local timezone and is stamped at session-creation time; long-lived sessions
 * (e.g. canonical A2A conversations) keep their creation-date cwd.
 */

export const BOT_WORKSPACE_DIR_NAME = 'bots';

/** Format a date as local-time YYYY-MM-DD for per-day bot workspace folders. */
export function formatBotWorkspaceDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Type guard for metabot ids that are usable as workspace folder names. */
export function isWorkspaceMetabotId(metabotId: unknown): metabotId is number {
  return typeof metabotId === 'number' && Number.isInteger(metabotId) && metabotId > 0;
}

/**
 * Resolve (and create) the per-bot dated workspace directory for a session.
 * Throws when the metabot id or base directory is invalid — callers that treat
 * bot directories as optional should guard with isWorkspaceMetabotId first.
 */
export function resolveBotWorkspaceCwd(
  baseWorkingDirectory: string,
  metabotId: number,
  now: Date = new Date()
): string {
  const trimmedBase = typeof baseWorkingDirectory === 'string' ? baseWorkingDirectory.trim() : '';
  if (!trimmedBase) {
    throw new Error('Cannot resolve bot workspace without a base working directory.');
  }
  if (!isWorkspaceMetabotId(metabotId)) {
    throw new Error(`Cannot resolve bot workspace for invalid metabot id: ${String(metabotId)}`);
  }
  const botWorkspaceCwd = path.join(
    path.resolve(trimmedBase),
    BOT_WORKSPACE_DIR_NAME,
    String(metabotId),
    formatBotWorkspaceDate(now)
  );
  fs.mkdirSync(botWorkspaceCwd, { recursive: true });
  return botWorkspaceCwd;
}

/**
 * Unified cwd resolution for session entry points: a valid metabot id routes
 * the session into its per-bot dated workspace; anything else keeps the legacy
 * behavior of using the (resolved) base directory as-is.
 */
export function resolveSessionWorkingDirectory(
  baseWorkingDirectory: string,
  metabotId?: number | null,
  now: Date = new Date()
): string {
  if (isWorkspaceMetabotId(metabotId)) {
    return resolveBotWorkspaceCwd(baseWorkingDirectory, metabotId, now);
  }
  return path.resolve(baseWorkingDirectory);
}
