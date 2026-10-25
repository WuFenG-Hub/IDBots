import type { ChainWriteCreatePin } from './postBuzzAgentTools';
import { SEEN_ACTION_RANK, type MetawebSurfSeenAction } from '../metawebSurfStore';

/**
 * Surf-session write state, carried on ActiveSession.metawebSurfSession.
 *
 * The inline tool surface is rebuilt on every DSH turn, so any counter kept
 * in a tool closure silently resets whenever the surface is rebuilt. Keeping
 * the counters on the session marker (one object per ActiveSession, stable
 * across turns) makes the interaction budget and the duplicate-interaction
 * record structural instead of incidental (review P2.1).
 */
export interface SurfSessionWriteState {
  /** Hard ceiling of chain-writing interactions for this run (0 = none). */
  interactionBudget: number;
  /**
   * Hard ceiling of ORIGINAL posts (buzz/note/question — writes with no
   * interaction target) for this run. P1a: posts draw on this SEPARATE pool
   * so creating never crowds out likes/comments. Absent (legacy states) falls
   * back to sharing the interaction pool — the pre-P1a behavior.
   */
  creationBudget?: number;
  /** Hard ceiling of metaweb-source KB adds for this run. */
  kbBudget: number;
  /** Chain writes attempted so far this run (attempts count, even failed ones). */
  writesUsed?: number;
  /** Original posts attempted so far this run (the creation pool counter). */
  creationsUsed?: number;
  /** metaweb-source KB adds so far this run (read by the KB wrapper). */
  kbAddsUsed?: number;
  /**
   * Hard ceiling of deduped deep reads for this run (surfDeepReadBudgetExceeded).
   * Absent (legacy states) falls back to the caller-provided default, which
   * the wrapper derives from the prompt guidance constant.
   */
  deepReadBudget?: number;
  /** targetPinId → strongest interaction rank published this run (dup guard). */
  interactions?: Record<string, number>;
  /**
   * pinIds of ORIGINAL posts actually published this run (buzz/note/question/
   * rev) — the 'posted' receipt class. Read back after the session as ground
   * truth (review 2, item 6).
   */
  postedPinIds?: string[];
  /**
   * pinIds actually deep-read this run (recorded by the readPin wrapper —
   * readable pins only, deduped). Success path: folded over the model's
   * self-reported readPinIds (receipts over self-report, round 3). Failure
   * path: powers the real partial stats on the failed run row — these pins
   * deliberately stay OUT of the seen ledger so the next surf re-presents
   * them (the run's saves are lost; the catch-up must get another chance).
   */
  readPinIds?: string[];
  /**
   * Scheduled tasks actually created this run (create_scheduled_task — the
   * surf→work handoff, Step 1 of broadcast collaboration). Counter drives the
   * per-run hard cap; ids are the ground-truth receipt for the run stats.
   */
  tasksScheduled?: number;
  /** Ids of the scheduled tasks created this run (same order as created). */
  scheduledTaskIds?: string[];
}

export type SurfSeenLedgerReader = (
  metabotId: number,
  pinId: string,
) => MetawebSurfSeenAction | null;

const RECEIPT_ACTION_BY_RANK = new Map<number, MetawebSurfSeenAction>(
  (['liked', 'commented', 'answered', 'challenged'] as MetawebSurfSeenAction[])
    .map((action) => [SEEN_ACTION_RANK[action], action]),
);

/** Chain-write classes whose ledger entries come ONLY from guard receipts. */
const RECEIPT_ACTIONS = new Set<MetawebSurfSeenAction>(['liked', 'commented', 'answered', 'posted', 'challenged']);

/**
 * The run's ACTUAL on-chain writes as seen-ledger entries, read back from
 * the guard-mutated write state after the session — the ground truth the
 * model's self-report is checked against (review 2, item 6).
 */
