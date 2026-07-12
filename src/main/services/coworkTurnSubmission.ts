import type {
  CoworkMessage,
  CoworkMessageMetadata,
  CoworkSession,
} from '../coworkStore';

export type CoworkSubmitInput = {
  sessionId: string;
  submissionId: string;
  text: string;
  systemPrompt?: string;
  activeSkillIds?: string[];
};

export type CoworkSubmitInputErrorCode =
  | 'invalid_input'
  | 'session_not_found'
  | 'unsupported_session'
  | 'unsupported_execution'
  | 'delivery_failed';

export type CoworkSubmitInputResult =
  | {
      success: true;
      mode: 'steer' | 'continue';
      message: CoworkMessage;
    }
  | {
      success: false;
      error: string;
      code: CoworkSubmitInputErrorCode;
    };

type CoworkSubmitInputFailure = Extract<CoworkSubmitInputResult, { success: false }>;

type SteerCapability = 'open-local' | 'closing-local' | 'sandbox' | 'inactive';

interface SubmissionStore {
  getSession(sessionId: string): CoworkSession | null;
  getMessageById(sessionId: string, messageId: string): CoworkMessage | null;
  addMessageWithId(
    sessionId: string,
    messageId: string,
    message: Omit<CoworkMessage, 'id' | 'timestamp'>
  ): CoworkMessage;
  updateMessage(
    sessionId: string,
    messageId: string,
    updates: { content?: string; metadata?: CoworkMessageMetadata }
  ): void;
}

interface SubmissionRunner {
  getSteerCapability(sessionId: string): SteerCapability;
  trySubmitSteer(
    sessionId: string,
    submissionId: string,
    text: string
  ):
    | { accepted: true; delivered: Promise<void> }
    | { accepted: false; reason: 'inactive' | 'closing' | 'sandbox' };
  waitForActiveTurnSettlement(sessionId: string): Promise<void>;
  continueSession(
    sessionId: string,
    text: string,
    options?: { systemPrompt?: string; skillIds?: string[]; skipUserMessage?: boolean }
  ): Promise<void>;
  on?: {
    (event: 'steerSettled', listener: (sessionId: string, submissionId: string) => void): unknown;
    (event: 'steerFailed', listener: (sessionId: string, submissionId: string, reason: string) => void): unknown;
  };
}

export type CoworkTurnSubmissionDependencies = {
  store: SubmissionStore;
  runner: SubmissionRunner;
  emitMessage: (sessionId: string, message: CoworkMessage) => void;
  emitMessageUpdate: (
    sessionId: string,
    messageId: string,
    content: string,
    metadata: CoworkMessageMetadata
  ) => void;
};

const SUBMISSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function errorResult(code: CoworkSubmitInputErrorCode, error: string): CoworkSubmitInputFailure {
  return { success: false, code, error };
}

function validateStandardSession(session: CoworkSession | null): CoworkSubmitInputFailure | null {
  if (!session) {
    return errorResult('session_not_found', 'Cowork session not found');
  }
  if (session.sessionType === 'a2a') {
    return errorResult(
      'unsupported_session',
      'Runtime input submission is not supported for A2A sessions'
    );
  }
  return null;
}

function isCompletedSubmission(message: CoworkMessage): boolean {
  const metadata = message.metadata;
  if (metadata?.submissionResult !== 'completed') return false;
  if (metadata.submissionMode === 'continue') return true;
  return metadata.submissionMode === 'steer'
    && (metadata.steerStatus === 'delivered' || metadata.steerStatus === 'settled');
}

function resultFromExisting(message: CoworkMessage): CoworkSubmitInputResult {
  return {
    success: true,
    mode: message.metadata?.submissionMode === 'continue' ? 'continue' : 'steer',
    message,
  };
}

