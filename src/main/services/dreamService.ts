import type { CoworkStore } from '../coworkStore';
import type { DreamDayActivity, DreamStore } from '../dreamStore';
import {
  DREAM_LOOKBACK_DAYS,
  buildDreamPrompt,
  computeDueDreamDates,
  getDayBoundsMs,
  parseDreamOutput,
  validateSelfIdentity,
  type DreamOutput,
} from '../libs/dreamPrompt';
import { formatBotWorkspaceDate } from '../libs/botWorkspace';
import { performChatCompletionForOrchestrator } from './cognitiveChatCompletion';

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
const DREAM_LLM_MAX_TOKENS = 4096;
const DREAM_STATUS_CHANNEL = 'metabot:dreamStatusChanged';

const EVALUATION_LABELS: Record<string, string> = {
  none: '没什么评价',
  praise: '高度赞扬',
  dissatisfied: '好像不太满意',
  neutral: '一般',
};

export interface DreamMetabotLike {
  id: number;
  name: string;
  role?: string | null;
  soul?: string | null;
  llm_id?: string | null;
  enabled?: boolean;
}

export interface DreamMetabotStoreLike {
  listMetabots(): DreamMetabotLike[];
}

export type DreamPerformChat = (
  systemPrompt: string,
  userMessage: string,
  llmId?: string | null,
  options?: { signal?: AbortSignal; maxTokens?: number }
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
}

export class DreamService {
  private readonly performChat: DreamPerformChat;
  private timer: ReturnType<typeof setInterval> | null = null;
  private queue: DreamQueueItem[] = [];
  private processing = false;
  // Instances are live once constructed (runNow works without start());
  // stop() halts queue draining and future ticks.
  private stopped = false;
  private dreamingBots = new Set<number>();

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
    for (const bot of bots) {
      try {
        const policy = this.deps.coworkStore.getEffectiveMemoryPolicyForMetabot(bot.id);
        if (!policy.dreamEnabled) continue;
        const runStates = this.deps.dreamStore.getRunStates(bot.id, dates);
        const dueDates = computeDueDreamDates({ now, metabotId: bot.id, runStates });
        for (const date of dueDates) {
          this.enqueue(bot.id, date);
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
    this.enqueue(metabotId, targetDate, true);
    await this.processQueue();
    return { metabotId, date: targetDate };
  }

  private enqueue(metabotId: number, date: string, toFront = false): void {
    if (this.dreamingBots.has(metabotId)) return;
    if (this.queue.some((item) => item.metabotId === metabotId && item.date === date)) return;
    if (toFront) {
      this.queue.unshift({ metabotId, date });
    } else {
      this.queue.push({ metabotId, date });
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (!this.stopped && this.queue.length > 0) {
        const item = this.queue.shift()!;
        await this.runDream(item.metabotId, item.date);
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

  private emitDreaming(metabotId: number, dreaming: boolean): void {
    try {
      this.deps.emitToRenderer?.(DREAM_STATUS_CHANNEL, { metabotId, dreaming });
    } catch (error) {
      console.warn('[DreamService] Failed to emit dream status:', error);
    }
  }

  private async callDreamLlm(systemPrompt: string, userMessage: string, llmId: string | null): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.deps.llmTimeoutMs ?? DREAM_LLM_TIMEOUT_MS);
    try {
      return await this.performChat(systemPrompt, userMessage, llmId, {
        signal: controller.signal,
        maxTokens: DREAM_LLM_MAX_TOKENS,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async runDream(metabotId: number, date: string): Promise<void> {
    if (this.dreamingBots.has(metabotId)) return;
    const metabot = this.deps.metabotStore.listMetabots().find((bot) => bot.id === metabotId) ?? null;
    if (!metabot) {
      console.warn(`[DreamService] Skip dream for unknown metabot ${metabotId}`);
      return;
    }

    this.dreamingBots.add(metabotId);
    this.emitDreaming(metabotId, true);
    const llmId = this.resolveDreamLlmId(metabot);
    this.deps.dreamStore.beginRun(metabotId, date, llmId);
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

      let output = await this.generateAndParse(prompt.system, prompt.user, llmId);
      output = await this.ensureSelfIdentity(output, prompt.system, prompt.user, llmId);
      this.writeDreamResults(metabotId, date, output, activity, llmId);
      this.deps.dreamStore.finishRun(metabotId, date, 'completed');
      console.log(`[DreamService] Dream completed for metabot ${metabotId} date ${date}`);
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
  private async generateAndParse(system: string, user: string, llmId: string | null): Promise<DreamOutput> {
    const firstRaw = await this.callDreamLlm(system, user, llmId);
    const first = parseDreamOutput(firstRaw);
    if (first.ok) return first.output;
    const firstError = (first as { ok: false; error: string }).error;

    const retryRaw = await this.callDreamLlm(
      system,
      `${user}\n\n(上一次输出无法解析:${firstError}。请严格只输出一个 JSON 对象,不要输出任何其他文字。)`,
      llmId
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
    llmId: string | null
  ): Promise<DreamOutput> {
    const validation = validateSelfIdentity(output.selfIdentity);
    if (validation.valid) return output;

    const retryRaw = await this.callDreamLlm(
      system,
      `${user}\n\n(上一次的 self_identity ${output.selfIdentity ? `只有 ${validation.charCount} 个非空白字符` : '缺失'}。请重新输出完整 JSON,其中 self_identity 不少于 200 个非空白字符,认真写一段「我是谁」。)`,
      llmId
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
    llmId: string | null
  ): void {
    this.deps.dreamStore.upsertDailySummary({
      metabotId,
      summaryDate: date,
      summaryText: output.dailySummary,
      sections: output.sections,
      stats: {
        sessionCount: activity.sessions.length,
        orderSessionCount: activity.sessions.filter((session) => session.isOrder).length,
        taskRunCount: activity.taskRuns.length,
        messageCount: activity.sessions.reduce((sum, session) => sum + session.messages.length, 0),
      },
      llmId,
    });

    for (const text of output.importantMemories) {
      this.deps.coworkStore.createUserMemory({
        metabotId,
        text,
        scopeKind: 'owner',
        scopeKey: 'owner:self',
        usageClass: 'profile_fact',
        origin: 'dream',
        isExplicit: true,
        source: { sourceType: 'dream', sourceChannel: 'dream' },
      });
    }

    for (const review of output.workReviews) {
      const text = [
        `工作:${review.subject}`,
        `对象:${review.counterparty || '未知'}`,
        `评价:${EVALUATION_LABELS[review.evaluation] ?? EVALUATION_LABELS.none}`,
        review.note ? `依据:${review.note}` : '',
      ].filter(Boolean).join(';');
      this.deps.coworkStore.createUserMemory({
        metabotId,
        text,
        scopeKind: 'owner',
        scopeKey: 'owner:self',
        usageClass: 'work_review',
        origin: 'dream',
        isExplicit: true,
        source: { sourceType: 'dream', sourceChannel: 'dream' },
      });
    }

    if (output.selfIdentity) {
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
          source: { sourceType: 'dream', sourceChannel: 'dream' },
        });
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
