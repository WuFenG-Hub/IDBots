/**
 * SurfService — the autonomous MetaWeb surf ("AI 冲浪") loop.
 *
 * One run: stage-0 briefing (deterministic) → optional unattended LLM session
 * (injected; learns/engages in persona) → watermarks advance, report lands in
 * metaweb_surf_runs for the UI and the same night's dream.
 *
 * Design follows the DreamService module-singleton pattern with injectable
 * session/broadcast for tests. Per-bot mutex in memory; metaweb_surf_runs rows
 * are the crash-recovery anchor.
 */

import { randomUUID } from 'node:crypto';

import {
  emptySurfRunStats,
  type MetawebSurfRunRecord,
  type MetawebSurfRunStats,
  type MetawebSurfSeenAction,
  type MetawebSurfStore,
  type MetawebSurfTrigger,
} from '../metawebSurfStore';
import { buildSurfBriefing, renderSurfBriefingMarkdown, type SurfBriefing } from '../libs/surfBriefing';
import { extractSurfNotesFromReportJson } from '../libs/surfPrompt';
import { DEFAULT_SURF_PROTOCOLS, type SurfProtocolDescriptor } from '../libs/surfProtocols';
import { getSurfInteractionBudget, isSurfBeforeDreamEnabled, type SurfSettingsReader } from './surfSettings';

export const SURF_STATUS_CHANNEL = 'metabot:surfStatusChanged';
/** A finished surf younger than this makes the pre-dream surf redundant. */
export const PRE_DREAM_SURF_RECENCY_MS = 20 * 60 * 60 * 1000;

export interface SurfStatusEvent {
  metabotId: number;
  runId: string;
  trigger: MetawebSurfTrigger;
  status: 'running' | 'done' | 'failed';
  error?: string | null;
}

export interface SurfMetabotStoreLike extends SurfSettingsReader {
  getMetabotById(id: number): { id: number; name: string } | null;
}

export interface SurfSessionContext {
  runId: string;
  metabotId: number;
  botName: string;
  trigger: MetawebSurfTrigger;
  briefing: SurfBriefing;
  /**
   * Set by the host session wiring (main.ts): false runs the DEGRADED prompt
   * variant (no KB/memory tools exist in that session) — manual triggers are
   * allowed with memory off (review 2, item 9 option B). Absent → full prompt.
   */
  memoryEnabled?: boolean;
  /**
   * The "notes for next surf" the bot wrote in its last DONE run's report,
   * read back out of reportJson (round 3: notes were a write-only channel).
   * Absent/null → no notes section in the prompt.
   */
  previousNotes?: string | null;
}

export interface SurfSessionResult {
  stats?: Partial<MetawebSurfRunStats>;
  reportMarkdown?: string | null;
  reportJson?: string | null;
  /** Per-pin actions reported by the session, folded into the seen ledger. */
  seenActions?: Array<{ pinId: string; action: import('../metawebSurfStore').MetawebSurfSeenAction }>;
}

export interface SurfServiceDeps {
  store: MetawebSurfStore;
  metabotStore: SurfMetabotStoreLike;
  broadcast: (payload: SurfStatusEvent) => void;
  /** Phase-3 LLM session; absent → digest-only run (still useful: report + watermarks). */
  runSurfSession?: (context: SurfSessionContext) => Promise<SurfSessionResult>;
  /**
   * Memory policy (same source the study service reads). Only the PRE-DREAM
   * path is gated: the nightly unattended run learns into the KB, so with
   * memory off it is skipped. Manual triggers deliberately run DEGRADED with
   * memory off (owner decision, review 2 item 9 option B) — the session gets
   * no KB/memory tools and the prompt says so. Absent → gate off (tests).
   */
  isMemoryEnabled?: (metabotId: number) => boolean;
  registry?: SurfProtocolDescriptor[];
  nowMs?: () => number;
}

export class SurfService {
  private readonly store: MetawebSurfStore;
  private readonly metabotStore: SurfMetabotStoreLike;
  private readonly broadcast: (payload: SurfStatusEvent) => void;
  private readonly runSurfSession?: (context: SurfSessionContext) => Promise<SurfSessionResult>;
  private readonly isMemoryEnabled?: (metabotId: number) => boolean;
  private readonly registry: SurfProtocolDescriptor[];
  private readonly nowMs: () => number;
  private readonly runningByMetabot = new Map<number, string>();

