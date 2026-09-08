/**
 * Group-task mode (R1, OpenTeam chat-scenario adaptation 2026-09): every group
 * is born either 'task' (the classic dispatch-deliver-accept pipeline) or
 * 'chat' (a free-form conversation with no deliverable discipline). The mode
 * is declared once at group creation by the chair, persisted on group_tasks,
 * and carried through the OpenTeam invite envelope so the GUEST host applies
 * the same semantics. It is immutable for the life of the group — a mid-flight
 * switch would strand monitoring state and prompt contracts, so it is not
 * supported (a new group is the correct path when the nature of the work
 * changes).
 *
 * Unknown/absent values always normalize to 'task': legacy rows predate the
 * column and every envelope from an older inviter omits the field, so
 * 'task' is the backward-compatible default everywhere.
 */

export type GroupTaskMode = 'task' | 'chat';

/** Normalize any persisted/wire value to a GroupTaskMode; 'task' is the default. */
export function normalizeGroupTaskMode(value: unknown): GroupTaskMode {
  return value === 'chat' ? 'chat' : 'task';
}
