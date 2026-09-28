import type { CoworkExecutionMode, CoworkSessionAutoOrigin } from '../coworkStore';
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
 *    `ownerReminderMs` (a reminder is due). A `waitUntil` quiet window on an
 *    owner wait is honored: no reminders inside the window, then one full
 *    re-presentation once it passes.
 *  - a wait-establishing event is STALE: the journal shows work on the
 *    sub-project after it, so the board state must be converged (unblocked
 *    or re-recorded) instead of re-reminding the owner.
 *  - (P1 supervision) the current in-progress sub-project is stalling: its
 *    most recent worker dispatches all failed/timed out, or it has run past
 *    its expected-duration budget without converging — a supervision turn
 *    then demands a verdict and ONE corrective action from the TwinBot.
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
/**
 * Quiet time before re-presenting a parked owner decision (default 2h).
 * The sidebar's 跟踪任务 dot and the 长期任务 tab badge now carry the "you are
 * the blocker" attention, so the heartbeat only has to re-present the pending
 * decision — every 30 minutes was nagging, not reminding. The sweep cadence
 * (LONGTERM_ADVANCE_INTERVAL_MS) and the nudge throttle are untouched: only the
 * owner-nag interval relaxes.
 */
const DEFAULT_WAITING_OWNER_REMINDER_MS = 2 * 3_600_000;
const DEFAULT_EXTERNAL_REMINDER_MS = 4 * 3_600_000;
const DEFAULT_FAILURE_STREAK_THRESHOLD = 2;
const DEFAULT_EXPECTED_MINUTES = 240;
/**
 * Bound-session budget before the heartbeat rotates to a fresh session.
 *
 * What is actually counted (CoworkStore.countSessionMessages): EVERY
 * `cowork_messages` row of the session — user + assistant + tool_use +
 * tool_result + system, no type filter. That is not "conversation turns", and
 * one tool-heavy turn adds 60–400 rows, so the intended "about this many turns
 * of context" reading never held: production rotation points (the counts
 * journaled by the rotation note) run 62–2024 with a median of 129 and a mean
 * of 202 across 36 rotations.
 *
 * 180 therefore states the real intent: one session carries a whole day of
 * heartbeat advances for an active sub-project (~150–300 counted messages/day)
 * before the journal-only continuity hand-off, roughly halving-to-thirding the
 * rotation count. The check runs BEFORE a turn, so the effective rotation point
 * still overshoots by one turn — that overshoot is inherent to the mechanism,
 * which this constant does not change.
 */
export const DEFAULT_SESSION_ROTATION_MESSAGES = 180;
/** Longest subtask fragment carried in a `[长期]` session title. */
const SESSION_TITLE_SUBTASK_MAX_CHARS = 40;
/** Convergence churn breaker: stale-wait convergence turns per window before escalation to the owner. */
const CONVERGENCE_CHURN_LIMIT = 3;
const CONVERGENCE_CHURN_WINDOW_MS = 2 * 3_600_000;
/** Reason prefixes that mark a convergence-family escalation (stale wait / churn). */
const CONVERGENCE_REASON_PREFIXES = ['stale owner wait', 'convergence churn'];

/** Worker-dispatch telemetry used by supervision (P1) — one row per orchestration attempt tied to the task. */
export interface LongTermWorkerAttemptSummary {
  id: string;
  /** Human-readable dispatch label (the attempt's idempotency key). */
  label: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled';
  startedAtMs: number | null;
  finishedAtMs: number | null;
}

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
  /** Stamp the auto-origin marker so the sidebar can fold this session away. */
  setSessionAutoOrigin(id: string, autoOrigin: CoworkSessionAutoOrigin): void;
  addMessage(id: string, message: { type: string; content: string; metadata?: Record<string, unknown> }): unknown;
  getSession(id: string): unknown;
  /** Message count of a session — the rotation budget check (optional). */
  countSessionMessages?(id: string): number;
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
  /** P1 supervision: worker dispatch attempts tied to the task (via its bound sessions). */
  listWorkerAttempts?: (taskId: string, subtaskId: string) => LongTermWorkerAttemptSummary[];
  /** P1 supervision: leading failed/timed-out dispatch count that trips a supervise turn. */
  failureStreakThreshold?: number;
  /** P1 supervision: default expected duration (minutes) when the sub-project sets none. */
  defaultExpectedMinutes?: number;
  /** Session rotation: message budget for the bound session (default 180 — see DEFAULT_SESSION_ROTATION_MESSAGES for what is counted). */
  sessionRotationThreshold?: number;
}