export function surfReceiptSeenActions(
  state: SurfSessionWriteState,
): Array<{ pinId: string; action: MetawebSurfSeenAction }> {
  const fromInteractions = Object.entries(state.interactions ?? {})
    .map(([pinId, rank]) => ({ pinId, action: RECEIPT_ACTION_BY_RANK.get(rank) }))
    .filter((entry): entry is { pinId: string; action: MetawebSurfSeenAction } => Boolean(entry.action));
  const fromPosts = (state.postedPinIds ?? [])
    .map((pinId) => String(pinId || '').trim())
    .filter(Boolean)
    .map((pinId) => ({ pinId, action: 'posted' as MetawebSurfSeenAction }));
  return [...fromInteractions, ...fromPosts];
}

/**
 * Fold receipts over the session's self-reported seen actions: every
 * chain-write class comes ONLY from what the guard actually published — a
 * like the model forgot to report is still banked, a like it merely claimed
 * is dropped. Read/saved-class entries stay self-reported (their blast
 * radius is one bot's digest, not gas).
 */
export function foldSurfReceiptsIntoSeenActions(
  selfReported: Array<{ pinId: string; action: MetawebSurfSeenAction }>,
  state: SurfSessionWriteState,
): Array<{ pinId: string; action: MetawebSurfSeenAction }> {
  return [
    ...selfReported.filter((entry) => !RECEIPT_ACTIONS.has(entry.action)),
    ...surfReceiptSeenActions(state),
    // Deep-read receipts ride on top of the self-report (the batch store
    // keeps the strongest action per pin, so a self-reported 'saved' still
    // wins over a tracked 'read' of the same pin).
    ...surfDeepReadReceiptSeenActions(state),
  ];
}

/** Record one actual deep read on the session marker (deduped). */
export function recordSurfDeepRead(state: SurfSessionWriteState, pinId: string): void {
  const clean = String(pinId ?? '').trim();
  if (!clean) return;
  const reads = state.readPinIds ?? (state.readPinIds = []);
  if (!reads.includes(clean)) reads.push(clean);
}

/**
 * Deep-read budget check: the prompt's "at most ~N deep reads" guidance is
 * advisory only, so a runaway model loop could read unboundedly (each read
 * rides the resent transcript and grows every later round). The wrapper in
 * coworkRunner consults this before every readPin/readPinsBatch call and
 * hard-stops the run at the budget, mirroring the KB-add budget error.
 */
export function surfDeepReadBudgetExceeded(
  state: SurfSessionWriteState,
  defaultBudget: number,
): boolean {
  const budget = Math.max(0, Math.floor(Number(state.deepReadBudget ?? defaultBudget) || 0));
  if (budget <= 0) return false;
  return (state.readPinIds?.length ?? 0) >= budget;
}

/** The run's tracked deep reads as 'read'-class seen-ledger entries. */
export function surfDeepReadReceiptSeenActions(
  state: SurfSessionWriteState,
): Array<{ pinId: string; action: MetawebSurfSeenAction }> {
  return (state.readPinIds ?? []).map((pinId) => ({ pinId, action: 'read' as const }));
}

/**
 * What the host can vouch for on a FAILED run (round 3): real counts from the
 * guard-mutated marker — chain interactions by their strongest action, posts,
 * KB adds and tracked deep reads. Attached to the session error so the failed
 * run row stops reporting all-zero stats.
 */
export function surfSessionPartialStats(
  state: SurfSessionWriteState,
): Partial<import('../metawebSurfStore').MetawebSurfRunStats> {
  const stats: Partial<import('../metawebSurfStore').MetawebSurfRunStats> = {};
  const receipts = surfReceiptSeenActions(state);
  const countOf = (action: MetawebSurfSeenAction) => receipts.filter((entry) => entry.action === action).length;
  if (receipts.length > 0) {
    stats.liked = countOf('liked');
    stats.commented = countOf('commented');
    stats.answered = countOf('answered');
    stats.challenged = countOf('challenged');
    stats.posted = countOf('posted');
  }
  if ((state.kbAddsUsed ?? 0) > 0) stats.savedToKb = state.kbAddsUsed;
  if ((state.readPinIds?.length ?? 0) > 0) stats.deepRead = state.readPinIds!.length;
  if ((state.tasksScheduled ?? 0) > 0) stats.tasksScheduled = state.tasksScheduled;
  return stats;
}

/**
 * Chain-write paths whose payload targets ANOTHER pin — the "never interact
 * with the same pin twice" rule (review P2.3) applies to exactly these.
 * Original posts (buzz/note/question/rev) have no target and skip the check.
 */