function toContinueMetadata(metadata: CoworkMessageMetadata | undefined): CoworkMessageMetadata {
  const {
    interactionKind: _interactionKind,
    steerStatus: _steerStatus,
    steerDeliveredAt: _steerDeliveredAt,
    steerSettledAt: _steerSettledAt,
    steerFailedAt: _steerFailedAt,
    steerErrorCode: _steerErrorCode,
    ...rest
  } = metadata ?? {};
  return {
    ...rest,
    submissionMode: 'continue',
    submissionResult: 'completed',
  };
}

export class CoworkTurnSubmissionController {
  private readonly store: SubmissionStore;
  private readonly runner: SubmissionRunner;
  private readonly emitMessage: CoworkTurnSubmissionDependencies['emitMessage'];
  private readonly emitMessageUpdate: CoworkTurnSubmissionDependencies['emitMessageUpdate'];

  constructor(dependencies: CoworkTurnSubmissionDependencies) {
    this.store = dependencies.store;
    this.runner = dependencies.runner;
    this.emitMessage = dependencies.emitMessage;
    this.emitMessageUpdate = dependencies.emitMessageUpdate;

    this.runner.on?.('steerSettled', (sessionId, submissionId) => {
      this.markSteerSettled(sessionId, submissionId);
    });
    this.runner.on?.('steerFailed', (sessionId, submissionId, reason) => {
      this.markSteerFailed(sessionId, submissionId, reason);
    });
  }