/**
 * Title for the session a sub-project runs in: `[长期] <task> · #<ordinal> <subtask>`.
 *
 * Without the sub-project part every session of a task — and every rotation —
 * carried the identical `[长期] <task>` title, so the sidebar's folded Auto
 * Tasks list showed a column of indistinguishable rows. Rotations of the SAME
 * sub-project keep the identical title on purpose: the continuity preamble,
 * not the title, carries the "this is a fresh session" signal, and a stable
 * title lets the owner follow one sub-project across rotations.
 *
 * The `[长期]` prefix stays a hardcoded zh artifact (it is a stored title, not
 * UI chrome, and the fold's own label is localized separately).
 */
export function buildLongTermSessionTitle(
  taskTitle: string,
  ordinal: number,
  subtaskTitle: string,
): string {
  const task = taskTitle.trim();
  const subtask = subtaskTitle.trim();
  const shortSubtask = subtask.length > SESSION_TITLE_SUBTASK_MAX_CHARS
    ? `${subtask.slice(0, SESSION_TITLE_SUBTASK_MAX_CHARS - 1).trimEnd()}…`
    : subtask;
  const taskPart = task ? `[长期] ${task}` : '[长期]';
  const hasOrdinal = Number.isFinite(ordinal) && ordinal > 0;
  if (!hasOrdinal) return shortSubtask ? `${taskPart} · ${shortSubtask}` : taskPart;
  return shortSubtask ? `${taskPart} · #${ordinal} ${shortSubtask}` : `${taskPart} · #${ordinal}`;
}

export interface LongTermAdvanceReport {
  checkedTasks: number;
  escalated: Array<{ taskId: string; subtaskId: string; sessionId: string; reusedSession: boolean; reasons: string[] }>;
  skipped: Array<{ taskId: string; reason: string }>;
}

/**
 * Extra prompt block for turns where the current sub-project waits on the
 * owner (P0 contract): the reply must re-present the pending decision in
 * full — never a bare "no change" line — and converge a stale wait first.
 * Empty string for every other status.
 */
