import type { Metabot } from '../types/metabot';
import { stripLoneSurrogates, truncateUtf16Units } from '../libs/llmSafeText';

export interface TwinWorkerDirectorySession {
  id: string;
  metabotId?: number | null;
}

export interface TwinWorkerDirectoryDeps {
  getSession(sessionId: string): TwinWorkerDirectorySession | null;
  listMetabots(): Metabot[];
  getOwnerGlobalMetaId(): string | null;
  listCapabilityEvidence?: (metabotId: number) => Array<{
    summaryDate: string;
    summaryText: string;
    sessionRefs?: Array<{ sessionId: string; title: string }>;
  }>;
  getActiveWorkload?: (metabotId: number) => number;
}

export interface TwinWorkerDirectoryEntry {
  id: number;
  name: string;
  type: Metabot['metabot_type'];
  enabled: boolean;
  globalMetaID: string | null;
  ownerGlobalMetaId: string | null;
  ownerBindingVerified: boolean;
  role: string;
  bio: string | null;
  goal: string | null;
  personaSummary: string;
  skills: string[];
  chatSkills: string[];
  capabilityEvidence: Array<{
    summaryDate: string;
    summaryText: string;
    sessionRefs: Array<{ sessionId: string; title: string }>;
  }>;
  availability: 'available' | 'disabled';
  activeOrchestrationSteps: number | null;
}

export interface TwinWorkerDirectoryResult {
  requester: {
    sessionId: string;
    twinId: number;
    ownerGlobalMetaId: string;
  };
  workers: TwinWorkerDirectoryEntry[];
}

/**
 * One distilled impression the Twin holds about a Worker, keyed by the
 * subject Worker's globalMetaID. Backed by metaid_impression_snapshots and
 * rewritten by nightly dream consolidation.
 */
export interface TwinImpressionEntry {
  subjectGlobalMetaID: string;
  summaryText: string | null;
  updatedAt?: number | null;
  capabilityTags?: string[];
  lastCollaboration?: {
    title: string;
    outcome: string;
    pinIds: string[];
  } | null;
}

export class TwinWorkerDirectoryAuthorizationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'TwinWorkerDirectoryAuthorizationError';
    this.code = code;
  }
}

const MAX_TEXT_LENGTH = 2_000;
const MAX_EVIDENCE_LENGTH = 800;
const MAX_EVIDENCE_ITEMS = 3;
const ROSTER_FIELD_CAP = 200;
const ROSTER_SKILLS_CAP = 8;
const IMPRESSION_SUMMARY_CAP = 240;

function boundedText(value: string | null | undefined, maxLength = MAX_TEXT_LENGTH): string | null {
  // Roster/directory fields ride the Twin system prompt — the cut must never
  // split a surrogate pair (llmSafeText header for the DeepSeek 400 mode).
  const text = stripLoneSurrogates(String(value ?? '').trim());
  if (!text) return null;
  return text.length <= maxLength ? text : `${truncateUtf16Units(text, maxLength - 1)}…`;
}

function normalizedList(values: string[] | null | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean)));
}

function capText(value: string | null | undefined, maxLength: number): string {
  const text = stripLoneSurrogates(String(value ?? '').trim());
  if (!text) return '';
  return text.length <= maxLength ? text : `${truncateUtf16Units(text, maxLength - 1)}…`;
}

export function authorizeTwinSession(
  sessionId: string,
  deps: TwinWorkerDirectoryDeps,
): { twin: Metabot; ownerGlobalMetaId: string } {
  const session = deps.getSession(sessionId);
  if (!session) {
    throw new TwinWorkerDirectoryAuthorizationError('SOURCE_SESSION_NOT_FOUND', 'Source Cowork session was not found.');
  }
  if (!Number.isInteger(session.metabotId) || Number(session.metabotId) <= 0) {
    throw new TwinWorkerDirectoryAuthorizationError('SOURCE_METABOT_NOT_FOUND', 'Source session has no valid MetaBot attribution.');
  }

  const metabots = deps.listMetabots();
  const twins = metabots.filter((metabot) => metabot.metabot_type === 'twin');
  if (twins.length !== 1) {
    throw new TwinWorkerDirectoryAuthorizationError(
      'TWIN_INVARIANT_VIOLATION',
      `Expected exactly one local Twin Bot, found ${twins.length}.`,
    );
  }
  const twin = twins[0];
  if (twin.id !== Number(session.metabotId)) {
    throw new TwinWorkerDirectoryAuthorizationError('TWIN_TOOL_FORBIDDEN', 'Only the current Twin Bot may access the local Worker directory.');
  }
  if (!twin.enabled) {
    throw new TwinWorkerDirectoryAuthorizationError('TWIN_DISABLED', 'The current Twin Bot is disabled.');
  }

  const ownerGlobalMetaId = String(deps.getOwnerGlobalMetaId() ?? '').trim();
  const boundOwnerGlobalMetaId = String(twin.boss_global_metaid ?? '').trim();
  if (!ownerGlobalMetaId || !boundOwnerGlobalMetaId || ownerGlobalMetaId.toLowerCase() !== boundOwnerGlobalMetaId.toLowerCase()) {
    throw new TwinWorkerDirectoryAuthorizationError('OWNER_BINDING_MISMATCH', 'The Twin Bot is not bound to the active owner identity.');
  }
  return { twin, ownerGlobalMetaId };
}

