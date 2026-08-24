import type { CoworkStore } from '../coworkStore';
import type { DreamStore } from '../dreamStore';
import type { MetaIDExperienceStore } from '../metaidExperienceStore';
import type { MetaIDImpressionStore } from '../metaidImpressionStore';
import type { MetaIDKnowledgeStore } from '../metaidKnowledgeStore';
import { formatBotWorkspaceDate } from '../libs/botWorkspace';
import {
  isMemoryHygieneRunTimeDue,
  type MemoryHygieneConfig,
  type MemoryHygieneRunStats,
} from '../libs/memoryHygienePolicy';

/**
 * Memory hygiene service — the nightly deterministic "compression stroke".
 *
 * The dream pass abstracts raw experience into summaries, memories,
 * impressions and knowledge. This service retires what nothing will read
 * again: supersede stale impression observations, soft-archive old episodes
 * and decayed dream memories, prune knowledge-revision overflow and purge
 * low-risk tombstones. LLM-free and fully deterministic; every step is
 * isolated so one failure never blocks the others, and nothing here can
 * interfere with the dream pipeline (worst case a step retries next night).
 *
 * Scheduling: one pass per local date, eligible from 04:00 (late in the dream
 * window so nightly dreams finish first) and any time later as catch-up.
 * Manual runs (settings UI / IPC) bypass every gate.
 */

const HYGIENE_TICK_INTERVAL_MS = 60_000;
const HYGIENE_STATUS_CHANNEL = 'memoryHygiene:statusChanged';

export interface MemoryHygieneMetabotLike {
  id: number;
  globalmetaid?: string | null;
}

export interface MemoryHygieneMetabotStoreLike {
  listMetabots(): MemoryHygieneMetabotLike[];
}

/** Shared context handed to every step; steps are added one per commit. */
export interface MemoryHygieneRunContext {
  config: MemoryHygieneConfig;
  nowMs: number;
  /** Owner GlobalMetaIDs of bots whose per-bot policy opted out of hygiene. */
  disabledOwners: ReadonlySet<string>;
  coworkStore: CoworkStore;
  dreamStore?: DreamStore;
  experienceStore?: MetaIDExperienceStore;
  impressionStore?: MetaIDImpressionStore;
  knowledgeStore?: MetaIDKnowledgeStore;
}

interface MemoryHygieneStep {
  name: string;
  run: (context: MemoryHygieneRunContext) => Promise<Record<string, number>> | Record<string, number>;
}

export interface MemoryHygieneDeps {
  coworkStore: CoworkStore;
  metabotStore: MemoryHygieneMetabotStoreLike;
  dreamStore?: DreamStore;
  metaidExperienceStore?: MetaIDExperienceStore;
  metaidImpressionStore?: MetaIDImpressionStore;
  metaidKnowledgeStore?: MetaIDKnowledgeStore;
  tickIntervalMs?: number;
  now?: () => Date;
  emitToRenderer?: (channel: string, payload: unknown) => void;
}