  async submit(input: CoworkSubmitInput): Promise<CoworkSubmitInputResult> {
    const sessionId = typeof input?.sessionId === 'string' ? input.sessionId.trim() : '';
    const submissionId = typeof input?.submissionId === 'string' ? input.submissionId.trim() : '';
    const requestedText = typeof input?.text === 'string' ? input.text.trim() : '';
    if (!sessionId || !SUBMISSION_ID_RE.test(submissionId) || !requestedText) {
      return errorResult('invalid_input', 'Session ID, submission UUID, and text are required');
    }

    const existing = this.store.getMessageById(sessionId, submissionId);
    if (existing && isCompletedSubmission(existing)) {
      return resultFromExisting(existing);
    }

    const initialSession = this.store.getSession(sessionId);
    const sessionError = validateStandardSession(initialSession);
    if (sessionError) return sessionError;

    // This synchronous capability -> persistence -> admission segment is the
    // authority for the steer/Continue race. Do not add an await inside it.
    const capability = this.runner.getSteerCapability(sessionId);
    if (capability === 'sandbox') {
      return errorResult(
        'unsupported_execution',
        'Runtime steer currently supports local execution only'
      );
    }

    const interactionKind = capability === 'open-local' || capability === 'closing-local'
      ? 'steer'
      : undefined;
    const message = existing ?? this.store.addMessageWithId(sessionId, submissionId, {
      type: 'user',
      content: requestedText,
      metadata: interactionKind
        ? {
            interactionKind,
            submissionId,
            submissionMode: 'steer',
            submissionResult: 'pending',
            steerStatus: 'queued',
          }
        : {
            submissionId,
            submissionMode: 'continue',
            submissionResult: 'pending',
          },
    });
    if (!existing) {
      this.emitMessage(sessionId, message);
    } else if (message.metadata?.submissionResult !== 'pending') {
      const retryMetadata: CoworkMessageMetadata = interactionKind
        ? {
            ...message.metadata,
            interactionKind,
            submissionMode: 'steer',
            submissionResult: 'pending',
            steerStatus: 'queued',
            steerErrorCode: undefined,
            steerFailedAt: undefined,
          }
        : {
            ...toContinueMetadata(message.metadata),
            submissionResult: 'pending',
          };
      this.persistAndEmit(sessionId, message, retryMetadata);
    }

    // An idempotency retry keeps the originally persisted visible text.
    const text = message.content;
    if (capability === 'open-local') {
      const admission = this.runner.trySubmitSteer(sessionId, submissionId, text);
      if (admission.accepted) {
        try {
          await admission.delivered;
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'Steer delivery failed';
          this.markSteerFailed(sessionId, submissionId, reason);
          return errorResult('delivery_failed', reason);
        }

        const delivered = this.store.getMessageById(sessionId, submissionId) ?? message;
        if (delivered.metadata?.steerStatus === 'failed') {
          return errorResult(
            'delivery_failed',
            String(delivered.metadata.steerFailureReason || 'Steer delivery failed')
          );
        }
        if (delivered.metadata?.steerStatus === 'settled') {
          return { success: true, mode: 'steer', message: delivered };
        }
        const deliveredMetadata: CoworkMessageMetadata = {
          ...delivered.metadata,
          interactionKind: 'steer',
          submissionId,
          submissionMode: 'steer',
          submissionResult: 'completed',
          steerStatus: 'delivered',
          steerDeliveredAt: Date.now(),
        };
        this.persistAndEmit(sessionId, delivered, deliveredMetadata);
        return {
          success: true,
          mode: 'steer',
          message: this.store.getMessageById(sessionId, submissionId) ?? delivered,
        };
      }
      await this.runner.waitForActiveTurnSettlement(sessionId);
    } else if (capability === 'closing-local') {
      await this.runner.waitForActiveTurnSettlement(sessionId);
    }

    const currentSession = this.store.getSession(sessionId);
    const currentSessionError = validateStandardSession(currentSession);
    if (currentSessionError) {
      this.markSubmissionFailed(sessionId, message, currentSessionError.code, currentSessionError.error);
      return currentSessionError;
    }

    try {
      await this.runner.continueSession(sessionId, text, {
        skipUserMessage: true,
        systemPrompt: input.systemPrompt,
        skillIds: input.activeSkillIds,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Failed to continue Cowork session';
      this.markSubmissionFailed(sessionId, message, 'delivery_failed', reason);
      return errorResult('delivery_failed', reason);
    }

    const continued = this.store.getMessageById(sessionId, submissionId) ?? message;
    const continuedMetadata = toContinueMetadata(continued.metadata);
    this.persistAndEmit(sessionId, continued, continuedMetadata);
    return {
      success: true,
      mode: 'continue',
      message: this.store.getMessageById(sessionId, submissionId) ?? continued,
    };
  }

  private markSteerSettled(sessionId: string, submissionId: string): void {
    const message = this.store.getMessageById(sessionId, submissionId);
    if (!message || message.metadata?.interactionKind !== 'steer') return;
    if (message.metadata.steerStatus === 'failed' || message.metadata.steerStatus === 'cancelled') return;
    const metadata: CoworkMessageMetadata = {
      ...message.metadata,
      submissionMode: 'steer',
      submissionResult: 'completed',
      steerStatus: 'settled',
      steerSettledAt: Date.now(),
    };
    this.persistAndEmit(sessionId, message, metadata);
  }

  private markSteerFailed(sessionId: string, submissionId: string, reason: string): void {
    const message = this.store.getMessageById(sessionId, submissionId);
    if (!message || message.metadata?.interactionKind !== 'steer') return;
    if (message.metadata.steerStatus === 'settled') return;
    const metadata: CoworkMessageMetadata = {
      ...message.metadata,
      submissionMode: 'steer',
      submissionResult: 'failed',
      steerStatus: 'failed',
      steerFailedAt: Date.now(),
      steerErrorCode: 'delivery_failed',
      steerFailureReason: reason,
    };
    this.persistAndEmit(sessionId, message, metadata);
  }

  private markSubmissionFailed(
    sessionId: string,
    message: CoworkMessage,
    code: CoworkSubmitInputErrorCode,
    reason: string
  ): void {
    const current = this.store.getMessageById(sessionId, message.id) ?? message;
    const metadata: CoworkMessageMetadata = {
      ...current.metadata,
      submissionResult: 'failed',
      submissionErrorCode: code,
      submissionFailureReason: reason,
    };
    this.persistAndEmit(sessionId, current, metadata);
  }

  private persistAndEmit(
    sessionId: string,
    message: CoworkMessage,
    metadata: CoworkMessageMetadata
  ): void {
    this.store.updateMessage(sessionId, message.id, { metadata });
    message.metadata = metadata;
    this.emitMessageUpdate(sessionId, message.id, message.content, metadata);
  }
}
