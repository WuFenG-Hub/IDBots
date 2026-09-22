import type { CoworkExecutionMode } from '../coworkStore';
import type { LongTermTaskStore } from '../longTermTaskStore';
import type { LongTermSubtask, LongTermTaskDetail } from '../../renderer/types/longTermTask';

/**
 * Long-term task advancement — the `longterm.advance` heartbeat handler
 * (redesign P1). The heartbeat calls `run()` on its own throttle (default
 * 5 min); everything here is a cheap LOCAL check until something is actually
 * actionable — only then does one escalation open/continue a bound `longterm`
 * cowork session and hand the TwinBot a turn.
 *
 * Actionable means one of:
 *  - the current sub-project is `pending` (begin) or `in_progress` (push);
 *  - a time-based external wait expired (`wait_until` passed);
 *  - an owner decision or untimed external wait has gone quiet for
 *    `ownerReminderMs` (a reminder is due).
 *
 * Discipline (owner ruling): driving completion outranks quiet — there is no
 * daily cap. The only throttle is "no new information, no new nudge": per
 * task, at most one escalation per `nudgeThrottleMs` UNLESS the event journal
 * moved or a timed wait expired. Sessions are created once per sub-project
 * and reused afterwards — never a session per heartbeat.
 */

export const LONGTERM_ADVANCE_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MAX_ESCALATIONS_PER_RUN = 2;
const DEFAULT_NUDGE_THROTTLE_MS = 30 * 60_000;
const DEFAULT_OWNER_REMINDER_MS = 4 * 3_600_000;

/** Minimal session-store shape (satisfied by CoworkStore). */
export interface LongTermAdvanceSessionStore {
  createSession(
    title: string,
    cwd: string,
    systemPrompt: string,
    executionMode: CoworkExecutionMode,
    activeSkillIds: string[],
    metabotId: number | null,
    sessionType: string,
  ): { id: string };
  updateSession(id: string, patch: { status?: string }): unknown;
  addMessage(id: string, message: { type: string; content: string }): unknown;
  getSession(id: string): unknown;
}

/** Minimal runner shape (satisfied by CoworkRunner). */
export interface LongTermAdvanceRunner {
  startSession(sessionId: string, prompt: string, options?: Record<string, unknown>): Promise<unknown>;
  /** Ground-truth "a turn is executing on this session" probe (skip re-firing). */
  isSessionActive?(sessionId: string): boolean;
}

export interface LongTermAdvanceDeps {
  store: () => LongTermTaskStore;
  coworkStore: () => LongTermAdvanceSessionStore;
  coworkRunner: () => LongTermAdvanceRunner;
  /** Resolve the enabled Twin bot id (null = none). */
  resolveTwinMetabotId: () => number | null;
  resolveWorkingDirectory: (metabotId: number | null) => string;
  getBaseSystemPrompt: () => string;
  getSkillsPrompt?: () => Promise<string | null>;
  emitLog?: (line: string) => void;
  maxEscalationsPerRun?: number;
  nudgeThrottleMs?: number;
  ownerReminderMs?: number;
}

export interface LongTermAdvanceReport {
  checkedTasks: number;
  escalated: Array<{ taskId: string; subtaskId: string; sessionId: string; reusedSession: boolean; reasons: string[] }>;
  skipped: Array<{ taskId: string; reason: string }>;
}

function buildNudgePrompt(detail: LongTermTaskDetail, current: LongTermSubtask, reasons: string[]): string {
  return [
    'You are the TwinBot driving the owner\'s long-term task. This turn was opened by the heartbeat (not by the owner) because the task looks advanceable.',
    '',
    `Task: "${detail.title}" (taskId: ${detail.id})`,
    `Current sub-project: #${current.ordinal} "${current.title}" (subtaskId: ${current.id})`,
    `Why this turn was opened: ${reasons.join('; ')}.`,
    '',
    'Required:',
    '1. Read the full state brief with longterm_task_get first — never push from memory.',
    '2. Then act per the longterm-task-exec discipline:',
    '   - If the sub-project can advance now, advance it (begin/continue via the agreed channel).',
    '   - If you need the owner, ask — exactly ONE question, multiple choice with your recommended option first; free-text answers always allowed.',
    '   - If blocked externally, record the wait with longterm_subtask_wait (precise note + waitUntil when known).',
    '   - If the deliverable verifiably meets every acceptance criterion, propose acceptance with evidence.',
    '3. Reply in the owner\'s language.',
  ].join('\n');
}