function buildOwnerWaitBlock(current: LongTermSubtask, language: string): string {
  if (current.status !== 'waiting_owner') return '';
  if (language === 'zh') {
    return [
      '',
      '特别要求（当前子项目正在等待主人拍板——这是本轮最重要的义务）：',
      '- 回复必须以「待拍板重申」开头：完整重述等主人决定的问题——问题本体、可选项（你的推荐项最前、附一句理由）、这项决策已经等待了多久、在它拍板之前阻塞了什么。每条心跳消息都必须自含完整上下文：主人可能错过之前的提醒，绝不能要求他翻聊天记录才能拍板。',
      '- 重申必须按「决策简报」的六段结构展开，每段一行小标题，顺序固定：1) 背景与已完成进展 2) 当前状况 3) 需要你拍板的事项 4) 选项与利弊 5) 推荐项及理由 6) 拍板后的下一步。这是主人不需要读完整会话就能拍板的唯一依据。',
      '- 禁止「状态无变化／静默保持」式的一行回复——对一个等拍板的任务，那读起来就是「没有事需要你」，是失联不是安静。',
      `- 等待备注：${current.waitNote || '(无记录——先用 longterm_subtask_wait 补上)'}${current.waitUntil ? `；承诺的静默窗口至 ${current.waitUntil}（本轮在窗口之后）` : ''}`,
      '- 先核对这条等待是否仍然成立：如果 journal 显示挂起等待之后你又推进过工作（等待已过时），先用 longterm_subtask_unblock 解除等待再继续推进；若等待仍成立但备注需要更新，用 longterm_subtask_wait 重新记录（会刷新等待锚点）——重记时同样按上面的六段结构重写 note。',
      '- 重申之后，若还有不依赖这个决策的推进空间，可以继续推进——但重申必须是回复的第一部分。',
    ].join('\n');
  }
  return [
    '',
    'SPECIAL REQUIREMENT (this sub-project is waiting on the owner\'s decision — the single most important duty of this turn):',
    '- Open your reply with a full re-presentation of the pending decision: the question itself, the options (your recommendation first, one-line reasoning), how long it has been waiting, and what stays blocked until it is answered. Every heartbeat message must be self-contained — the owner may have missed earlier reminders and must never have to scroll back through history to act.',
    '- The re-presentation MUST follow the six-section decision-brief structure, each section on its own labeled line, in this order: 1) background & progress so far 2) current situation 3) the decision you need 4) options with trade-offs 5) recommendation & why 6) next step after the call. It is the only thing the owner has to read to decide.',
    '- A bare "no change / holding quiet" one-liner is FORBIDDEN while a decision is pending — to the owner it reads as "nothing needs you": a dropout, not quiet.',
    `- Wait note: ${current.waitNote || '(none recorded — record one with longterm_subtask_wait first)'}${current.waitUntil ? `; promised quiet window until ${current.waitUntil} (this turn is past the window)` : ''}`,
    '- First verify the wait still holds: if the journal shows you worked on this sub-project AFTER parking the wait, converge the state before anything else — longterm_subtask_unblock to resume, or longterm_subtask_wait to re-record it (this refreshes the wait anchor; re-recorded notes use the same six sections).',
    '- After the re-presentation you may keep pushing any part that does not depend on the decision — but the re-presentation comes first.',
  ].join('\n');
}

/**
 * Extra prompt block for SUPERVISION turns (P1): the TwinBot must deliver a
 * supervision verdict — closer to acceptance, or looping? — and exactly ONE
 * corrective action. Null when this is not a supervision turn.
 */
function buildSupervisionBlock(attempts: LongTermWorkerAttemptSummary[] | null, language: string): string {
  if (attempts === null) return '';
  const dispatchLines = attempts
    .slice(0, 8)
    .map((attempt) => {
      const durationMin = attempt.startedAtMs !== null && attempt.finishedAtMs !== null
        ? Math.max(1, Math.round((attempt.finishedAtMs - attempt.startedAtMs) / 60_000))
        : null;
      return `   - ${attempt.label ?? attempt.id}: ${attempt.status}${durationMin !== null ? ` (${durationMin}min)` : ''}`;
    })
    .join('\n') || '   (no worker dispatches on record)';
  if (language === 'zh') {
    return [
      '',
      '特别要求（本轮是监督回合，不是例行推进）：',
      '- 这是针对委派工作的主动监督：先读 journal（longterm_task_get）与证据，再结合下面的派发记录判断。',
      '- 回复必须回答三个问题：① 自上次监督以来，工作离验收标准更近了吗——给出证据；② 是否在重复同一类失败（同错误、同方法、盲目重试）；③ 监督结论 + 恰好一项行动：继续 / 纠偏（给 worker 发带锚点的纠正指令）/ 终止并重派 / 确属主人决策时才提问。',
      '- 责任链：worker 的所有问题第一责任人是你——先诊断、纠偏、换方法、重派，穷尽之后才升级主人；主人只处理产品决策与不可逆取舍。绝不允许静默等待一个反复失败的循环跑下去。',
      '- 反盲试规则：同一方法以同类方式失败 2 次以上，禁止原样重试第三次——必须换方法、先取证（例如核实代码实际运行的位置与版本），或升级。',
      '- 用 longterm_event_note 记录监督结论（以「supervision: 」开头），让下一轮监督可以直接对比。',
      `- 本任务最近的 worker 派发（新→旧）：\n${dispatchLines}`,
    ].join('\n');
  }
  return [
    '',
    'SPECIAL REQUIREMENT (this turn is a SUPERVISION check on delegated work, not a routine push):',
    '- Read the journal (longterm_task_get) and the evidence first, then judge against the dispatch record below.',
    '- Your reply must answer three questions: (1) is the work closer to the acceptance criteria than at the last check — with evidence; (2) is it repeating the same class of failure (same error, same approach, blind retries); (3) verdict + exactly ONE action: continue / correct course (send the worker a corrective instruction carrying the anchor) / stop and reassign / ask the owner only if it is genuinely their call.',
    '- Responsibility chain: worker problems are YOURS first — diagnose, correct, change approach, reassign; escalate to the owner only product decisions and irreversible trade-offs. Never silently wait out a repeatedly failing loop.',
    '- Anti-blind-retry rule: after the same approach has failed the same way twice, a third identical retry is forbidden — change the approach, gather evidence first (e.g. verify where and which version of the code actually runs), or escalate.',
    '- Journal the verdict with longterm_event_note (prefix "supervision: ") so the next supervision turn can diff against it.',
    `- Recent worker dispatches for this task (newest first):\n${dispatchLines}`,
  ].join('\n');
}

