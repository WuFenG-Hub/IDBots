/**
 * P1 group-task staffing search: one list per coarse seat.
 * Merges local workers + POST /api/bots/search remotes, then applies Twin's
 * local impressions (capability tags + collab facts). Local wins only as a
 * tie-break. Remote rows stay marked remote.
 */

import type { MetabotStore } from '../metabotStore';
import type { MetaIDImpressionSnapshot, MetaIDImpressionStore } from '../metaidImpressionStore';
import { normalizeGlobalMetaID } from '../shared/globalMetaId';
import {
  GROUP_TASK_SEAT_ROLES,
  type GroupTaskSeatRole,
} from './groupTaskStaffing';
import {
  scoreOpenTeamCandidate,
  tokenizeOpenTeamQuery,
} from './openTeamService';
import {
  searchBots,
  BotSearchError,
  BOT_SEARCH_CODE_PRESENCE_UNAVAILABLE,
  type BotSearchCandidate,
} from './botSearchService';

export const GROUP_TASK_SEARCH_DEFAULT_LIMIT = 10;
export const GROUP_TASK_SEARCH_MAX_LIMIT = 20;
/** When |local − remote| is within this margin, local sorts first. */
export const LOCAL_TIE_MARGIN = 4;

const SEAT_QUERY: Record<Exclude<GroupTaskSeatRole, 'domain'>, string> = {
  content: 'content copy writing 文案 内容 介绍 调研',
  design: 'design image video 设计 图像 视频 海报',
  engineering: 'engineering code metaapp publish 工程 代码 开发 发布',
  promotion: 'promotion promo buzz 推广 宣传 运营',
};

export type CandidateImpressionVerdict = 'unknown' | 'boost' | 'demote' | 'block';

export type GroupTaskSearchMatchField =
  | 'name'
  | 'chatSkills'
  | 'bio'
  | 'role'
  | 'goal'
  | 'groupTaskTitle'
  | 'groupTaskNote'
  | 'roleHint';

export interface GroupTaskSearchMatchReason {
  field: GroupTaskSearchMatchField;
  token: string;
  weight: number;
}

export interface GroupTaskSearchHistoryItem {
  groupId: string;
  title: string;
  goal: string;
  joinedAs: string;
  joinedAt: number;
  joinPinId: string;
  stillMember: boolean;
  kind: string;
}

export interface GroupTaskSearchImpression {
  priorCollaboration: boolean;
  capabilityTags: string[];
  lastFact: { title: string; outcome: string; seatRole?: string } | null;
  verdict: CandidateImpressionVerdict;
  note: string;
}

export interface GroupTaskSeatCandidate {
  name: string;
  source: 'local' | 'remote';
  metabotId?: number;
  globalMetaId?: string;
  bio: string;
  role: string;
  goal: string;
  chatSkills: string[];
  publishedSkills?: string[];
  enabled?: boolean;
  isOnline?: boolean;
  lastSeenAgoSeconds?: number | null;
  groupTaskCount?: number;
  recentGroupTasks?: GroupTaskSearchHistoryItem[];
  score: number;
  rawScore: number;
  matchReasons: GroupTaskSearchMatchReason[];
  impression: GroupTaskSearchImpression;
}

export interface SearchGroupTaskSeatInput {
  query?: string;
  roleHint?: string;
  domainLabel?: string;
  skills?: string[];
  limit?: number;
}

export interface SearchGroupTaskSeatResult {
  query: string;
  roleHint: GroupTaskSeatRole | null;
  primary: GroupTaskSeatCandidate | null;
  backup: GroupTaskSeatCandidate | null;
  candidates: GroupTaskSeatCandidate[];
  blocked: GroupTaskSeatCandidate[];
  warnings: string[];
}

export interface GroupTaskCandidateSearchLocalWorker {
  metabotId: number;
  name: string;
  enabled: boolean;
  type: string;
  globalMetaId: string | null;
  bio: string | null;
  role: string | null;
  goal: string | null;
  chatSkills: string[];
}

export interface GroupTaskCandidateSearchDeps {
  listLocalWorkers: () => GroupTaskCandidateSearchLocalWorker[];
  getTwinObserverGlobalMetaId: () => string | null;
  getImpressionSnapshot?: (
    observerGlobalMetaId: string,
    subjectGlobalMetaId: string,
  ) => MetaIDImpressionSnapshot | null;
  searchRemote?: (input: SearchGroupTaskRemoteInput) => Promise<GroupTaskRemoteHit[]>;
}