const INTERACTION_TARGETS: Array<{
  path: string;
  action: MetawebSurfSeenAction;
  payloadFields: string[];
}> = [
  { path: '/protocols/paylike', action: 'liked', payloadFields: ['likeTo'] },
  { path: '/protocols/paycomment', action: 'commented', payloadFields: ['commentTo'] },
  { path: '/protocols/simpleanswer', action: 'answered', payloadFields: ['answerTo'] },
  { path: '/protocols/agentpedia/challenge', action: 'challenged', payloadFields: ['targetRev', 'target_rev'] },
];

interface InteractionTarget {
  pinId: string;
  action: MetawebSurfSeenAction;
}

/**
 * Re-derive one bot's surf receipts from a local chain-writes ledger row
 * (round 3 reconciliation): the row's own pin is always a 'posted' receipt
 * (the bot published it), and an interaction payload yields its target
 * receipt on top. Used to backfill the seen ledger before a surf run, so
 * receipts lost to a crash/kill mid-run (or a stopped orphan session) can
 * never cause a paid duplicate interaction.
 */
export function surfReceiptsFromChainWriteRecord(record: {
  pinId: string;
  path?: string | null;
  contentText?: string | null;
}): Array<{ pinId: string; action: MetawebSurfSeenAction }> {
  const receipts: Array<{ pinId: string; action: MetawebSurfSeenAction }> = [];
  const ownPinId = String(record.pinId ?? '').trim();
  if (ownPinId) receipts.push({ pinId: ownPinId, action: 'posted' });
  const target = extractInteractionTarget({
    path: String(record.path ?? ''),
    payload: String(record.contentText ?? ''),
  });
  if (target) receipts.push(target);
  return receipts;
}

/**
 * Best-effort (target pinId, interaction action) extraction from a createPin
 * call. Returns null for original posts and for unparsable payloads — those
 * writes are budget-counted but never duplicate-blocked.
 */
function extractInteractionTarget(metaidData: { path?: string; payload: string }): InteractionTarget | null {
  const pinPath = String(metaidData.path ?? '').trim().toLowerCase();
  if (!pinPath) return null;
  const spec = INTERACTION_TARGETS.find((entry) => entry.path === pinPath);
  if (!spec) return null;
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(metaidData.payload);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    payload = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  for (const field of spec.payloadFields) {
    const value = payload[field];
    if (typeof value === 'string' && value.trim()) {
      return { pinId: value.trim(), action: spec.action };
    }
  }
  return null;
}

/**
 * The surf session's single chain-write choke point (review P2.1 + P2.3).
 *
 * Every interaction tool a surf session can reach (like/comment/answer/ask/
 * buzz/note/agentpedia challenge) funnels through this guard, which enforces
 * three rules before the wallet is touched:
 *
 * 0. Self-interaction block (review 2, item 5): liking, answering, or
 *    challenging the bot's OWN pin is chain spam — rejected without spending
 *    budget, against the local writes ledger (isOwnPin; best-effort, pins
 *    published elsewhere are unknown). Comments on own pins stay allowed:
 *    replying in your own thread is how the inbox step works.
 * 1. Duplicate-interaction guard: targeting a pin this bot already engaged
 *    with an equal-or-stronger action — earlier in THIS run (state.interactions)
 *    or in a previous surf (the seen ledger via getSeenAction) — is rejected
 *    WITHOUT spending budget. Read/save-level ledger entries never block an
 *    interaction: liking a pin you only bookmarked yesterday is fine.
 * 2. Budget hard ceiling, split into two pools (P1a):
 *    - INTERACTIONS (likes/comments/answers/challenges — writes targeting
 *      another pin) draw on state.interactionBudget;
 *    - ORIGINAL POSTS (buzz/note/question — no target) draw on
 *      state.creationBudget, so creating never crowds out engaging (and vice
 *      versa). Legacy states without creationBudget share the interaction
 *      pool, exactly the pre-P1a behavior.
 *    Write attempts beyond their pool are rejected with guidance to finish
 *    the run report. Budget 0 refuses every write of that class while the
 *    other class and the learning tools keep working.
 *
 * The counters live on the session marker (see SurfSessionWriteState), so a
 * per-turn tool-surface rebuild cannot reset them mid-run.
 */
