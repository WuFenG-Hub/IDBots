/**
 * Bridge: run one orchestrator "skill turn" via CoworkRunner so the same
 * skill list + Read/Bash logic is used as in local Cowork (no duplicate prompts).
 */

import type { CoworkRunner } from '../libs/coworkRunner';
import type { CoworkStore } from '../coworkStore';
import { isNonAnswerAssistantReply } from '../libs/coworkAssistantReply';

const SKILL_TURN_TIMEOUT_MS = 300_000;
/**
 * How long the bridge keeps watching a session after the skill-turn watchdog
 * fires. The watchdog only detaches the caller's promise: the worker session
 * keeps running inside CoworkRunner and may legitimately deliver its result
 * hours later (a real delegation took ~8h). Late results are handed to
 * onLateCompletion so the attempt can be corrected to completed instead of
 * staying permanently failed. If the session neither completes nor terminates
 * within this window, recovery is abandoned via onRecoveryExpired.
 */
const SKILL_TURN_RECOVERY_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * Error the skill-turn promise rejects with when the watchdog fires. Carries
 * the sessionId so the caller can keep tracking the still-running session and
 * correct its attempt state when a late result eventually arrives.
 */
export class SkillTurnTimeoutError extends Error {
  readonly sessionId: string;
  readonly timeoutMs: number;

  constructor(sessionId: string, timeoutMs: number) {
    super(`Skill turn timed out after ${timeoutMs / 1000}s`);
    this.name = 'SkillTurnTimeoutError';
    this.sessionId = sessionId;
    this.timeoutMs = timeoutMs;
  }
}

export interface RunOrchestratorSkillTurnParams {
  systemPrompt: string;
  userMessage: string;
  cwd: string;
  /** MetaBot id for this group task; session will use its wallet env for skill scripts. */
  metabotId?: number;
  groupId?: string | null;
  triggerReason?: string;
  supervisorGlobalmetaid?: string | null;
  latestMessageSenderGlobalmetaid?: string | null;
  activeSkillIds?: string[];
  disableRemoteServicesPrompt?: boolean;
  sourceChannel?: 'metaweb_group' | 'metaweb_private' | 'orchestrator';
  /** Optional lifecycle hook used by durable orchestration before execution starts. */
  onSessionCreated?: (sessionId: string) => Promise<void> | void;
  /** Background delegation may opt into a bounded permission mode. */
  autoApprove?: boolean;
  disableMemoryUpdates?: boolean;
  permissionMode?: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';
  /** Overrides the skill-turn watchdog timeout (ms). Defaults to 300s. */
  skillTurnTimeoutMs?: number;
  /**
   * How long (ms) the bridge keeps watching the session after the watchdog
   * fires so a still-running worker session can deliver a late result.
   * Defaults to 12h. Only matters when the session outlives the watchdog.
   */
  lateCompletionTimeoutMs?: number;
  /** Called when the session completes after the watchdog fired (late result). */
  onLateCompletion?: (late: { sessionId: string; replyText: string }) => void | Promise<void>;
  /** Called when the session errors or is stopped after the watchdog fired. */
  onLateTermination?: (late: { sessionId: string; reason: 'error' | 'stopped'; message?: string }) => void | Promise<void>;
  /** Called when the recovery window expires without any terminal session event. */
  onRecoveryExpired?: (late: { sessionId: string }) => void | Promise<void>;
}

export interface RunExistingSessionSkillTurnParams {
  sessionId: string;
  systemPrompt: string;
  userMessage: string;
  cwd: string;
  activeSkillIds?: string[];
  disableRemoteServicesPrompt?: boolean;
  onSkillExecutionStart?: () => Promise<void> | void;
}

export interface RunExistingSessionSkillTurnResult {
  replyText: string;
  assistantMessageId: string | null;
}

/**
 * Extract the final usable assistant reply from a session's messages.
 *
 * A message counts as a usable final reply only when ALL of these hold:
 * - it is an assistant text message (not a persisted thinking block);
 * - it is not a known non-answer placeholder (e.g. DeepSeek's
 *   `[reasoning unavailable]` can be persisted as thinking content);
 * - it is not followed by any tool_use/tool_result — text emitted before
 *   more tool activity is an intermediate progress note, not the handoff.
 *
 * This prevents a worker session that ended with a reasoning-only turn (no
 * real text output) from being reported as a successful completion with
 * `[reasoning unavailable]` as its "reply".
 */