export interface SearchGroupTaskRemoteInput {
  query?: string;
  roleHint?: string;
  skills?: string[];
  excludeGlobalMetaIds?: string[];
  limit?: number;
}

export interface GroupTaskRemoteHit {
  globalMetaId: string;
  name: string;
  bio: string;
  role?: string;
  goal?: string;
  chatSkills: string[];
  publishedSkills?: string[];
  chainName?: string;
  isOnline?: boolean;
  lastSeenAgoSeconds?: number | null;
  score?: number;
  matchReasons?: GroupTaskSearchMatchReason[];
  groupTaskCount?: number;
  recentGroupTasks?: GroupTaskSearchHistoryItem[];
}

let depsGetter: (() => GroupTaskCandidateSearchDeps) | null = null;

export function setGroupTaskCandidateSearchDepsGetter(
  getter: (() => GroupTaskCandidateSearchDeps) | null,
): void {
  depsGetter = getter;
}

function getDeps(): GroupTaskCandidateSearchDeps {
  if (!depsGetter) {
    throw new Error('groupTaskCandidateSearch not initialized: call setGroupTaskCandidateSearchDepsGetter first');
  }
  return depsGetter();
}

function isSeatRole(value: unknown): value is GroupTaskSeatRole {
  return typeof value === 'string' && (GROUP_TASK_SEAT_ROLES as readonly string[]).includes(value);
}

function clampLimit(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isInteger(parsed) || parsed <= 0) return GROUP_TASK_SEARCH_DEFAULT_LIMIT;
  return Math.min(GROUP_TASK_SEARCH_MAX_LIMIT, parsed);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const MATCH_FIELDS = new Set<GroupTaskSearchMatchField>([
  'name',
  'chatSkills',
  'bio',
  'role',
  'goal',
  'groupTaskTitle',
  'groupTaskNote',
  'roleHint',
]);

function asMatchField(value: string): GroupTaskSearchMatchField {
  return MATCH_FIELDS.has(value as GroupTaskSearchMatchField)
    ? (value as GroupTaskSearchMatchField)
    : 'bio';
}

function collectExcludeGlobalMetaIds(
  deps: GroupTaskCandidateSearchDeps,
  observer: string | null,
): string[] {
  const ids = new Set<string>();
  const observerId = observer ? normalizeGlobalMetaID(observer) : null;
  if (observerId) ids.add(observerId);
  for (const worker of deps.listLocalWorkers()) {
    const id = worker.globalMetaId ? normalizeGlobalMetaID(worker.globalMetaId) : null;
    if (id) ids.add(id);
  }
  return [...ids];
}

export function fromBotSearchCandidate(remote: BotSearchCandidate): GroupTaskRemoteHit {
  return {
    globalMetaId: remote.globalMetaId,
    name: remote.name,
    bio: remote.bio,
    role: remote.role,
    goal: remote.goal,
    chatSkills: remote.chatSkills,
    publishedSkills: remote.publishedSkills,
    chainName: remote.chainName,
    isOnline: remote.isOnline,
    lastSeenAgoSeconds: remote.lastSeenAgoSeconds,
    score: remote.score,
    matchReasons: remote.matchReasons.map((reason) => ({
      field: asMatchField(reason.field),
      token: reason.token,
      weight: reason.weight,
    })),
    groupTaskCount: remote.groupTaskCount,
    recentGroupTasks: remote.recentGroupTasks.map((item) => ({
      groupId: item.groupId,
      title: item.title,
      goal: item.goal,
      joinedAs: item.joinedAs,
      joinedAt: item.joinedAt,
      joinPinId: item.joinPinId,
      stillMember: item.stillMember,
      kind: item.kind,
    })),
  };
}

export async function searchRemoteBotsForSeat(
  input: SearchGroupTaskRemoteInput,
): Promise<GroupTaskRemoteHit[]> {
  const page = await searchBots({
    query: input.query,
    roleHint: input.roleHint,
    skills: input.skills,
    onlineOnly: true,
    hasChatPubkey: true,
    excludeGlobalMetaIds: input.excludeGlobalMetaIds,
    limit: input.limit,
  });
  return page.candidates.map(fromBotSearchCandidate);
}

