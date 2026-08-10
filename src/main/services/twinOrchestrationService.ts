import {
  runOrchestratorSkillTurn,
  SkillTurnTimeoutError,
  type RunOrchestratorSkillTurnParams,
} from './orchestratorCoworkBridge';
import { isNonAnswerAssistantReply } from '../libs/coworkAssistantReply';
import {
  collectWorkspaceCommits,
  formatWorkerEmptyHandoffError,
  hasSubstantiveActivity,
  summarizeSessionActivity,
  WORKER_EMPTY_HANDOFF,
  type CoworkSessionActivityMessage,
} from '../libs/coworkSessionActivity';
import type { CoworkRunner } from '../libs/coworkRunner';
import type { CoworkStore } from '../coworkStore';
import {
  authorizeTwinSession,
  type TwinWorkerDirectoryDeps,
} from './twinWorkerDirectoryService';
import {
  OrchestrationStore,
  type OrchestrationAttempt,
  type OrchestrationTask,
  type OrchestrationStep,
} from '../orchestrationStore';
import type { CoworkCrossSessionInsertResult } from './coworkCrossSession';
import type { Metabot } from '../types/metabot';

/**
 * Round-4 r6: cross-session notify seam. Defaults to the host CoworkRunner's
 * insertCrossSessionMessageAndQueue (insert + queue-to-continue); tests
 * inject a recording implementation.
 */
export type TwinOrchestrationInsertCrossSessionMessageFn = (input: {
  sourceSessionId: string;
  targetSessionId: string;
  message: string;
}) => CoworkCrossSessionInsertResult;

/** Minimal kv surface for the terminal-state notify guard (SqliteStore in main.ts). */
export interface TwinOrchestrationKvStore {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
  delete(key: string): void;
}

export interface DelegateLocalWorkerInput {
  workerMetabotId: number;
  objective: string;
  acceptanceCriteria?: unknown[];
  context?: string | null;
  permissionScope?: Record<string, unknown>;
  taskId?: string | null;
  stepId?: string | null;
  taskIntent?: string | null;
  idempotencyKey?: string | null;
}

export interface DelegateLocalWorkerResult {
  task: OrchestrationTask;
  step: OrchestrationStep;
  attempt: OrchestrationAttempt;
  replyText: string | null;
  reused: boolean;
}

export interface TwinTaskStatusResult {
  task: OrchestrationTask;
  steps: Array<OrchestrationStep & { attempts: OrchestrationAttempt[] }>;
}

export interface TwinOrchestrationServiceDeps {
  orchestrationStore: OrchestrationStore;
  coworkStore: CoworkStore;
  coworkRunner: CoworkRunner;
  directory: TwinWorkerDirectoryDeps;
  getMetabotById(id: number): Metabot | null;
  getWorkerWorkspace(metabotId: number): string;
  runWorkerTurn?: (params: RunOrchestratorSkillTurnParams) => Promise<string>;
  /**
   * Round-4 r6: worker-completion notification to the Twin. Defaults to the
   * host CoworkRunner's insertCrossSessionMessageAndQueue seam — the same
   * path the MCP idbots_session_insert_user_message tool takes — so the
   * inserted ORCH-NOTIFY message also queues the target Twin session to
   * continue (activate). The activation itself lives in the host process
   * (CoworkRunner's cross-session continuation drain → continueSession);
   * this service only calls into it. Tests inject a recording
   * implementation. Returns the insert result (never throws).
   */
  insertCrossSessionUserMessage?: TwinOrchestrationInsertCrossSessionMessageFn;
  /**
   * Round-4 r6: persistent idempotency guard for terminal-state notifications
   * (kv key `orch_notify:<taskId>:<status>`). Without it a process restart
   * between a notification and the guard write could double-notify.
   */
  kv?: TwinOrchestrationKvStore;
}

function jsonBlock(value: unknown): string {
  try { return JSON.stringify(value ?? {}, null, 2); } catch { return '{}'; }
}

