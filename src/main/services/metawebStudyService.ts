import {
  DEFAULT_STUDY_PIN_BUDGET_PER_NIGHT,
  MAX_STUDY_CONSECUTIVE_FAILURES,
  MAX_STUDY_RUNS_PER_JOB,
  MetawebStudyJobStore,
  normalizeStudyTopic,
  studyTopicFingerprintOf,
  type MetawebStudyJobRecord,
  type MetawebStudyJobStatus,
} from '../metawebStudyJobStore';import { KNOWLEDGE_BASE_AUTO_LEARN_WINDOW } from './knowledgeBaseService';
import { stripLoneSurrogates, truncateUtf16Units } from '../libs/llmSafeText';

/**
 * MetaWeb study service ("自主学习任务", M4) — the queue + nightly scheduler
 * behind "study topic X in your spare time".
 *
 * The owner assigns a topic in chat (metaweb_study_enqueue) → a per-bot job
 * row. Inside the nightly window (shared with knowledge-base auto-learn,
 * local [00:00,06:00)) the scheduler drains pending jobs one at a time: each
 * run is a bounded background agent session (the `runStudyJob` host hook,
 * wired in main.ts) that searches MetaWeb, reads pins, and saves the
 * worthwhile bodies into the bot's knowledge bases. A job spans nights —
 * each run consumes up to `budgetPins` NEW pins — and completes when a run
 * adds nothing new or the run-count safety cap is reached.
 *
 * Locked product decisions (owner, 2026-08-23): owner-assigned topics only
 * (self-derived topics are M5, from the bot's persona); NO proactive morning
 * report — the bot answers from metaweb_study_status and the UI lists jobs
 * next to the knowledge-base panel; default budget 20 pins per topic per
 * night.
 *
 * Job kind 'qa-surf' (on-chain Q&A surfing, feat/metaweb-qa): a recurring
 * per-bot job the owner enables once — every night the bot browses the
 * latest questions, answers what fits its persona, saves valuable Q&A into
 * its knowledge bases, and reacts honestly. Recurring by design: successful
 * runs always return it to 'pending'; only repeated failures mark it failed.
 */

const TICK_MS = 30 * 60 * 1000;
const MAX_BUDGET_PINS = 50;
/** Cap the already-processed pinId list injected into a study prompt. */
const PROMPT_PROCESSED_PIN_CAP = 80;
/** Default nightly budget for a recurring Q&A-surf job (pins handled: answered or saved). */
export const DEFAULT_QA_SURF_BUDGET_PER_NIGHT = 10;
/**
 * Stored processed-pin history cap for recurring jobs — a qa-surf job never
 * completes, so without a cap its handled list would grow forever (the prompt
 * only ever shows the most recent slice anyway).
 */
const MAX_STORED_PROCESSED_PINS = 400;
/** Fixed topic label / fingerprint for the per-bot Q&A-surf job. */
const QA_SURF_TOPIC_LABEL = 'On-chain Q&A surfing';

export interface MetawebStudyRunResult {
  /** PinIds the run actually saved into a knowledge base (new this run). */
  newPinIds: string[];
  /** 2-3 sentence owner-readable outcome, recorded on the job. */
  summary: string;
}

/**
 * Host hook (main.ts) that runs ONE bounded background study session for the
 * job and resolves with what it saved. Implementations must be unattended
 * (no user prompts) and pass the job's pin budget through
 * `metawebStudySession: { pinBudget }` so coworkRunner restricts the session
 * to the learning tool allowlist and hard-caps metaweb-source KB adds.
 */
export type MetawebStudyRunHook = (job: MetawebStudyJobRecord) => Promise<MetawebStudyRunResult>;

export interface MetawebStudyServiceDeps {
  store: MetawebStudyJobStore;
  runStudyJob: MetawebStudyRunHook;
  now?: () => Date;
  /**
   * Knowledge-base tools are gated on the bot's memory policy (coworkRunner's
   * sessionMemoryEnabled), so with memory disabled a study session could
   * search and read but save NOTHING — and the empty run would be misrecorded
   * as 'done'. When provided, runTick checks this before launching a session
   * and fails the job loudly instead of burning a session on a guaranteed
   * no-op. Omitting it preserves the previous behavior (always run).
   */
  isMemoryEnabled?: (metabotId: number) => boolean;
}

