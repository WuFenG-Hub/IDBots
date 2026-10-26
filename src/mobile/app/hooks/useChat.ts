import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type {
  CoworkConfig,
  CoworkPermissionRequest,
  CoworkPermissionResult,
  CoworkSession,
} from '@/types/cowork';
import {
  CoworkSessionController,
  type CoworkActionResult,
  type CoworkResyncGuard,
  type CoworkResyncSnapshot,
  type CoworkSessionControllerSnapshot,
} from '@/services/coworkSessionController';
import {
  buildCoworkSessionStartOptions,
  resolveDefaultMetabotId,
} from '@/services/coworkSessionStart';
import { getMobileElectron, hasAppBridge } from '../appBridge';
import type { MockMetabot } from '../../bridge/types';
import { projectChatMessages } from '../chatProjection';
import { t } from '../../i18n';

export type { ChatMessageView } from '../chatProjection';

export interface ChatPermissionView {
  request: CoworkPermissionRequest;
  responding: boolean;
}

export interface ChatToolCallView {
  requestId: string;
  toolName: string;
  status: 'pending';
  input: Record<string, unknown>;
}

export type ChatTurnPhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'waiting_permission'
  | 'steering'
  | 'stopping'
  | 'completed'
  | 'error'
  | 'cancelled'
  | 'offline_unknown';

const EMPTY_SNAPSHOT: CoworkSessionControllerSnapshot = {
  states: new Map(),
  sessions: [],
  currentSessionId: null,
  attempts: [],
  drafts: {},
  actionErrors: {},
  streamErrors: {},
  respondingPermissionIds: new Set(),
  dismissedPermissionIds: new Set(),
  stoppingSessionIds: new Set(),
  uncertainSessionIds: new Set(),
  restoring: false,
  generation: 0,
  epoch: 0,
};

const QUOTA_ERROR_CODE = 'LLM_QUOTA_EXHAUSTED';

export type QuotaExhaustedKind = 'free' | 'purchased';

export interface QuotaExhaustedState {
  exhausted: boolean;
  kind: QuotaExhaustedKind | null;
}

const RELAY_QUOTA_CODE_PATTERN = /(free_quota_exhausted|quota_exhausted)/i;

export function quotaKindFromErrorText(text: unknown): QuotaExhaustedKind | null {
  const match = RELAY_QUOTA_CODE_PATTERN.exec(String(text ?? ''));
  if (!match) return null;
  return match[1].toLowerCase() === 'quota_exhausted' ? 'purchased' : 'free';
}

function isTerminalErrorRow(message: { type?: unknown; content?: unknown } | null | undefined): message is { type: 'system'; content: string } {
  return (
    message !== null
    && typeof message === 'object'
    && message.type === 'system'
    && typeof message.content === 'string'
    && message.content.startsWith('Error:')
  );
}

