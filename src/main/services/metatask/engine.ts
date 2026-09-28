import {
  CHALLENGE_TTL_DAYS_DEFAULT,
  ENGINE_ALGO_VERSION,
  H_ACT,
  H_ACT2,
  REVIEWER_ACCURACY_FLOOR_BP,
  SUBMITTER_SHARE_BP_DEFAULT,
  SUBMITTER_SHARE_BP_MAX,
  SUBMITTER_SHARE_BP_MIN,
  hAct2Or,
} from './constants';
import { canonJ, sha256Hex } from './canon';
import type {
  AmendBody,
  ChallengeBody,
  MetaTaskChainEvent,
  MetaTaskNodeProjection,
  MetaTaskParticipantStats,
  MetaTaskSettlementManifest,
  MetaTaskSettlementShare,
  MetaTaskTaskProjection,
  MetaTaskVoteSummary,
  TaskBody,
  TreeNodeBody,
  TreeBody,
} from './types';

export interface ReplayOptions {
  /** Task root pin; omitted = latest task pin in the pool. */
  rootPinId?: string;
  /** Fixed clock (ms epoch) for TTL / review-window / challenge-expiry derivation. Omit = no expiry. */
  now?: number;
  hAct?: number;
  hAct2?: number | null;
  evaluatedAtMs?: number;
  /** Roster pin bodies by pinId (same-side review filtering, H_ACT2-gated only). */
  rosterPins?: Record<string, unknown>;
}

const BIG = 10 ** 12;

const asNum = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const asStr = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;
const truthyStr = (value: unknown): boolean =>
  typeof value === 'string' && value.trim().length > 0;

const orderKey = (event: MetaTaskChainEvent): [number, number, number, string] => [
  event.height >= 0 ? event.height : BIG,
  asNum(event.txIndex),
  asNum(event.timestampMs),
  event.pinId,
];

const compareByOrderKey = (a: MetaTaskChainEvent, b: MetaTaskChainEvent): number => {
  const ka = orderKey(a);
  const kb = orderKey(b);
  for (let i = 0; i < 4; i += 1) {
    if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
  }
  return 0;
};

interface CycleSubmission {
  pinId: string;
  author: string;
  atMs: number;
  height: number;
  supersedeid: string | null;
}

interface CycleRecord {
  node: string;
  claimId: string;
  claimant: string;
  submissions: CycleSubmission[];
  effective: { pinId: string; author: string; atMs: number } | null;
  /** Pins replaced via valid supersede chains (unpaid-history marker). */
  supersededPinIds: Set<string>;
  outcome: 'verified' | 'fail_rejected' | 'open' | 'superseded';
}

/** #8/#9 vote validity gates: apply only to events at/after hAct (engine ruling, H_ACT=190000). */
const voteInvalidReason = (
  body: Record<string, unknown>,
  height: number,
  hAct: number
): string | null => {
  if (height < hAct) return null; // v1.1 semantics below the switch point
  if (!truthyStr(body.semantic_check)) return 'missing_semantic_check';
  if (body.verdict === 'fail' && !truthyStr(body.failreason)) return 'missing_failreason';
  return null;
};

const sameSide = (rosterGroups: string[][], a: string, b: string): boolean => {
  if (!a || !b) return false;
  if (a === b) return true;
  return rosterGroups.some((group) => group.includes(a) && group.includes(b));
};

const rosterGroupsFor = (rosterBody: unknown): string[][] => {
  if (!rosterBody || typeof rosterBody !== 'object') return [];
  const record = rosterBody as Record<string, unknown>;
  const raw = Array.isArray(record.groups)
    ? record.groups
    : Array.isArray(rosterBody)
      ? rosterBody
      : [];
  return raw
    .filter((group): group is unknown[] => Array.isArray(group))
    .map((group) => group.filter((id): id is string => typeof id === 'string'));
};

const isAcyclic = (nodes: Map<string, TreeNodeBody>): boolean => {
  for (const startId of nodes.keys()) {
    const seen = new Set<string>();
    let cursor: string | null = startId;
    while (cursor) {
      if (seen.has(cursor)) return false;
      seen.add(cursor);
      cursor = nodes.get(cursor)?.parent ?? null;
    }
  }
  return true;
};

const sumWeights = (nodes: Map<string, TreeNodeBody>): number => {
  let total = 0;
  for (const node of nodes.values()) {
    const w = node.weight;
    if (typeof w !== 'number' || !Number.isInteger(w) || w < 1 || w > 10000) return -1;
    total += w;
  }
  return total;
};

/**
 * Fold amends (v1.2, H_ACT2-gated). Publisher authority, bases version chain
 * with earliest-wins conflicts, frozen-on-start nodes, and the four fold
 * invariants. Any failure ignores the WHOLE amend (recorded).
 */
