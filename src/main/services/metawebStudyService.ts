import {
  DEFAULT_STUDY_PIN_BUDGET_PER_NIGHT,
  MAX_STUDY_CONSECUTIVE_FAILURES,
  MAX_STUDY_RUNS_PER_JOB,
  MetawebStudyJobStore,
  normalizeStudyTopic,
  studyTopicFingerprintOf,
  type MetawebStudyJobRecord,
  type MetawebStudyJobStatus,
} from '../metawebStudyJobStore';
import { KNOWLEDGE_BASE_AUTO_LEARN_WINDOW } from './knowledgeBaseService';
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
 */

const TICK_MS = 30 * 60 * 1000;
const MAX_BUDGET_PINS = 50;
/** Cap the already-processed pinId list injected into a study prompt. */
const PROMPT_PROCESSED_PIN_CAP = 80;

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
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Runs are serialized globally — one background study session at a time. */
  private running = false;
  /** Job currently running in THIS process (null when idle) — see startSchedule. */
  private runningJobId: string | null = null;

  constructor(deps: MetawebStudyServiceDeps) {
    this.store = deps.store;
    this.runStudyJob = deps.runStudyJob;
    this.now = deps.now ?? (() => new Date());
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
      this.running = true;
      this.runningJobId = job.id;
      try {
        this.store.markRunning(job.id, this.now().toISOString());
        const result = await this.runStudyJob(this.store.getById(job.id) ?? job);
        const merged = [...new Set([...job.processedPinIds, ...result.newPinIds])];
        const newCount = merged.length - job.processedPinIds.length;
        const runCount = job.runCount + 1;
        const nextStatus: MetawebStudyJobStatus =
          newCount === 0 || runCount >= MAX_STUDY_RUNS_PER_JOB ? 'done' : 'pending';
        const summary =
          nextStatus === 'done' && runCount >= MAX_STUDY_RUNS_PER_JOB && newCount > 0
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
