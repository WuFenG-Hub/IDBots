import type { CoworkStore } from '../coworkStore';
import type { DreamDayActivity, DreamStore } from '../dreamStore';
import {
  DREAM_LOOKBACK_DAYS,
  DREAM_VERSION,
  buildDreamPrompt,
  computeDueDreamDates,
  getDayBoundsMs,
  parseDreamOutput,
  validateSelfIdentity,
  type DreamOutput,
} from '../libs/dreamPrompt';
import { formatBotWorkspaceDate } from '../libs/botWorkspace';
import { performChatCompletionForOrchestrator } from './cognitiveChatCompletion';
import { normalizeMetabotLlmId } from './llmFallback';

/**
 * Dream consolidation service — the nightly "做梦" pipeline.
 *
 * During the nightly window (00:00–06:00 local), each enabled MetaBot reviews
 * its previous day's experiences with its own LLM and produces: a daily
 * summary row, dream-origin memories (self-selected important items + work
 * reviews), and the protected self-identity entry. Missed days (app was off)
 * are caught up on the next start, bounded to the last DREAM_LOOKBACK_DAYS.
 *
 * Design follows the privateChatDaemon module-singleton pattern with an
 * injectable performChat for tests. All runs execute serially through one
 * queue; metabot_dream_runs rows are the idempotency anchor.
 */

const DREAM_TICK_INTERVAL_MS = 60_000;
const DREAM_LLM_TIMEOUT_MS = 180_000;
// Dream prompts carry a full day's activity and require structured JSON.
// Reasoning-style models count hidden reasoning against this same budget.
const DREAM_LLM_MAX_TOKENS = 8192;
const DREAM_STATUS_CHANNEL = 'metabot:dreamStatusChanged';

const EVALUATION_LABELS: Record<string, string> = {
  warming: '升温',
  stable: '持平',
  cooling: '降温',
};

export interface DreamMetabotLike {
  id: number;
  name: string;
  role?: string | null;
  soul?: string | null;
  llm_id?: string | null;
  fallback_llm_id?: string | null;
  enabled?: boolean;
}

export interface DreamMetabotStoreLike {
  listMetabots(): DreamMetabotLike[];
}

export type DreamPerformChat = (
  systemPrompt: string,
  userMessage: string,
  llmId?: string | null,
  options?: {
    signal?: AbortSignal;
    maxTokens?: number;
    fallbackLlmId?: string | null;
    throwOnEmptyContent?: boolean;
  }
) => Promise<string>;

export interface DreamServiceDeps {
  coworkStore: CoworkStore;
  metabotStore: DreamMetabotStoreLike;
  dreamStore: DreamStore;
  performChat?: DreamPerformChat;
  emitToRenderer?: (channel: string, payload: unknown) => void;
  tickIntervalMs?: number;
  llmTimeoutMs?: number;
  now?: () => Date;
}

interface DreamQueueItem {
  metabotId: number;
  date: string;
  /** Version-repair run: refreshes the day's records but never touches identity. */
  isRepair: boolean;
}

function dreamRunKey(metabotId: number, date: string): string {
  return `${metabotId}:${date}`;
}

export class DreamService {
  private readonly performChat: DreamPerformChat;
  private timer: ReturnType<typeof setInterval> | null = null;
  private queue: DreamQueueItem[] = [];
  private processing = false;
  /** Completion signals let manual callers wait even when another queue drain is already active. */
  private runCompletions = new Map<string, Promise<void>>();
  private runCompletionResolvers = new Map<string, () => void>();
  // Instances are live once constructed (runNow works without start());
  // stop() halts queue draining and future ticks.
  private stopped = false;
  private dreamingBots = new Set<number>();
  /** botId → local date key of the night a version repair was last scheduled. */
  private lastRepairNight = new Map<number, string>();

  constructor(private deps: DreamServiceDeps) {
    this.performChat = deps.performChat ?? performChatCompletionForOrchestrator;
  }

  start(): void {
    this.stopTimer();
    this.stopped = false;
    const resetCount = this.deps.dreamStore.resetStaleRunningRuns();
    if (resetCount > 0) {
      console.warn(`[DreamService] Reset ${resetCount} stale running dream run(s) from previous session`);
    }
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.deps.tickIntervalMs ?? DREAM_TICK_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    this.stopTimer();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getDreamingBotIds(): number[] {
    return Array.from(this.dreamingBots);
  }

  isDreaming(metabotId: number): boolean {
    return this.dreamingBots.has(metabotId);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private candidateDates(): string[] {
    const now = this.now();
    const dates: string[] = [];
    for (let daysAgo = 1; daysAgo <= DREAM_LOOKBACK_DAYS; daysAgo++) {
      dates.push(formatBotWorkspaceDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo)));
    }
    return dates;
  }

