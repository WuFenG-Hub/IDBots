import { getMobileElectron } from '../appBridge';
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../../i18n';

/**
 * Chat demo backed by the mock bridge (REQ-E-8). Subscribes to the real
 * `cowork:stream:*` event surface and accumulates deltas token by token,
 * so it exercises the same wire protocol the desktop renderer consumes.
 */

export interface DemoChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface DemoPermissionRequest {
  requestId: string;
  toolName: string;
}

export interface UseMockChat {
  messages: DemoChatMessage[];
  isStreaming: boolean;
  permission: DemoPermissionRequest | null;
  quotaExhausted: boolean;
  send: (text: string) => Promise<void>;
  respondPermission: (allow: boolean) => Promise<void>;
  dismissQuota: () => void;
}

interface StreamCompletePayload {
  sessionId: string;
  claudeSessionId: string | null;
  metadata?: { errorCode?: string };
}

const QUOTA_ERROR_CODE = 'LLM_QUOTA_EXHAUSTED';

export function useMockChat(): UseMockChat {
  const [messages, setMessages] = useState<DemoChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [permission, setPermission] = useState<DemoPermissionRequest | null>(null);
  const [quotaExhausted, setQuotaExhausted] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const activeAssistantIdRef = useRef<string | null>(null);
  const submissionSeqRef = useRef(0);

  useEffect(() => {
    const cowork = getMobileElectron().cowork;
    const offMessage = cowork.onStreamMessage(({ message }: { message: { id: string } }) => {
      activeAssistantIdRef.current = message.id;
      setMessages((prev) => [...prev, { id: message.id, role: 'assistant', text: '' }]);
      setIsStreaming(true);
    });
    const offUpdate = cowork.onStreamMessageUpdate(
      (payload: { messageId: string; content?: string; delta?: string }) => {
        setMessages((prev) =>
          prev.map((msg) => {
            if (msg.id !== payload.messageId) return msg;
            const text = payload.content !== undefined ? payload.content : msg.text + (payload.delta ?? '');
            return { ...msg, text };
          }),
        );
      },
    );
    const offPermission = cowork.onStreamPermission(
      ({ request }: { request: { requestId: string; toolName: string } }) => {
        setPermission({ requestId: request.requestId, toolName: request.toolName });
      },
    );
    const offPermissionResolved = cowork.onStreamPermissionResolved(() => {
      setPermission(null);
    });
    const offComplete = cowork.onStreamComplete((payload: StreamCompletePayload) => {
      setIsStreaming(false);
      activeAssistantIdRef.current = null;
      if (payload.metadata?.errorCode === QUOTA_ERROR_CODE) {
        setQuotaExhausted(true);
      }
    });
    const offError = cowork.onStreamError(() => {
      setIsStreaming(false);
      activeAssistantIdRef.current = null;
    });
    return () => {
      offMessage();
      offUpdate();
      offPermission();
      offPermissionResolved();
      offComplete();
      offError();
    };
  }, []);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setMessages((prev) => [...prev, { id: `local-${Date.now()}-${++submissionSeqRef.current}`, role: 'user', text: trimmed }]);
    setQuotaExhausted(false);
    const cowork = getMobileElectron().cowork;
    if (!sessionIdRef.current) {
      const result = await cowork.startSession({ prompt: trimmed, title: t('mobile.demo.chatTitle') });
      if (result.success && result.session) {
        sessionIdRef.current = result.session.id;
      }
      return;
    }
    await cowork.submitInput({
      sessionId: sessionIdRef.current,
      submissionId: `sub-${++submissionSeqRef.current}`,
      text: trimmed,
    });
  }, []);

  const respondPermission = useCallback(async (allow: boolean) => {
    if (!permission) return;
    await getMobileElectron().cowork.respondToPermission({
      requestId: permission.requestId,
      result: allow ? { behavior: 'allow' } : { behavior: 'deny', message: 'denied in demo' },
    });
  }, [permission]);

  const dismissQuota = useCallback(() => setQuotaExhausted(false), []);

  return { messages, isStreaming, permission, quotaExhausted, send, respondPermission, dismissQuota };
}
