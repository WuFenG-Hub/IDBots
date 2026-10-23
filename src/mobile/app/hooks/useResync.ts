import { useEffect, useRef, useState } from 'react';
import type { CoworkSessionDetail, PendingPermissionRequest } from '../../bridge/types';
import type { MockElectronAPI } from '../../bridge/types';
import { getAppBridge, getMobileElectron, hasAppBridge } from '../appBridge';

/**
 * Reconnect resync (REQ-E-5). On every gateway (re)connect the client may
 * have missed stream events, permission requests, or list mutations while the
 * socket was down, so the shell re-pulls the hot state in a fixed C2-ordered
 * sequence before bumping a counter the screens' hooks depend on:
 *
 *   1. `cowork.getSession` for the open session (rebuilds the transcript)
 *   2. `cowork.getStreamLiveContent` for any in-flight stream (heals the
 *      delta the reassembler may have desynced on)
 *   3. `mobile.listPendingPermissions` (surfaces a permission request that
 *      arrived while offline)
 *   4. bump `resyncCounter` → tasks/meters/me hooks refresh their lists
 *
 * The trigger differs per bridge: the real gateway fires `onReconnected` on
 * every successful connect (first included); the mock bridge's connection
 * bus only signals transitions back to `online`.
 */

export interface ResyncSnapshot {
  /** Step 1: fresh detail of the open session, null when none is open. */
  session: CoworkSessionDetail | null;
  /** Step 2: live text of the in-flight stream, null when idle. */
  liveContent: { sessionId: string; messageId: string; content: string } | null;
  /** Step 3: permission requests still waiting for a decision. */
  pendingPermissions: PendingPermissionRequest[];
}

/** Fresh (non-stale) chat context, supplied by the shell via useChat refs. */
export interface ResyncContextSource {
  getOpenSessionId: () => string | null;
  getStreamingMessage: () => { sessionId: string; messageId: string } | null;
}

/**
 * The ordered resync sequence itself, exported for tests: a fake electron
 * records the invoke order. Each step tolerates individual failures (the
 * socket may drop again mid-resync) so one bad invoke never aborts the rest.
 */
export async function performResync(
  electron: Pick<MockElectronAPI, 'cowork' | 'mobile'>,
  context: ResyncContextSource,
): Promise<ResyncSnapshot> {
  // Step 1: open-session transcript.
  let session: CoworkSessionDetail | null = null;
  const sessionId = context.getOpenSessionId();
  if (sessionId) {
    try {
      const result = await electron.cowork.getSession(sessionId, { messageLimit: 200 });
      if (result?.success && result.session) {
        session = result.session as CoworkSessionDetail;
      }
    } catch {
      // Still offline or session gone: leave the current transcript as-is.
    }
  }

  // Step 2: in-flight stream live content.
  let liveContent: ResyncSnapshot['liveContent'] = null;
  const streaming = context.getStreamingMessage();
  if (streaming) {
    try {
      const live = await electron.cowork.getStreamLiveContent(streaming);
      if (live?.success && typeof live.content === 'string') {
        liveContent = { ...streaming, content: live.content };
      }
    } catch {
      // A missed live-content pull heals on the next stream event instead.
    }
  }

  // Step 3: pending permission requests.
  let pendingPermissions: PendingPermissionRequest[] = [];
  try {
    const pending = await electron.mobile.listPendingPermissions();
    if (Array.isArray(pending)) {
      pendingPermissions = pending as PendingPermissionRequest[];
    }
  } catch {
    // Permission surfacing is best-effort; the next resync retries.
  }

  return { session, liveContent, pendingPermissions };
}

/**
 * Subscribes to whichever bridge is active and runs the resync sequence on
 * every (re)connect. `onSnapshot` (useChat.applyResync) consumes steps 1–3
 * for the open chat; the returned counter (step 4) is the dependency the
 * tasks/meters/me hooks use to refresh their lists.
 */
export function useResync(
  context: ResyncContextSource,
  onSnapshot: (snapshot: ResyncSnapshot) => void,
): number {
  const [resyncCounter, setResyncCounter] = useState(0);
  // Latest-ref pattern: the shell passes fresh closures every render and the
  // long-lived subscription must always call the current ones.
  const contextRef = useRef(context);
  const onSnapshotRef = useRef(onSnapshot);
  contextRef.current = context;
  onSnapshotRef.current = onSnapshot;
  const runningRef = useRef(false);
  const runAgainRef = useRef(false);

  useEffect(() => {
    if (!hasAppBridge()) return undefined;
    const bridge = getAppBridge();
    let disposed = false;

    const run = async (): Promise<void> => {
      if (runningRef.current) {
        // A resync is already in flight (reconnect storm): schedule one more.
        runAgainRef.current = true;
        return;
      }
      runningRef.current = true;
      try {
        const snapshot = await performResync(getMobileElectron(), contextRef.current);
        if (disposed) return;
        onSnapshotRef.current(snapshot);
        // Step 4: list refresh for the screens' hooks.
        setResyncCounter((counter) => counter + 1);
      } finally {
        runningRef.current = false;
        if (runAgainRef.current && !disposed) {
          runAgainRef.current = false;
          void run();
        }
      }
    };

    if (bridge.gateway) {
      const off = bridge.gateway.onReconnected(() => void run());
      return () => {
        disposed = true;
        off();
      };
    }

    // Mock bridge: only a transition back to online from a non-online state
    // counts as a reconnect (the initial 'online' fires no event).
    let previous = bridge.connection.getState();
    const off = bridge.connection.onChange((state) => {
      const wasNonOnline = previous !== 'online';
      previous = state;
      if (state === 'online' && wasNonOnline) {
        void run();
      }
    });
    return () => {
      disposed = true;
      off();
    };
  }, []);

  return resyncCounter;
}