  /** Scan all enabled bots for due dream dates and drain the queue. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    let bots: DreamMetabotLike[] = [];
    try {
      bots = this.deps.metabotStore.listMetabots().filter((bot) => bot && bot.enabled !== false);
    } catch (error) {
      console.warn('[DreamService] Failed to list metabots:', error);
      return;
    }
    const dates = this.candidateDates();
    const nightKey = formatBotWorkspaceDate(now);
    for (const bot of bots) {
      try {
        const policy = this.deps.coworkStore.getEffectiveMemoryPolicyForMetabot(bot.id);
        if (!policy.dreamEnabled) continue;
        const runStates = this.deps.dreamStore.getRunStates(bot.id, dates);
        const { dueDates, repairDates } = computeDueDreamDates({ now, metabotId: bot.id, runStates });
        for (const date of dueDates) {
          this.enqueue(bot.id, date);
        }
        // Algorithm-version repair: at most one stale date per bot per night,
        // newest first — the window converges over a few nights without a
        // nightly rewrite of the whole lookback range.
        if (repairDates.length > 0 && this.lastRepairNight.get(bot.id) !== nightKey) {
          if (this.enqueue(bot.id, repairDates[0], { isRepair: true })) {
            this.lastRepairNight.set(bot.id, nightKey);
          }
        }
      } catch (error) {
        console.warn(`[DreamService] Due-scan failed for metabot ${bot.id}:`, error);
      }
    }
    await this.processQueue();
  }

  /** Manual trigger (dream:runNow IPC): bypasses window and policy gates. */
  async runNow(metabotId: number, date?: string): Promise<{ metabotId: number; date: string }> {
    const targetDate = date?.trim() || formatBotWorkspaceDate(
      new Date(this.now().getFullYear(), this.now().getMonth(), this.now().getDate() - 1)
    );
    const key = dreamRunKey(metabotId, targetDate);
    if (!this.dreamingBots.has(metabotId)) {
      this.enqueue(metabotId, targetDate, { toFront: true });
    }
    const completion = this.runCompletions.get(key);
    if (!completion) {
      throw new Error(`Dream is already running for metabot ${metabotId}`);
    }
    void this.processQueue();
    await completion;
    return { metabotId, date: targetDate };
  }