function isSkillTurnTimeoutError(error: unknown): error is { sessionId: string; timeoutMs: number } {
  if (error instanceof SkillTurnTimeoutError) return true;
  return typeof error === 'object'
    && error !== null
    && (error as { name?: unknown }).name === 'SkillTurnTimeoutError'
    && typeof (error as { sessionId?: unknown }).sessionId === 'string';
}

function buildWorkerPrompt(input: DelegateLocalWorkerInput, task: OrchestrationTask, step: OrchestrationStep): string {
  return [
    '<twin_delegation>',
    `  <task_id>${task.id}</task_id>`,
    `  <step_id>${step.id}</step_id>`,
    '  <objective>',
    input.objective.trim(),
    '  </objective>',
    '  <acceptance_criteria>',
    jsonBlock(input.acceptanceCriteria ?? []),
    '  </acceptance_criteria>',
    input.context?.trim() ? `  <verified_context>\n${input.context.trim()}\n  </verified_context>` : null,
    '  <permission_scope>',
    jsonBlock(input.permissionScope ?? { workspace: 'read_write', network: 'read_only' }),
    '  </permission_scope>',
    '  <handoff_contract>',
    'Return a concise structured handoff with summary, deliverables, verification evidence, and blockers. Do not claim an external action succeeded without evidence.',
    'ALWAYS close the session with a plain-text handoff summary — what was done, evidence, and blockers — even when a step failed or the last tool call errored. Never end with an empty reply, a bare tool error, or a reasoning placeholder.',
    '  </handoff_contract>',
    '</twin_delegation>',
  ].filter((line): line is string => line != null).join('\n');
}

export class TwinOrchestrationService {
  private readonly runWorkerTurn: (params: RunOrchestratorSkillTurnParams) => Promise<string>;
  private readonly insertCrossSession: TwinOrchestrationInsertCrossSessionMessageFn;

  constructor(private readonly deps: TwinOrchestrationServiceDeps) {
    this.runWorkerTurn = deps.runWorkerTurn ?? ((params) => runOrchestratorSkillTurn(deps.coworkRunner, deps.coworkStore, params));
    this.insertCrossSession = deps.insertCrossSessionUserMessage
      // P1-5b: the default path goes through the host CoworkRunner's
      // insertCrossSessionMessageAndQueue — the same seam the MCP
      // idbots_session_insert_user_message tool uses — so the ORCH-NOTIFY
      // insert also queues the target Twin session to continue (drained via
      // continueSession once the target is not mid-turn). A bare
      // CoworkCrossSessionService.insertUserMessage (the old default) only
      // wrote the message into the store and never woke the Twin session up.
      // We return only the insert half; the queue outcome is best-effort and
      // intentionally does not affect the idempotency guard semantics.
      ?? ((input) => deps.coworkRunner.insertCrossSessionMessageAndQueue(input).insert);
  }