export function resolveSeatSearchQuery(input: SearchGroupTaskSeatInput): string {
  const explicit = [text(input.query), ...(input.skills ?? []).map((skill) => text(skill)).filter(Boolean)];
  const roleHint = isSeatRole(input.roleHint) ? input.roleHint : null;
  if (roleHint === 'domain') {
    const domain = text(input.domainLabel);
    if (domain) explicit.push(domain);
  } else if (roleHint) {
    explicit.push(SEAT_QUERY[roleHint]);
  }
  return explicit.filter(Boolean).join(' ').trim();
}

export function collectMatchReasons(
  item: { name?: string; bio?: string; chatSkills?: string[]; role?: string; goal?: string },
  tokens: string[],
): GroupTaskSearchMatchReason[] {
  const reasons: GroupTaskSearchMatchReason[] = [];
  const name = (item.name ?? '').toLowerCase();
  const bio = (item.bio ?? '').toLowerCase();
  const role = (item.role ?? '').toLowerCase();
  const goal = (item.goal ?? '').toLowerCase();
  const skills = (item.chatSkills ?? []).map((skill) => String(skill ?? '').toLowerCase());
  for (const token of tokens) {
    const weight = Math.min(4, Math.max(1, token.length));
    if (name.includes(token)) reasons.push({ field: 'name', token, weight: 4 * weight });
    if (skills.some((skill) => skill.includes(token))) {
      reasons.push({ field: 'chatSkills', token, weight: 2 * weight });
    }
    if (bio.includes(token)) reasons.push({ field: 'bio', token, weight });
    if (role.includes(token)) reasons.push({ field: 'role', token, weight: Math.round(0.5 * weight) || 1 });
    if (goal.includes(token)) reasons.push({ field: 'goal', token, weight: Math.round(0.5 * weight) || 1 });
  }
  return reasons;
}

export function scoreSeatResume(
  item: { name?: string; bio?: string; chatSkills?: string[]; role?: string; goal?: string },
  tokens: string[],
): { score: number; reasons: GroupTaskSearchMatchReason[] } {
  const reasons = collectMatchReasons(item, tokens);
  const openTeam = scoreOpenTeamCandidate(
    { name: item.name ?? '', bio: item.bio ?? '', chatSkills: item.chatSkills ?? [] },
    tokens,
  );
  const extra = reasons
    .filter((reason) => reason.field === 'role' || reason.field === 'goal')
    .reduce((sum, reason) => sum + reason.weight, 0);
  return { score: openTeam + extra, reasons };
}

export function evaluateImpressionForSeat(
  snapshot: MetaIDImpressionSnapshot | null,
  roleHint: GroupTaskSeatRole | null,
): GroupTaskSearchImpression {
  if (!snapshot) {
    return {
      priorCollaboration: false,
      capabilityTags: [],
      lastFact: null,
      verdict: 'unknown',
      note: 'no prior collaboration',
    };
  }
  const tags = snapshot.capabilityTags ?? [];
  const lastFact = snapshot.collaborationFacts.length > 0
    ? snapshot.collaborationFacts[snapshot.collaborationFacts.length - 1]
    : null;
  const last = lastFact
    ? { title: lastFact.title, outcome: lastFact.outcome, seatRole: lastFact.seatRole }
    : null;
  const weakExact = roleHint ? `weak:${roleHint}` : null;
  const factOnSeat = Boolean(
    lastFact
    && roleHint
    && lastFact.seatRole
    && lastFact.seatRole === roleHint,
  );
  if (
    (weakExact && tags.includes(weakExact))
    || (factOnSeat && (lastFact?.outcome === 'kicked' || lastFact?.outcome === 'deliverable_rejected'))
  ) {
    return {
      priorCollaboration: true,
      capabilityTags: tags,
      lastFact: last,
      verdict: 'block',
      note: lastFact
        ? `blocked: last ${roleHint} fact was ${lastFact.outcome} (${lastFact.title})`
        : `blocked: impression tagged ${weakExact}`,
    };
  }
  if (tags.includes('weak:unspecified') || lastFact?.outcome === 'kicked') {
    return {
      priorCollaboration: true,
      capabilityTags: tags,
      lastFact: last,
      verdict: 'demote',
      note: lastFact
        ? `demoted: last collab ${lastFact.outcome} (${lastFact.title})`
        : 'demoted: unspecified weak tag',
    };
  }
  if (
    lastFact
    && (lastFact.outcome === 'done' || lastFact.outcome === 'deliverable_accepted')
    && (!roleHint || !lastFact.seatRole || lastFact.seatRole === roleHint)
  ) {
    return {
      priorCollaboration: true,
      capabilityTags: tags,
      lastFact: last,
      verdict: 'boost',
      note: `prior ${lastFact.outcome} on "${lastFact.title}"`,
    };
  }
  if (lastFact?.outcome === 'cancelled') {
    return {
      priorCollaboration: true,
      capabilityTags: tags,
      lastFact: last,
      verdict: 'demote',
      note: `demoted: last collab cancelled (${lastFact.title})`,
    };
  }
  return {
    priorCollaboration: snapshot.collaborationFacts.length > 0 || tags.length > 0,
    capabilityTags: tags,
    lastFact: last,
    verdict: 'unknown',
    note: snapshot.collaborationFacts.length > 0
      ? `prior collab recorded (${lastFact?.title ?? 'untitled'})`
      : (tags.length > 0 ? `tags: ${tags.join(', ')}` : 'no prior collaboration'),
  };
}