function inStudyWindow(date: Date): boolean {
  const hour = date.getHours();
  return hour >= KNOWLEDGE_BASE_AUTO_LEARN_WINDOW.startHour && hour < KNOWLEDGE_BASE_AUTO_LEARN_WINDOW.endHour;
}

function truncateMiddle(value: string, max: number): string {
  const clean = stripLoneSurrogates(value);
  return clean.length > max ? `${truncateUtf16Units(clean, max)}…` : clean;
}

/**
 * The unattended study-session prompt. The session's final message must be a
 * single ```json fence with {processedPinIds, summary} — main.ts parses that
 * contract best-effort; everything else the session says is ignored.
 */
export function buildMetawebStudySessionPrompt(job: MetawebStudyJobRecord): string {
  if (job.kind === 'qa-surf') return buildQaSurfSessionPrompt(job);
  const alreadyProcessed = job.processedPinIds.slice(-PROMPT_PROCESSED_PIN_CAP);
  const processedNote = alreadyProcessed.length
    ? [
        `Already processed in earlier runs (${job.processedPinIds.length} total${job.processedPinIds.length > alreadyProcessed.length ? `, showing the ${alreadyProcessed.length} most recent` : ''}) — do NOT read or save these pinIds again:`,
        ...alreadyProcessed.map((pinId) => `- ${pinId}`),
        '',
      ].join('\n')
    : 'This is the first run for this topic — nothing processed yet.';
  return [
    `You are running an unattended overnight MetaWeb study session. There is no user watching: never ask questions, never wait for confirmation, and do not install any skills or packages during this session — archive knowledge only.`,
    '',
    `Study topic: "${job.topic}"`,
    `Nightly budget: save AT MOST ${job.budgetPins} NEW pins this run. Quality over quantity — stop early if the good material runs out.`,
    '',
    processedNote,
    '',
    'Procedure:',
    '1. Derive 3–5 keyword sets from the topic yourself (include both Chinese and English variants; on-chain content is bilingual).',
    '2. search_metaweb each keyword set (sort=relevance, size 10). Do NOT pass a protocols filter — tutorials live across simplenote, simplebuzz, metaapp and more.',
    '3. Judge by title and summary; read_metaweb_pin only the promising pins.',
    '4. For each pin worth keeping long-term: knowledge_base_add_document with sourceType \'metaweb\', the pinId, the pin\'s title, and its full body as content (if the body was truncated, use the payload field). Skip pins with empty, encrypted, or thin content. Use a topical knowledge base from your <knowledge_bases> list when one matches, otherwise the default one.',
    '5. When done saving: knowledge_base_learn to absorb the new documents into the search index.',
    '6. If the study run taught you a repeatable workflow (not just facts), also procedure_save it with the source pinIds. Single facts are not worth saving here — they live in the knowledge base bodies.',
    '7. End your run with EXACTLY one final message: a single ```json code fence and nothing else, shaped as',
    '   {"processedPinIds": ["<pinId>", ...], "summary": "<2-3 sentences: what you studied, what you saved, notable gaps>"}',
    '   processedPinIds lists ONLY the pins you actually saved this run.',
  ].join('\n');
}

/**
 * The unattended nightly Q&A surfing prompt (job kind 'qa-surf'): browse the
 * on-chain Q&A, answer what fits the bot's persona, save what its role should
 * keep, react honestly. Same ```json run-report contract as topic study.
 */