  constructor(deps: SurfServiceDeps) {
    this.store = deps.store;
    this.metabotStore = deps.metabotStore;
    this.broadcast = deps.broadcast;
    this.runSurfSession = deps.runSurfSession;
    this.isMemoryEnabled = deps.isMemoryEnabled;
    this.registry = deps.registry ?? DEFAULT_SURF_PROTOCOLS;
    this.nowMs = deps.nowMs ?? (() => Date.now());
  }

  /** Crash recovery at startup: runs orphaned by a killed process become failed. */
  recoverAfterRestart(excludeRunId?: string): number {
    return this.store.failStaleRunningRuns({
      error: 'App restarted during surf run',
      nowIso: new Date(this.nowMs()).toISOString(),
      excludeId: excludeRunId,
    });
  }

  isRunning(metabotId: number): boolean {
    return this.runningByMetabot.has(metabotId);
  }

  /**
   * The notes the bot wrote to itself in its last DONE run (round 3): read
   * back out of reportJson so the next surf inherits its hard-won lessons.
   * Best-effort — a missing/malformed note must never block a run.
   */
  private latestSurfNotes(metabotId: number): string | null {
    try {
      const latest = this.store.getLatestFinishedRun(metabotId);
      return extractSurfNotesFromReportJson(latest?.reportJson ?? null);
    } catch {
      return null;
    }
  }

  /**
   * Pre-dream gate: the bot's surf-before-dream toggle is on (default) and it
   * has not finished a surf within the recency window (a manual evening surf
   * makes the nightly one redundant).
   */
  shouldPreDreamSurf(metabotId: number): boolean {
    if (!isSurfBeforeDreamEnabled(this.metabotStore, metabotId)) return false;
    if (this.isRunning(metabotId)) return false;
    try {
      // A bot without memory learns nothing from surfing — skip quietly here
      // (the dream proceeds either way); manual triggers fail loudly instead.
      if (this.isMemoryEnabled?.(metabotId) === false) return false;
    } catch {
      return false;
    }
    const latest = this.store.getLatestFinishedRun(metabotId);
    if (!latest?.finishedAt) return true;
    const finishedMs = Date.parse(latest.finishedAt);
    if (!Number.isFinite(finishedMs)) return true;
    return this.nowMs() - finishedMs >= PRE_DREAM_SURF_RECENCY_MS;
  }

  /**
   * Start a surf run in the background; returns the created run row.
   * Throws when the bot does not exist or a run is already in flight.
   */
  startSurf(metabotId: number, trigger: MetawebSurfTrigger): MetawebSurfRunRecord {
    const run = this.beginRun(metabotId, trigger);
    void this.executeRun(run.id).catch(() => {
      // executeRun records failures on the run row itself; this catch only
      // guards against bugs in the failure-recording path.
    });
    return run;
  }

  /** Awaitable variant for the pre-dream pipeline. */
  async runSurfAndWait(metabotId: number, trigger: MetawebSurfTrigger): Promise<MetawebSurfRunRecord> {
    const run = this.beginRun(metabotId, trigger);
    await this.executeRun(run.id).catch(() => undefined);
    return this.store.getRun(run.id) ?? run;
  }

  private beginRun(metabotId: number, trigger: MetawebSurfTrigger): MetawebSurfRunRecord {
    const bot = this.metabotStore.getMetabotById(metabotId);
    if (!bot) throw new Error(`MetaBot ${metabotId} not found`);
    // Only pre-dream is memory-gated (same gate as dreaming). Manual triggers
    // run DEGRADED with memory off (owner decision — review 2 item 9, option
    // B / plan §4.7): the session then has no KB/memory tools and the prompt
    // says so, but the bot can still browse, engage, and handle its inbox.
    if (trigger === 'pre-dream' && this.isMemoryEnabled?.(metabotId) === false) {
      throw new Error('Pre-dream surf requires memory enabled (same gate as dreaming).');
    }
    if (this.runningByMetabot.has(metabotId)) {
      throw new Error('A surf run is already in progress for this bot');
    }
    const nowIso = new Date(this.nowMs()).toISOString();
    const run = this.store.createRun({ id: randomUUID(), metabotId, trigger, nowIso });
    this.runningByMetabot.set(metabotId, run.id);
    this.broadcast({ metabotId, runId: run.id, trigger, status: 'running' });
    return run;
  }

