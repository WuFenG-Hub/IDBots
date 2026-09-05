/**
 * One-time ledger repair for the line-scoped [DELIVERABLE] parser gap.
 *
 * The round-4 parser only read the text AFTER the tag ON THE SAME LINE, so the
 * "description line + blank line + URI line" delivery shape (task #62 msg
 * c48d2eb6: a skill-pack pin, a skill zip metafile and a MetaApp URI, each
 * under its own [DELIVERABLE] tag) produced no URI rows — the descriptions
 * even carry sha256 hex that tripped the truncated-pinid invalidation. The
 * rail then showed only the same-line deliveries (two pins) while the real
 * on-chain artifacts were missing.
 *
 * This repair re-parses every task's chat history with the (fixed) parser and
 * inserts the missing on-chain rows. Safety properties:
 * - Additive only: never updates or deletes existing rows.
 * - Idempotent: the store's (msg_pin_id, uri, kind) and same-author same-URI
 *   dedupe (the live daemon's own guards) make repeated runs no-ops.
 * - No side effects beyond the row insert: no on-chain verification, no
 *   chair wake, no correction supersede (those stay live-daemon concerns).
 * - status='delivered': the artifact is verifiably on-chain, only the row was
 *   missing. confirmation stays 'unconfirmed' (honest — not re-verified).
 */
import type { GroupTaskStore } from '../groupTaskStore';
import { parseDeliverableLines } from './groupTaskDeliverableParser';

export function backfillMultiLineDeliverables(store: GroupTaskStore): {
  tasksScanned: number;
  messagesScanned: number;
  inserted: number;
} {
  let messagesScanned = 0;
  let inserted = 0;
  const tasks = store.listTasks({ includeArchived: true });
  for (const task of tasks) {
    if (!task.groupId) continue;
    for (const message of store.listGroupChatMessagesWithDeliverableTag(task.groupId)) {
      messagesScanned += 1;
      if (!message.pinId) continue;
      for (const candidate of parseDeliverableLines(message.content ?? '')) {
        if (!candidate.valid || !candidate.uri) continue;
        if (store.findDeliverableByMsgPinAndUri(task.id, message.pinId, candidate.uri, candidate.kind)) {
          continue;
        }
        if (
          message.senderGlobalMetaId
          && store.findDeliverableByAuthorAndUri(task.id, message.senderGlobalMetaId, candidate.uri)
        ) {
          continue;
        }
        store.addDeliverable({
          taskId: task.id,
          msgPinId: message.pinId,
          authorGlobalmetaid: message.senderGlobalMetaId,
          kind: candidate.kind,
          uri: candidate.uri,
          status: 'delivered',
        });
        inserted += 1;
      }
    }
  }
  return { tasksScanned: tasks.length, messagesScanned, inserted };
}
