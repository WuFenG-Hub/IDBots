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
  /** Hard ceiling of metaweb-source KB adds for this run. */
  kbBudget: number;
  /** Chain writes attempted so far this run (attempts count, even failed ones). */
  writesUsed?: number;
  /** metaweb-source KB adds so far this run (read by the KB wrapper). */
  kbAddsUsed?: number;
  /** targetPinId → strongest interaction rank published this run (dup guard). */
  interactions?: Record<string, number>;
}

export type SurfSeenLedgerReader = (
  metabotId: number,
  pinId: string,
) => MetawebSurfSeenAction | null;

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
 * two rules before the wallet is touched:
 *
 * 1. Duplicate-interaction guard: targeting a pin this bot already engaged
 *    with an equal-or-stronger action — earlier in THIS run (state.interactions)
 *    or in a previous surf (the seen ledger via getSeenAction) — is rejected
 *    WITHOUT spending budget. Read/save-level ledger entries never block an
 *    interaction: liking a pin you only bookmarked yesterday is fine.
 * 2. Budget hard ceiling: write attempts beyond state.interactionBudget are
 *    rejected with guidance to finish the run report. Budget 0 refuses every
 *    write while learning tools keep working.
 *
 * The counters live on the session marker (see SurfSessionWriteState), so a
 * per-turn tool-surface rebuild cannot reset them mid-run.
 */
export function createSurfCreatePinGuard(deps: {
  createPin: ChainWriteCreatePin;
  state: SurfSessionWriteState;
  getSeenAction?: SurfSeenLedgerReader;
}): ChainWriteCreatePin {
  const { createPin, state, getSeenAction } = deps;
  const budget = Math.max(0, Math.floor(state.interactionBudget) || 0);
  return async (metabotId, metaidData, options) => {
    const target = extractInteractionTarget(metaidData);
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
    const used = state.writesUsed ?? 0;
    if (used >= budget) {
      throw new Error(
        `MetaWeb surf interaction budget exhausted for this run (${budget} chain writes allowed). Stop interacting and write the final surf report now.`,
      );
    }
    state.writesUsed = used + 1;
    const result = await createPin(metabotId, metaidData, options);
    if (target) {
      const interactions = state.interactions ?? (state.interactions = {});
      interactions[target.pinId] = Math.max(
        interactions[target.pinId] ?? -1,
        SEEN_ACTION_RANK[target.action],
      );
    }
    return result;
  };
}