export class MemoryHygieneService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopped = false;

  /** Steps registered by later commits (observation compaction, episode archival, …). */
  protected readonly steps: MemoryHygieneStep[] = [];

  constructor(private readonly deps: MemoryHygieneDeps) {
    this.registerSteps();
  }

  /** One entry per compaction mechanism; each is error-isolated by runAll. */
  protected registerSteps(): void {
    // Impression observations: supersede stale ones past the per-pair anchors;
    // the snapshot survives as the compressed state.
    this.steps.push({
      name: 'impression-observations',
      run: (context) => {
        if (!context.impressionStore) return {};
        const result = context.impressionStore.compactObservations({
          cutoffMs: context.nowMs - context.config.observationRetentionDays * 86_400_000,
          anchorsPerPair: context.config.observationAnchorsPerPair,
          excludeObservers: context.disabledOwners,
        });
        return {
          observationPairsCompacted: result.pairsCompacted,
          observationsSuperseded: result.observationsSuperseded,
          observationSnapshotsRebuilt: result.snapshotsRebuilt,
        };
      },
    });
    // Episodes: soft-archive terminal episodes past the retention horizon so
    // dream candidates / contact views / cognition context stop scanning them;
    // explicit experience_recall keeps them visible with an (archived) mark.
    this.steps.push({
      name: 'episodes',
      run: (context) => {
        if (!context.experienceStore) return {};
        const archived = context.experienceStore.archiveEpisodes({
          cutoffMs: context.nowMs - context.config.episodeArchiveDays * 86_400_000,
          archivedAt: context.nowMs,
          excludeOwners: context.disabledOwners,
        });
        return { episodesArchived: archived };
      },
    });
  }

  start(): void {
    this.stopTimer();
    this.stopped = false;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.deps.tickIntervalMs ?? HYGIENE_TICK_INTERVAL_MS);
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

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private emitStatus(stats: MemoryHygieneRunStats): void {
    try {
      this.deps.emitToRenderer?.(HYGIENE_STATUS_CHANNEL, stats);
    } catch {
      // Renderer notification is best-effort.
    }
  }

  getLastRun(): MemoryHygieneRunStats | null {
    return this.deps.coworkStore.getMemoryHygieneLastRun();
  }

  /** Scheduled gate: run-time check plus once-per-local-date dedupe. */
  async tick(): Promise<void> {
    if (this.stopped || this.running) {
      return;
    }
    const now = this.now();
    if (!isMemoryHygieneRunTimeDue(now)) {
      return;
    }
    const dateKey = formatBotWorkspaceDate(now);
    const lastRun = this.deps.coworkStore.getMemoryHygieneLastRun();
    if (lastRun && lastRun.dateKey === dateKey) {
      return;
    }
    await this.runAll('scheduled');
  }

  /** Manual trigger (settings UI / IPC): bypasses the window and dedupe gates. */
  async runNow(): Promise<MemoryHygieneRunStats> {
    return this.runAll('manual');
  }

  async runAll(trigger: 'scheduled' | 'manual'): Promise<MemoryHygieneRunStats> {
    if (this.running) {
      throw new Error('Memory hygiene run already in progress');
    }
    const config = this.deps.coworkStore.getMemoryHygieneConfig();
    if (trigger === 'scheduled' && !config.enabled) {
      // Do not stamp the last-run record: a later enable still runs tonight.
      return {
        dateKey: formatBotWorkspaceDate(this.now()),
        ranAt: this.now().getTime(),
        trigger,
        counts: { skippedDisabled: 1 },
        errors: [],
      };
    }

    this.running = true;
    const stats: MemoryHygieneRunStats = {
      dateKey: formatBotWorkspaceDate(this.now()),
      ranAt: this.now().getTime(),
      trigger,
      counts: {},
      errors: [],
    };
    try {
      const context: MemoryHygieneRunContext = {
        config,
        nowMs: stats.ranAt,
        disabledOwners: this.resolveDisabledOwners(),
        coworkStore: this.deps.coworkStore,
        dreamStore: this.deps.dreamStore,
        experienceStore: this.deps.metaidExperienceStore,
        impressionStore: this.deps.metaidImpressionStore,
        knowledgeStore: this.deps.metaidKnowledgeStore,
      };
      for (const step of this.steps) {
        try {
          const counts = await step.run(context);
          for (const [key, value] of Object.entries(counts)) {
            stats.counts[key] = value;
          }
        } catch (error) {
          const message = `${step.name}: ${error instanceof Error ? error.message : String(error)}`;
          stats.errors.push(message);
          console.warn(`[MemoryHygiene] Step "${step.name}" failed: ${message}`);
        }
      }
      this.deps.coworkStore.setMemoryHygieneLastRun(stats);
      this.emitStatus(stats);
      return stats;
    } finally {
      this.running = false;
    }
  }

  /** Bots whose per-bot policy opts out; their owned stores are skipped by steps. */
  protected resolveDisabledOwners(): Set<string> {
    const owners = new Set<string>();
    try {
      for (const bot of this.deps.metabotStore.listMetabots()) {
        const policy = this.deps.coworkStore.getEffectiveMemoryPolicyForMetabot(bot.id);
        if (!policy.hygieneEnabled && bot.globalmetaid) {
          owners.add(String(bot.globalmetaid));
        }
      }
    } catch (error) {
      console.warn(
        `[MemoryHygiene] Failed to resolve per-bot hygiene policy: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return owners;
  }
}

let memoryHygieneServiceInstance: MemoryHygieneService | null = null;

export function startMemoryHygieneService(deps: MemoryHygieneDeps): MemoryHygieneService {
  stopMemoryHygieneService();
  memoryHygieneServiceInstance = new MemoryHygieneService(deps);
  memoryHygieneServiceInstance.start();
  return memoryHygieneServiceInstance;
}

export function stopMemoryHygieneService(): void {
  memoryHygieneServiceInstance?.stop();
  memoryHygieneServiceInstance = null;
}

export function getMemoryHygieneService(): MemoryHygieneService | null {
  return memoryHygieneServiceInstance;
}
