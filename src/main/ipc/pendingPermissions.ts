/**
 * Pending tool-permission tracker for the `mobile:permission:listPending`
 * channel (REQ-A-24, C2 "Tool Permission Requests").
 *
 * The cowork runner owns the authoritative pending set (its `pendingPermissions`
 * map, with renderer overlay, text relay, auto-allow, watchdog, and abort
 * resolution paths). This module is an additive main-process mirror of the
 * requests that were broadcast to renderers, so a reconnecting mobile client
 * can list the prompts it missed. It is hooked at the existing raise/resolve
 * sites in main.ts next to the `cowork:stream:permission*` broadcasts:
 * record on raise, remove on resolve — including the implicit resolves that
 * session stop/abort/waitdog trigger inside the runner, which all funnel
 * through the runner's `permissionResolved` event.
 *
 * Pure module: no electron imports, loadable from plain node (tests drive the
 * tracker API directly).
 */

export interface PendingPermissionEntry {
  sessionId: string;
  request: unknown;
  createdAt: number;
}

/** Keyed by `request.requestId`; insertion order is the raise order. */
const pending = new Map<string, PendingPermissionEntry>();

/**
 * Record one broadcast permission request. Requests raised while the same
 * requestId is already tracked are refreshed in place (a re-raise replaces
 * the payload and timestamp); the runner never reuses a live requestId, this
 * only guards against duplicate event delivery.
 */
export function trackPendingPermission(sessionId: string, request: unknown): void {
  const requestId = (request as { requestId?: unknown } | null)?.requestId;
  if (typeof requestId !== 'string' || !requestId) return;
  pending.set(requestId, { sessionId, request, createdAt: Date.now() });
}

/** Drop one resolved/cancelled permission request (no-op when unknown). */
export function resolvePendingPermission(_sessionId: string, requestId: string): void {
  if (typeof requestId !== 'string' || !requestId) return;
  pending.delete(requestId);
}

/**
 * Drop every tracked request of a session. Not needed on the normal stop
 * path (the runner resolves each pending request individually, which emits
 * `permissionResolved` per request), but exposed as a safety sweep for
 * session-level cleanup hooks.
 */
export function clearPendingPermissionsForSession(sessionId: string): void {
  for (const [requestId, entry] of pending.entries()) {
    if (entry.sessionId === sessionId) pending.delete(requestId);
  }
}

/** Snapshot of the tracked pending requests, in raise order. */
export function listPendingPermissions(): PendingPermissionEntry[] {
  return [...pending.values()];
}

/** Test seam: reset the tracker between cases. */
export function resetPendingPermissionsForTests(): void {
  pending.clear();
}