  private async executeRun(runId: string): Promise<void> {
    const run = this.store.getRun(runId);
    if (!run) return;
    const { metabotId, trigger } = run;
    const bot = this.metabotStore.getMetabotById(metabotId);
    const finish = (outcome: 'done' | 'failed', error: string | null) => {
      this.broadcast({ metabotId, runId, trigger, status: outcome, error });
      this.runningByMetabot.delete(metabotId);
    };
    let fetchedCount = 0;
    try {
      const budget = getSurfInteractionBudget(this.metabotStore, metabotId);
      const briefing = await buildSurfBriefing({
        store: this.store,
        metabotId,
        interactionBudget: budget,
        registry: this.registry,
        nowMs: this.nowMs(),
      });
      fetchedCount = briefing.items.length;

      const stats: MetawebSurfRunStats = { ...emptySurfRunStats(), fetched: briefing.items.length };
      let reportMarkdown: string | null = null;
      let reportJson: string | null = null;
      const sessionSeenActions: Array<{ pinId: string; action: MetawebSurfSeenAction }> = [];
      if (this.runSurfSession) {
        const session = await this.runSurfSession({
          runId,
          metabotId,
          botName: bot?.name ?? `Bot ${metabotId}`,
          trigger,
          briefing,
          previousNotes: this.latestSurfNotes(metabotId),
        });
        Object.assign(stats, session.stats ?? {});
        reportMarkdown = session.reportMarkdown ?? null;
        reportJson = session.reportJson ?? null;
        sessionSeenActions.push(...(session.seenActions ?? []));
      }

      // Seen-ledger writes land ONLY on this success path: every briefed pin
      // becomes 'presented' and the session's self-reported actions fold on
      // top (strongest action wins, one batched store write). A run that
      // fails before this point leaves the ledger untouched, so the next
      // surf re-presents the same window — one bad night (LLM timeout,
      // outage) never silently drops that content (review P1).
      const nowIso = new Date(this.nowMs()).toISOString();
      this.store.markSeenBatch(metabotId, [
        ...briefing.items.map((item) => ({ pinId: item.pinId, action: 'presented' as const })),
        ...sessionSeenActions,
      ], nowIso);

      // Watermarks advance only after the run body completed, and only for
      // protocols with a usable cursor (fetch errors and fully crowded-out
      // sections keep their old cursor so the next surf retries them).
      for (const section of briefing.protocols) {
        if (!section.error && section.nextWatermarkTs !== null) {
          this.store.advanceProtocolState(metabotId, section.key, {
            lastSeenTs: section.nextWatermarkTs,
            lastPinId: null,
            nowIso,
          });
        }
      }
      this.store.pruneSeenPins(metabotId, nowIso);

      const digest = renderSurfBriefingMarkdown(briefing);
      this.store.finishRun(runId, {
        status: 'done',
        stats,
        reportMarkdown: reportMarkdown ? `${reportMarkdown}\n\n---\n\n${digest}` : digest,
        reportJson,
        finishedAtIso: nowIso,
      });
      finish('done', null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Round 3: a failed run keeps the REAL numbers the host can vouch for
      // (fetched from the briefing; deep reads / KB adds / chain interactions
      // attached to the session error by main.ts runSurfSession) instead of
      // the historical all-zero stats.
      const partial = (error as { surfPartialStats?: Partial<MetawebSurfRunStats> } | null)?.surfPartialStats;
      this.store.finishRun(runId, {
        status: 'failed',
        stats: { ...emptySurfRunStats(), fetched: fetchedCount, ...(partial ?? {}) },
        error: message,
        finishedAtIso: new Date(this.nowMs()).toISOString(),
      });
      finish('failed', message);
    }
  }
}