export class LongTermAdvanceService {
  private readonly deps: LongTermAdvanceDeps;
  private readonly maxEscalationsPerRun: number;
  private readonly nudgeThrottleMs: number;
  private readonly ownerReminderMs: number;
  private readonly emitLog: (line: string) => void;

  constructor(deps: LongTermAdvanceDeps) {
    this.deps = deps;
    this.maxEscalationsPerRun = Math.max(1, Math.trunc(deps.maxEscalationsPerRun ?? DEFAULT_MAX_ESCALATIONS_PER_RUN));
    this.nudgeThrottleMs = Math.max(60_000, Math.trunc(deps.nudgeThrottleMs ?? DEFAULT_NUDGE_THROTTLE_MS));
    this.ownerReminderMs = Math.max(3_600_000, Math.trunc(deps.ownerReminderMs ?? DEFAULT_OWNER_REMINDER_MS));
    this.emitLog = deps.emitLog ?? ((line: string) => console.log(line));
  }

  async run(nowMs: number = Date.now()): Promise<LongTermAdvanceReport> {
    const store = this.deps.store();
    const report: LongTermAdvanceReport = { checkedTasks: 0, escalated: [], skipped: [] };
    // Least-recently-active first: stale tasks get the push slot before busy ones.
    const activeCards = store
      .listBoard()
      .cards.filter((card) => card.stage === 'active')
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

    for (const card of activeCards) {
      if (report.escalated.length >= this.maxEscalationsPerRun) {
        report.skipped.push({ taskId: card.id, reason: 'run escalation budget reached' });
        continue;
      }
      report.checkedTasks += 1;
      const detail = store.getTask(card.id);
      if (!detail) continue;
      const current = detail.subtasks.find((sub) => sub.id === detail.currentSubtaskId) ?? null;
      if (!current) {
        report.skipped.push({ taskId: card.id, reason: 'no open sub-project' });
        continue;
      }
      const reasons = this.collectReasons(detail, current, nowMs);
      if (reasons.length === 0) {
        report.skipped.push({ taskId: card.id, reason: `current sub-project is ${current.status}, nothing due` });
        continue;
      }
      // Throttle: one escalation per task per window, unless the journal moved
      // (new information) or a timed wait expired (a clock condition, not noise).
      const latestEventId = detail.events[0]?.id ?? 0;
      const nudgeState = store.getNudgeState(card.id);
      const waitDue =
        current.status === 'waiting_external' &&
        current.waitUntil !== null &&
        Date.parse(current.waitUntil) <= nowMs;
      const throttled =
        nudgeState !== null &&
        nowMs - nudgeState.lastNudgeAtMs < this.nudgeThrottleMs &&
        latestEventId <= nudgeState.lastEventId;
      if (throttled && !waitDue) {
        report.skipped.push({ taskId: card.id, reason: 'nudge throttled (no new events since last escalation)' });
        continue;
      }
      // Never stack a second turn onto a session that is already executing one.
      if (current.sessionId && this.deps.coworkRunner().isSessionActive?.(current.sessionId)) {
        report.skipped.push({ taskId: card.id, reason: 'a turn is already running in the bound session' });
        continue;
      }
      try {
        const outcome = await this.escalate(detail, current, reasons);
        report.escalated.push({
          taskId: card.id,
          subtaskId: current.id,
          sessionId: outcome.sessionId,
          reusedSession: outcome.reusedSession,
          reasons,
        });
        // Store the journal position AFTER the nudge event itself, or the
        // nudge would count as "new events" and defeat the throttle next run.
        const postEventId = store.getTask(card.id)?.events[0]?.id ?? latestEventId;
        store.setNudgeState(card.id, { lastNudgeAtMs: nowMs, lastEventId: postEventId });
        this.emitLog(
          `[LongTermAdvance] escalated task "${detail.title}" sub-project #${current.ordinal} ` +
            `(${outcome.reusedSession ? 'continued' : 'opened'} session ${outcome.sessionId}): ${reasons.join('; ')}`,
        );
      } catch (error) {
        report.skipped.push({
          taskId: card.id,
          reason: `escalation failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        this.emitLog(
          `[LongTermAdvance] escalation failed for task ${card.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return report;
  }

  private collectReasons(detail: LongTermTaskDetail, current: LongTermSubtask, nowMs: number): string[] {
    const lastActivityAtMs = detail.events[0] ? Date.parse(detail.events[0].createdAt) : Date.parse(detail.updatedAt);
    const quietMs = nowMs - lastActivityAtMs;
    switch (current.status) {
      case 'pending':
        return ['current sub-project is pending and ready to begin'];
      case 'in_progress':
        // A fresh begin/work event means a turn just ran — only re-push once
        // the work has gone quiet for a full throttle window.
        if (quietMs > this.nudgeThrottleMs) {
          return ['current sub-project is in progress but has gone quiet — needs a push'];
        }
        return [];
      case 'waiting_external':
        if (current.waitUntil !== null && Date.parse(current.waitUntil) <= nowMs) {
          return [`timed wait expired — re-check the condition (${current.waitNote})`];
        }
        if (quietMs > this.ownerReminderMs) {
          return [`external wait has gone quiet for >${Math.round(this.ownerReminderMs / 3_600_000)}h — re-check (${current.waitNote})`];
        }
        return [];
      case 'waiting_owner':
        if (quietMs > this.ownerReminderMs) {
          return [`owner decision still pending for >${Math.round(this.ownerReminderMs / 3_600_000)}h (${current.waitNote})`];
        }
        return [];
      default:
        return [];
    }
  }

  /** Open (once) or continue (afterwards) the sub-project's bound session. */
  private async escalate(
    detail: LongTermTaskDetail,
    current: LongTermSubtask,
    reasons: string[],
  ): Promise<{ sessionId: string; reusedSession: boolean }> {
    const coworkStore = this.deps.coworkStore();
    const runner = this.deps.coworkRunner();
    const twinId = this.deps.resolveTwinMetabotId();
    const prompt = buildNudgePrompt(detail, current, reasons);

    let sessionId = current.sessionId ?? '';
    let reusedSession = false;
    if (sessionId && coworkStore.getSession(sessionId)) {
      reusedSession = true;
    } else {
      let skillsPrompt: string | null = null;
      if (this.deps.getSkillsPrompt) {
        try {
          skillsPrompt = await this.deps.getSkillsPrompt();
        } catch (error) {
          this.emitLog(`[LongTermAdvance] skills prompt unavailable (continuing without): ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const systemPrompt = [skillsPrompt, this.deps.getBaseSystemPrompt()].filter((part): part is string => Boolean(part?.trim())).join('\n\n');
      const session = coworkStore.createSession(
        `[长期] ${detail.title}`,
        this.deps.resolveWorkingDirectory(twinId),
        systemPrompt,
        'local',
        ['long-term-task-exec'],
        twinId,
        'longterm',
      );
      sessionId = session.id;
      this.deps.store().bindSession(current.id, sessionId, 'system');
    }

    coworkStore.updateSession(sessionId, { status: 'running' });
    coworkStore.addMessage(sessionId, { type: 'user', content: prompt });
    this.deps.store().recordNudge(detail.id, current.id, `heartbeat escalation (${reasons.join('; ')}) → session ${sessionId}`);
    await runner.startSession(sessionId, prompt, { skipInitialUserMessage: true, confirmationMode: 'text' });
    return { sessionId, reusedSession };
  }
}