export function buildTwinWorkerDirectory(
  sessionId: string,
  deps: TwinWorkerDirectoryDeps,
): TwinWorkerDirectoryResult {
  const { twin, ownerGlobalMetaId } = authorizeTwinSession(sessionId, deps);
  const workers = deps.listMetabots().map((metabot) => ({
    id: metabot.id,
    name: metabot.name.trim(),
    type: metabot.metabot_type,
    enabled: metabot.enabled,
    globalMetaID: (metabot.globalmetaid ?? '').trim() || null,
    ownerGlobalMetaId: boundedText(metabot.boss_global_metaid, 256),
    ownerBindingVerified: Boolean(
      metabot.boss_global_metaid?.trim()
      && metabot.boss_global_metaid.trim().toLowerCase() === ownerGlobalMetaId.toLowerCase(),
    ),
    role: boundedText(metabot.role) ?? '',
    bio: boundedText(metabot.bio ?? metabot.background),
    goal: boundedText(metabot.goal),
    personaSummary: boundedText([metabot.role, metabot.bio ?? metabot.background, metabot.goal, metabot.soul].filter(Boolean).join('\n')) ?? '',
    skills: normalizedList(metabot.skills),
    chatSkills: normalizedList(metabot.allow_chat_skills),
    capabilityEvidence: (deps.listCapabilityEvidence?.(metabot.id) ?? [])
      .slice(0, MAX_EVIDENCE_ITEMS)
      .map((evidence) => ({
        summaryDate: String(evidence.summaryDate ?? '').trim(),
        summaryText: boundedText(evidence.summaryText, MAX_EVIDENCE_LENGTH) ?? '',
        sessionRefs: (evidence.sessionRefs ?? []).slice(0, 5).map((ref) => ({
          sessionId: String(ref.sessionId ?? '').trim(),
          title: boundedText(ref.title, 300) ?? '',
        })),
      })),
    availability: (metabot.enabled ? 'available' : 'disabled') as 'available' | 'disabled',
    activeOrchestrationSteps: deps.getActiveWorkload ? Math.max(0, Math.trunc(deps.getActiveWorkload(metabot.id))) : null,
  }));

  return {
    requester: { sessionId, twinId: twin.id, ownerGlobalMetaId },
    workers,
  };
}

/**
 * Stable local Worker roster for the Twin system prompt. Contains only
 * metabots-table profile data (identity, role, specialty, skills), which
 * changes only when a Bot is created or edited — safe in the cached system
 * prompt prefix. Volatile dream impressions belong in the per-turn tail and
 * are rendered separately by buildTwinLocalImpressionBlock.
 */
export function buildTwinLocalRosterBlock(directory: TwinWorkerDirectoryResult): string {
  const workers = directory.workers
    .filter((worker) => worker.type !== 'twin')
    .sort((left, right) => left.id - right.id);
  if (workers.length === 0) return '';

  const lines = workers.map((worker) => {
    const fields: string[] = [];
    const metaId = (worker.globalMetaID ?? '').trim();
    if (metaId) fields.push(`MetaID: ${metaId}`);
    const role = capText(worker.role, ROSTER_FIELD_CAP);
    if (role) fields.push(`Role: ${role}`);
    const bio = capText(worker.bio, ROSTER_FIELD_CAP);
    if (bio) fields.push(`Bio: ${bio}`);
    const goal = capText(worker.goal, ROSTER_FIELD_CAP);
    if (goal) fields.push(`Goal: ${goal}`);
    if (worker.skills.length > 0) {
      const shown = worker.skills.slice(0, ROSTER_SKILLS_CAP);
      fields.push(`Skills: ${shown.join(', ')}${worker.skills.length > ROSTER_SKILLS_CAP ? ', …' : ''}`);
    }
    return `- ${worker.name} (id=${worker.id}, ${worker.enabled ? 'enabled' : 'disabled'})${fields.length > 0 ? ` — ${fields.join('; ')}` : ''}`;
  });

  return [
    '## Local Worker Roster',
    'This is the current roster of persistent local Worker Bots. Recognize a Worker by name or id immediately; you do NOT need to call local_workers_list just to identify who someone is or what their role is.',
    ...lines,
    '- Disabled Workers exist but cannot be delegated to until re-enabled.',
  ].join('\n');
}

/**
 * Twin's distilled impressions of local Workers (nightly dream layer).
 * Volatile by nature, so this block rides the per-turn user-message tail and
 * never enters the cached system-prompt prefix.
 */
export function buildTwinLocalImpressionBlock(
  directory: TwinWorkerDirectoryResult,
  impressions: TwinImpressionEntry[],
): string {
  const bySubject = new Map(impressions.map((entry) => [entry.subjectGlobalMetaID, entry]));
  const lines = directory.workers
    .filter((worker) => worker.type !== 'twin' && Boolean(worker.globalMetaID))
    .sort((left, right) => left.id - right.id)
    .map((worker) => {
      const entry = bySubject.get(worker.globalMetaID as string);
      const summary = capText(entry?.summaryText, IMPRESSION_SUMMARY_CAP);
      const tags = (entry?.capabilityTags ?? []).filter(Boolean).slice(0, 8);
      const last = entry?.lastCollaboration;
      const extras: string[] = [];
      if (tags.length > 0) extras.push(`tags: ${tags.join(', ')}`);
      if (last?.title) {
        extras.push(`last collab: "${capText(last.title, 80)}" ${last.outcome}`);
      }
      if (!summary && extras.length === 0) return null;
      const suffix = extras.length > 0 ? ` [${extras.join('; ')}]` : '';
      return `- ${worker.name}: ${summary || 'no written summary'}${suffix}`;
    })
    .filter((line): line is string => Boolean(line));
  if (lines.length === 0) return '';
  return [
    '<local_worker_impressions>',
    'Your latest distilled impressions of local Workers (updated by nightly dream consolidation):',
    ...lines,
    '</local_worker_impressions>',
  ].join('\n');
}