  /**
   * Round-4 r6: one short [ORCH-NOTIFY] status message into the Twin session
   * that delegated the task (task.sourceSessionId). Idempotent per terminal
   * state via kv `orch_notify:<taskId>:<completed|failed>`; the fixed prefix
   * + taskId lets the Twin's own context recognize it as a status update.
   * Never throws into the orchestration flow: any failure (missing session,
   * A2A target, kv absence) is logged and skipped.
   */
  private notifyTwinTerminalState(
    task: OrchestrationTask,
    attempt: OrchestrationAttempt,
    workerName: string,
    outcome: 'completed' | 'failed',
    detail?: string | null,
  ): void {
    try {
      const targetSessionId = (task.sourceSessionId ?? '').trim();
      const workerSessionId = (attempt.workerSessionId ?? '').trim();
      if (!targetSessionId) return; // no Twin session to notify
      const guardKey = `orch_notify:${task.id}:${outcome}`;
      if (this.deps.kv?.get<string>(guardKey) === '1') return; // one notify per terminal state
      if (!workerSessionId) return; // no worker session identity to attribute the message to
      const text = outcome === 'completed'
        ? `[ORCH-NOTIFY] worker ${workerName} 已完成 task ${task.id} → review，请验收`
        : `[ORCH-NOTIFY] worker ${workerName} 未完成 task ${task.id}：${(detail ?? '').trim() || 'WORKER_ATTEMPT_FAILED'}（failed）`;
      const result = this.insertCrossSession({
        sourceSessionId: workerSessionId,
        targetSessionId,
        message: text,
      });
      if ('code' in result) {
        // CoworkCrossSessionError (insert failed: missing session, A2A target…)
        console.warn(
          `[TwinOrchestration] Twin notification skipped (${result.code}): ${result.message}`,
        );
        return;
      }
      this.deps.kv?.set(guardKey, '1');
      console.log(`[TwinOrchestration] Twin notified (${task.id} → ${outcome}): ${text}`);
    } catch (error) {
      console.warn(
        `[TwinOrchestration] Twin notification failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private workerNameOf(metabotId: number): string {
    return this.deps.getMetabotById(metabotId)?.name?.trim() || `bot-${metabotId}`;
  }

  /**
   * 清单 #10 P-A: read the worker session's messages for substantive-activity
   * detection. Tolerant by design — a missing store method or a store error
   * yields [] so the EMPTY_HANDOFF judgment degrades to the old behavior.
   */
  private readSessionActivityMessages(sessionId: string | null): CoworkSessionActivityMessage[] {
    if (!sessionId) return [];
    try {
      const reader = this.deps.coworkStore as unknown as {
        getSessionMessagesPage?: (
          sid: string,
          opts?: { limit?: number },
        ) => { messages?: Array<{ type: string; content: string; metadata?: Record<string, unknown> | null }> } | null;
      };
      const page = reader.getSessionMessagesPage?.(sessionId, { limit: 100 });
      return (page?.messages ?? []).map((message) => ({
        type: message.type,
        content: String(message.content ?? ''),
        metadata: message.metadata ?? null,
      }));
    } catch (error) {
      console.warn(
        `[TwinOrchestration] Session activity read failed (${sessionId}): ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  /**
   * 清单 #10 P-A: build the EMPTY_HANDOFF error for a session whose final
   * reply was empty. When the session shows substantive activity (file edits,
   * commits, test evidence, tool/error counts, tail narration) the error
   * carries the WORKER_EMPTY_HANDOFF_WITH_ACTIVITY summary so the chair can
   * immediately recognize a false failure and reuse the output; a truly bare
   * session keeps the plain WORKER_EMPTY_HANDOFF.
   */
  private async buildEmptyHandoffError(attempt: OrchestrationAttempt, worker: Metabot): Promise<string> {
    // The attempt passed into executeAttempt is a pre-run snapshot (no worker
    // session identity yet); read the fresh record so activity detection and
    // git evidence see the session that actually ran.
    const freshAttempt = this.deps.orchestrationStore.getAttempt(attempt.id) ?? attempt;
    const summary = summarizeSessionActivity(this.readSessionActivityMessages(freshAttempt.workerSessionId));
    if (!hasSubstantiveActivity(summary)) return WORKER_EMPTY_HANDOFF;
    let workspaceCommits: string[] = [];
    try {
      workspaceCommits = await collectWorkspaceCommits(
        this.deps.getWorkerWorkspace(worker.id),
        freshAttempt.startedAt,
      );
    } catch (error) {
      console.warn(
        `[TwinOrchestration] Workspace commit read failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return formatWorkerEmptyHandoffError(summary, workspaceCommits);
  }

  private async executeAttempt(
    task: OrchestrationTask,
    step: OrchestrationStep,
    attempt: OrchestrationAttempt,
    worker: Metabot,
    input: DelegateLocalWorkerInput,
  ): Promise<void> {
    const prompt = buildWorkerPrompt(input, task, step);
    const attemptId = attempt.id;
    try {
      const replyText = await this.runWorkerTurn({
        systemPrompt: 'You are a persistent Worker Bot executing one delegated step for the owner Twin Bot. Use your own persona, memories, skills, wallet, and permissions. Do not broaden the permission scope or claim unverifiable completion.',
        userMessage: prompt,
        cwd: this.deps.getWorkerWorkspace(worker.id),
        metabotId: worker.id,
        activeSkillIds: worker.skills ?? [],
        disableRemoteServicesPrompt: true,
        autoApprove: false,
        disableMemoryUpdates: false,
        permissionMode: 'acceptEdits',
        sourceChannel: 'orchestrator',
        onSessionCreated: (sessionId) => {
          this.deps.orchestrationStore.updateStepStatus(step.id, 'running', { activeAttemptId: attempt.id });
          this.deps.orchestrationStore.updateAttempt(attempt.id, 'running', { workerSessionId: sessionId });
        },
        // Recovery hooks: when the skill-turn watchdog fires at 300s the worker
        // session keeps running inside CoworkRunner. These callbacks align the
        // attempt state with whatever the session eventually delivers — a late
        // completion corrects the attempt to completed; a late error/stop or a
        // silent recovery window settles it to failed.
        onLateCompletion: (late) => {
          void this.applyLateAttemptResult(task, step, attemptId, late.replyText).catch((error) => {
            console.warn(
              `[TwinOrchestration] Late completion settlement failed: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            );
          });
        },
        onLateTermination: (late) => {
          const error = late.reason === 'error'
            ? (late.message?.trim() || 'WORKER_ATTEMPT_FAILED')
            : 'WORKER_SESSION_STOPPED';
          this.settleTimedOutAttempt(attemptId, error);
        },
        onRecoveryExpired: () => {
          this.settleTimedOutAttempt(attemptId, 'SKILL_TURN_TIMEOUT_NO_RECOVERY');
        },
      });
      if (isNonAnswerAssistantReply(replyText ?? '')) {
        // 清单 #10 P-A: an empty final reply is only a bare EMPTY_HANDOFF when
        // the session shows no substantive activity; otherwise the error
        // carries the activity summary (commit/files/tests/toolCalls/errors/
        // lastError) so the chair can recognize the false failure and reuse
        // the produced work.
        throw new Error(await this.buildEmptyHandoffError(attempt, worker));
      }
      const result = { replyText: replyText.trim(), verified: false };
      this.deps.orchestrationStore.updateAttempt(attempt.id, 'completed', { result });
      this.deps.orchestrationStore.updateStepStatus(step.id, 'completed', { acceptedResult: result });
      this.deps.orchestrationStore.updateTaskStatus(task.id, 'review');
      // Round-4 r6: normal-completion terminal state → notify the Twin.
      this.notifyTwinTerminalState(
        task,
        this.deps.orchestrationStore.getAttempt(attempt.id) ?? attempt,
        worker.name,
        'completed',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isTimeout = isSkillTurnTimeoutError(error);
      const currentAttempt = this.deps.orchestrationStore.getAttempt(attempt.id);
      if (currentAttempt && ['queued', 'running'].includes(currentAttempt.status)) {
        if (isTimeout) {
          // Watchdog fired but the worker session is still alive: park the
          // attempt as timed_out (recoverable) instead of failed, so a late
          // completion can still correct it to completed.
          this.deps.orchestrationStore.updateAttempt(attempt.id, 'timed_out', { error: message });
        } else {
          this.deps.orchestrationStore.updateAttempt(attempt.id, 'failed', { error: message });
          // Round-4 r6: direct-failure terminal state → notify the Twin.
          this.notifyTwinTerminalState(
            task,
            this.deps.orchestrationStore.getAttempt(attempt.id) ?? currentAttempt,
            worker.name,
            'failed',
            message,
          );
        }
      }
      const currentStep = this.deps.orchestrationStore.getStep(step.id);
      if (currentStep && ['queued', 'running', 'waiting_input'].includes(currentStep.status) && !isTimeout) {
        this.deps.orchestrationStore.updateStepStatus(step.id, 'failed');
      }
      const currentTask = this.deps.orchestrationStore.getTask(task.id);
      if (currentTask?.status === 'running' && !isTimeout) {
        this.deps.orchestrationStore.updateTaskStatus(task.id, 'failed');
      }
      if (isTimeout) {
        console.warn(
          `[TwinOrchestration] Worker attempt ${attempt.id} timed out (${message}); session ${error.sessionId} still running — parked as timed_out, awaiting late completion or recovery expiry`
        );
      } else {
        console.warn(`[TwinOrchestration] Worker attempt ${attempt.id} failed: ${message}`);
      }
    }
  }

  /**
   * Late-completion recovery: the worker session finished after the skill-turn
   * watchdog fired. If the attempt is still awaiting its result and still owns
   * the step, correct the state to completed and move the task to review —
   * the same flow a normal completion takes. Attempts cancelled, reassigned or
   * already completed in the meantime are left untouched.
   */
  private async applyLateAttemptResult(task: OrchestrationTask, step: OrchestrationStep, attemptId: string, replyText: string): Promise<void> {
    const store = this.deps.orchestrationStore;
    const currentAttempt = store.getAttempt(attemptId);
    if (!currentAttempt || !['queued', 'running', 'timed_out'].includes(currentAttempt.status)) return;
    const currentStep = store.getStep(step.id);
    if (!currentStep || currentStep.activeAttemptId !== attemptId || !['queued', 'running'].includes(currentStep.status)) return;
    if (isNonAnswerAssistantReply(replyText ?? '')) {
      // 清单 #10 P-A (late-completion path): same activity-aware judgment as
      // executeAttempt — a late session that worked but ended empty fails with
      // the WITH_ACTIVITY summary instead of an opaque WORKER_EMPTY_HANDOFF.
      const worker = this.deps.getMetabotById(currentAttempt.workerMetabotId);
      const error = worker
        ? await this.buildEmptyHandoffError(currentAttempt, worker)
        : WORKER_EMPTY_HANDOFF;
      this.settleTimedOutAttempt(attemptId, error);
      return;
    }
    const result = { replyText: replyText.trim(), verified: false };
    // Clear the parked timeout error: the attempt completed with a real result.
    store.updateAttempt(attemptId, 'completed', { result, error: null });
    store.updateStepStatus(step.id, 'completed', { acceptedResult: result });
    const currentTask = store.getTask(task.id);
    if (currentTask && ['planning', 'running', 'review'].includes(currentTask.status)) {
      store.updateTaskStatus(task.id, 'review');
    }
    // Round-4 r6: late-completion terminal state → notify the Twin (kv guard
    // makes it idempotent even if the normal path already notified).
    this.notifyTwinTerminalState(
      currentTask ?? task,
      store.getAttempt(attemptId) ?? currentAttempt,
      this.workerNameOf(currentAttempt.workerMetabotId),
      'completed',
    );
  }

  /**
   * Late-termination / recovery-expiry settlement: the session ended without a
   * usable result (errored, stopped, or silent for the whole recovery window).
   * Only now is the attempt marked failed — matching "only mark failed when the
   * session truly produced no output".
   */
  private settleTimedOutAttempt(attemptId: string, error: string): void {
    const store = this.deps.orchestrationStore;
    const currentAttempt = store.getAttempt(attemptId);
    if (!currentAttempt || !['queued', 'running', 'timed_out'].includes(currentAttempt.status)) return;
    store.updateAttempt(attemptId, 'failed', { error });
    const currentStep = store.getStep(currentAttempt.stepId);
    if (currentStep && ['queued', 'running'].includes(currentStep.status) && currentStep.activeAttemptId === attemptId) {
      store.updateStepStatus(currentStep.id, 'failed');
    }
    const currentTask = store.getTaskForStep(currentAttempt.stepId);
    if (currentTask && currentTask.status === 'running') {
      store.updateTaskStatus(currentTask.id, 'failed');
    }
    // Round-4 r6: late-failure terminal state → notify the Twin with the reason.
    if (currentTask) {
      this.notifyTwinTerminalState(
        currentTask,
        store.getAttempt(attemptId) ?? currentAttempt,
        this.workerNameOf(currentAttempt.workerMetabotId),
        'failed',
        error,
      );
    }
  }

  async delegateLocalWorker(sourceSessionId: string, input: DelegateLocalWorkerInput): Promise<DelegateLocalWorkerResult> {
    const { twin, ownerGlobalMetaId } = authorizeTwinSession(sourceSessionId, this.deps.directory);
    const workerMetabotId = Math.trunc(Number(input.workerMetabotId));
    const worker = this.deps.getMetabotById(workerMetabotId);
    if (!worker || worker.metabot_type !== 'worker') {
      throw new Error('WORKER_NOT_FOUND_OR_NOT_SPECIALIST');
    }
    if (!worker.enabled) throw new Error('WORKER_DISABLED');
    const objective = String(input.objective ?? '').trim();
    if (!objective) throw new Error('WORKER_OBJECTIVE_REQUIRED');

    const requestedIdempotencyKey = String(input.idempotencyKey ?? '').trim();
    if (requestedIdempotencyKey) {
      const existingAttempt = this.deps.orchestrationStore.getAttemptByIdempotencyKey(requestedIdempotencyKey);
      if (existingAttempt) {
        const existingStep = this.deps.orchestrationStore.getStep(existingAttempt.stepId);
        const existingTask = existingStep ? this.deps.orchestrationStore.getTask(existingStep.taskId) : null;
        if (!existingStep || !existingTask) throw new Error('ORCHESTRATION_EVIDENCE_CORRUPT');
        if (existingTask.twinMetabotId !== twin.id || existingTask.ownerGlobalMetaId.toLowerCase() !== ownerGlobalMetaId.toLowerCase()) {
          throw new Error('ORCHESTRATION_TASK_OWNER_MISMATCH');
        }
        if (existingAttempt.workerMetabotId !== workerMetabotId) {
          throw new Error('ORCHESTRATION_ATTEMPT_ASSIGNEE_MISMATCH');
        }
        const previousResult = existingAttempt.result && typeof existingAttempt.result === 'object'
          ? (existingAttempt.result as { replyText?: unknown }).replyText
          : null;
        return {
          task: existingTask,
          step: existingStep,
          attempt: existingAttempt,
          replyText: typeof previousResult === 'string' ? previousResult : null,
          reused: true,
        };
      }
    }

    let task = input.taskId ? this.deps.orchestrationStore.getTask(input.taskId) : null;
    if (input.taskId && !task) throw new Error('ORCHESTRATION_TASK_NOT_FOUND');
    if (task && (task.twinMetabotId !== twin.id || task.ownerGlobalMetaId.toLowerCase() !== ownerGlobalMetaId.toLowerCase())) {
      throw new Error('ORCHESTRATION_TASK_OWNER_MISMATCH');
    }
    if (!task) {
      task = this.deps.orchestrationStore.createTask({
        ownerIntent: String(input.taskIntent ?? objective).trim(),
        enrichedGoal: String(input.taskIntent ?? objective).trim(),
        acceptanceCriteria: input.acceptanceCriteria ?? [],
        sourceSessionId,
        twinMetabotId: twin.id,
        ownerGlobalMetaId,
      });
    }

    let step = input.stepId ? this.deps.orchestrationStore.getStep(input.stepId) : null;
    if (input.stepId && (!step || step.taskId !== task.id)) throw new Error('ORCHESTRATION_STEP_NOT_FOUND');
    if (!step) {
      const existingSteps = this.deps.orchestrationStore.listSteps(task.id);
      step = this.deps.orchestrationStore.createStep({
        taskId: task.id,
        ordinal: existingSteps.length + 1,
        title: worker.name,
        objective,
        acceptanceCriteria: input.acceptanceCriteria ?? [],
        assigneeMetabotId: worker.id,
        permissionScope: input.permissionScope ?? { workspace: 'read_write', network: 'read_only' },
        status: 'ready',
      });
    } else if (step.assigneeMetabotId !== worker.id) {
      throw new Error('ORCHESTRATION_STEP_ASSIGNEE_MISMATCH');
    }

    const idempotencyKey = requestedIdempotencyKey || `${task.id}:${step.id}:${worker.id}:${Date.now()}`;

    if (task.status === 'planning' || task.status === 'review' || task.status === 'failed') {
      task = this.deps.orchestrationStore.updateTaskStatus(task.id, 'running');
    }
    if (step.status === 'failed' || step.status === 'completed') {
      step = this.deps.orchestrationStore.updateStepStatus(step.id, 'ready');
    }
    if (step.status === 'ready') {
      step = this.deps.orchestrationStore.updateStepStatus(step.id, 'queued');
    }
    const attempt = this.deps.orchestrationStore.createAttempt({
      stepId: step.id,
      idempotencyKey,
      workerMetabotId: worker.id,
      prompt: objective,
    });
    void this.executeAttempt(task, step, attempt, worker, input);
    return {
      task: this.deps.orchestrationStore.getTask(task.id)!,
      step: this.deps.orchestrationStore.getStep(step.id)!,
      attempt: this.deps.orchestrationStore.getAttempt(attempt.id)!,
      replyText: null,
      reused: false,
    };
  }

  getTaskStatus(sourceSessionId: string, taskId: string): TwinTaskStatusResult {
    const { twin, ownerGlobalMetaId } = authorizeTwinSession(sourceSessionId, this.deps.directory);
    const task = this.deps.orchestrationStore.getTask(taskId);
    if (!task) throw new Error('ORCHESTRATION_TASK_NOT_FOUND');
    if (task.twinMetabotId !== twin.id || task.ownerGlobalMetaId.toLowerCase() !== ownerGlobalMetaId.toLowerCase()) {
      throw new Error('ORCHESTRATION_TASK_OWNER_MISMATCH');
    }
    return {
      task,
      steps: this.deps.orchestrationStore.listSteps(task.id).map((step) => ({
        ...step,
        attempts: this.deps.orchestrationStore.listAttempts(step.id),
      })),
    };
  }

  cancelTask(sourceSessionId: string, taskId: string): OrchestrationTask {
    const status = this.getTaskStatus(sourceSessionId, taskId);
    return this.deps.orchestrationStore.cancelTaskCascade(status.task.id);
  }

  async reassignLocalWorker(sourceSessionId: string, input: {
    stepId: string;
    workerMetabotId: number;
    objective?: string;
    acceptanceCriteria?: unknown[];
    context?: string | null;
    permissionScope?: Record<string, unknown>;
    idempotencyKey?: string | null;
  }): Promise<DelegateLocalWorkerResult> {
    const status = this.getTaskStatus(sourceSessionId, this.deps.orchestrationStore.getTaskForStep(input.stepId)?.id ?? '');
    const step = status.steps.find((candidate) => candidate.id === input.stepId);
    if (!step) throw new Error('ORCHESTRATION_STEP_NOT_FOUND');
    const activeAttempt = step.attempts.find((attempt) => attempt.id === step.activeAttemptId);
    if (activeAttempt && ['queued', 'running', 'timed_out'].includes(activeAttempt.status)) {
      this.deps.orchestrationStore.updateAttempt(activeAttempt.id, 'cancelled', { error: 'REASSIGNED_TO_ANOTHER_WORKER' });
    }
    if (step.status !== 'ready') this.deps.orchestrationStore.updateStepStatus(step.id, 'ready', { activeAttemptId: null });
    this.deps.orchestrationStore.updateStepAssignee(step.id, Math.trunc(Number(input.workerMetabotId)));
    const updated = this.deps.orchestrationStore.getStep(step.id)!;
    return this.delegateLocalWorker(sourceSessionId, {
      workerMetabotId: input.workerMetabotId,
      objective: input.objective?.trim() || updated.objective,
      acceptanceCriteria: input.acceptanceCriteria ?? updated.acceptanceCriteria,
      context: input.context,
      permissionScope: input.permissionScope ?? (updated.permissionScope as Record<string, unknown>),
      taskId: updated.taskId,
      stepId: updated.id,
      idempotencyKey: input.idempotencyKey,
    });
  }
}