export function createSurfCreatePinGuard(deps: {
  createPin: ChainWriteCreatePin;
  state: SurfSessionWriteState;
  getSeenAction?: SurfSeenLedgerReader;
  isOwnPin?: (metabotId: number, pinId: string) => boolean;
}): ChainWriteCreatePin {
  const { createPin, state, getSeenAction, isOwnPin } = deps;
  const budget = Math.max(0, Math.floor(state.interactionBudget) || 0);
  // P1a separate creation pool — ONLY when explicitly configured. States
  // without creationBudget (pre-P1a) keep the exact legacy semantics: posts
  // count against the shared interaction pool.
  const hasCreationPool = typeof state.creationBudget === 'number' && Number.isFinite(state.creationBudget);
  const creationBudget = hasCreationPool ? Math.max(0, Math.floor(state.creationBudget as number)) : null;
  return async (metabotId, metaidData, options) => {
    const target = extractInteractionTarget(metaidData);
    if (target && target.action !== 'commented') {
      let own = false;
      try {
        own = isOwnPin?.(metabotId, target.pinId) === true;
      } catch {
        // A sick ledger must not block chain writes — the in-run record and
        // the budget ceiling still hold.
        own = false;
      }
      if (own) {
        throw new Error(
          `Pin ${target.pinId} is YOUR OWN pin — ${target.action === 'liked' ? 'liking' : target.action === 'answered' ? 'answering' : 'challenging'} yourself is chain spam (replying in your own thread via comment is fine and needs no check). Pick a different pin; this attempt did not spend the interaction budget.`,
        );
      }
    }
    if (target) {
      const attemptedRank = SEEN_ACTION_RANK[target.action];
      let ledgerAction: MetawebSurfSeenAction | null = null;
      try {
        ledgerAction = getSeenAction?.(metabotId, target.pinId) ?? null;
      } catch {
        // A sick ledger must not block chain writes — the in-run record and
        // the budget ceiling still hold.
        ledgerAction = null;
      }
      const onRecordRank = Math.max(
        state.interactions?.[target.pinId] ?? -1,
        ledgerAction ? SEEN_ACTION_RANK[ledgerAction] : -1,
      );
      if (onRecordRank >= attemptedRank) {
        throw new Error(
          `Already interacted with pin ${target.pinId} (${target.action} or a stronger action is on record from this run or a previous surf). Never interact with the same pin twice — pick a different pin. This attempt did not spend the interaction budget.`,
        );
      }
    }
    // P1a budget pools: with an explicitly configured creationBudget, original
    // posts draw on the creation pool and targeted interactions on the
    // interaction pool — the two never compete. Without it, every write
    // counts against the interaction pool exactly as before.
    const usesCreationPool = !target && creationBudget !== null;
    if (usesCreationPool) {
      const creationsUsed = state.creationsUsed ?? 0;
      if (creationsUsed >= creationBudget!) {
        throw new Error(
          `MetaWeb surf creation budget exhausted for this run (${creationBudget} original posts allowed). Stop posting and write the final surf report now.`,
        );
      }
      state.creationsUsed = creationsUsed + 1;
    } else {
      const used = state.writesUsed ?? 0;
      if (used >= budget) {
        throw new Error(
          `MetaWeb surf interaction budget exhausted for this run (${budget} chain writes allowed). Stop interacting and write the final surf report now.`,
        );
      }
      state.writesUsed = used + 1;
    }
    const result = await createPin(metabotId, metaidData, options);
    if (target) {
      const interactions = state.interactions ?? (state.interactions = {});
      interactions[target.pinId] = Math.max(
        interactions[target.pinId] ?? -1,
        SEEN_ACTION_RANK[target.action],
      );
    } else {
      // Original posts: record the 'posted' receipt so the bot's own fresh
      // content never comes back as "new" (or gets self-engaged later).
      const newPinId = typeof result?.pinId === 'string' ? result.pinId.trim() : '';
      if (newPinId) (state.postedPinIds ??= []).push(newPinId);
    }
    return result;
  };
}