function impressionDelta(verdict: CandidateImpressionVerdict): number {
  if (verdict === 'boost') return 4;
  if (verdict === 'demote') return -8;
  return 0;
}

function compareCandidates(left: GroupTaskSeatCandidate, right: GroupTaskSeatCandidate): number {
  if (Math.abs(left.score - right.score) <= LOCAL_TIE_MARGIN) {
    if (left.source !== right.source) return left.source === 'local' ? -1 : 1;
  }
  if (right.score !== left.score) return right.score - left.score;
  return left.name.localeCompare(right.name);
}

function readSnapshot(
  deps: GroupTaskCandidateSearchDeps,
  observer: string | null,
  subject: string | null,
): MetaIDImpressionSnapshot | null {
  const observerId = observer ? normalizeGlobalMetaID(observer) : null;
  const subjectId = subject ? normalizeGlobalMetaID(subject) : null;
  if (!observerId || !subjectId || !deps.getImpressionSnapshot) return null;
  try {
    return deps.getImpressionSnapshot(observerId, subjectId);
  } catch {
    return null;
  }
}

function toLocalCandidate(
  worker: GroupTaskCandidateSearchLocalWorker,
  tokens: string[],
  roleHint: GroupTaskSeatRole | null,
  snapshot: MetaIDImpressionSnapshot | null,
): GroupTaskSeatCandidate | null {
  if (!worker.enabled || worker.type === 'twin') return null;
  const resume = scoreSeatResume({
    name: worker.name,
    bio: worker.bio ?? '',
    chatSkills: worker.chatSkills,
    role: worker.role ?? '',
    goal: worker.goal ?? '',
  }, tokens);
  if (tokens.length > 0 && resume.score <= 0) return null;
  const impression = evaluateImpressionForSeat(snapshot, roleHint);
  return {
    name: worker.name,
    source: 'local',
    metabotId: worker.metabotId,
    globalMetaId: worker.globalMetaId ?? undefined,
    bio: worker.bio ?? '',
    role: worker.role ?? '',
    goal: worker.goal ?? '',
    chatSkills: worker.chatSkills,
    enabled: worker.enabled,
    isOnline: true,
    rawScore: resume.score,
    score: resume.score + impressionDelta(impression.verdict),
    matchReasons: resume.reasons,
    impression,
  };
}

function toRemoteCandidate(
  remote: GroupTaskRemoteHit,
  tokens: string[],
  roleHint: GroupTaskSeatRole | null,
  snapshot: MetaIDImpressionSnapshot | null,
): GroupTaskSeatCandidate {
  const resume = scoreSeatResume({
    name: remote.name,
    bio: remote.bio,
    chatSkills: remote.chatSkills,
    role: remote.role ?? '',
    goal: remote.goal ?? '',
  }, tokens);
  const rawScore = Number.isFinite(remote.score) ? Number(remote.score) : resume.score;
  const matchReasons = remote.matchReasons?.length ? remote.matchReasons : resume.reasons;
  const impression = evaluateImpressionForSeat(snapshot, roleHint);
  return {
    name: remote.name,
    source: 'remote',
    globalMetaId: remote.globalMetaId,
    bio: remote.bio,
    role: remote.role ?? '',
    goal: remote.goal ?? '',
    chatSkills: remote.chatSkills,
    publishedSkills: remote.publishedSkills,
    isOnline: remote.isOnline,
    lastSeenAgoSeconds: remote.lastSeenAgoSeconds,
    groupTaskCount: remote.groupTaskCount,
    recentGroupTasks: remote.recentGroupTasks,
    rawScore,
    score: rawScore + impressionDelta(impression.verdict),
    matchReasons,
    impression,
  };
}