export function buildQaSurfSessionPrompt(job: MetawebStudyJobRecord): string {
  const alreadyProcessed = job.processedPinIds.slice(-PROMPT_PROCESSED_PIN_CAP);
  const processedNote = alreadyProcessed.length
    ? [
        `Already handled in earlier surf runs (${job.processedPinIds.length} total${job.processedPinIds.length > alreadyProcessed.length ? `, showing the ${alreadyProcessed.length} most recent` : ''}) — skip these again:`,
        ...alreadyProcessed.map((pinId) => `- ${pinId}`),
        '',
      ].join('\n')
    : 'This is the first surf run for this bot — nothing handled yet.';
  return [
    `You are running an unattended overnight Q&A surfing session on MetaWeb. No user is watching: never ask questions, never wait for confirmation, and do not install any skills or packages during this session.`,
    '',
    `Your persona decides everything tonight: only questions squarely inside your role and competence deserve your attention — skip the rest without guilt.`,
    `Budget: handle AT MOST ${job.budgetPins} NEW pins this run (questions you answer plus pins you save). Answer at most ~3 questions — every answer is an on-chain write that costs sats, and quality beats volume.`,
    '',
    processedNote,
    '',
    'Procedure:',
    '1. list_latest_questions with max_answers=0 — the unanswered queue, newest first. Page through 1–2 pages.',
    '2. Judge each question against YOUR role (your identity block). Skip anything outside your competence; do not answer to seem busy.',
    '3. When you can answer one really well: get_question_answers first — if a good answer already exists, do NOT repeat it, like_pin it instead. Otherwise post_simpleanswer (`answer_to` = the question pinId), concise and concrete.',
    '4. Also browse one page of ANSWERED questions in your domain (list_latest_questions default sort) and react honestly: like_pin +1 for genuinely good answers, -1 for wrong ones. A few reactions, not dozens.',
    '5. Save what your role should keep long-term: read_metaweb_pin the full body of a valuable question or answer, then knowledge_base_add_document (sourceType \'metaweb\', the pinId, its title, the full body) into a topical knowledge base from your <knowledge_bases> list (default one otherwise). Run knowledge_base_learn once at the end. A repeatable workflow the Q&A taught you (not a single fact) is worth procedure_save with the source pinIds.',
    '6. Do NOT post_simplequestion in this session — asking is for interactive work when you are stuck; tonight you browse, answer, and learn. Do NOT publish buzz or notes.',
    '7. End your run with EXACTLY one final message: a single ```json code fence and nothing else, shaped as',
    '   {"processedPinIds": ["<pinId>", ...], "summary": "<2-3 sentences: what you answered, saved, reacted to; notable gaps>"}',
    '   processedPinIds lists the question pinIds you ANSWERED plus the pins you SAVED — tonight\'s handled set, so future surf runs skip them.',
  ].join('\n');
}

/**
 * Parse a study session's final reply into the run result. Contract: the last
 * ```json fence carries {"processedPinIds": [...], "summary": "..."}. A reply
 * that is itself bare JSON is also accepted. Anything else throws — the
 * service records the job as failed rather than guessing what was saved.
 */
export function parseMetawebStudyRunReport(replyText: string): MetawebStudyRunResult {
  const text = String(replyText ?? '').trim();
  const candidates: string[] = [];
  const fences = [...text.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)```/g)].map((match) => match[1]);
  // The contract fence is the LAST one; earlier fences may be quoted examples.
  for (let index = fences.length - 1; index >= 0; index -= 1) candidates.push(fences[index]);
  if (text.startsWith('{')) candidates.push(text);
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    const newPinIds = Array.isArray(record.processedPinIds)
      ? [...new Set(record.processedPinIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))]
      : [];
    const summary = typeof record.summary === 'string' && record.summary.trim()
      ? record.summary.trim()
      : 'Study run completed; the session did not provide a summary.';
    if (newPinIds.length > 0 || Array.isArray(record.processedPinIds)) {
      return { newPinIds, summary };
    }
  }
  throw new Error('Study session did not return the required ```json report (processedPinIds + summary).');
}

export class MetawebStudyService {
  private readonly store: MetawebStudyJobStore;
  private readonly runStudyJob: MetawebStudyRunHook;
  private readonly now: () => Date;
  private readonly isMemoryEnabled?: (metabotId: number) => boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Runs are serialized globally — one background study session at a time. */
  private running = false;
  /** Job currently running in THIS process (null when idle) — see startSchedule. */
  private runningJobId: string | null = null;

  constructor(deps: MetawebStudyServiceDeps) {
    this.store = deps.store;
    this.runStudyJob = deps.runStudyJob;
    this.now = deps.now ?? (() => new Date());
    this.isMemoryEnabled = deps.isMemoryEnabled;
  }