function buildNudgePrompt(
  detail: LongTermTaskDetail,
  current: LongTermSubtask,
  reasons: string[],
  language: string,
  supervisionAttempts: LongTermWorkerAttemptSummary[] | null = null,
  rotation: { messages: number } | null = null,
): string {
  const criteria = current.acceptanceCriteria.length > 0
    ? current.acceptanceCriteria.map((criterion, index) => `   ${index + 1}. ${criterion}`).join('\n')
    : '   (no acceptance criteria on file — align them with the owner before pushing)';
  if (language === 'zh') {
    const lines = [
      ...(rotation
        ? [
            `【会话轮换】这是本子项目的新接续会话。旧会话已满（${rotation.messages} 条消息）并保持可读归档；你在本会话中没有任何历史上下文。你的持久记忆是任务 journal——绝不依赖聊天历史：先 longterm_task_get 读取完整状态简报，再按下面的要求行动。回复主人时无需解释轮换本身。`,
            '',
          ]
        : []),
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
      '   - 如果被外部条件卡住，用 longterm_subtask_wait 记录等待（精确的备注 + 知道日期就写 waitUntil；waitUntil 一律换算成主人本地时区、带时区偏移的完整 ISO 时间戳——不要写裸 UTC，除非主人明确用 UTC）。',
      '   - 如果交付物可验证地满足全部验收标准，带上证据提请验收。',
      '4. 用主人的语言回复。',
    ];
    const ownerWaitBlock = buildOwnerWaitBlock(current, language);
    if (ownerWaitBlock) lines.push(ownerWaitBlock);
    const supervisionBlock = buildSupervisionBlock(supervisionAttempts, language);
    if (supervisionBlock) lines.push(supervisionBlock);
    return lines.join('\n');
  }
  const lines = [
    ...(rotation
      ? [
          `[SESSION ROTATION] This is a fresh continuation session for this sub-project. The previous session reached its message budget (${rotation.messages} messages) and stays readable as an archive; you have NO history in this session. Your persistent memory is the task journal — never chat history: read the full state brief with longterm_task_get first, then act per the requirements below. No need to explain the rotation to the owner.`,
          '',
        ]
      : []),
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
    '   - If blocked externally, record the wait with longterm_subtask_wait (precise note + waitUntil when known; ALWAYS convert waitUntil to a full ISO timestamp WITH timezone offset in the owner\'s local timezone — never bare UTC unless the owner explicitly uses UTC).',
    '   - If the deliverable verifiably meets every acceptance criterion, propose acceptance with evidence.',
    '4. Reply in the owner\'s language.',
  ];
  const ownerWaitBlock = buildOwnerWaitBlock(current, language);
  if (ownerWaitBlock) lines.push(ownerWaitBlock);
  const supervisionBlock = buildSupervisionBlock(supervisionAttempts, language);
  if (supervisionBlock) lines.push(supervisionBlock);
  return lines.join('\n');
}

