import {
  runOrchestratorSkillTurn,
  type RunOrchestratorSkillTurnParams,
} from './orchestratorCoworkBridge';
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
import type { Metabot } from '../types/metabot';

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
}

function jsonBlock(value: unknown): string {
  try { return JSON.stringify(value ?? {}, null, 2); } catch { return '{}'; }
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
    '  </handoff_contract>',
    '</twin_delegation>',
  ].filter((line): line is string => line != null).join('\n');
}

export class TwinOrchestrationService {
  private readonly runWorkerTurn: (params: RunOrchestratorSkillTurnParams) => Promise<string>;

  constructor(private readonly deps: TwinOrchestrationServiceDeps) {
    this.runWorkerTurn = deps.runWorkerTurn ?? ((params) => runOrchestratorSkillTurn(deps.coworkRunner, deps.coworkStore, params));
  }

  private async executeAttempt(
    task: OrchestrationTask,
    step: OrchestrationStep,
    attempt: OrchestrationAttempt,
    worker: Metabot,
    input: DelegateLocalWorkerInput,
  ): Promise<void> {
    const prompt = buildWorkerPrompt(input, task, step);
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
      });
      if (!replyText?.trim()) throw new Error('WORKER_EMPTY_HANDOFF');
      const result = { replyText: replyText.trim(), verified: false };
      this.deps.orchestrationStore.updateAttempt(attempt.id, 'completed', { result });
      this.deps.orchestrationStore.updateStepStatus(step.id, 'completed', { acceptedResult: result });
      this.deps.orchestrationStore.updateTaskStatus(task.id, 'review');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const currentAttempt = this.deps.orchestrationStore.getAttempt(attempt.id);
      if (currentAttempt && ['queued', 'running'].includes(currentAttempt.status)) {
        this.deps.orchestrationStore.updateAttempt(attempt.id, 'failed', { error: message });
      }
      const currentStep = this.deps.orchestrationStore.getStep(step.id);
      if (currentStep && ['queued', 'running', 'waiting_input'].includes(currentStep.status)) {
        this.deps.orchestrationStore.updateStepStatus(step.id, 'failed');
      }
      const currentTask = this.deps.orchestrationStore.getTask(task.id);
      if (currentTask?.status === 'running') this.deps.orchestrationStore.updateTaskStatus(task.id, 'failed');
      console.warn(`[TwinOrchestration] Worker attempt ${attempt.id} failed: ${message}`);
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
    if (activeAttempt && ['queued', 'running'].includes(activeAttempt.status)) {
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