  enqueueStudyJob(
    metabotId: number,
    input: { topic: string; budgetPins?: number },
  ): { job: MetawebStudyJobRecord; created: boolean } {
    if (!Number.isInteger(metabotId) || metabotId <= 0) {
      throw new Error(`Invalid metabotId: ${String(metabotId)}`);
    }
    const topic = normalizeStudyTopic(input.topic);
    if (!topic) throw new Error('Study topic is required');
    const fingerprint = studyTopicFingerprintOf(topic);
    const existing = this.store.findActiveByFingerprint(metabotId, fingerprint);
    if (existing) return { job: existing, created: false };
    const nowIso = this.now().toISOString();
    const budgetPins = Math.max(
      1,
      Math.min(MAX_BUDGET_PINS, Math.floor(input.budgetPins ?? DEFAULT_STUDY_PIN_BUDGET_PER_NIGHT)),
    );
    const job: MetawebStudyJobRecord = {
      id: `study-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      metabotId,
      kind: 'topic',
      topic,
      topicFingerprint: fingerprint,
      status: 'pending',
      budgetPins,
      processedPinIds: [],
      runCount: 0,
      consecutiveFailures: 0,
      lastRunAt: null,
      lastRunSummary: null,
      lastError: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.store.insert(job);
    return { job, created: true };
  }

  /**
   * Enable the recurring nightly Q&A surfing job for one bot (one active
   * surf job per bot). Unlike a topic job it never completes on its own —
   * every successful run returns it to 'pending' for the next night; only
   * repeated failures mark it 'failed' (re-enqueue then creates a fresh row).
   */
  enqueueQaSurfJob(
    metabotId: number,
    input: { budgetPins?: number } = {},
  ): { job: MetawebStudyJobRecord; created: boolean } {
    if (!Number.isInteger(metabotId) || metabotId <= 0) {
      throw new Error(`Invalid metabotId: ${String(metabotId)}`);
    }
    const existing = this.store.findActiveQaSurf(metabotId);
    if (existing) return { job: existing, created: false };
    const nowIso = this.now().toISOString();
    const budgetPins = Math.max(
      1,
      Math.min(MAX_BUDGET_PINS, Math.floor(input.budgetPins ?? DEFAULT_QA_SURF_BUDGET_PER_NIGHT)),
    );
    const job: MetawebStudyJobRecord = {
      id: `qa-surf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      metabotId,
      kind: 'qa-surf',
      topic: QA_SURF_TOPIC_LABEL,
      topicFingerprint: 'qa-surf',
      status: 'pending',
      budgetPins,
      processedPinIds: [],
      runCount: 0,
      consecutiveFailures: 0,
      lastRunAt: null,
      lastRunSummary: null,
      lastError: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.store.insert(job);
    return { job, created: true };
  }

  /**
   * Owner-disable path: stop the bot's active Q&A surfing job. Returns true
   * when an active job was disabled, false when there was nothing to stop.
   * Re-enabling later simply enqueues a fresh job.
   */
  disableQaSurfJob(metabotId: number): boolean {
    if (!Number.isInteger(metabotId) || metabotId <= 0) return false;
    return this.store.markActiveQaSurfDone(metabotId, {
      note: 'Disabled by the owner; nightly Q&A surfing stopped.',
      nowIso: this.now().toISOString(),
    }) > 0;
  }

  listStudyJobs(metabotId: number): MetawebStudyJobRecord[] {
    if (!Number.isInteger(metabotId) || metabotId <= 0) return [];
    return this.store.listByMetabot(metabotId);
  }

  startSchedule(): void {
    if (this.timer) return;
    // Crash recovery: a process killed mid-run leaves 'running' rows behind.
    // A job still running in THIS process (sqlite recovery restarts the
    // schedule while its session lives on) is excluded — resetting it would
    // start a duplicate study session.
    this.store.resetRunningToPending(this.now().toISOString(), this.runningJobId ?? undefined);
    // First tick immediately (no-op outside the window) so a job queued just
    // before the window, or an app restart inside it, does not wait 30min.
    void this.runTick().catch(() => undefined);
    this.timer = setInterval(() => {
      void this.runTick().catch(() => undefined);
    }, TICK_MS);
  }

  stopSchedule(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Drain the pending queue inside the nightly window, one job at a time.
   * Jobs whose run ends still finding new material go back to 'pending' and
   * continue the next night; a run that saved nothing new (or hit the run
   * cap) completes the job. Failures are retryable: the job stays 'pending'
   * until MAX_STUDY_CONSECUTIVE_FAILURES failures in a row, then 'failed'.
   * One job's bookkeeping error must never kill the batch — it is logged and
   * the drain continues with the next job.
   */
  async runTick(): Promise<{ ran: number }> {
    if (this.running) return { ran: 0 };
    if (!inStudyWindow(this.now())) return { ran: 0 };
    let ran = 0;
    for (const job of this.store.listPending()) {
      if (!inStudyWindow(this.now())) break;
      // Memory gate: with memory disabled for this bot the study session has
      // no knowledge-base tools to save into, so the run would be a guaranteed
      // no-op misrecorded as 'done'. Fail loudly instead — no session burned,
      // no run consumed. An unreadable policy (e.g. mid sqlite recovery) skips
      // the job this tick and leaves it pending for the next one.
      let memoryEnabled = true;
      try {
        memoryEnabled = this.isMemoryEnabled ? this.isMemoryEnabled(job.metabotId) : true;
      } catch (policyError) {
        // release-review P2: an unreadable policy (e.g. mid sqlite recovery)
        // used to skip the job with zero trace — a bot stuck in recovery had
        // its study jobs silently pending every 30-min tick. Log it like every
        // other failure path in this tick does.
        console.warn(
          '[MetawebStudy] memory policy unreadable; job kept pending for the next tick:',
          `job=${job.id} metabot=${job.metabotId}`,
          policyError instanceof Error ? policyError.message : String(policyError),
        );
        continue;
      }
      if (!memoryEnabled) {
        try {
          this.store.markFailedWithoutRun(job.id, {
            error:
              'Memory is disabled for this bot, so study sessions have no knowledge-base tools to save into. Re-enable memory for this bot and re-enqueue the topic.',
            nowIso: this.now().toISOString(),
          });
        } catch (bookkeepingError) {
          // Same posture as run-failure bookkeeping below: an unhealthy store
          // must not kill the batch — the job stays pending and is retried.
          console.error('[MetawebStudy] failed to record memory-gated refusal:', bookkeepingError instanceof Error ? bookkeepingError.message : String(bookkeepingError));
        }
        continue;
      }
      this.running = true;
      this.runningJobId = job.id;
      try {
        this.store.markRunning(job.id, this.now().toISOString());
        const result = await this.runStudyJob(this.store.getById(job.id) ?? job);
        // A qa-surf job disabled while its session was in flight must not be
        // resurrected by this run's bookkeeping — its answers/saves stand, but
        // the row keeps the disabled state the owner chose.
        if (job.kind === 'qa-surf') {
          const current = this.store.getById(job.id);
          if (!current || current.status !== 'running') {
            continue;
          }
        }
        const mergedAll = [...new Set([...job.processedPinIds, ...result.newPinIds])];
        // Recurring surf jobs cap the stored handled list (they never end);
        // topic jobs keep the full list for corpus-exhaustion detection.
        const merged = job.kind === 'qa-surf'
          ? mergedAll.slice(-MAX_STORED_PROCESSED_PINS)
          : mergedAll;
        const newCount = mergedAll.length - job.processedPinIds.length;
        const runCount = job.runCount + 1;
        // qa-surf is recurring by design: a quiet night (nothing new) or a
        // high run count never completes it — only failures (below) can.
        const nextStatus: MetawebStudyJobStatus = job.kind === 'qa-surf'
          ? 'pending'
          : newCount === 0 || runCount >= MAX_STUDY_RUNS_PER_JOB ? 'done' : 'pending';
        const summary =
          job.kind !== 'qa-surf' && nextStatus === 'done' && runCount >= MAX_STUDY_RUNS_PER_JOB && newCount > 0
            ? `${truncateMiddle(result.summary, 500)} (completed: reached the ${MAX_STUDY_RUNS_PER_JOB}-run safety cap)`
            : truncateMiddle(result.summary, 500);
        this.store.recordRun(job.id, {
          nextStatus,
          processedPinIds: merged,
          consecutiveFailures: 0,
          summary,
          error: null,
          nowIso: this.now().toISOString(),
        });
      } catch (error) {
        const message = truncateMiddle(error instanceof Error ? error.message : String(error), 500);
        try {
          const consecutiveFailures = job.consecutiveFailures + 1;
          this.store.recordRun(job.id, {
            nextStatus: consecutiveFailures >= MAX_STUDY_CONSECUTIVE_FAILURES ? 'failed' : 'pending',
            processedPinIds: job.processedPinIds,
            consecutiveFailures,
            summary: null,
            error: message,
            nowIso: this.now().toISOString(),
          });
        } catch (bookkeepingError) {
          // The store itself is unhealthy (e.g. mid sqlite recovery) — log and
          // move on; the job stays pending and is retried on a later tick.
          console.error('[MetawebStudy] failed to record study run outcome:', bookkeepingError instanceof Error ? bookkeepingError.message : String(bookkeepingError));
        }
        console.error('[MetawebStudy] study run failed:', message);
      } finally {
        this.running = false;
        this.runningJobId = null;
      }
      ran += 1;
    }
    return { ran };
  }
}
