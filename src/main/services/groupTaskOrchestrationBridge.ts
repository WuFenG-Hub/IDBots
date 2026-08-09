import type { Metabot } from '../types/metabot';
import {
  OrchestrationStore,
  type OrchestrationAttempt,
  type OrchestrationStep,
  type OrchestrationTask,
} from '../orchestrationStore';
import {
  GroupTaskStore,
  type GroupTask,
  type GroupTaskDeliverable,
  type GroupTaskStatusEventActor,
} from '../groupTaskStore';

export interface GroupTaskOrchestrationBridgeDeps {
  groupTaskStore: GroupTaskStore;
  orchestrationStore: OrchestrationStore;
  getMetabotById(id: number): Metabot | null;
}

export interface GroupTaskWorkerAttemptContext {
  task: OrchestrationTask;
  step: OrchestrationStep;
  attempt: OrchestrationAttempt;
  reused: boolean;
}

function sourceSessionId(groupTaskId: number): string {
  return `group-task:${groupTaskId}`;
}

function acceptanceCriteria(task: GroupTask): unknown[] {
  const text = task.acceptanceCriteria?.trim();
  return text ? [{ type: 'owner_defined', text }] : [];
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

export class GroupTaskOrchestrationBridge {
  constructor(private readonly deps: GroupTaskOrchestrationBridgeDeps) {}

  ensureCanonicalTask(taskOrId: GroupTask | number): OrchestrationTask {
    const groupTask = typeof taskOrId === 'number'
      ? this.deps.groupTaskStore.getTaskById(taskOrId)
      : taskOrId;
    if (!groupTask) throw new Error(`Group task ${taskOrId} not found`);

    if (groupTask.orchestrationTaskId) {
      const linked = this.deps.orchestrationStore.getTask(groupTask.orchestrationTaskId);
      if (!linked) {
        throw new Error(
          `Group task ${groupTask.id} references missing orchestration task ${groupTask.orchestrationTaskId}`,
        );
      }
      return linked;
    }

    const sourceId = sourceSessionId(groupTask.id);
    const existing = this.deps.orchestrationStore.getTaskBySourceSessionId(sourceId);
    if (existing) {
      this.deps.groupTaskStore.linkOrchestrationTask(groupTask.id, existing.id);
      return existing;
    }

    const twin = this.deps.getMetabotById(groupTask.chairMetabotId);
    if (!twin || twin.metabot_type !== 'twin' || !twin.enabled) {
      throw new Error(`Group task ${groupTask.id} chair is not the enabled local Twin Bot`);
    }
    const ownerGlobalMetaId = String(twin.boss_global_metaid ?? '').trim();
    if (!ownerGlobalMetaId) {
      throw new Error(`Group task ${groupTask.id} Twin has no owner GlobalMetaID binding`);
    }

    const canonical = this.deps.orchestrationStore.createTask({
      ownerIntent: groupTask.goal,
      enrichedGoal: groupTask.goal,
      acceptanceCriteria: acceptanceCriteria(groupTask),
      sourceSessionId: sourceId,
      twinMetabotId: twin.id,
      ownerGlobalMetaId,
    });
    this.deps.groupTaskStore.linkOrchestrationTask(groupTask.id, canonical.id);
    return canonical;
  }

  syncStatus(groupTaskId: number): OrchestrationTask {
    const groupTask = this.deps.groupTaskStore.getTaskById(groupTaskId);
    if (!groupTask) throw new Error(`Group task ${groupTaskId} not found`);
    let canonical = this.ensureCanonicalTask(groupTask);

    if (groupTask.status === 'cancelled') {
      return canonical.status === 'cancelled'
        ? canonical
        : this.deps.orchestrationStore.cancelTaskCascade(canonical.id);
    }
    if (groupTask.status === 'done') {
      return this.acceptGroupTask(groupTask.id).canonicalTask;
    }
    if (canonical.status === 'completed' || canonical.status === 'cancelled') return canonical;

    if (groupTask.status === 'executing' && canonical.status !== 'running') {
      canonical = this.deps.orchestrationStore.updateTaskStatus(canonical.id, 'running');
    } else if (groupTask.status === 'review' && canonical.status === 'running') {
      canonical = this.deps.orchestrationStore.updateTaskStatus(canonical.id, 'review');
    }
    return canonical;
  }

  beginWorkerAttempt(input: {
    groupTaskId: number;
    workerMetabotId: number;
    objective: string;
    sourceMessageKey: string;
  }): GroupTaskWorkerAttemptContext {
    const objective = input.objective.trim();
    if (!objective) throw new Error('Group Task Worker objective is required');
    const worker = this.deps.getMetabotById(input.workerMetabotId);
    if (!worker || worker.metabot_type !== 'worker' || !worker.enabled) {
      throw new Error(`MetaBot ${input.workerMetabotId} is not an enabled local Worker`);
    }
    let task = this.ensureCanonicalTask(input.groupTaskId);
    if (task.status === 'completed' || task.status === 'cancelled') {
      throw new Error(`Orchestration task ${task.id} is ${task.status}`);
    }
    if (task.status !== 'running') {
      task = this.deps.orchestrationStore.updateTaskStatus(task.id, 'running');
    }

    const idempotencyKey = [
      'group-task',
      input.groupTaskId,
      input.sourceMessageKey.trim(),
      'worker',
      worker.id,
    ].join(':');
    const existingAttempt = this.deps.orchestrationStore.getAttemptByIdempotencyKey(idempotencyKey);
    if (existingAttempt) {
      const existingStep = this.deps.orchestrationStore.getStep(existingAttempt.stepId);
      if (!existingStep || existingStep.taskId !== task.id) {
        throw new Error(`Orchestration evidence is inconsistent for attempt ${existingAttempt.id}`);
      }
      return { task, step: existingStep, attempt: existingAttempt, reused: true };
    }

    const steps = this.deps.orchestrationStore.listSteps(task.id);
    const step = this.deps.orchestrationStore.createStep({
      taskId: task.id,
      ordinal: steps.length + 1,
      title: `Worker assignment: ${worker.name.trim() || `bot-${worker.id}`}`,
      objective,
      acceptanceCriteria: task.acceptanceCriteria,
      assigneeMetabotId: worker.id,
      permissionScope: {
        source: 'group_task',
        workspace: 'read_write',
        network: 'worker_skills_only',
        publicOnChain: 'task_scoped',
      },
      status: 'queued',
    });
    const attempt = this.deps.orchestrationStore.createAttempt({
      stepId: step.id,
      idempotencyKey,
      workerMetabotId: worker.id,
      prompt: objective,
    });
    return { task, step: this.deps.orchestrationStore.getStep(step.id)!, attempt, reused: false };
  }

  markWorkerAttemptRunning(attemptId: string, workerSessionId: string): OrchestrationAttempt {
    let attempt = this.deps.orchestrationStore.getAttempt(attemptId);
    if (!attempt) throw new Error(`Orchestration attempt ${attemptId} not found`);
    const step = this.deps.orchestrationStore.getStep(attempt.stepId);
    if (!step) throw new Error(`Orchestration step ${attempt.stepId} not found`);
    if (step.status === 'queued') {
      this.deps.orchestrationStore.updateStepStatus(step.id, 'running', { activeAttemptId: attempt.id });
    }
    if (attempt.status === 'queued') {
      attempt = this.deps.orchestrationStore.updateAttempt(attempt.id, 'running', { workerSessionId });
    }
    return attempt;
  }

  completeWorkerAttempt(input: {
    attemptId: string;
    replyText: string;
    groupMessagePinId: string;
  }): OrchestrationAttempt {
    let attempt = this.deps.orchestrationStore.getAttempt(input.attemptId);
    if (!attempt) throw new Error(`Orchestration attempt ${input.attemptId} not found`);
    let step = this.deps.orchestrationStore.getStep(attempt.stepId);
    if (!step) throw new Error(`Orchestration step ${attempt.stepId} not found`);
    if (attempt.status === 'queued') {
      attempt = this.deps.orchestrationStore.updateAttempt(attempt.id, 'running');
    }
    if (step.status === 'queued') {
      step = this.deps.orchestrationStore.updateStepStatus(step.id, 'running', { activeAttemptId: attempt.id });
    }
    if (attempt.status === 'running') {
      attempt = this.deps.orchestrationStore.updateAttempt(attempt.id, 'completed', {
        result: {
          replyText: input.replyText.trim(),
          groupMessagePinId: input.groupMessagePinId.trim(),
          verified: false,
          deliverables: [],
        },
      });
    }
    if (step.status === 'running') {
      this.deps.orchestrationStore.updateStepStatus(step.id, 'waiting_input', {
        activeAttemptId: attempt.id,
        acceptedResult: attempt.result,
      });
    }
    return attempt;
  }

  failWorkerAttempt(attemptId: string, error: string): void {
    const attempt = this.deps.orchestrationStore.getAttempt(attemptId);
    if (!attempt) return;
    if (attempt.status === 'queued' || attempt.status === 'running') {
      this.deps.orchestrationStore.updateAttempt(attempt.id, 'failed', { error: error.trim() || 'WORKER_ATTEMPT_FAILED' });
    }
    const step = this.deps.orchestrationStore.getStep(attempt.stepId);
    if (step && (step.status === 'queued' || step.status === 'running')) {
      this.deps.orchestrationStore.updateStepStatus(step.id, 'failed', { activeAttemptId: attempt.id });
    }
  }

  recordDeliverable(input: {
    groupTaskId: number;
    deliverable: GroupTaskDeliverable;
    verificationNotes: string[];
  }): void {
    const groupTask = this.deps.groupTaskStore.getTaskById(input.groupTaskId);
    if (!groupTask) throw new Error(`Group task ${input.groupTaskId} not found`);
    const canonical = this.ensureCanonicalTask(groupTask);
    const author = this.deps.groupTaskStore.listMembers(groupTask.id).find((member) =>
      Boolean(member.globalmetaid)
      && member.globalmetaid!.toLowerCase() === String(input.deliverable.authorGlobalmetaid ?? '').toLowerCase(),
    );
    if (!author?.metabotId) return;
    const step = this.deps.orchestrationStore.listSteps(canonical.id)
      .slice()
      .reverse()
      .find((candidate) => candidate.assigneeMetabotId === author.metabotId && candidate.activeAttemptId);
    if (!step?.activeAttemptId) return;
    const attempt = this.deps.orchestrationStore.getAttempt(step.activeAttemptId);
    if (!attempt) return;

    const result = asObject(attempt.result);
    const previous = Array.isArray(result.deliverables) ? result.deliverables : [];
    const deliverableEvidence = {
      groupTaskDeliverableId: input.deliverable.id,
      msgPinId: input.deliverable.msgPinId,
      kind: input.deliverable.kind,
      uri: input.deliverable.uri,
      verificationNotes: input.verificationNotes,
      ownerAccepted: false,
    };
    const deliverables = previous.some((item) =>
      asObject(item).groupTaskDeliverableId === input.deliverable.id,
    ) ? previous : [...previous, deliverableEvidence];
    const merged = { ...result, deliverables, verified: false };
    this.deps.orchestrationStore.updateAttempt(attempt.id, attempt.status, { result: merged });
    this.deps.orchestrationStore.updateStepStatus(step.id, step.status, {
      activeAttemptId: attempt.id,
      acceptedResult: merged,
    });
  }

  /**
   * Auto-ignore noise steps: failed steps are typically noise (a mistaken worker
   * mention whose skill routing failed) that carries no real deliverable. When a
   * task enters review, demote them to completed with an `ignored` marker so they
   * neither block owner acceptance nor show up as real work. Safe to call at any
   * point; steps that already have a different status are left untouched.
   */
  ignoreFailedSteps(groupTaskId: number): number {
    const groupTask = this.deps.groupTaskStore.getTaskById(groupTaskId);
    if (!groupTask) throw new Error(`Group task ${groupTaskId} not found`);
    if (!groupTask.orchestrationTaskId) return 0;
    const steps = this.deps.orchestrationStore.listSteps(groupTask.orchestrationTaskId);
    let ignored = 0;
    for (const step of steps) {
      if (step.status !== 'failed') continue;
      this.deps.orchestrationStore.updateStepStatus(step.id, 'completed', {
        acceptedResult: {
          ignored: true,
          reason: 'noise step auto-ignored on review entry (no real deliverable)',
        },
      });
      ignored += 1;
    }
    return ignored;
  }

  /**
   * P1-5: latest canonical attempt state for one worker of one group task —
   * the "error/working" half of the member workStatus readout. 'running'
   * attempt => working; 'failed' attempt (recent) => error. `atMs` is the
   * attempt start (running) or finish (failed) timestamp.
   */
  getWorkerAttemptStatus(
    groupTaskId: number,
    workerMetabotId: number,
  ): { status: 'running' | 'failed' | null; atMs: number | null } {
    const groupTask = this.deps.groupTaskStore.getTaskById(groupTaskId);
    if (!groupTask?.orchestrationTaskId) return { status: null, atMs: null };
    const steps = this.deps.orchestrationStore.listSteps(groupTask.orchestrationTaskId)
      .filter((step) => step.assigneeMetabotId === workerMetabotId);
    let latest: { status: 'running' | 'failed'; atMs: number | null } | null = null;
    let latestQueuedMs = 0;
    for (const step of steps) {
      for (const attempt of this.deps.orchestrationStore.listAttempts(step.id)) {
        const queuedMs = Date.parse(attempt.queuedAt);
        if (!Number.isFinite(queuedMs) || queuedMs < latestQueuedMs) continue;
        latestQueuedMs = queuedMs;
        const atMsOf = (value: string | null): number | null => {
          const parsed = Date.parse(value ?? '');
          return Number.isFinite(parsed) ? parsed : null;
        };
        if (attempt.status === 'running') {
          latest = { status: 'running', atMs: atMsOf(attempt.startedAt) };
        } else if (attempt.status === 'failed') {
          latest = { status: 'failed', atMs: atMsOf(attempt.finishedAt) };
        } else {
          latest = null;
        }
      }
    }
    return latest ?? { status: null, atMs: null };
  }

  acceptGroupTask(
    groupTaskId: number,
    actor?: GroupTaskStatusEventActor,
  ): { groupTask: GroupTask; canonicalTask: OrchestrationTask } {
    const groupTask = this.deps.groupTaskStore.getTaskById(groupTaskId);
    if (!groupTask) throw new Error(`Group task ${groupTaskId} not found`);
    let canonical = this.ensureCanonicalTask(groupTask);
    if (canonical.status === 'cancelled') {
      throw new Error(`Orchestration task ${canonical.id} is cancelled`);
    }
    const steps = this.deps.orchestrationStore.listSteps(canonical.id);
    // Only ACTIVE steps (ready/queued/running/blocked) block acceptance; failed and
    // cancelled steps are noise (mistaken mentions, aborted turns) and never carry
    // a real deliverable, so they must not trap the task in review.
    const unfinished = steps.filter((step) =>
      ['ready', 'queued', 'running', 'blocked'].includes(step.status),
    );
    if (unfinished.length > 0) {
      throw new Error(`Group task ${groupTaskId} has unfinished canonical steps`);
    }
    if (steps.length > 0 && groupTask.status !== 'review' && groupTask.status !== 'done') {
      throw new Error(`Group task ${groupTaskId} must be in review before owner acceptance`);
    }
    for (const step of steps) {
      if (step.status !== 'waiting_input') continue;
      const accepted = { ...asObject(step.acceptedResult), ownerAccepted: true };
      if (step.activeAttemptId) {
        const attempt = this.deps.orchestrationStore.getAttempt(step.activeAttemptId);
        if (attempt) {
          this.deps.orchestrationStore.updateAttempt(attempt.id, attempt.status, {
            result: { ...asObject(attempt.result), ownerAccepted: true },
          });
        }
      }
      this.deps.orchestrationStore.updateStepStatus(step.id, 'completed', { acceptedResult: accepted });
    }
    for (const deliverable of this.deps.groupTaskStore.listDeliverables(groupTask.id)) {
      if (deliverable.status === 'pending') {
        this.deps.groupTaskStore.updateDeliverableStatus(deliverable.id, 'accepted');
      }
    }
    canonical = this.deps.orchestrationStore.getTask(canonical.id)!;
    if (canonical.status === 'running') {
      canonical = this.deps.orchestrationStore.updateTaskStatus(canonical.id, 'review');
    }
    if (canonical.status === 'planning' || canonical.status === 'review') {
      canonical = this.deps.orchestrationStore.updateTaskStatus(canonical.id, 'completed');
    }
    const closed = groupTask.status === 'done'
      ? groupTask
      : this.deps.groupTaskStore.updateTaskStatus(groupTask.id, 'done', { actor: actor ?? { kind: 'system' } });
    return { groupTask: closed, canonicalTask: canonical };
  }

  cancelGroupTask(
    groupTaskId: number,
    actor?: GroupTaskStatusEventActor,
  ): { groupTask: GroupTask; canonicalTask: OrchestrationTask } {
    const groupTask = this.deps.groupTaskStore.getTaskById(groupTaskId);
    if (!groupTask) throw new Error(`Group task ${groupTaskId} not found`);
    const canonical = this.ensureCanonicalTask(groupTask);
    const cancelledCanonical = canonical.status === 'cancelled'
      ? canonical
      : this.deps.orchestrationStore.cancelTaskCascade(canonical.id);
    const cancelledGroup = groupTask.status === 'cancelled'
      ? groupTask
      : this.deps.groupTaskStore.updateTaskStatus(groupTask.id, 'cancelled', { actor: actor ?? { kind: 'system' } });
    return { groupTask: cancelledGroup, canonicalTask: cancelledCanonical };
  }
}