export class LongTermAdvanceService {
  private readonly deps: LongTermAdvanceDeps;
  private readonly maxEscalationsPerRun: number;
  private readonly nudgeThrottleMs: number;
  private readonly waitingOwnerReminderMs: number;
  private readonly externalReminderMs: number;
  private readonly failureStreakThreshold: number;
  private readonly defaultExpectedMinutes: number;
  private readonly sessionRotationThreshold: number;
  private readonly emitLog: (line: string) => void;

  constructor(deps: LongTermAdvanceDeps) {
    this.deps = deps;
    this.maxEscalationsPerRun = Math.max(1, Math.trunc(deps.maxEscalationsPerRun ?? DEFAULT_MAX_ESCALATIONS_PER_RUN));
    this.nudgeThrottleMs = Math.max(60_000, Math.trunc(deps.nudgeThrottleMs ?? DEFAULT_NUDGE_THROTTLE_MS));
    this.waitingOwnerReminderMs = Math.max(60_000, Math.trunc(deps.waitingOwnerReminderMs ?? DEFAULT_WAITING_OWNER_REMINDER_MS));
    this.externalReminderMs = Math.max(3_600_000, Math.trunc(deps.externalReminderMs ?? DEFAULT_EXTERNAL_REMINDER_MS));
    this.failureStreakThreshold = Math.max(1, Math.trunc(deps.failureStreakThreshold ?? DEFAULT_FAILURE_STREAK_THRESHOLD));
    this.defaultExpectedMinutes = Math.max(1, Math.trunc(deps.defaultExpectedMinutes ?? DEFAULT_EXPECTED_MINUTES));
    this.sessionRotationThreshold = Math.max(10, Math.trunc(deps.sessionRotationThreshold ?? DEFAULT_SESSION_ROTATION_MESSAGES));
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
      const supervision = this.supervisionSignal(detail, current, nowMs);
      const reasons = this.collectReasons(detail, current, nowMs, nudgeState?.lastEventId ?? 0, supervision);
      if (reasons.length === 0) {
        report.skipped.push({ taskId: card.id, reason: `current sub-project is ${current.status}, nothing due` });
        continue;
      }
      // Throttle: one escalation per task per window, unless the journal moved
      // (new information) or a timed wait expired (a clock condition, not
      // noise). A supervision signal is new information by construction — a
      // fresh failure signature or an elapsed budget window — so it too
      // bypasses the noise throttle (its own re-arm state prevents spam).
      const waitDue =
        current.status === 'waiting_external' &&
        current.waitUntil !== null &&
        Date.parse(current.waitUntil) <= nowMs;
      const throttled =
        nudgeState !== null &&
        nowMs - nudgeState.lastNudgeAtMs < this.nudgeThrottleMs &&
        latestEventId <= nudgeState.lastEventId;
      if (throttled && !waitDue && supervision === null) {
        report.skipped.push({ taskId: card.id, reason: 'nudge throttled (no new events since last escalation)' });
        continue;
      }
      // Never stack a second turn onto a session that is already executing one.
      if (current.sessionId && this.deps.coworkRunner().isSessionActive?.(current.sessionId)) {
        report.skipped.push({ taskId: card.id, reason: 'a turn is already running in the bound session' });
        continue;
      }
      try {
        const outcome = await this.escalate(
          detail,
          current,
          reasons,
          supervision ? (this.deps.listWorkerAttempts?.(detail.id, current.id) ?? []) : null,
        );
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
        if (supervision) {
          // P1-A: the failure-streak marker is written ONLY by failure turns;
          // duration turns re-arm by time (lastSuperviseAtMs) and must not
          // clobber the failure signature — the two signals cross-deduped
          // through one field caused spurious paired supervision turns.
          store.setSuperviseState(card.id, {
            lastSuperviseAtMs: nowMs,
            ...(supervision.failureSignature !== null ? { lastFailureSignal: supervision.failureSignature } : {}),
          });
        } else if (reasons.some((reason) => CONVERGENCE_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix)))) {
          // A convergence-family escalation: record it on the churn trail.
          const prior = store.getSuperviseState(card.id);
          const trail = [...(prior?.convergenceAtMs ?? []).filter((atMs) => nowMs - atMs < CONVERGENCE_CHURN_WINDOW_MS), nowMs];
          store.setSuperviseState(card.id, {
            lastSuperviseAtMs: prior?.lastSuperviseAtMs ?? 0,
            convergenceAtMs: trail,
          });
        }
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