const foldAmends = (input: {
  amends: MetaTaskChainEvent[];
  rootAuthor: string;
  treePinId: string;
  initialNodes: Map<string, TreeNodeBody>;
  /** Order key of each node's FIRST effective claim (point-in-time freeze source). */
  firstClaimOrder: Map<string, [number, number, number, string]>;
  verifiedNodeIds: Set<string>;
  activeCycleNodeIds: Set<string>;
  rootVerified: boolean;
  hAct2: number;
}): { nodes: Map<string, TreeNodeBody>; ignored: { pinId: string; reason: string }[]; head: string } => {
  const ignored: { pinId: string; reason: string }[] = [];
  const nodes = new Map(input.initialNodes);
  const takenBases = new Set<string>();
  let head = input.treePinId;

  /** Frozen-on-start: the node's first effective claim landed BEFORE this amend. */
  const frozenAt = (nodeId: string, amendKey: [number, number, number, string]): boolean => {
    const claimKey = input.firstClaimOrder.get(nodeId);
    if (!claimKey) return false;
    for (let i = 0; i < 4; i += 1) {
      if (claimKey[i] !== amendKey[i]) return claimKey[i] < amendKey[i];
    }
    return false;
  };

  for (const amend of input.amends) {
    const amendKey = orderKey(amend);
    const body = amend.body as unknown as AmendBody;
    if (amend.height < input.hAct2) {
      ignored.push({ pinId: amend.pinId, reason: 'below_h_act2' });
      continue;
    }
    if (amend.author !== input.rootAuthor) {
      ignored.push({ pinId: amend.pinId, reason: 'amend_not_publisher' });
      continue;
    }
    if (input.rootVerified) {
      ignored.push({ pinId: amend.pinId, reason: 'amend_task_finalized' });
      continue;
    }
    if (asStr(body.bases) !== head) {
      ignored.push({
        pinId: amend.pinId,
        reason: takenBases.has(asStr(body.bases)) ? 'amend_conflict' : 'amend_stale',
      });
      continue;
    }
    takenBases.add(asStr(body.bases));

    // Apply ops to a scratch copy; commit only if every invariant holds.
    const scratch = new Map(Array.from(nodes, ([id, node]) => [id, { ...node }]));
    let ok = true;
    const ops = Array.isArray(body.ops) ? body.ops : [];
    for (const rawOp of ops) {
      if (!rawOp || typeof rawOp !== 'object') {
        ok = false;
        break;
      }
      const op = rawOp as unknown as Record<string, unknown>;
      const kind = asStr(op.op);
      const targetId = asStr(op.node);
      if (kind === 'add_node') {
        const raw = (op.newNode ?? op.node) as Record<string, unknown> | null;
        const id = asStr(raw?.id);
        const parent = asStr(raw?.parent);
        if (!raw || !id || nodes.has(id) || scratch.has(id)) {
          ok = false;
          break;
        }
        const parentNode = scratch.get(parent) ?? nodes.get(parent);
        if (!parentNode || input.verifiedNodeIds.has(parent) || input.activeCycleNodeIds.has(parent)) {
          ok = false;
          break;
        }
        const w = raw.weight;
        scratch.set(id, {
          id,
          parent,
          title: asStr(raw.title),
          kind: asStr(raw.kind, 'proof'),
          specid: typeof raw.specid === 'string' ? raw.specid : null,
          params: (raw.params && typeof raw.params === 'object' ? raw.params : {}) as Record<string, unknown>,
          deps: Array.isArray(raw.deps) ? raw.deps.filter((d): d is string => typeof d === 'string') : [],
          weight: typeof w === 'number' ? w : undefined,
        });
      } else if (kind === 'remove_node') {
        const target = scratch.get(targetId);
        if (!target || target.parent === null) {
          ok = false;
          break;
        }
        const stack = [targetId];
        while (stack.length && ok) {
          const current = stack.pop() as string;
          if (frozenAt(current, amendKey)) {
            ok = false;
            break;
          }
          for (const [id, node] of scratch) {
            if (node.parent === current) stack.push(id);
          }
        }
        if (!ok) break;
        scratch.delete(targetId);
      } else if (kind === 'reweight') {
        const target = scratch.get(targetId);
        const w = op.weight;
        if (
          !target ||
          frozenAt(targetId, amendKey) ||
          typeof w !== 'number' ||
          !Number.isInteger(w) ||
          w < 1 ||
          w > 10000
        ) {
          ok = false;
          break;
        }
        target.weight = w;
      } else if (kind === 'retitle') {
        const target = scratch.get(targetId);
        if (!target || frozenAt(targetId, amendKey) || !truthyStr(op.title)) {
          ok = false;
          break;
        }
        target.title = asStr(op.title);
      } else if (kind === 'respec') {
        const target = scratch.get(targetId);
        if (!target || frozenAt(targetId, amendKey) || !truthyStr(op.specid)) {
          ok = false;
          break;
        }
        target.specid = asStr(op.specid);
      } else {
        ok = false;
        break;
      }
    }
    if (!ok || sumWeights(scratch) !== 10000 || !isAcyclic(scratch)) {
      ignored.push({ pinId: amend.pinId, reason: 'amend_invariant_violation' });
      continue;
    }
    nodes.clear();
    for (const [id, node] of scratch) nodes.set(id, node);
    head = amend.pinId;
  }
  return { nodes, ignored, head };
};

/**
 * Replay one MetaTask from its event set. Baseline node states follow the
 * reference Python engine exactly (final-holder anchoring, last-valid vote
 * per bot with #8/#9 filtered first, quorum judgment, immediate reopen on a
 * valid fail). v1.2 features (amend / supersede / challenge / settlement)
 * are H_ACT2-gated per the rev-2 registration draft.
 *
 * Node universe: only the effective (post-amend) tree exists. Claims,
 * releases, submissions and cycles naming any other node id — a stray claim
 * on an invented node, or a node an effective amend removed — are dropped
 * and recorded in `ignoredEvents` with reason 'unknown_node'; they never
 * create node state, appear in openNodes, count in progress, or join the
 * settlement weight table.
 */
