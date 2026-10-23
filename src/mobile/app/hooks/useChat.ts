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
  role: 'user' | 'assistant';
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

interface StreamCompletePayload {
  sessionId: string;
  claudeSessionId: string | null;
  metadata?: { errorCode?: string };
}

const QUOTA_ERROR_CODE = 'LLM_QUOTA_EXHAUSTED';

function detailToViews(session: CoworkSessionDetail): ChatMessageView[] {
  return session.messages
    .filter((message) => message.type === 'user' || message.type === 'assistant')
    .map((message) => ({
      id: message.id,
      role: message.type === 'user' ? 'user' : 'assistant',
      text: message.content ?? '',
      streaming: false,
    }));
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
      setMessages((prev) => [...prev, { id: message.id, role: 'assistant', text: '', streaming: true }]);
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
    const offComplete = cowork.onStreamComplete((payload: StreamCompletePayload) => {
      setIsStreaming(false);
      if (payload.metadata?.errorCode === QUOTA_ERROR_CODE) {
        setQuotaExhausted(true);
      }
      void reloadSessions();
    });
    const offError = cowork.onStreamError(() => {
      setIsStreaming(false);
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
    setQuotaExhausted(false);
  }, []);

  const newChat = useCallback(() => {
    sessionIdRef.current = null;
    setSessionId(null);
    setSessionTitle(null);
    setMessages([]);
    setIsStreaming(false);
    setQuotaExhausted(false);
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setQuotaExhausted(false);
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