  private collectReasons(
    detail: LongTermTaskDetail,
    current: LongTermSubtask,
    nowMs: number,
    nudgeLastEventId: number,
    supervision: { reasons: string[]; failureSignature: string | null } | null,
  ): string[] {
    const lastActivityAtMs = detail.events[0] ? Date.parse(detail.events[0].createdAt) : Date.parse(detail.updatedAt);
    const quietMs = nowMs - lastActivityAtMs;
    switch (current.status) {
      case 'pending':
        return ['current sub-project is pending and ready to begin'];
      case 'in_progress': {
        // P1: supervision outranks the plain quiet push — a stalling or
        // looping delegation gets a supervision turn, not just "push it".
        if (supervision) return supervision.reasons;
        // A fresh begin/work event means a turn just ran — only re-push once
        // the work has gone quiet for a full throttle window.
        if (quietMs > this.nudgeThrottleMs) {
          return ['current sub-project is in progress but has gone quiet — needs a push'];
        }
        return [];
      }
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
        // tick — not after a quiet window (owner ruling: 一提请就叫你). Direct
        // query: the proposal just has to be newer than the last nudge.
        const proposed = this.deps.store().getLatestSubtaskEventOfKinds(detail.id, current.id, ['proposed']);
        if (proposed && proposed.id > nudgeLastEventId) {
          return ['acceptance proposal awaiting the owner\'s call'];
        }
        // A promised quiet window on an owner wait is honored: the TwinBot
        // told the owner "silent until <waitUntil>" (e.g. an overnight
        // window), so no reminder may fire inside it. The first turn after
        // the window passes must re-present the decision in full.
        if (current.waitUntil !== null && Date.parse(current.waitUntil) > nowMs) {
          return [];
        }
        // Stale wait: the journal shows work on this sub-project AFTER the
        // wait was parked (or the proposal made) — the board state no longer
        // reflects reality. Converge it instead of re-nudging the owner about
        // a decision that may no longer exist (regression: 55 reminders over
        // 40h for a wait the TwinBot had already worked past).
        const staleReason = this.staleWaitReason(detail, current, nowMs);
        if (staleReason) return [staleReason];
        if (quietMs > this.waitingOwnerReminderMs) {
          if (current.waitUntil !== null) {
            return [`owner quiet window ended (${current.waitUntil}) — re-present the pending decision in full (${current.waitNote})`];
          }
          return [`owner decision still pending for >${Math.round(this.waitingOwnerReminderMs / 60_000)}min (${current.waitNote})`];
        }
        return [];
      }
      default:
        return [];
    }
  }

  /**
   * The wait recorded on this waiting_owner sub-project is stale: the journal
   * shows real work after the latest wait-establishing event ('waiting' or
   * 'proposed'). Direct indexed queries — never the capped 200-event detail
   * projection. Heartbeat 'nudged'/'supervised' events and system notes
   * (session binds) are infrastructure, not work. When the wait keeps going
   * stale (the Twin re-parks it instead of committing), the churn breaker
   * replaces the convergence nudge with an owner escalation.
   */
  private staleWaitReason(detail: LongTermTaskDetail, current: LongTermSubtask, nowMs: number): string | null {
    if (current.status !== 'waiting_owner') return null;
    const store = this.deps.store();
    const anchor = store.getLatestSubtaskEventOfKinds(detail.id, current.id, ['waiting', 'proposed']);
    if (!anchor) return null;
    if (!store.hasTwinWorkAfter(detail.id, current.id, anchor.id)) return null;
    const state = store.getSuperviseState(detail.id);
    const recentConvergences = (state?.convergenceAtMs ?? []).filter((atMs) => nowMs - atMs < CONVERGENCE_CHURN_WINDOW_MS).length;
    if (recentConvergences >= CONVERGENCE_CHURN_LIMIT) {
      return `convergence churn — this wait has gone stale and been re-parked ${recentConvergences} times in the last ${Math.round(CONVERGENCE_CHURN_WINDOW_MS / 3_600_000)}h (${current.waitNote}). Stop the loop: either resolve it definitively (longterm_subtask_unblock and commit to one path) or bring the decision to the owner now — full history, one clear question, your recommendation first`;
    }
    return `stale owner wait — the journal shows work after the wait was parked (${current.waitNote}); converge the state first: longterm_subtask_unblock to resume, or longterm_subtask_wait to re-record it, then re-present whatever still needs the owner`;
  }

  /**
   * P1 supervision: cheap local stall detection on the current in-progress
   * sub-project — no LLM involved. Two triggers with SEPARATE consumption
   * markers (P1-A: a single shared slot let a duration turn reset the failure
   * dedup, causing spurious paired supervision per budget window):
   *  - failure streak: the N most recent worker dispatches for this task all
   *    ended failed/timed_out; the signature (count + latest failed id) is
   *    consumed once via lastFailureSignal — each NEW failure supervises
   *    exactly once, and duration turns never clear it;
   *  - duration overrun: in progress longer than the sub-project's expected
   *    budget (or the default) without converging; re-armed once per budget
   *    window via lastSuperviseAtMs (both turn types advance it).
   */
  private supervisionSignal(
    detail: LongTermTaskDetail,
    current: LongTermSubtask,
    nowMs: number,
  ): { reasons: string[]; failureSignature: string | null } | null {
    if (current.status !== 'in_progress') return null;
    const state = this.deps.store().getSuperviseState(detail.id);
    // Scoped to THIS sub-project's bound session: a previous sub-project's
    // failed dispatches must not trip supervision on the one just begun.
    const attempts = this.deps.listWorkerAttempts?.(detail.id, current.id) ?? [];
    const ordered = [...attempts].sort(
      (a, b) => (b.finishedAtMs ?? b.startedAtMs ?? 0) - (a.finishedAtMs ?? a.startedAtMs ?? 0),
    );
    let streak = 0;
    let latestFailedId = '';
    for (const attempt of ordered) {
      if (attempt.status === 'failed' || attempt.status === 'timed_out') {
        streak += 1;
        if (!latestFailedId) latestFailedId = attempt.id;
      } else break;
    }
    if (streak >= this.failureStreakThreshold) {
      const signature = `fails:${streak}@${latestFailedId}`;
      if (signature !== (state?.lastFailureSignal ?? '')) {
        return {
          reasons: [
            `supervision: ${streak} consecutive failed/timed-out worker dispatches (latest ${latestFailedId}) — supervise the delegated work: diagnose the common failure mode and correct course or reassign; a third identical retry is forbidden`,
          ],
          failureSignature: signature,
        };
      }
    }
    const enteredAtMs = this.enteredInProgressAtMs(detail, current);
    const expectedMinutes = current.expectedMinutes ?? this.defaultExpectedMinutes;
    const budgetMs = expectedMinutes * 60_000;
    if (
      enteredAtMs !== null &&
      nowMs - enteredAtMs > budgetMs &&
      (!state || nowMs - state.lastSuperviseAtMs >= budgetMs)
    ) {
      const hours = Math.max(1, Math.round((nowMs - enteredAtMs) / 3_600_000));
      return {
        reasons: [
          `supervision: in progress for >${hours}h without converging (budget ${expectedMinutes}min) — supervise: verify the work is still moving toward the acceptance criteria, not looping`,
        ],
        failureSignature: null,
      };
    }
    return null;
  }

  /** When the sub-project last entered in_progress: newest began/unblocked/rejected
   *  event (direct query), else updatedAt. */
  private enteredInProgressAtMs(detail: LongTermTaskDetail, current: LongTermSubtask): number | null {
    const event = this.deps.store().getLatestSubtaskEventOfKinds(detail.id, current.id, ['began', 'unblocked', 'rejected']);
    const parsed = Date.parse(event?.createdAt ?? current.updatedAt);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /** Open (once) or continue (afterwards) the sub-project's bound session. */
  private async escalate(
    detail: LongTermTaskDetail,
    current: LongTermSubtask,
    reasons: string[],
    supervisionAttempts: LongTermWorkerAttemptSummary[] | null = null,
  ): Promise<{ sessionId: string; reusedSession: boolean }> {
    const coworkStore = this.deps.coworkStore();
    const runner = this.deps.coworkRunner();
    const twinId = this.deps.resolveTwinMetabotId();
    const language = this.deps.getAppLanguage?.() ?? 'en';

    const boundSessionId = current.sessionId ?? '';
    let sessionId = '';
    let reusedSession = false;
    let rotation: { from: string; messages: number } | null = null;
    if (boundSessionId && coworkStore.getSession(boundSessionId)) {
      const messageCount = coworkStore.countSessionMessages?.(boundSessionId) ?? 0;
      if (messageCount < this.sessionRotationThreshold) {
        sessionId = boundSessionId;
        reusedSession = true;
      } else {
        // Session rotation: the bound session is over its message budget —
        // unbounded context growth is how anchor drift starts on multi-week
        // tasks. The journal (not chat history) is the TwinBot's memory, so a
        // fresh session carrying the continuity preamble is safe. The budget
        // counts EVERY message row (tool traffic included) and is checked
        // before a turn, so the count at rotation overshoots it by one turn.
        rotation = { from: boundSessionId, messages: messageCount };
      }
    }
    if (!sessionId) {
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
        buildLongTermSessionTitle(detail.title, current.ordinal, current.title),
        this.deps.resolveWorkingDirectory(twinId),
        systemPrompt,
        'local',
        ['long-term-task-exec'],
        twinId,
        'longterm',
      );
      sessionId = session.id;
      coworkStore.setSessionAutoOrigin(sessionId, 'longterm');
      this.deps.store().bindSession(current.id, sessionId, 'system');
      if (rotation) {
        this.deps.store().addNote(
          detail.id,
          current.id,
          `session rotated: ${rotation.from} → ${sessionId} (${rotation.messages} messages; continuity via journal)`,
          'system',
        );
        this.emitLog(
          `[LongTermAdvance] rotated session for task "${detail.title}" sub-project #${current.ordinal}: ${rotation.from} → ${sessionId} (${rotation.messages} messages)`,
        );
      }
    }
    const prompt = buildNudgePrompt(detail, current, reasons, language, supervisionAttempts, rotation);

    coworkStore.updateSession(sessionId, { status: 'running' });
    coworkStore.addMessage(sessionId, {
      type: 'user',
      content: prompt,
      metadata: { origin: 'heartbeat' },
    });
    // Supervision turns journal as 'supervised' — the owner's audit trail
    // distinguishes interventions from routine pushes.
    if (supervisionAttempts !== null) {
      this.deps.store().recordSupervision(detail.id, current.id, `supervision escalation (${reasons.join('; ')}) → session ${sessionId}`);
    } else {
      this.deps.store().recordNudge(detail.id, current.id, `heartbeat escalation (${reasons.join('; ')}) → session ${sessionId}`);
    }
    await runner.startSession(sessionId, prompt, { skipInitialUserMessage: true, confirmationMode: 'text' });
    return { sessionId, reusedSession };
  }
}