function extractFinalAssistantReply(
  messages: Array<{ id: string; type: string; content: string; metadata?: Record<string, unknown> }>
): { replyText: string; assistantMessageId: string | null } {
  let sawToolAfter = false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) continue;
    if (message.type === 'tool_use' || message.type === 'tool_result') {
      sawToolAfter = true;
      continue;
    }
    if (message.type !== 'assistant') continue;
    if (message.metadata?.privateChatSkillWaitNotice === true) continue;
    if (message.metadata?.isThinking === true) continue;
    const content = String(message.content ?? '');
    if (isNonAnswerAssistantReply(content)) continue;
    if (sawToolAfter) continue; // intermediate text, more tool activity followed
    return { replyText: content.trim(), assistantMessageId: message.id ?? null };
  }
  return { replyText: '', assistantMessageId: null };
}

/**
 * Run one skill turn using CoworkRunner: create a new session,
 * startSession with autoApprove, wait for 'complete', extract last assistant
 * content, keep session for UI visibility, return reply text.
 */
export function runOrchestratorSkillTurn(
  runner: CoworkRunner,
  store: CoworkStore,
  params: RunOrchestratorSkillTurnParams
): Promise<string> {
  const {
    systemPrompt,
    userMessage,
    cwd,
    metabotId,
    groupId,
    triggerReason,
    supervisorGlobalmetaid,
    latestMessageSenderGlobalmetaid,
    activeSkillIds = [],
    disableRemoteServicesPrompt = true,
    sourceChannel,
    onSessionCreated,
    autoApprove = true,
    disableMemoryUpdates = true,
    permissionMode = 'default',
  } = params;

  const now = Date.now();
  const normalizedGroupId = (groupId ?? '').trim();
  const sessionTitle = normalizedGroupId
    ? `Group-${normalizedGroupId.slice(0, 12)}-${now}`
    : `[Orchestrator] skill-turn-${now}`;
  const externalConversationId = normalizedGroupId
    ? `metaweb-group:${normalizedGroupId}:${now}`
    : `orchestrator:${now}`;

  const session = store.createSession(
    sessionTitle,
    cwd,
    systemPrompt,
    'local',
    activeSkillIds,
    metabotId ?? null
  );
  const sessionId = session.id;

  try {
    onSessionCreated?.(sessionId);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }

  if (normalizedGroupId && sourceChannel !== 'metaweb_private') {
    try {
      store.upsertConversationMapping({
        channel: 'metaweb_group',
        externalConversationId,
        metabotId: metabotId ?? null,
        coworkSessionId: sessionId,
      });
    } catch (error) {
      console.warn('[Orchestrator] Failed to upsert group conversation mapping:', error);
    }
  }

  const userMessageRecord = store.addMessage(sessionId, {
    type: 'user',
    content: userMessage,
    metadata: {
      sourceChannel: sourceChannel ?? (normalizedGroupId ? 'metaweb_group' : 'orchestrator'),
      externalConversationId,
      groupId: normalizedGroupId || undefined,
      skillIds: activeSkillIds,
      triggerReason,
      supervisorGlobalmetaid: supervisorGlobalmetaid ?? undefined,
      latestMessageSenderGlobalmetaid: latestMessageSenderGlobalmetaid ?? undefined,
    },
  });
  runner.emit('message', sessionId, userMessageRecord);

  const skillTurnTimeoutMs = params.skillTurnTimeoutMs ?? SKILL_TURN_TIMEOUT_MS;
  const lateCompletionTimeoutMs = params.lateCompletionTimeoutMs ?? SKILL_TURN_RECOVERY_WINDOW_MS;

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let recoveryActive = false;
    let recoveryWindowTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      runner.off('complete', onComplete);
      runner.off('error', onError);
      runner.off('stopped', onRecoveryStopped);
      if (timeoutId != null) clearTimeout(timeoutId);
      if (recoveryWindowTimer != null) clearTimeout(recoveryWindowTimer);
    };

    const finish = (result: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const fail = (err: string | Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        store.updateSession(sessionId, { status: 'error' });
      } catch (e) {
        console.warn('[Orchestrator] Failed to mark session error:', e);
      }
      reject(typeof err === 'string' ? new Error(err) : err);
    };

    const extractLastAssistantContent = (): string => {
      const messages = store.getSession(sessionId)?.messages ?? [];
      return extractFinalAssistantReply(messages).replyText;
    };

    const reportLateCompletion = (replyText: string) => {
      cleanup();
      if (!params.onLateCompletion) return;
      const report = () => params.onLateCompletion!({ sessionId, replyText });
      try {
        void Promise.resolve(report()).catch((error) => {
          console.warn('[Orchestrator] Late skill-turn completion callback failed:', error instanceof Error ? error.message : String(error));
        });
      } catch (error) {
        console.warn('[Orchestrator] Late skill-turn completion callback failed:', error instanceof Error ? error.message : String(error));
      }
    };

    const reportLateTermination = (reason: 'error' | 'stopped', message?: string) => {
      cleanup();
      if (!params.onLateTermination) return;
      const report = () => params.onLateTermination!({ sessionId, reason, message });
      try {
        void Promise.resolve(report()).catch((error) => {
          console.warn('[Orchestrator] Late skill-turn termination callback failed:', error instanceof Error ? error.message : String(error));
        });
      } catch (error) {
        console.warn('[Orchestrator] Late skill-turn termination callback failed:', error instanceof Error ? error.message : String(error));
      }
    };

    const reportRecoveryExpired = () => {
      cleanup();
      if (!params.onRecoveryExpired) return;
      const report = () => params.onRecoveryExpired!({ sessionId });
      try {
        void Promise.resolve(report()).catch((error) => {
          console.warn('[Orchestrator] Skill-turn recovery expiry callback failed:', error instanceof Error ? error.message : String(error));
        });
      } catch (error) {
        console.warn('[Orchestrator] Skill-turn recovery expiry callback failed:', error instanceof Error ? error.message : String(error));
      }
    };

    const onComplete = (sid: string) => {
      if (sid !== sessionId) return;
      const lastAssistantContent = extractLastAssistantContent();
      if (recoveryActive) {
        // Watchdog already fired: the session finished late. Hand the result to
        // the recovery callback so the attempt can be corrected to completed.
        reportLateCompletion(lastAssistantContent || '');
        return;
      }
      finish(lastAssistantContent || '');
    };

    const onError = (sid: string, errorMessage: string) => {
      if (sid !== sessionId) return;
      if (recoveryActive) {
        reportLateTermination('error', errorMessage);
        return;
      }
      fail(errorMessage);
    };

    const onRecoveryStopped = (sid: string) => {
      if (sid !== sessionId || !recoveryActive) return;
      reportLateTermination('stopped');
    };

    const enterRecovery = () => {
      recoveryActive = true;
      // Keep listening for a late 'complete'/'error' — the worker session is
      // still alive inside CoworkRunner and its eventual result is recoverable.
      runner.on('stopped', onRecoveryStopped);
      recoveryWindowTimer = setTimeout(() => {
        recoveryWindowTimer = null;
        reportRecoveryExpired();
      }, lateCompletionTimeoutMs);
    };

    let timeoutId: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timeoutId = null;
      if (settled) return;
      // The caller's promise gives up at the watchdog, but the session itself
      // is NOT stopped and keeps running. Park the turn in recovery mode
      // instead of failing the session: a late completion must still be able
      // to correct the attempt state (see onLateCompletion).
      settled = true;
      enterRecovery();
      reject(new SkillTurnTimeoutError(sessionId, skillTurnTimeoutMs));
    }, skillTurnTimeoutMs);

    runner.on('complete', onComplete);
    runner.on('error', onError);

    runner
      .startSession(sessionId, userMessage, {
        skipInitialUserMessage: true,
        skillIds: activeSkillIds,
        systemPrompt,
        autoApprove,
        disableMemoryUpdates,
        disableRemoteServicesPrompt,
        permissionMode,
        confirmationMode: 'text',
        workspaceRoot: cwd,
      })
      .catch((err) => {
        console.error('[Orchestrator] [Bridge] startSession rejected:', err instanceof Error ? err.message : String(err));
        if (!settled) fail(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

/**
 * Run one skill turn inside an existing session. This is used by ordinary
 * private chat so tool_use/tool_result/assistant output stays in the current
 * A2A window instead of opening a separate "[Orchestrator] skill-turn" session.
 */
export function runSkillTurnInExistingSession(
  runner: CoworkRunner,
  store: CoworkStore,
  params: RunExistingSessionSkillTurnParams
): Promise<RunExistingSessionSkillTurnResult> {
  const {
    sessionId,
    systemPrompt,
    userMessage,
    cwd,
    activeSkillIds = [],
    disableRemoteServicesPrompt = true,
  } = params;

  const session = store.getSession(sessionId);
  if (!session) {
    return Promise.reject(new Error(`Skill turn session ${sessionId} not found`));
  }

  return new Promise<RunExistingSessionSkillTurnResult>((resolve, reject) => {
    let settled = false;
    let skillExecutionStartPromise: Promise<void> | null = null;
    const cleanup = () => {
      runner.off('complete', onComplete);
      runner.off('error', onError);
      runner.off('message', onMessage);
      runner.off('stopped', onStopped);
      if (timeoutId != null) clearTimeout(timeoutId);
    };

    const finish = (result: RunExistingSessionSkillTurnResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const fail = (err: string | Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        store.updateSession(sessionId, { status: 'error' });
      } catch (e) {
        console.warn('[Orchestrator] Failed to mark existing skill session error:', e);
      }
      reject(typeof err === 'string' ? new Error(err) : err);
    };

    const cancelWithoutSessionError = (err: string | Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(typeof err === 'string' ? new Error(err) : err);
    };

    const triggerSkillExecutionStart = () => {
      if (skillExecutionStartPromise || !params.onSkillExecutionStart) return;
      try {
        skillExecutionStartPromise = Promise.resolve(params.onSkillExecutionStart()).catch((error) => {
          console.warn(
            '[Orchestrator] Private chat skill wait notice callback failed:',
            error instanceof Error ? error.message : String(error)
          );
        });
      } catch (error) {
        skillExecutionStartPromise = Promise.resolve();
        console.warn(
          '[Orchestrator] Private chat skill wait notice callback failed:',
          error instanceof Error ? error.message : String(error)
        );
      }
    };

    const finishAfterSkillStartNotice = (result: RunExistingSessionSkillTurnResult) => {
      const waitForNotice = skillExecutionStartPromise;
      if (!waitForNotice) {
        finish(result);
        return;
      }
      waitForNotice.then(() => finish(result));
    };

    const onMessage = (sid: string, message: { type?: string } | null | undefined) => {
      if (sid !== sessionId || message?.type !== 'tool_use') return;
      triggerSkillExecutionStart();
    };

    const onComplete = (sid: string) => {
      if (sid !== sessionId) return;
      const sessionWithMessages = store.getSession(sessionId);
      const messages = sessionWithMessages?.messages ?? [];
      const { replyText, assistantMessageId } = extractFinalAssistantReply(messages);
      finishAfterSkillStartNotice({
        replyText,
        assistantMessageId,
      });
    };

    const onError = (sid: string, errorMessage: string) => {
      if (sid !== sessionId) return;
      fail(errorMessage);
    };

    const onStopped = (sid: string) => {
      if (sid !== sessionId) return;
      cancelWithoutSessionError('Private chat skill turn stopped before assistant output so queued A2A guidance can be applied');
    };

    let timeoutId: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timeoutId = null;
      fail(`Skill turn timed out after ${SKILL_TURN_TIMEOUT_MS / 1000}s`);
    }, SKILL_TURN_TIMEOUT_MS);

    runner.on('complete', onComplete);
    runner.on('error', onError);
    runner.on('message', onMessage);
    runner.on('stopped', onStopped);

    runner
      .startSession(sessionId, userMessage, {
        skipInitialUserMessage: true,
        skillIds: activeSkillIds,
        systemPrompt,
        autoApprove: true,
        disableMemoryUpdates: true,
        disableRemoteServicesPrompt,
        confirmationMode: 'text',
        workspaceRoot: cwd,
      })
      .catch((err) => {
        console.error('[Orchestrator] [Bridge] start existing session rejected:', err instanceof Error ? err.message : String(err));
        if (!settled) fail(err instanceof Error ? err : new Error(String(err)));
      });
  });
}
