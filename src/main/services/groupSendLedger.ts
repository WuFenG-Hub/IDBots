/**
 * Outgoing group-send ledger (R4, OpenTeam chat scenario 2026-09): a tiny
 * in-memory, process-local record of every /protocols/simplegroupchat pin this
 * app broadcast, written at BOTH send choke points —
 *
 *   - groupChatTransport.sendGroupChatMessage / sendGroupChatMessageAsIdentity
 *     (daemon auto-replies, kickoffs, service flows), and
 *   - the group_chat TOOL's inline control.sendGroupMessage in main.ts
 *     (mid-turn model sends, the skill-turn path).
 *
 * Why not the DB: a locally-sent message only reaches group_chat_messages via
 * the indexer/backfill seconds-to-minutes later, so a DB read at turn end
 * cannot prove "the bot already spoke in this group during THIS turn". The
 * ledger records the send the moment createPin succeeds, in-process, making
 * the guest daemon's single-send guarantee (R4) a synchronous fact check:
 * before auto-sending a turn's final text, ask whether this (bot, group)
 * already sent anything since the turn started — if yes, the final text is a
 * duplicate report and must stay off-chain.
 *
 * Deliberately in-memory (not persisted): it answers one question about the
 * CURRENT process's recent sends; a restart clears it, which is fine because
 * a turn cannot span a restart.
 */

export interface OutgoingGroupSendRecord {
  metabotId: number;
  groupId: string;
  pinId: string;
  /** Epoch ms of the successful createPin. */
  at: number;
  /** Which choke point recorded it ('transport' | 'group_chat_tool' | custom). */
  origin: string;
}

const LEDGER_CAP = 500;
const LEDGER_MAX_AGE_MS = 30 * 60_000;

const records: OutgoingGroupSendRecord[] = [];

function prune(): void {
  while (records.length > LEDGER_CAP) records.shift();
  // Age-prune RELATIVE to the newest record (not wall clock): callers may
  // stamp synthetic times (tests), and monotonicity against the newest entry
  // is what "recent" means here.
  const newestAt = records.length > 0 ? records[records.length - 1]!.at : 0;
  const cutoff = newestAt - LEDGER_MAX_AGE_MS;
  while (records.length > 0 && records[0]!.at < cutoff) records.shift();
}

/** Record one successful group send. Never throws. */
export function recordOutgoingGroupSend(entry: {
  metabotId: number;
  groupId: string;
  pinId: string;
  at?: number;
  origin?: string;
}): void {
  try {
    records.push({
      metabotId: entry.metabotId,
      groupId: entry.groupId,
      pinId: entry.pinId,
      at: entry.at ?? Date.now(),
      origin: entry.origin ?? 'transport',
    });
    prune();
  } catch {
    // A ledger failure must never break the send path it observes.
  }
}

/**
 * True when this (bot, group) sent at least one group message AFTER sinceMs
 * (exclusive). The guest daemon calls this with the turn's start time: any
 * hit means the model already spoke to the group mid-turn and the daemon's
 * final-text auto-send must be suppressed (single-send guarantee).
 */
export function hasOutgoingGroupSendSince(
  metabotId: number,
  groupId: string,
  sinceMs: number,
  opts?: { excludePinId?: string },
): boolean {
  return records.some(
    (record) =>
      record.metabotId === metabotId
      && record.groupId === groupId
      && record.at > sinceMs
      && record.pinId !== opts?.excludePinId,
  );
}

/** Test seam: drop every recorded send. */
export function resetOutgoingGroupSendLedger(): void {
  records.length = 0;
}
