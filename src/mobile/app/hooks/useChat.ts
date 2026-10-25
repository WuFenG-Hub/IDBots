import { useCallback, useEffect, useRef, useState } from 'react';
import { CoworkStreamReassembler } from '@/services/coworkStreamReassembly';
import type { CoworkSessionSummary, CoworkSessionDetail } from '../../bridge/types';
import { getMobileElectron, hasAppBridge } from '../appBridge';
import { t } from '../../i18n';
import type { ResyncSnapshot } from './useResync';

/**
 * Chat tab state (REQ-E-12): session list drawer, MetaBot switcher, live
 * streaming via the desktop reassembler, permission bottom sheet, tool-call
 * summary and the quota-exhausted card. Holds its state at the shell level so
 * tab switches do not tear down an in-flight stream.
 */

export interface ChatMessageView {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
  streaming: boolean;
}

export interface ChatPermissionView {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  resolved: 'approved' | 'denied' | null;
}

export interface ChatToolCallView {
  requestId: string;
  toolName: string;
  status: 'pending' | 'approved' | 'denied';
  input: Record<string, unknown>;
}

/**
 * Real `cowork:stream:error` frame (runner → main.ts wiring, REQ-A-25):
 * `metadata.errorCode` rides the ERROR frame for classifiable failures —
 * today 'LLM_QUOTA_EXHAUSTED' for both relay quota codes
 * (free_quota_exhausted / quota_exhausted). The mock bridge used to
 * simulate it on the completion frame; the tenant sends it here.
 */
interface StreamErrorPayload {
  sessionId: string;
  error: string;
  metadata?: { errorCode?: string };
}

const QUOTA_ERROR_CODE = 'LLM_QUOTA_EXHAUSTED';

/** Which relay allowance the failure burned: the free starter or the purchased pool. */
export type QuotaExhaustedKind = 'free' | 'purchased';

export interface QuotaExhaustedState {
  exhausted: boolean;
  kind: QuotaExhaustedKind | null;
}

// quota_exhausted is a substring of free_quota_exhausted, so the alternation
// order pins the more specific code first (same pin as the main-process
// extractRelayQuotaExhaustedCode in coworkAssistantReply.ts).
const RELAY_QUOTA_CODE_PATTERN = /(free_quota_exhausted|quota_exhausted)/i;

/** Reads the relay quota machine code out of an error text, if any. */
export function quotaKindFromErrorText(text: unknown): QuotaExhaustedKind | null {
  const match = RELAY_QUOTA_CODE_PATTERN.exec(String(text ?? ''));
  if (!match) return null;
  return match[1].toLowerCase() === 'quota_exhausted' ? 'purchased' : 'free';
}

/**
 * Terminal turn failures are persisted by the runner's handleError as
 * `Error: …` system rows; they are the only system messages the phone
 * renders (as the inline red notice). Every other system row stays
 * transcript-internal.
 */
function isTerminalErrorRow(message: { type?: unknown; content?: unknown } | null | undefined): message is { type: 'system'; content: string } {
  return (
    message !== null
    && typeof message === 'object'
    && message.type === 'system'
    && typeof message.content === 'string'
    && message.content.startsWith('Error:')
  );
}

/**
 * Quota-card state from a session detail (the reopen / reconnect-resync
 * path). Mirrors the desktop live-state rule (renderer quotaErrorBanner):
 * the card belongs to the CURRENT failure only — the session must sit in
 * status 'error' and its newest terminal error row must carry a relay
 * quota code. The next submitted turn flips the status to 'running',
 * which retires the card again; a different failure leaves the card to
 * that failure's own inline notice.
 */
export function deriveQuotaExhaustedFromDetail(
  session: Pick<CoworkSessionDetail, 'status' | 'messages'> | null | undefined,
): QuotaExhaustedState {
  if (!session || session.status !== 'error') return { exhausted: false, kind: null };
  const messages = Array.isArray(session.messages) ? session.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (isTerminalErrorRow(message)) {
      const kind = quotaKindFromErrorText(message.content);
      return { exhausted: kind !== null, kind };
    }
  }
  return { exhausted: false, kind: null };
}

function detailToViews(session: CoworkSessionDetail): ChatMessageView[] {
  const views: ChatMessageView[] = [];
  for (const message of session.messages) {
    if (message.type === 'user' || message.type === 'assistant') {
      views.push({
        id: message.id,
        role: message.type === 'user' ? 'user' : 'assistant',
        text: message.content ?? '',
        streaming: false,
      });
    } else if (isTerminalErrorRow(message)) {
      views.push({ id: message.id, role: 'error', text: message.content, streaming: false });
    }
  }
  return views;
}