export function replayMetaTask(
  events: MetaTaskChainEvent[],
  options: ReplayOptions = {}
): MetaTaskTaskProjection {
  const hAct = options.hAct ?? H_ACT;
  const hAct2 = hAct2Or(options.hAct2 === undefined ? H_ACT2 : options.hAct2);
  const now = typeof options.now === 'number' ? options.now : null;
  const evaluatedAtMs = options.evaluatedAtMs ?? Date.now();

  const byPath = new Map<string, MetaTaskChainEvent[]>();
  for (const event of events) {
    const list = byPath.get(event.path) ?? [];
    list.push(event);
    byPath.set(event.path, list);
  }
  for (const list of byPath.values()) list.sort(compareByOrderKey);

  // -- task root -----------------------------------------------------------
  const taskPins = byPath.get('task') ?? [];
  const rootPin = options.rootPinId
    ? taskPins.find((pin) => pin.pinId === options.rootPinId) ?? null
    : taskPins[taskPins.length - 1] ?? null;
  if (!rootPin) throw new Error('metatask replay: no task root pin in event set');
  const rootAuthor = rootPin.author;
  const taskBody = rootPin.body as unknown as TaskBody;
  const policy = taskBody.policy ?? {};
  const quorum = Math.max(1, asNum(policy.verify_quorum, 2));
  const ttlHours = asNum(policy.claim_ttl_hours, 0);
  const windowHours = asNum(policy.verify_window_hours, 0);
  const challengeTtlDays = asNum(policy.challenge_ttl_days, CHALLENGE_TTL_DAYS_DEFAULT);
  const split = policy.split ?? null;
  // σ: the submitter share actually used by the split, published in the
  // projection so consumers (mid-task share estimates) read the SAME clamp the
  // settlement applies. Not an engine input: the clamp is protocol-fixed.
  const submitterShareBP = Math.min(
    SUBMITTER_SHARE_BP_MAX,
    Math.max(SUBMITTER_SHARE_BP_MIN, asNum(split?.submitterShareBP, SUBMITTER_SHARE_BP_DEFAULT)),
  );

  // Task-scoped events: root pin + tree by reference + taskid references.
  const treePinId = asStr(taskBody.treeid);
  const treePin = (byPath.get('tree') ?? []).find((pin) => pin.pinId === treePinId) ?? null;
  const taskScoped = new Map<string, MetaTaskChainEvent>();
  taskScoped.set(rootPin.pinId, rootPin);
  if (treePin) taskScoped.set(treePin.pinId, treePin);
  for (const [path, list] of byPath) {
    if (path === 'task' || path === 'tree' || path === 'spec') continue;
    for (const pin of list) {
      if (asStr(pin.body.taskid) === rootPin.pinId) taskScoped.set(pin.pinId, pin);
    }
  }

  // -- submissions (task-scoped, ordered) ------------------------------------
  const submissions = (byPath.get('submission') ?? [])
    .filter((p) => asStr(p.body.taskid) === rootPin.pinId)
    .sort(compareByOrderKey);
  const submissionAuthorByPin = new Map<string, string>();
  const submissionBodyByPin = new Map<string, Record<string, unknown>>();
  const knownTargets = new Set<string>();
  for (const sub of submissions) {
    submissionAuthorByPin.set(sub.pinId, sub.author);
    submissionBodyByPin.set(sub.pinId, sub.body);
    knownTargets.add(sub.pinId);
  }
  // Verify and challenge pins carry no taskid; they scope by target (a task submission).
  for (const scopePath of ['verify', 'challenge'] as const) {
    for (const pin of byPath.get(scopePath) ?? []) {
      if (knownTargets.has(asStr(pin.body.targetid))) taskScoped.set(pin.pinId, pin);
    }
  }

  // -- vote pre-pass: gates, roster, last valid per (target, bot) -------------
  // #8/#9 filtering happens BEFORE last-per-bot (a malformed vote never
  // withdraws the same bot's earlier valid vote).
  const rosterGroups =
    split?.rosterid && options.rosterPins
      ? rosterGroupsFor(options.rosterPins[split.rosterid])
      : [];
  interface VoteRecord {
    bot: string;
    pinId: string;
    body: Record<string, unknown>;
    height: number;
  }
  const ignoredEvents: { pinId: string; reason: string }[] = [];
  const lastVotes = new Map<string, VoteRecord>();
  for (const vote of byPath.get('verify') ?? []) {
    const target = asStr(vote.body.targetid);
    if (!target || !knownTargets.has(target)) continue;
    const reason = voteInvalidReason(vote.body, vote.height, hAct);
    if (reason) {
      ignoredEvents.push({ pinId: vote.pinId, reason });
      continue;
    }
    if (hAct2 !== Number.POSITIVE_INFINITY && vote.height >= hAct2 && rosterGroups.length) {
      const submitter = submissionAuthorByPin.get(target) ?? '';
      if (sameSide(rosterGroups, vote.author, submitter) || sameSide(rosterGroups, vote.author, rootAuthor)) {
        ignoredEvents.push({ pinId: vote.pinId, reason: 'same_side_roster' });
        continue;
      }
    }
    lastVotes.set(`${target} ${vote.author}`, {
      bot: vote.author,
      pinId: vote.pinId,
      body: vote.body,
      height: vote.height,
    });
  }
  const votesByTarget = new Map<string, VoteRecord[]>();
  for (const vote of lastVotes.values()) {
    const target = asStr(vote.body.targetid);
    const list = votesByTarget.get(target) ?? [];
    list.push(vote);
    votesByTarget.set(target, list);
  }
  const lastVoteByPin = new Map<string, VoteRecord>();
  for (const vote of lastVotes.values()) lastVoteByPin.set(vote.pinId, vote);

  // -- unified ordered walk ---------------------------------------------------
  // Claims, releases, submissions and last-valid votes interleave in global
  // chain order. This extends the reference engine's claim+release walk with
  // ruling three: a valid fail kills the current lock immediately, which is
  // what lets rework start a fresh claim cycle without a manual release.
  const claims = (byPath.get('claim') ?? []).filter((p) => asStr(p.body.taskid) === rootPin.pinId);
  const releases = (byPath.get('release') ?? []).filter((p) => asStr(p.body.taskid) === rootPin.pinId);
  const actingVotes = (byPath.get('verify') ?? []).filter((p) => lastVoteByPin.has(p.pinId));
  const timeline = [...claims, ...releases, ...submissions, ...actingVotes].sort(compareByOrderKey);
  interface HolderState {
    pinId: string;
    claimant: string;
    sinceMs: number;
  }
  const holders = new Map<string, HolderState>();
  const firstClaimOrder = new Map<string, [number, number, number, string]>();
  /** Claims that took a node lock, in chain order; node membership is resolved
   *  only after the amend fold (effective-tree filter below). */
  const effectiveClaims: { node: string; author: string }[] = [];
  const cycleByNodeClaim = new Map<string, CycleRecord>();
  const verifiedSubmissionPins = new Set<string>();
  const passVotersByNode = new Map<string, Map<string, string>>();
  /** Submission pin -> node, for the node's CURRENT effective submission only. */
  const nodeOfLiveTarget = new Map<string, string>();

  for (const pin of timeline) {
    if (pin.path === 'claim') {
      const node = asStr(pin.body.node);
      if (node && !holders.has(node)) {
        holders.set(node, { pinId: pin.pinId, claimant: pin.author, sinceMs: asNum(pin.timestampMs) });
        if (!firstClaimOrder.has(node)) firstClaimOrder.set(node, orderKey(pin));
        effectiveClaims.push({ node, author: pin.author });
      }
      continue;
    }
    if (pin.path === 'release') {
      const node = asStr(pin.body.node);
      if (asStr(pin.body.claimid) === holders.get(node)?.pinId) {
        holders.delete(node);
        passVotersByNode.delete(node);
      }
      continue;
    }
    if (pin.path === 'submission') {
      const node = asStr(pin.body.node);
      const claimId = asStr(pin.body.claimid);
      if (!node || !claimId) continue;
      const holder = holders.get(node);
      if (!holder || holder.pinId !== claimId) continue; // not the current cycle
      const key = `${node} ${claimId}`;
      let cycle = cycleByNodeClaim.get(key);
      if (!cycle) {
        cycle = {
          node,
          claimId,
          claimant: holder.claimant,
          submissions: [],
          effective: null,
          supersededPinIds: new Set<string>(),
          outcome: 'open',
        };
        cycleByNodeClaim.set(key, cycle);
      }
      const record: CycleSubmission = {
        pinId: pin.pinId,
        author: pin.author,
        atMs: asNum(pin.timestampMs),
        height: pin.height,
        supersedeid:
          typeof pin.body.supersedeid === 'string' && pin.body.supersedeid
            ? pin.body.supersedeid
            : null,
      };
      if (!cycle.effective) {
        // v1.1 earliest-holds: the first submission of the cycle anchors it.
        cycle.submissions.push(record);
        cycle.effective = { pinId: record.pinId, author: record.author, atMs: record.atMs };
        nodeOfLiveTarget.set(record.pinId, node);
        continue;
      }
      if (!record.supersedeid) {
        ignoredEvents.push({ pinId: record.pinId, reason: 'duplicate_without_supersede' });
        continue;
      }
      // Supersede six predicates (rev-2, path 6): target exists in the same
      // cycle; same pin author; both ends at/after H_ACT2; the target is the
      // current chain tip and not already superseded (one replacement per
      // submission). "Target not verified" holds by construction: a verified
      // cycle is terminal and admits no further walk state.
      const target = cycle.submissions.find((s) => s.pinId === record.supersedeid);
      const chainOk =
        Boolean(target) &&
        target !== undefined &&
        target.pinId !== record.pinId &&
        target.pinId === cycle.effective.pinId &&
        target.author === record.author &&
        record.height >= hAct2 &&
        target.height >= hAct2 &&
        !cycle.supersededPinIds.has(record.supersedeid);
      if (chainOk) {
        cycle.supersededPinIds.add(record.supersedeid);
        cycle.submissions.push(record);
        nodeOfLiveTarget.set(record.pinId, node);
        cycle.effective = { pinId: record.pinId, author: record.author, atMs: record.atMs };
      } else {
        ignoredEvents.push({ pinId: record.pinId, reason: 'supersede_predicate_failed' });
      }
      continue;
    }
    // verify: only last-valid votes act in the walk.
    const vote = lastVoteByPin.get(pin.pinId);
    if (!vote) continue;
    const target = asStr(vote.body.targetid);
    const node = nodeOfLiveTarget.get(target);
    if (!node) continue; // target is not a current-cycle effective submission
    const holder = holders.get(node);
    const cycle = cycleByNodeClaim.get(`${node} ${holder?.pinId ?? ''}`);
    if (!cycle || cycle.effective?.pinId !== target) continue;
    if (vote.body.verdict === 'fail') {
      // Ruling three (identity NOT filtered — reference parity): reopen now;
      // the claim is consumed and rework needs a fresh claim cycle. A fail
      // arriving after quorum was provisionally reached undoes the verified
      // state (judgment is over all votes, not a race).
      cycle.outcome = 'fail_rejected';
      verifiedSubmissionPins.delete(target);
      holders.delete(node);
      passVotersByNode.delete(node);
      continue;
    }
    if (vote.body.verdict === 'pass') {
      const submitter = submissionAuthorByPin.get(target) ?? '';
      if (vote.bot === submitter || vote.bot === rootAuthor) continue; // identity: never counts
      let voters = passVotersByNode.get(node);
      if (!voters) {
        voters = new Map<string, string>();
        passVotersByNode.set(node, voters);
      }
      if (!voters.has(vote.bot)) voters.set(vote.bot, vote.pinId);
      if (voters.size >= quorum) {
        cycle.outcome = 'verified';
        verifiedSubmissionPins.add(target);
      }
    }
  }

  // A node's current cycle = its most recent cycle in chain order (live or
  // terminal); verified is sticky through the terminal state.
  const activeCycleByNode = new Map<string, CycleRecord>();
  for (const cycle of cycleByNodeClaim.values()) {
    activeCycleByNode.set(cycle.node, cycle);
  }

  // -- expiry pass (guard semantics; only when a clock is provided) ---------
  const expiryApplied = now !== null;
  if (now !== null) {
    for (const [node, holder] of holders) {
      const cycle = cycleByNodeClaim.get(`${node} ${holder.pinId}`);
      const effective = cycle?.effective ?? null;
      if (!effective) {
        if (ttlHours > 0 && now - holder.sinceMs > ttlHours * 3_600_000) {
          holders.delete(node);
          passVotersByNode.delete(node);
        }
      } else if (windowHours > 0) {
        const good = passVotersByNode.get(node)?.size ?? 0;
        if (good < quorum && now - effective.atMs > windowHours * 3_600_000) {
          holders.delete(node);
          passVotersByNode.delete(node);
        }
      }
    }
  }

  // -- node bookkeeping -------------------------------------------------------
  const initialTree = treePin ? (treePin.body as unknown as TreeBody) : null;
  const initialNodes = new Map<string, TreeNodeBody>();
  if (initialTree && Array.isArray(initialTree.nodes)) {
    for (const raw of initialTree.nodes) {
      if (!raw || typeof raw !== 'object') continue;
      initialNodes.set(String(raw.id), raw as TreeNodeBody);
    }
  }
  const nodeIds = new Set<string>(initialNodes.keys());
  // Vote-level verified set (walk outcome) feeds the amend fold; the final
  // aggregation-precondition pass below may still demote parents afterwards.
  const verifiedNodeIds = new Set<string>();
  for (const [nodeId, cycle] of activeCycleByNode) {
    if (cycle.effective && verifiedSubmissionPins.has(cycle.effective.pinId)) {
      verifiedNodeIds.add(nodeId);
    }
  }

  // Amend fold (H_ACT2): point-in-time claim state + live-cycle/verified sets.
  const amendResult = foldAmends({
    amends: (byPath.get('amend') ?? []).filter((p) => asStr(p.body.taskid) === rootPin.pinId),
    rootAuthor,
    treePinId,
    initialNodes,
    firstClaimOrder,
    verifiedNodeIds,
    activeCycleNodeIds: new Set(holders.keys()),
    rootVerified: Boolean(initialTree?.root) && verifiedNodeIds.has(asStr(initialTree?.root)),
    hAct2,
  });
  ignoredEvents.push(...amendResult.ignored);
  const effectiveTree = amendResult.nodes;
  const amendHead = amendResult.head;

  // -- effective-tree filter -------------------------------------------------
  // The task's node universe IS its effective (post-amend) tree. A claim,
  // release, submission or cycle naming any other node id is a chain fact
  // about a node this task does not have: it must not create node state,
  // appear in openNodes, inflate progress.total, or reach the settlement
  // weight table (which keys strictly on the effective tree). This closes two
  // holes: a stray claim pin on an INVENTED node id no longer de-validates the
  // tree weights (which used to dump every task onto legacy uniform weights),
  // and a node an effective amend REMOVED stops being claimable/counted. A
  // claim that was valid when published but whose node a later amend removed
  // simply drops out of the effective projection — no crash.
  const effectiveNodeIds = new Set<string>(effectiveTree.keys());
  const alreadyIgnoredPins = new Set(ignoredEvents.map((entry) => entry.pinId));
  const markIgnored = (pinId: string, reason: string): void => {
    if (alreadyIgnoredPins.has(pinId)) return;
    alreadyIgnoredPins.add(pinId);
    ignoredEvents.push({ pinId, reason });
  };
  for (const [node, holder] of Array.from(holders)) {
    if (effectiveNodeIds.has(node)) continue;
    holders.delete(node);
    passVotersByNode.delete(node);
    markIgnored(holder.pinId, 'unknown_node');
  }
  for (const [key, cycle] of Array.from(cycleByNodeClaim)) {
    if (effectiveNodeIds.has(cycle.node)) continue;
    cycleByNodeClaim.delete(key);
    markIgnored(cycle.claimId, 'unknown_node');
    for (const submission of cycle.submissions) markIgnored(submission.pinId, 'unknown_node');
  }
  nodeIds.clear();
  for (const id of effectiveNodeIds) nodeIds.add(id);

  // -- aggregation precondition (v1.2.1 paths.aggregationPrecondition) -------
  // Parent verified = all children verified AND own submission passed votes;
  // an aggregate's childids must correspond exactly to the children's
  // effective VERIFIED submissions (pinId identity = "hash 与对应子件一致").
  // Enforced from H_ACT2, anchored on the parent's effective-submission
  // height; pre-H_ACT2 parents are grandfathered at their recorded vote level
  // (pilot #01's root keeps its historical verified state). Two documented
  // implementation readings flagged for v1.2.2: the amend fold gates parents
  // on the vote-level set (conservative), and childids equality is set-based
  // (order-insensitive).
  const childrenOf = new Map<string, string[]>();
  for (const node of effectiveTree.values()) {
    if (node.parent !== null) {
      const list = childrenOf.get(node.parent) ?? [];
      list.push(node.id);
      childrenOf.set(node.parent, list);
    }
  }
  const heightOfEffective = (node: string): number => {
    const cycle = activeCycleByNode.get(node);
    if (!cycle?.effective) return -1;
    return cycle.submissions.find((s) => s.pinId === cycle.effective?.pinId)?.height ?? -1;
  };
  const finalVerifiedCache = new Map<string, boolean>();
  const finalVerified = (node: string): boolean => {
    const cached = finalVerifiedCache.get(node);
    if (cached !== undefined) return cached;
    finalVerifiedCache.set(node, false); // cycle guard; the tree is already acyclic
    let result = false;
    const cycle = activeCycleByNode.get(node);
    if (cycle?.effective && cycle.outcome === 'verified') {
      result = true;
      const children = childrenOf.get(node) ?? [];
      if (children.length > 0 && heightOfEffective(node) >= hAct2) {
        const childPins = new Set<string>();
        const allChildrenVerified = children.every((child) => {
          if (!finalVerified(child)) return false;
          const childCycle = activeCycleByNode.get(child);
          if (childCycle?.effective) childPins.add(childCycle.effective.pinId);
          return true;
        });
        const body = submissionBodyByPin.get(cycle.effective.pinId);
        const resultObject = body?.result as Record<string, unknown> | undefined;
        const canonical = Array.isArray(resultObject?.childids)
          ? (resultObject.childids as unknown[])
          : Array.isArray(body?.childids)
            ? (body.childids as unknown[])
            : [];
        const listed = new Set(canonical.filter((id): id is string => typeof id === 'string'));
        result =
          allChildrenVerified &&
          listed.size === childPins.size &&
          Array.from(childPins).every((pin) => listed.has(pin));
      }
    }
    finalVerifiedCache.set(node, result);
    return result;
  };
  const finalVerifiedNodeIds = new Set<string>();
  for (const node of nodeIds) {
    if (finalVerified(node)) finalVerifiedNodeIds.add(node);
  }
  const finalVerifiedPins = new Set<string>();
  for (const node of finalVerifiedNodeIds) {
    const pin = activeCycleByNode.get(node)?.effective?.pinId;
    if (pin) finalVerifiedPins.add(pin);
  }

  // -- challenges (H_ACT2): open = unwithdrawn, unexpired, not overturned ----
  const openChallenges = new Map<string, { pinId: string; node: string; author: string; target: string }>();
  if (hAct2 !== Number.POSITIVE_INFINITY) {
    // Challenge pins carry no taskid; they scope by target (a task submission).
    const challenges = (byPath.get('challenge') ?? []).filter((p) =>
      knownTargets.has(asStr(p.body.targetid))
    );
    for (const ch of challenges) {
      const body = ch.body as unknown as ChallengeBody;
      const target = asStr(body.targetid);
      const submitter = submissionAuthorByPin.get(target) ?? '';
      if (ch.height < hAct2) {
        ignoredEvents.push({ pinId: ch.pinId, reason: 'below_h_act2' });
        continue;
      }
      if (ch.author === submitter || ch.author === rootAuthor || !truthyStr(body.evidence)) {
        ignoredEvents.push({ pinId: ch.pinId, reason: 'challenge_gate_failed' });
        continue;
      }
      if (body.withdraw) {
        for (const [key, open] of openChallenges) {
          if (open.author === ch.author && open.target === target) openChallenges.delete(key);
        }
        continue;
      }
      const key = `${target} ${ch.author}`;
      if (openChallenges.has(key)) {
        ignoredEvents.push({ pinId: ch.pinId, reason: 'duplicate_open_challenge' });
        continue;
      }
      const cycle = Array.from(activeCycleByNode.values()).find((c) => c.effective?.pinId === target);
      if (!cycle) {
        ignoredEvents.push({ pinId: ch.pinId, reason: 'target_not_active_verified' });
        continue;
      }
      if (
        now !== null &&
        asNum(ch.timestampMs) > 0 &&
        now - asNum(ch.timestampMs) > challengeTtlDays * 86_400_000
      ) {
        ignoredEvents.push({ pinId: ch.pinId, reason: 'challenge_expired' });
        continue;
      }
      openChallenges.set(key, { pinId: ch.pinId, node: cycle.node, author: ch.author, target });
    }
  }
  // A challenge stands only while its target still anchors a FINAL-verified
  // node (aggregation precondition included).
  const disputedNodeIds = new Set<string>();
  for (const [key, open] of openChallenges) {
    const cycle = activeCycleByNode.get(open.node);
    const stillVerified = Boolean(cycle?.effective && finalVerifiedPins.has(cycle.effective!.pinId));
    if (cycle?.effective?.pinId === open.target && stillVerified) {
      disputedNodeIds.add(open.node);
    } else {
      openChallenges.delete(key); // overturned via the fail path: resolves closed, never revives
    }
  }

  // -- node projections + participant stats ----------------------------------
  const nodeStates: Record<string, MetaTaskNodeProjection> = {};
  const participants = new Map<string, MetaTaskParticipantStats>();
  const bump = (metaId: string): MetaTaskParticipantStats => {
    let stats = participants.get(metaId);
    if (!stats) {
      stats = {
        metaId,
        effectiveClaims: 0,
        submissions: 0,
        verifiedContrib: 0,
        reviewVotes: 0,
        reviewCorrect: 0,
        reviewTerminal: 0,
      };
      participants.set(metaId, stats);
    }
    return stats;
  };
  // Effective claims per author, restricted to the effective tree: a claim on
  // a node this task does not have must not inflate a participant's standing.
  const effectiveClaimCounts = new Map<string, number>();
  for (const claim of effectiveClaims) {
    if (!effectiveNodeIds.has(claim.node)) continue;
    effectiveClaimCounts.set(claim.author, (effectiveClaimCounts.get(claim.author) ?? 0) + 1);
  }
  bump(rootAuthor);
  for (const [author, count] of effectiveClaimCounts) bump(author).effectiveClaims = count;

  const progress = { total: 0, verified: 0, claimed: 0, open: 0, disputed: 0 };
  const nodeSort = (a: string, b: string): number =>
    a.length !== b.length ? a.length - b.length : a < b ? -1 : 1;
  for (const node of Array.from(nodeIds).sort(nodeSort)) {
    const treeRec = effectiveTree.get(node);
    const cycle = activeCycleByNode.get(node);
    const holder = holders.get(node) ?? null;
    const effective = cycle?.effective ?? null;
    const isVerified = finalVerifiedNodeIds.has(node);
    const voteList: MetaTaskVoteSummary[] = [];
    let passVotes = 0;
    let failVotes = 0;
    if (effective) {
      for (const v of votesByTarget.get(effective.pinId) ?? []) {
        const identityOk = v.bot !== effective.author && v.bot !== rootAuthor;
        if (v.body.verdict === 'pass' && identityOk) passVotes += 1;
        if (v.body.verdict === 'fail') failVotes += 1;
        // Participation visible from the node view: EVERY counted vote (same
        // identity rule as `counted` below) is review activity, whether the
        // cycle is still open or already terminal.
        if (identityOk) bump(v.bot).reviewVotes += 1;
        voteList.push({
          voter: v.bot,
          verdict: asStr(v.body.verdict, 'invalid'),
          pinId: v.pinId,
          counted: identityOk,
          ignoreReason: identityOk ? null : 'identity_conflict',
          semanticCheck: truthyStr(v.body.semantic_check),
          failreason: truthyStr(v.body.failreason),
        });
      }
    }
    const status: MetaTaskNodeProjection['status'] = isVerified
      ? 'verified'
      : holder
        ? 'claimed'
        : 'open';
    const disputed = disputedNodeIds.has(node);
    nodeStates[node] = {
      id: node,
      parent: treeRec?.parent ?? null,
      title: treeRec?.title ?? node,
      kind: treeRec?.kind ?? 'proof',
      weight: treeRec?.weight ?? null,
      params: treeRec && treeRec.params && typeof treeRec.params === 'object'
        ? (treeRec.params as Record<string, unknown>)
        : null,
      specid: treeRec?.specid ?? null,
      status,
      disputed,
      holder: holder
        ? { pinId: holder.pinId, claimant: holder.claimant, sinceMs: holder.sinceMs }
        : null,
      submission: effective
        ? {
            pinId: effective.pinId,
            submitter: effective.author,
            atMs: effective.atMs,
            superseded: false,
            result: (() => {
              const body = submissionBodyByPin.get(effective.pinId);
              const result = body?.result;
              return result && typeof result === 'object' && !Array.isArray(result)
                ? (result as Record<string, unknown>)
                : null;
            })(),
            hash: asStr(submissionBodyByPin.get(effective.pinId)?.hash) || null,
            contentType: asStr(submissionBodyByPin.get(effective.pinId)?.contentType) || null,
            attachment: asStr(submissionBodyByPin.get(effective.pinId)?.attachment) || null,
          }
        : null,
      passVotes,
      failVotes,
      votes: voteList,
      cycleCount: Array.from(cycleByNodeClaim.values()).filter((c) => c.node === node).length,
    };
    progress.total += 1;
    if (disputed) progress.disputed += 1;
    if (isVerified) progress.verified += 1;
    else if (holder) progress.claimed += 1;
    else progress.open += 1;
    if (effective) {
      bump(effective.author).submissions += 1;
      if (isVerified) bump(effective.author).verifiedContrib += 1;
    }
  }

  // Reviewer accuracy input: counted votes on terminally-resolved cycles
  // (boundary = boundary block). The identity filter mirrors the node view and
  // the settlement reviewer set R(n) exactly — a self vote or the publisher's
  // vote must never move a(r) (it used to inflate Laplace accuracy from 5000
  // to 7500, i.e. +50% of the reviewer pool).
  const terminalCycles = Array.from(cycleByNodeClaim.values()).filter(
    (cycle) => cycle.outcome === 'verified' || cycle.outcome === 'fail_rejected'
  );
  for (const cycle of terminalCycles) {
    if (!cycle.effective) continue;
    for (const v of votesByTarget.get(cycle.effective.pinId) ?? []) {
      if (v.bot === cycle.effective.author || v.bot === rootAuthor) continue;
      const stats = bump(v.bot);
      stats.reviewTerminal += 1;
      const correct =
        (v.body.verdict === 'pass' && cycle.outcome === 'verified') ||
        (v.body.verdict === 'fail' && cycle.outcome === 'fail_rejected');
      if (correct) stats.reviewCorrect += 1;
    }
  }

  // Task completion = the ROOT node verified (v1.2.1 aggregation text). Via
  // the precondition this equals all-verified for H_ACT2-era trees; grandfathered
  // trees keep their recorded divergence (pilot #01: root verified, all_verified=false).
  const rootTreeNodeId =
    Array.from(effectiveTree.values()).find((node) => node.parent === null)?.id ??
    asStr(initialTree?.root) ??
    null;
  const taskComplete =
    rootTreeNodeId !== null && rootTreeNodeId !== ''
      ? finalVerifiedNodeIds.has(rootTreeNodeId)
      : progress.total > 0 && progress.verified === progress.total;

  // -- eventSetHash (recipe per rev-2, settlement section) -------------------
  const pathOrder = [
    'task',
    'tree',
    'spec',
    'claim',
    'release',
    'submission',
    'verify',
    'amend',
    'challenge',
  ];
  // Membership table (v1.2.1 settlement.eventSetHash.membership): spec pins
  // enter the set ONLY via task.specid — node-level specid overrides are not
  // task members for hashing purposes.
  const specRefs = new Set<string>();
  if (taskBody.specid) specRefs.add(taskBody.specid);
  const hashEntries: { path: string; pinId: string; height: number; txIndex: number }[] = [];
  let boundaryBlock = -1;
  for (const path of pathOrder) {
    const scoped = (byPath.get(path) ?? []).filter((pin) => {
      if (pin.height < 0) return false; // confirmed only; mempool excluded
      if (path === 'task') return pin.pinId === rootPin.pinId;
      if (path === 'tree') return pin.pinId === treePinId;
      if (path === 'spec') return specRefs.has(pin.pinId);
      if (path === 'verify' || path === 'challenge') return knownTargets.has(asStr(pin.body.targetid));
      return asStr(pin.body.taskid) === rootPin.pinId;
    });
    scoped.sort((a, b) => {
      if (a.height !== b.height) return a.height - b.height;
      if (a.txIndex !== b.txIndex) return a.txIndex - b.txIndex;
      return a.pinId < b.pinId ? -1 : a.pinId > b.pinId ? 1 : 0;
    });
    for (const pin of scoped) {
      hashEntries.push({
        path: `/protocols/metatask/${path}`,
        pinId: pin.pinId,
        height: pin.height,
        txIndex: asNum(pin.txIndex),
      });
      if (pin.height > boundaryBlock) boundaryBlock = pin.height;
    }
  }
  const eventSetHash = sha256Hex(canonJ(hashEntries));

  // -- settlement manifest (v1.2) -------------------------------------------
  let settlement: MetaTaskSettlementManifest | null = null;
  if (taskComplete && openChallenges.size === 0) {
    // The weight table keys STRICTLY on the effective tree: nodeIds is that
    // same set (any other node id never survives the effective-tree filter),
    // so a stray claim pin can no longer force the legacy uniform fallback.
    const nodeCount = nodeIds.size;
    const weights = new Map<string, number>();
    let weightsValid = nodeCount > 0;
    let totalWeight = 0;
    if (weightsValid) {
      for (const node of effectiveTree.values()) {
        const w = node.weight;
        if (typeof w !== 'number' || !Number.isInteger(w) || w < 1 || w > 10000) {
          weightsValid = false;
          break;
        }
        weights.set(node.id, w);
        totalWeight += w;
      }
      if (totalWeight !== 10000) weightsValid = false;
    }
    if (!weightsValid) {
      // Legacy tasks (pre-H_ACT2, no weight field): uniform floor(10000/N),
      // residue deliberately discarded (rev-2 ruling: never to the root).
      const uniform = nodeCount > 0 ? Math.floor(10000 / nodeCount) : 0;
      for (const node of nodeIds) weights.set(node, uniform);
    }
    const sigma = submitterShareBP;

    const accuracy = new Map<string, number>();
    for (const stats of participants.values()) {
      const smoothed = Math.floor((10000 * (stats.reviewCorrect + 1)) / (stats.reviewTerminal + 2));
      accuracy.set(stats.metaId, Math.min(10000, Math.max(REVIEWER_ACCURACY_FLOOR_BP, smoothed)));
    }

    const shareParts = new Map<string, { submittedBP: number; reviewedBP: number }>();
    const ensureShare = (metaId: string): { submittedBP: number; reviewedBP: number } => {
      let parts = shareParts.get(metaId);
      if (!parts) {
        parts = { submittedBP: 0, reviewedBP: 0 };
        shareParts.set(metaId, parts);
      }
      return parts;
    };
    for (const node of nodeIds) {
      const cycle = activeCycleByNode.get(node);
      if (!cycle?.effective || !finalVerifiedPins.has(cycle.effective.pinId)) continue;
      const w = weights.get(node) ?? 0;
      if (w <= 0) continue;
      const submitter = ensureShare(cycle.effective.author);
      const subBP = Math.floor((w * sigma) / 10000);
      submitter.submittedBP += subBP;
      const pool = w - subBP; // defined by subtraction: no double rounding
      const cycleVotes = (votesByTarget.get(cycle.effective.pinId) ?? []).filter(
        (v) => v.body.verdict === 'pass' && v.bot !== cycle.effective?.author && v.bot !== rootAuthor
      );
      if (!cycleVotes.length) {
        submitter.submittedBP += pool; // defensive: empty R(n) pool goes to the submitter
        continue;
      }
      const accSum = cycleVotes.reduce(
        (sum, v) => sum + (accuracy.get(v.bot) ?? REVIEWER_ACCURACY_FLOOR_BP),
        0
      );
      for (const v of cycleVotes) {
        const a = accuracy.get(v.bot) ?? REVIEWER_ACCURACY_FLOOR_BP;
        ensureShare(v.bot).reviewedBP += Math.floor((pool * a) / accSum); // residue discarded
      }
    }
    const shares: MetaTaskSettlementShare[] = Array.from(shareParts, ([metaId, parts]) => ({
      metaId,
      shareBP: parts.submittedBP + parts.reviewedBP,
      from: parts,
    })).sort((a, b) => b.shareBP - a.shareBP || (a.metaId < b.metaId ? -1 : 1));

    const unpaidHistory: MetaTaskSettlementManifest['unpaidHistory'] = [];
    for (const cycle of cycleByNodeClaim.values()) {
      for (const s of cycle.submissions) {
        if (cycle.supersededPinIds.has(s.pinId)) {
          unpaidHistory.push({ node: cycle.node, author: s.author, pinId: s.pinId, reason: 'superseded' });
          continue;
        }
        // The cycle's final effective submission: paid only when verified;
        // a fail-rejected cycle's effective submission is unpaid rework history
        // (an open live cycle is pending, not history).
        const isEffective = cycle.effective?.pinId === s.pinId;
        if (isEffective && cycle.outcome === 'fail_rejected') {
          unpaidHistory.push({ node: cycle.node, author: s.author, pinId: s.pinId, reason: 'rework_cycle' });
        }
      }
    }

    const weightsTable = Array.from(weights, ([id, w]) => ({ id, weight: w })).sort((a, b) =>
      a.id < b.id ? -1 : 1
    );
    settlement = {
      taskid: rootPin.pinId,
      boundaryBlock,
      eventSetHash,
      engineAlgoVersion: ENGINE_ALGO_VERSION,
      shares,
      unpaidHistory,
      disputed: [],
      weightsTableHash: sha256Hex(canonJ(weightsTable)),
    };
  }

  let lastActivityMs = 0;
  for (const pin of taskScoped.values()) {
    if (asNum(pin.timestampMs) > lastActivityMs) lastActivityMs = asNum(pin.timestampMs);
  }

  return {
    rootPinId: rootPin.pinId,
    title: asStr(taskBody.title, rootPin.pinId),
    brief: asStr(taskBody.brief),
    publisher: rootAuthor,
    tags: Array.isArray(taskBody.tags)
      ? taskBody.tags.filter((t): t is string => typeof t === 'string')
      : [],
    policy: {
      claimTtlHours: ttlHours,
      verifyQuorum: quorum,
      verifyWindowHours: windowHours,
      rewardSat: asNum(policy.reward_sat, 0),
      challengeTtlDays,
      hasSplit: Boolean(split),
      rosterid: split?.rosterid ?? null,
      submitterShareBP,
    },
    nodes: Array.from(effectiveTree.values()),
    amendHead,
    nodeStates,
    progress,
    taskComplete,
    participants: Array.from(participants.values()).sort(
      (a, b) => b.verifiedContrib - a.verifiedContrib || (a.metaId < b.metaId ? -1 : 1)
    ),
    identities: {}, // enriched at the projection-store layer (local roster resolver)
    settlement,
    lastActivityMs,
    freshness: {
      boundaryBlock,
      evaluatedAtMs,
      eventCount: taskScoped.size,
      eventSetHash,
      expiryApplied,
    },
    ignoredEvents,
  };
}
