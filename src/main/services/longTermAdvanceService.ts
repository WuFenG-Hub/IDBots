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
const DEFAULT_WAITING_OWNER_REMINDER_MS = 30 * 60_000;
const DEFAULT_EXTERNAL_REMINDER_MS = 4 * 3_600_000;

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
  /** Owner's UI language ('zh' | 'en') — the nudge prompt follows it. */
  getAppLanguage?: () => string;
  emitLog?: (line: string) => void;
  maxEscalationsPerRun?: number;
  nudgeThrottleMs?: number;
  /** Quiet time before reminding on an owner decision (default 30 min — a
   *  fresh proposal should reach the owner fast). */
  waitingOwnerReminderMs?: number;
  /** Quiet time before re-checking an untimed external wait (default 4h). */
  externalReminderMs?: number;
}

export interface LongTermAdvanceReport {
  checkedTasks: number;
  escalated: Array<{ taskId: string; subtaskId: string; sessionId: string; reusedSession: boolean; reasons: string[] }>;
  skipped: Array<{ taskId: string; reason: string }>;
}

function buildNudgePrompt(detail: LongTermTaskDetail, current: LongTermSubtask, reasons: string[], language: string): string {
  const criteria = current.acceptanceCriteria.length > 0
    ? current.acceptanceCriteria.map((criterion, index) => `   ${index + 1}. ${criterion}`).join('\n')
    : '   (no acceptance criteria on file — align them with the owner before pushing)';
  if (language === 'zh') {
    return [
      '你是正在为主人推进长期任务的 TwinBot。这个回合由心跳自动开启（不是主人发起的），因为任务看起来可以继续推进。',
      '',
      `任务：「${detail.title}」（taskId: ${detail.id}）`,
      `目标（done-ness 定义）：${detail.goal}`,
      `当前子项目：#${current.ordinal}「${current.title}」（subtaskId: ${current.id}）`,
      '该子项目的验收标准：',
      criteria,
      `开启原因：${reasons.join('；')}。`,
      '',
      '要求：',
      '1. 先用 longterm_task_get 读取完整状态简报——不要凭记忆推进。',
      '2. 先用 2–3 句话向主人复述你对该子项目的理解（它要达成什么、验收看什么），再继续——锚定不对就停下来问，不要带着错误理解开工。',
      '3. 然后按 longterm-task-exec 的纪律行动：',
      '   - 如果现在能推进，就推进（begin/继续，走约定好的通道）。',
      '   - 若需委派：先用 longterm_delegation_anchor 生成锚点块并原样放进委派简报——委派不带锚点就是有损中继，worker 会按"合理"而非"正确"去做。',
      '   - 如果下一步要引入目标或事件流里没有的假设、基建或配置（新配置面、新通道、新依赖），先停下来问主人——这是提问，不是你可以自行拍板的事。',
      '   - 如果需要主人决策，就问他——恰好一个问题，选择题形式、你的推荐项放最前；始终允许他用文字给出自己的答案。',
      '   - 如果被外部条件卡住，用 longterm_subtask_wait 记录等待（精确的备注 + 知道日期就写 waitUntil）。',
      '   - 如果交付物可验证地满足全部验收标准，带上证据提请验收。',
      '4. 用主人的语言回复。',
    ].join('\n');
  }
  return [
    'You are the TwinBot driving the owner\'s long-term task. This turn was opened by the heartbeat (not by the owner) because the task looks advanceable.',
    '',
    `Task: "${detail.title}" (taskId: ${detail.id})`,
    `Goal (done-ness definition): ${detail.goal}`,
    `Current sub-project: #${current.ordinal} "${current.title}" (subtaskId: ${current.id})`,
    'Its acceptance criteria:',
    criteria,
    `Why this turn was opened: ${reasons.join('; ')}.`,
    '',
    'Required:',
    '1. Read the full state brief with longterm_task_get first — never push from memory.',
    '2. Restate your understanding of this sub-project to the owner in 2-3 sentences (what it must achieve, what acceptance looks like) before continuing — if the anchor is wrong, stop and ask; never build on a misunderstood requirement.',
    '3. Then act per the longterm-task-exec discipline:',
    '   - If the sub-project can advance now, advance it (begin/continue via the agreed channel).',
    '   - If you delegate: first build the anchor with longterm_delegation_anchor and paste it into the delegation brief verbatim — a delegation without the anchor is a lossy relay, and the worker will build the plausible thing instead of the right thing.',
    '   - If the next step introduces any assumption, infrastructure, or config not present in the goal or the journal (a new config surface, channel, or dependency), stop and ask the owner first — that is a question, never your call alone.',
    '   - If you need the owner, ask — exactly ONE question, multiple choice with your recommended option first; free-text answers always allowed.',
    '   - If blocked externally, record the wait with longterm_subtask_wait (precise note + waitUntil when known).',
    '   - If the deliverable verifiably meets every acceptance criterion, propose acceptance with evidence.',
    '4. Reply in the owner\'s language.',
  ].join('\n');
}