/**
 * REQ-E-5: merges a freshly pulled session detail into the live message list
 * without duplicates. Server rows win by message id; a local optimistic user
 * message whose text the server now persisted (an offline send that actually
 * landed — its local id can never match the server id) is dropped as a
 * content duplicate; local messages the server does not know about yet stay.
 */
export function mergeResyncedMessages(
  existing: ChatMessageView[],
  detailMessages: ChatMessageView[],
): ChatMessageView[] {
  const detailIds = new Set(detailMessages.map((message) => message.id));
  const detailUserTexts = new Set(
    detailMessages.filter((message) => message.role === 'user').map((message) => message.text),
  );
  const unackedLocal = existing.filter(
    (message) =>
      message.id.startsWith('local-') && !detailIds.has(message.id) && !detailUserTexts.has(message.text),
  );
  const retained = existing.filter((message) => !message.id.startsWith('local-') && !detailIds.has(message.id));
  const merged = detailMessages.map((message) => {
    const prior = existing.find((entry) => entry.id === message.id);
    // Keep the event-driven streaming flag; the detail text wins when present.
    return prior ? { ...prior, text: message.text || prior.text } : message;
  });
  return [...unackedLocal, ...retained, ...merged];
}

export function useChat(): {
  messages: ChatMessageView[];
  sessions: CoworkSessionSummary[];
  sessionId: string | null;
  sessionTitle: string | null;
  metabotId: number | null;
  isStreaming: boolean;
  permission: ChatPermissionView | null;
  toolCalls: ChatToolCallView[];
  quotaExhausted: boolean;
  quotaKind: QuotaExhaustedKind | null;
  setMetabotId: (id: number | null) => void;
  reloadSessions: () => Promise<void>;
  openSession: (id: string) => Promise<void>;
  newChat: () => void;
  send: (text: string) => Promise<void>;
  stop: () => Promise<void>;
  respondPermission: (allow: boolean) => Promise<void>;
  dismissPermission: () => void;
  dismissQuota: () => void;
  /** REQ-E-5: consumes a reconnect-resync snapshot (steps 1–3 of useResync). */
  applyResync: (snapshot: ResyncSnapshot) => void;
  /** Fresh context getters for the resync trigger (ref-backed, never stale). */
  getOpenSessionId: () => string | null;
  getStreamingMessage: () => { sessionId: string; messageId: string } | null;
} {
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [sessions, setSessions] = useState<CoworkSessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  const [metabotId, setMetabotId] = useState<number | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [permission, setPermission] = useState<ChatPermissionView | null>(null);
  const [toolCalls, setToolCalls] = useState<ChatToolCallView[]>([]);
  const [quotaExhausted, setQuotaExhausted] = useState(false);
  const [quotaKind, setQuotaKind] = useState<QuotaExhaustedKind | null>(null);

  const reassemblerRef = useRef(new CoworkStreamReassembler());
  const sessionIdRef = useRef<string | null>(null);
  const messagesRef = useRef<ChatMessageView[]>([]);
  const localSeqRef = useRef(0);
  const permissionHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ref mirror for the resync trigger: subscriptions fire outside the render
  // cycle and must see the latest message list.
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const reloadSessions = useCallback(async () => {
    if (!hasAppBridge()) return;
    const result = await getMobileElectron().cowork.listSessions();
    if (result?.success && Array.isArray(result.sessions)) {
      setSessions(result.sessions);
    }
  }, []);

  useEffect(() => {
    if (!hasAppBridge()) return undefined;
    void reloadSessions();
    const cowork = getMobileElectron().cowork;

    const patchMessage = (messageId: string, text: string) => {
      setMessages((prev) => prev.map((msg) => (msg.id === messageId ? { ...msg, text } : msg)));
    };

    const offMessage = cowork.onStreamMessage(({ message }) => {
      if (message.type === 'system') {
        // System rows are one-shot: they arrive with their full content on
        // the message frame and the runner never streams into them. Only
        // terminal `Error: …` rows render (inline red notice); other system
        // notices stay transcript-internal on the phone.
        if (isTerminalErrorRow(message)) {
          setMessages((prev) => [...prev, { id: message.id, role: 'error', text: message.content, streaming: false }]);
        }
        return;
      }
      setMessages((prev) => [
        ...prev,
        {
          id: message.id,
          role: 'assistant',
          text: typeof message.content === 'string' ? message.content : '',
          streaming: true,
        },
      ]);
      setIsStreaming(true);
    });
    const offUpdate = cowork.onStreamMessageUpdate((payload) => {
      const result = reassemblerRef.current.apply(payload);
      if (result.kind === 'full' || result.kind === 'append') {
        patchMessage(result.messageId, result.text);
      } else if (result.kind === 'desync') {
        void (async () => {
          const live = await cowork.getStreamLiveContent({
            sessionId: result.sessionId,
            messageId: result.messageId,
          });
          const resolved = reassemblerRef.current.resolveResync(
            result.sessionId,
            result.messageId,
            live?.success ? (live.content ?? null) : null,
          );
          if (resolved.kind === 'full') patchMessage(resolved.messageId, resolved.text);
        })();
      }
    });
    const offPermission = cowork.onStreamPermission(({ request }) => {
      if (permissionHideTimerRef.current) clearTimeout(permissionHideTimerRef.current);
      setPermission({
        requestId: request.requestId,
        toolName: request.toolName,
        input: (request.toolInput as Record<string, unknown> | undefined) ?? {},
        resolved: null,
      });
      setToolCalls((prev) => [
        ...prev,
        {
          requestId: request.requestId,
          toolName: request.toolName,
          status: 'pending',
          input: (request.toolInput as Record<string, unknown> | undefined) ?? {},
        },
      ]);
    });
    const offPermissionResolved = cowork.onStreamPermissionResolved(({ requestId }) => {
      setPermission((prev) => {
        if (!prev || prev.requestId !== requestId) return prev;
        const resolved = prev.resolved ?? 'approved';
        return { ...prev, resolved };
      });
      setToolCalls((prev) =>
        prev.map((call) =>
          call.requestId === requestId ? { ...call, status: call.status === 'pending' ? 'approved' : call.status } : call,
        ),
      );
      // Keep the resolved state visible briefly, then free the sheet.
      permissionHideTimerRef.current = setTimeout(() => setPermission(null), 1400);
    });
    const offComplete = cowork.onStreamComplete(() => {
      setIsStreaming(false);
      void reloadSessions();
    });
    const offError = cowork.onStreamError((payload: StreamErrorPayload) => {
      setIsStreaming(false);
      // REQ-A-25: the quota death settles on the ERROR frame with
      // metadata.errorCode — the recharge card keys off it instead of
      // parsing the human-readable text. Only the open session's failure
      // may raise the card; background sessions (scheduled tasks, titles)
      // keep their errors internal.
      if (
        payload?.metadata?.errorCode === QUOTA_ERROR_CODE
        && payload.sessionId === sessionIdRef.current
      ) {
        setQuotaKind(quotaKindFromErrorText(payload.error) ?? 'free');
        setQuotaExhausted(true);
      }
    });

    return () => {
      offMessage();
      offUpdate();
      offPermission();
      offPermissionResolved();
      offComplete();
      offError();
      if (permissionHideTimerRef.current) clearTimeout(permissionHideTimerRef.current);
    };
  }, [reloadSessions]);

  const openSession = useCallback(async (id: string) => {
    const result = await getMobileElectron().cowork.getSession(id, { messageLimit: 200 });
    if (!result?.success || !result.session) return;
    sessionIdRef.current = id;
    setSessionId(id);
    setSessionTitle(result.session.title ?? null);
    setMessages(detailToViews(result.session));
    setIsStreaming(false);
    // Reopened errored sessions re-derive the quota card from the persisted
    // terminal error row, so the wall survives app restarts and session
    // switches (the live stream:error frame is transient).
    const quota = deriveQuotaExhaustedFromDetail(result.session);
    setQuotaExhausted(quota.exhausted);
    setQuotaKind(quota.kind);
  }, []);

  const newChat = useCallback(() => {
    sessionIdRef.current = null;
    setSessionId(null);
    setSessionTitle(null);
    setMessages([]);
    setIsStreaming(false);
    setQuotaExhausted(false);
    setQuotaKind(null);
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setQuotaExhausted(false);
      setQuotaKind(null);
      const cowork = getMobileElectron().cowork;
      const currentSessionId = sessionIdRef.current;
      // Append the user message BEFORE the invoke: the mock emits the
      // assistant's stream:message synchronously inside startSession's turn,
      // so a post-await overwrite would drop it.
      setMessages((prev) => [
        ...prev,
        { id: `local-${++localSeqRef.current}`, role: 'user', text: trimmed, streaming: false },
      ]);
      if (!currentSessionId) {
        const started = await cowork.startSession({
          prompt: trimmed,
          title: trimmed.slice(0, 40),
          metabotId: metabotId ?? null,
        });
        if (!started?.success || !started.session) return;
        sessionIdRef.current = started.session.id;
        setSessionId(started.session.id);
        setSessionTitle(started.session.title ?? null);
        void reloadSessions();
        return;
      }
      await cowork.submitInput({
        sessionId: currentSessionId,
        submissionId: `sub-${++localSeqRef.current}`,
        text: trimmed,
      });
    },
    [metabotId, reloadSessions],
  );

  const stop = useCallback(async () => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) return;
    await getMobileElectron().cowork.stopSession(currentSessionId);
    setIsStreaming(false);
    setMessages((prev) => prev.map((msg) => (msg.streaming ? { ...msg, streaming: false } : msg)));
  }, []);

  const respondPermission = useCallback(
    async (allow: boolean) => {
      if (!permission || permission.resolved) return;
      const requestId = permission.requestId;
      setPermission((prev) => (prev ? { ...prev, resolved: allow ? 'approved' : 'denied' } : prev));
      setToolCalls((prev) =>
        prev.map((call) => (call.requestId === requestId ? { ...call, status: allow ? 'approved' : 'denied' } : call)),
      );
      await getMobileElectron().cowork.respondToPermission({
        requestId,
        result: allow ? { behavior: 'allow' } : { behavior: 'deny', message: t('mobile.chat.permissionDenied') },
      });
    },
    [permission],
  );

  const dismissPermission = useCallback(() => {
    if (permissionHideTimerRef.current) clearTimeout(permissionHideTimerRef.current);
    setPermission(null);
  }, []);

  const dismissQuota = useCallback(() => setQuotaExhausted(false), []);

  const applyResync = useCallback(
    (snapshot: ResyncSnapshot) => {
      const currentSessionId = sessionIdRef.current;
      // Step 1: rebuild the transcript from the fresh session detail.
      if (snapshot.session && snapshot.session.id === currentSessionId) {
        setMessages((prev) => mergeResyncedMessages(prev, detailToViews(snapshot.session as CoworkSessionDetail)));
        setSessionTitle(snapshot.session.title ?? null);
        // The resync detail is authoritative for the quota card too: a turn
        // that died while the socket was down still shows the wall.
        const quota = deriveQuotaExhaustedFromDetail(snapshot.session as CoworkSessionDetail);
        setQuotaExhausted(quota.exhausted);
        setQuotaKind(quota.kind);
      }
      // Step 2: heal the in-flight stream through the reassembler.
      if (snapshot.liveContent && snapshot.liveContent.sessionId === currentSessionId) {
        const resolved = reassemblerRef.current.resolveResync(
          snapshot.liveContent.sessionId,
          snapshot.liveContent.messageId,
          snapshot.liveContent.content,
        );
        if (resolved.kind === 'full') {
          setMessages((prev) =>
            prev.map((msg) => (msg.id === resolved.messageId ? { ...msg, text: resolved.text } : msg)),
          );
        }
      }
      // Step 3: surface a permission request that survived the reconnect.
      const pending =
        snapshot.pendingPermissions.find((entry) => entry.sessionId === currentSessionId) ??
        snapshot.pendingPermissions[0];
      if (pending) {
        if (permissionHideTimerRef.current) clearTimeout(permissionHideTimerRef.current);
        setPermission((prev) =>
          prev && prev.requestId === pending.request.requestId
            ? prev
            : {
                requestId: pending.request.requestId,
                toolName: pending.request.toolName,
                input: pending.request.toolInput ?? {},
                resolved: null,
              },
        );
      }
      // The sessions drawer refreshes with the same resync.
      void reloadSessions();
    },
    [reloadSessions],
  );

  const getOpenSessionId = useCallback(() => sessionIdRef.current, []);

  const getStreamingMessage = useCallback(() => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) return null;
    const streaming = messagesRef.current.find((msg) => msg.streaming);
    return streaming ? { sessionId: currentSessionId, messageId: streaming.id } : null;
  }, []);

  return {
    messages,
    sessions,
    sessionId,
    sessionTitle,
    metabotId,
    isStreaming,
    permission,
    toolCalls,
    quotaExhausted,
    quotaKind,
    setMetabotId,
    reloadSessions,
    openSession,
    newChat,
    send,
    stop,
    respondPermission,
    dismissPermission,
    dismissQuota,
    applyResync,
    getOpenSessionId,
    getStreamingMessage,
  };
}