export function deriveQuotaExhaustedFromDetail(
  session: Pick<CoworkSession, 'status' | 'messages'> | null | undefined,
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

function createController(): CoworkSessionController | null {
  if (!hasAppBridge()) return null;
  let storage: Storage | null = null;
  try {
    storage = typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    storage = null;
  }
  return new CoworkSessionController({ electron: getMobileElectron(), storage });
}

export function useChat(bots: MockMetabot[] = []) {
  const [controller, setController] = useState<CoworkSessionController | null>(null);
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  const [metabotId, setMetabotId] = useState<number | null>(null);
  const [quotaDismissedSession, setQuotaDismissedSession] = useState<string | null>(null);
  const configRef = useRef<Pick<CoworkConfig, 'workingDirectory' | 'systemPrompt'> | null>(null);
  const restoreStartedRef = useRef(false);

  useEffect(() => {
    const instance = createController();
    setController(instance);
    return () => instance?.destroy();
  }, []);

  useEffect(() => {
    if (!controller) return undefined;
    const unsubscribe = controller.subscribe(refresh);
    return () => unsubscribe();
  }, [controller]);

  useEffect(() => {
    if (!controller) return;
    void getMobileElectron().cowork.getConfig().then((result) => {
      if (result?.success && result.config) configRef.current = result.config;
    }).catch(() => undefined);
  }, [controller]);

  useEffect(() => {
    setMetabotId((current) => resolveDefaultMetabotId(bots, current));
  }, [bots]);

  useEffect(() => {
    if (!controller || metabotId === null || restoreStartedRef.current) return;
    restoreStartedRef.current = true;
    void controller.restore(metabotId);
  }, [controller, metabotId]);

  const snapshot = controller?.getSnapshot() ?? EMPTY_SNAPSHOT;
  const sessionId = snapshot.currentSessionId;
  const state = sessionId ? snapshot.states.get(sessionId) : undefined;
  const messages = useMemo(() => projectChatMessages(state?.messages ?? []), [state?.messages]);
  const attempts = useMemo(
    () => snapshot.attempts.filter((attempt) => attempt.sessionId === sessionId),
    [snapshot.attempts, sessionId],
  );
  const pendingPermissions = state?.pendingPermissions ?? [];
  const permissionRequest = pendingPermissions.find(
    (request) => !snapshot.dismissedPermissionIds.has(request.requestId),
  );
  const permission: ChatPermissionView | null = permissionRequest
    ? {
        request: permissionRequest,
        responding: snapshot.respondingPermissionIds.has(permissionRequest.requestId),
      }
    : null;
  const toolCalls: ChatToolCallView[] = pendingPermissions.map((request) => ({
    requestId: request.requestId,
    toolName: request.toolName,
    status: 'pending',
    input: request.toolInput,
  }));

  const isStopping = sessionId ? snapshot.stoppingSessionIds.has(sessionId) : false;
  const isSending = attempts.some((attempt) => attempt.status === 'sending');
  const isStreaming = state?.status === 'running' || isStopping;
  const turnPhase: ChatTurnPhase = isStopping
    ? 'stopping'
    : attempts.some((attempt) => attempt.status === 'sending' && attempt.kind === 'start')
      ? 'starting'
      : attempts.some((attempt) => attempt.status === 'sending')
        ? 'steering'
        : sessionId && snapshot.uncertainSessionIds.has(sessionId)
          ? 'offline_unknown'
          : pendingPermissions.length > 0
            ? 'waiting_permission'
            : state?.status === 'running'
              ? 'running'
              : state?.status === 'error'
                ? 'error'
                : state?.status === 'stopped'
                  ? 'cancelled'
                  : state?.status === 'completed' || state?.status === 'idle'
                    ? 'completed'
                    : 'idle';

  const streamError = sessionId ? snapshot.streamErrors[sessionId] : undefined;
  const persistedQuota = deriveQuotaExhaustedFromDetail(state);
  const liveQuota: QuotaExhaustedState = state?.status === 'error' && streamError?.code === QUOTA_ERROR_CODE
    ? { exhausted: true, kind: quotaKindFromErrorText(streamError.text) ?? persistedQuota.kind ?? 'free' }
    : persistedQuota;
  const quotaExhausted = liveQuota.exhausted && quotaDismissedSession !== sessionId;
  const quotaKind = liveQuota.kind;

  useEffect(() => {
    setQuotaDismissedSession(null);
  }, [sessionId]);
  useEffect(() => {
    if (state?.status === 'running') setQuotaDismissedSession(null);
  }, [state?.status]);

  const send = useCallback(async (text: string): Promise<CoworkActionResult> => {
    if (!controller) return { status: 'failed', error: t('mobile.bridge.unavailableBody') };
    const trimmed = text.trim();
    if (!trimmed) return { status: 'failed', error: t('mobile.chat.emptyMessage') };
    if (!sessionId && metabotId === null) {
      return { status: 'failed', error: t('mobile.chat.twinUnavailable') };
    }
    const title = trimmed.split('\n')[0]!.slice(0, 50);
    const startOptions = metabotId === null
      ? { title }
      : buildCoworkSessionStartOptions({ metabotId, title, config: configRef.current });
    return controller.send(trimmed, startOptions);
  }, [controller, metabotId, sessionId]);

  const openSession = useCallback(async (id: string): Promise<void> => {
    await controller?.openSession(id);
  }, [controller]);

  const applyResync = useCallback((resync: CoworkResyncSnapshot): void => {
    controller?.applyResync(resync);
  }, [controller]);

  const beginResync = useCallback((): CoworkResyncGuard => (
    controller?.beginResync() ?? { generation: 0, epoch: 0, messageRevisions: {} }
  ), [controller]);

  const respondPermission = useCallback(async (result: CoworkPermissionResult): Promise<CoworkActionResult> => {
    if (!controller || !permissionRequest) {
      return { status: 'failed', error: t('mobile.chat.permissionUnavailable') };
    }
    return controller.respondPermission(permissionRequest.requestId, result);
  }, [controller, permissionRequest]);

  return {
    messages,
    sessions: snapshot.sessions,
    sessionId,
    sessionTitle: state?.title ?? null,
    metabotId,
    isStreaming,
    isSending,
    turnPhase,
    permission,
    pendingPermissionCount: pendingPermissions.length,
    toolCalls,
    quotaExhausted,
    quotaKind,
    draft: controller?.getDraft() ?? '',
    attempts,
    actionError: snapshot.actionErrors[sessionId ?? 'new']
      ?? attempts.slice().reverse().find((attempt) => attempt.error)?.error
      ?? null,
    restoring: snapshot.restoring,
    hasMoreHistory: state?.messageHistory?.hasMoreBefore === true,
    setMetabotId,
    setDraft: (text: string) => controller?.setDraft(text),
    reloadSessions: async (): Promise<void> => { await controller?.reloadSessions(); },
    openSession,
    newChat: () => controller?.newChat(),
    send,
    stop: async (): Promise<CoworkActionResult> => (
      controller?.stop() ?? { status: 'failed', error: t('mobile.bridge.unavailableBody') }
    ),
    respondPermission,
    dismissPermission: () => {
      if (permissionRequest) controller?.dismissPermission(permissionRequest.requestId);
    },
    reopenPermissions: () => controller?.reopenPermissions(),
    dismissQuota: () => setQuotaDismissedSession(sessionId),
    retrySubmission: async (submissionId: string) => (
      controller?.retrySubmission(submissionId) ?? { status: 'failed', error: t('mobile.bridge.unavailableBody') }
    ),
    reconcileSubmission: async (submissionId: string) => (
      controller?.reconcileSubmission(submissionId) ?? { status: 'failed', error: t('mobile.bridge.unavailableBody') }
    ),
    discardSubmission: (submissionId: string) => controller?.discardSubmission(submissionId),
    loadEarlierMessages: async (): Promise<boolean> => controller?.loadEarlierMessages() ?? false,
    applyResync,
    beginResync,
    getOpenSessionId: (): string | null => controller?.getOpenSessionId() ?? null,
    getStreamingMessage: (): { sessionId: string; messageId: string } | null => (
      controller?.getStreamingMessage() ?? null
    ),
  };
}
