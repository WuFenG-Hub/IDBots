import type { Metabot } from '../types/metabot';

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

function boundedText(value: string | null | undefined, maxLength = MAX_TEXT_LENGTH): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function normalizedList(values: string[] | null | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean)));
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