export class LongTermAdvanceService {
  private readonly deps: LongTermAdvanceDeps;
  private readonly maxEscalationsPerRun: number;
  private readonly nudgeThrottleMs: number;
  private readonly waitingOwnerReminderMs: number;
  private readonly externalReminderMs: number;
  private readonly emitLog: (line: string) => void;

  constructor(deps: LongTermAdvanceDeps) {
    this.deps = deps;
    this.maxEscalationsPerRun = Math.max(1, Math.trunc(deps.maxEscalationsPerRun ?? DEFAULT_MAX_ESCALATIONS_PER_RUN));
    this.nudgeThrottleMs = Math.max(60_000, Math.trunc(deps.nudgeThrottleMs ?? DEFAULT_NUDGE_THROTTLE_MS));
    this.waitingOwnerReminderMs = Math.max(60_000, Math.trunc(deps.waitingOwnerReminderMs ?? DEFAULT_WAITING_OWNER_REMINDER_MS));
    this.externalReminderMs = Math.max(3_600_000, Math.trunc(deps.externalReminderMs ?? DEFAULT_EXTERNAL_REMINDER_MS));
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
      const latestEventId = detail.events[0]?.id ?? 0;
      const nudgeState = store.getNudgeState(card.id);
      const reasons = this.collectReasons(detail, current, nowMs, nudgeState === null || latestEventId > nudgeState.lastEventId);
      if (reasons.length === 0) {
        report.skipped.push({ taskId: card.id, reason: `current sub-project is ${current.status}, nothing due` });
        continue;
      }
      // Throttle: one escalation per task per window, unless the journal moved
      // (new information) or a timed wait expired (a clock condition, not noise).
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

  private collectReasons(detail: LongTermTaskDetail, current: LongTermSubtask, nowMs: number, hasNewEventsSinceNudge: boolean): string[] {
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
        if (quietMs > this.externalReminderMs) {
          return [`external wait has gone quiet for >${Math.round(this.externalReminderMs / 3_600_000)}h — re-check (${current.waitNote})`];
        }
        return [];
      case 'waiting_owner': {
        // A fresh acceptance proposal reaches the owner at the next heartbeat
        // tick — not after a quiet window (owner ruling: 一提请就叫你).
        const latestEvent = detail.events[0];
        if (
          latestEvent &&
          latestEvent.kind === 'proposed' &&
          latestEvent.subtaskId === current.id &&
          hasNewEventsSinceNudge
        ) {
          return ['acceptance proposal awaiting the owner\'s call'];
        }
        if (quietMs > this.waitingOwnerReminderMs) {
          return [`owner decision still pending for >${Math.round(this.waitingOwnerReminderMs / 60_000)}min (${current.waitNote})`];
        }
        return [];
      }
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
    const language = this.deps.getAppLanguage?.() ?? 'en';
    const prompt = buildNudgePrompt(detail, current, reasons, language);

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