  private enqueue(metabotId: number, date: string, options: { toFront?: boolean; isRepair?: boolean } = {}): boolean {
    if (this.dreamingBots.has(metabotId)) return false;
    const existingIndex = this.queue.findIndex((item) => item.metabotId === metabotId && item.date === date);
    if (existingIndex >= 0) {
      if (options.toFront && existingIndex > 0) {
        const [existing] = this.queue.splice(existingIndex, 1);
        this.queue.unshift(existing);
      }
      return false;
    }
    const item: DreamQueueItem = { metabotId, date, isRepair: options.isRepair ?? false };
    const key = dreamRunKey(metabotId, date);
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    this.runCompletions.set(key, completion);
    this.runCompletionResolvers.set(key, resolveCompletion);
    if (options.toFront) {
      this.queue.unshift(item);
    } else {
      this.queue.push(item);
    }
    return true;
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (!this.stopped && this.queue.length > 0) {
        const item = this.queue.shift()!;
        try {
          await this.runDream(item.metabotId, item.date, item.isRepair);
        } finally {
          const key = dreamRunKey(item.metabotId, item.date);
          this.runCompletionResolvers.get(key)?.();
          this.runCompletionResolvers.delete(key);
          this.runCompletions.delete(key);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /** Global override via cowork_config.dreamLlmId → the bot's own llm_id → app default (null). */
  private resolveDreamLlmId(metabot: DreamMetabotLike): string | null {
    const override = this.deps.dreamStore.getCoworkConfigValue('dreamLlmId');
    if (override?.trim()) return override.trim();
    const own = typeof metabot.llm_id === 'string' ? metabot.llm_id.trim() : '';
    return own || null;
  }

  /** The bot's fallback llm_id; skipped when the global dreamLlmId override is in effect. */
  private resolveDreamFallbackLlmId(metabot: DreamMetabotLike): string | null {
    const override = this.deps.dreamStore.getCoworkConfigValue('dreamLlmId');
    if (override?.trim()) return null;
    return normalizeMetabotLlmId(metabot.fallback_llm_id);
  }

  private emitDreaming(metabotId: number, dreaming: boolean): void {
    try {
      this.deps.emitToRenderer?.(DREAM_STATUS_CHANNEL, { metabotId, dreaming });
    } catch (error) {
      console.warn('[DreamService] Failed to emit dream status:', error);
    }
  }

  private async callDreamLlm(systemPrompt: string, userMessage: string, llmId: string | null, fallbackLlmId: string | null = null): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.deps.llmTimeoutMs ?? DREAM_LLM_TIMEOUT_MS);
    try {
      return await this.performChat(systemPrompt, userMessage, llmId, {
        signal: controller.signal,
        maxTokens: DREAM_LLM_MAX_TOKENS,
        fallbackLlmId,
        // Empty content must fail inside runWithLlmFallback so a configured
        // secondary provider gets a chance before the dream attempt fails.
        throwOnEmptyContent: true,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async runDream(metabotId: number, date: string, isRepair = false): Promise<void> {
    if (this.dreamingBots.has(metabotId)) return;
    const metabot = this.deps.metabotStore.listMetabots().find((bot) => bot.id === metabotId) ?? null;
    if (!metabot) {
      console.warn(`[DreamService] Skip dream for unknown metabot ${metabotId}`);
      return;
    }

    this.dreamingBots.add(metabotId);
    this.emitDreaming(metabotId, true);
    const llmId = this.resolveDreamLlmId(metabot);
    const fallbackLlmId = this.resolveDreamFallbackLlmId(metabot);
    this.deps.dreamStore.beginRun(metabotId, date, llmId, DREAM_VERSION);
    try {
      const { startMs, endMs } = getDayBoundsMs(date);
      const activity = this.deps.dreamStore.getActivityForDate(metabotId, startMs, endMs);
      if (activity.sessions.length === 0 && activity.taskRuns.length === 0) {
        // Nothing happened that day — no LLM call, no summary, still recorded.
        this.deps.dreamStore.finishRun(metabotId, date, 'completed');
        return;
      }

      const prompt = buildDreamPrompt({
        botName: metabot.name,
        role: metabot.role,
        soul: metabot.soul,
        date,
        activity,
      });

      let output = await this.generateAndParse(prompt.system, prompt.user, llmId, fallbackLlmId);
      // Repair runs discard selfIdentity in writeDreamResults, so skip the
      // expansion retry instead of burning an extra LLM call on it.
      if (!isRepair) {
        output = await this.ensureSelfIdentity(output, prompt.system, prompt.user, llmId, fallbackLlmId);
      }
      this.writeDreamResults(metabotId, date, output, activity, llmId, isRepair);
      this.deps.dreamStore.finishRun(metabotId, date, 'completed');
      console.log(`[DreamService] Dream completed for metabot ${metabotId} date ${date}${isRepair ? ' (version repair)' : ''}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[DreamService] Dream failed for metabot ${metabotId} date ${date}:`, message);
      this.deps.dreamStore.finishRun(metabotId, date, 'failed', message);
    } finally {
      this.dreamingBots.delete(metabotId);
      this.emitDreaming(metabotId, false);
    }
  }

  /** First attempt + one retry when the output is not parseable JSON. */
  private async generateAndParse(system: string, user: string, llmId: string | null, fallbackLlmId: string | null = null): Promise<DreamOutput> {
    const firstRaw = await this.callDreamLlm(system, user, llmId, fallbackLlmId);
    const first = parseDreamOutput(firstRaw);
    if (first.ok) return first.output;
    const firstError = (first as { ok: false; error: string }).error;

    const retryRaw = await this.callDreamLlm(
      system,
      `${user}\n\n(上一次输出无法解析:${firstError}。请严格只输出一个 JSON 对象,不要输出任何其他文字。)`,
      llmId,
      fallbackLlmId
    );
    const retry = parseDreamOutput(retryRaw);
    if (retry.ok) return retry.output;
    throw new Error(`dream output unparseable after retry: ${(retry as { ok: false; error: string }).error}`);
  }

  /** One retry when self_identity is missing or under the 200-char minimum. */
  private async ensureSelfIdentity(
    output: DreamOutput,
    system: string,
    user: string,
    llmId: string | null,
    fallbackLlmId: string | null = null
  ): Promise<DreamOutput> {
    const validation = validateSelfIdentity(output.selfIdentity);
    if (validation.valid) return output;

    const retryRaw = await this.callDreamLlm(
      system,
      `${user}\n\n(上一次的 self_identity ${output.selfIdentity ? `只有 ${validation.charCount} 个非空白字符` : '缺失'}。请重新输出完整 JSON,其中 self_identity 不少于 200 个非空白字符,认真写一段「我是谁」。)`,
      llmId,
      fallbackLlmId
    );
    const retry = parseDreamOutput(retryRaw);
    if (retry.ok && validateSelfIdentity(retry.output.selfIdentity).valid) {
      return retry.output;
    }
    // Keep the original output rather than failing the whole run over length.
    console.warn('[DreamService] self_identity still below minimum after retry; keeping best effort output');
    return output.selfIdentity ? output : (retry.ok ? retry.output : output);
  }

  private writeDreamResults(
    metabotId: number,
    date: string,
    output: DreamOutput,
    activity: DreamDayActivity,
    llmId: string | null,
    isRepair: boolean
  ): void {
    this.deps.dreamStore.upsertDailySummary({
      metabotId,
      summaryDate: date,
      summaryText: output.dailySummary,
      sections: output.sections,
      stats: {
        sessionCount: activity.sessions.length,
        orderSessionCount: activity.sessions.filter((session) => session.isOrder).length,
        orderCount: activity.orderCount,
        taskRunCount: activity.taskRuns.length,
        messageCount: activity.sessions.reduce((sum, session) => sum + session.messages.length, 0),
      },
      sessionRefs: activity.sessions.map((session) => ({
        sessionId: session.sessionId,
        title: session.title,
        sessionType: session.sessionType,
        isOrder: session.isOrder,
      })),
      llmId,
    });

    // Idempotent per-date batch: replace the day's dream memories wholesale so
    // retries and version repairs never pile duplicates into the store.
    const removed = this.deps.coworkStore.softDeleteDreamMemoriesForDate(metabotId, date);
    if (removed > 0) {
      console.log(`[DreamService] Replaced ${removed} existing dream memories for metabot ${metabotId} date ${date}`);
    }

    for (const text of new Set(output.importantMemories)) {
      this.deps.coworkStore.createUserMemory({
        metabotId,
        text,
        scopeKind: 'owner',
        scopeKey: 'owner:self',
        usageClass: 'profile_fact',
        origin: 'dream',
        isExplicit: true,
        forceNew: true,
        source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: date },
      });
    }

    const seenLessons = new Set<string>();
    for (const lesson of output.valueLessons) {
      const text = lesson.source ? `${lesson.rule}(源自:${lesson.source})` : lesson.rule;
      if (seenLessons.has(text)) continue;
      seenLessons.add(text);
      this.deps.coworkStore.createUserMemory({
        metabotId,
        text,
        scopeKind: 'owner',
        scopeKey: 'owner:self',
        usageClass: 'value_boundary',
        origin: 'dream',
        isExplicit: true,
        forceNew: true,
        source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: date },
      });
    }

    const seenReviews = new Set<string>();
    for (const review of output.workReviews) {
      const text = [
        `工作:${review.subject}`,
        `对象:${review.counterparty || '未知'}`,
        `评价:${EVALUATION_LABELS[review.evaluation] ?? EVALUATION_LABELS.stable}`,
        review.note ? `依据:${review.note}` : '',
      ].filter(Boolean).join(';');
      if (seenReviews.has(text)) continue;
      seenReviews.add(text);
      this.deps.coworkStore.createUserMemory({
        metabotId,
        text,
        scopeKind: 'owner',
        scopeKey: 'owner:self',
        usageClass: 'work_review',
        origin: 'dream',
        isExplicit: true,
        forceNew: true,
        source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: date },
      });
    }

    // Self-identity only moves forward in time: version repairs never touch
    // it, and a normal run for a date older than the identity's current
    // source date must not regress it either.
    if (output.selfIdentity && !isRepair) {
      const latestIdentityDate = this.deps.coworkStore.getDreamIdentityLatestDate(metabotId);
      if (latestIdentityDate && date < latestIdentityDate) {
        console.log(`[DreamService] Skip self-identity update for metabot ${metabotId}: date ${date} older than current source ${latestIdentityDate}`);
      } else {
        const existing = this.deps.coworkStore.listUserMemories({
          metabotId,
          scopeKind: 'owner',
          scopeKey: 'owner:self',
          usageClass: 'self_identity',
          status: 'all',
          limit: 1,
        })[0];
        if (existing) {
          this.deps.coworkStore.updateUserMemory({
            id: existing.id,
            metabotId,
            text: output.selfIdentity,
            usageClass: 'self_identity',
            allowProtected: true,
            source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: date },
          });
        } else {
          this.deps.coworkStore.createUserMemory({
            metabotId,
            text: output.selfIdentity,
            scopeKind: 'owner',
            scopeKey: 'owner:self',
            usageClass: 'self_identity',
            origin: 'dream',
            isExplicit: true,
            confidence: 0.9,
            forceNew: true,
            source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: date },
          });
        }
      }
    }
  }
}

let dreamServiceInstance: DreamService | null = null;

export function startDreamService(deps: DreamServiceDeps): DreamService {
  stopDreamService();
  dreamServiceInstance = new DreamService(deps);
  dreamServiceInstance.start();
  return dreamServiceInstance;
}

export function stopDreamService(): void {
  dreamServiceInstance?.stop();
  dreamServiceInstance = null;
}

export function getDreamService(): DreamService | null {
  return dreamServiceInstance;
}