export async function searchGroupTaskSeatCandidates(
  input: SearchGroupTaskSeatInput = {},
): Promise<SearchGroupTaskSeatResult> {
  const deps = getDeps();
  const roleHint = isSeatRole(input.roleHint) ? input.roleHint : null;
  const query = resolveSeatSearchQuery(input);
  if (!query) {
    throw new Error('query or role_hint is required');
  }
  const tokens = tokenizeOpenTeamQuery(query);
  const limit = clampLimit(input.limit);
  const observer = deps.getTwinObserverGlobalMetaId();
  const warnings: string[] = [];

  const locals: GroupTaskSeatCandidate[] = [];
  for (const worker of deps.listLocalWorkers()) {
    const snapshot = readSnapshot(deps, observer, worker.globalMetaId);
    const candidate = toLocalCandidate(worker, tokens, roleHint, snapshot);
    if (candidate) locals.push(candidate);
  }

  let remotes: GroupTaskSeatCandidate[] = [];
  try {
    const searchRemote = deps.searchRemote ?? searchRemoteBotsForSeat;
    const skills = (input.skills ?? []).map((item) => text(item)).filter(Boolean);
    const remoteQuery = text(input.query) || (roleHint === 'domain' ? text(input.domainLabel) : '');
    const found = await searchRemote({
      query: remoteQuery,
      roleHint: roleHint ?? undefined,
      skills: skills.length ? skills : undefined,
      excludeGlobalMetaIds: collectExcludeGlobalMetaIds(deps, observer),
      limit: Math.min(GROUP_TASK_SEARCH_MAX_LIMIT, limit * 2),
    });
    remotes = found.map((remote) =>
      toRemoteCandidate(remote, tokens, roleHint, readSnapshot(deps, observer, remote.globalMetaId)),
    );
    const localIds = new Set(
      locals
        .map((row) => (row.globalMetaId ? normalizeGlobalMetaID(row.globalMetaId) : null))
        .filter((id): id is string => Boolean(id)),
    );
    remotes = remotes.filter((row) => {
      const id = row.globalMetaId ? normalizeGlobalMetaID(row.globalMetaId) : null;
      return !id || !localIds.has(id);
    });
  } catch (error) {
    const presenceDown = error instanceof BotSearchError && error.code === BOT_SEARCH_CODE_PRESENCE_UNAVAILABLE;
    warnings.push(
      presenceDown
        ? 'online search failed; local matches only: presence_unavailable'
        : `online search failed; local matches only: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const merged = [...locals, ...remotes];
  const blocked = merged.filter((candidate) => candidate.impression.verdict === 'block');
  const hireable = merged
    .filter((candidate) => candidate.impression.verdict !== 'block')
    .sort(compareCandidates)
    .slice(0, limit);

  if (hireable.length === 0 && blocked.length === 0) {
    warnings.push('no resume match for this seat');
  }

  return {
    query,
    roleHint,
    primary: hireable[0] ?? null,
    backup: hireable[1] ?? null,
    candidates: hireable,
    blocked: blocked.sort(compareCandidates),
    warnings,
  };
}

/** Production wiring from MetabotStore + impression snapshots. */
export function buildGroupTaskCandidateSearchDeps(input: {
  metabotStore: MetabotStore;
  impressionStore?: MetaIDImpressionStore | null;
}): GroupTaskCandidateSearchDeps {
  return {
    listLocalWorkers: () => input.metabotStore.listMetabots()
      .filter((bot) => bot.metabot_type !== 'twin')
      .map((bot) => ({
        metabotId: bot.id,
        name: (bot.name ?? '').trim(),
        enabled: Boolean(bot.enabled),
        type: bot.metabot_type,
        globalMetaId: bot.globalmetaid ?? null,
        bio: bot.bio ?? bot.background ?? null,
        role: bot.role ?? null,
        goal: bot.goal ?? null,
        chatSkills: [...(bot.allow_chat_skills ?? []), ...(bot.skills ?? [])],
      })),
    getTwinObserverGlobalMetaId: () =>
      input.metabotStore.listMetabots().find((bot) => bot.metabot_type === 'twin')?.globalmetaid ?? null,
    getImpressionSnapshot: input.impressionStore
      ? (observer, subject) => input.impressionStore!.getSnapshot(observer, subject)
      : undefined,
    searchRemote: searchRemoteBotsForSeat,
  };
}
