import { v4 as uuidv4 } from 'uuid';
import {
  normalizeGlobalMetaID,
  requireGlobalMetaID,
  type GlobalMetaID,
} from './shared/globalMetaId';
import type { SqliteDatabase as Database } from './sqliteTypes';

export const METAID_EXPERIENCE_EPISODE_TYPES = [
  'direct_interaction',
  'task_participation',
  'service_order',
  'scheduled_task',
  'public_pin_observation',
  'third_party_reference',
] as const;

export type MetaIDExperienceEpisodeType = typeof METAID_EXPERIENCE_EPISODE_TYPES[number];
export type MetaIDExperienceEpisodeStatus = 'open' | 'completed' | 'failed' | 'abandoned';

export interface MetaIDExperienceEpisode {
  id: string;
  ownerGlobalMetaID: GlobalMetaID;
  episodeType: MetaIDExperienceEpisodeType;
  sourceChannel: string;
  sourceKey: string;
  sessionId: string | null;
  externalConversationId: string | null;
  taskId: string | null;
  orderId: string | null;
  status: MetaIDExperienceEpisodeStatus;
  startedAt: number;
  endedAt: number | null;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface MetaIDExperienceParticipant {
  episodeId: string;
  participantKey: string;
  globalMetaID: GlobalMetaID | null;
  unresolvedActorKey: string | null;
  identityState: 'known' | 'unknown';
  role: string;
  displayName: string | null;
  source: string;
  createdAt: number;
}

export interface MetaIDExperienceEvidence {
  id: string;
  episodeId: string;
  evidenceType: string;
  sourceKey: string;
  pinId: string | null;
  publisherGlobalMetaID: GlobalMetaID | null;
  messageId: string | null;
  contentHash: string;
  occurredAt: number;
  retrievedAt: number | null;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface CreateMetaIDExperienceEpisodeInput {
  id?: string;
  ownerGlobalMetaID: unknown;
  episodeType: MetaIDExperienceEpisodeType;
  sourceChannel: string;
  sourceKey: string;
  sessionId?: string | null;
  externalConversationId?: string | null;
  taskId?: string | null;
  orderId?: string | null;
  status?: MetaIDExperienceEpisodeStatus;
  startedAt?: number;
  endedAt?: number | null;
  metadata?: Record<string, unknown>;
}

export interface AddMetaIDExperienceParticipantInput {
  episodeId: string;
  globalMetaID?: unknown;
  unresolvedActorKey?: string | null;
  role: string;
  displayName?: string | null;
  source: string;
}

export interface AddMetaIDExperienceEvidenceInput {
  episodeId: string;
  evidenceType: string;
  sourceKey: string;
  pinId?: string | null;
  publisherGlobalMetaID?: unknown;
  messageId?: string | null;
  contentHash?: string | null;
  occurredAt?: number;
  retrievedAt?: number | null;
  metadata?: Record<string, unknown>;
}

export interface ListMetaIDExperienceEpisodesOptions {
  ownerGlobalMetaID: unknown;
  subjectGlobalMetaID?: unknown;
  fromTime?: number;
  toTime?: number;
  limit?: number;
}

interface EpisodeRow {
  id: string;
  owner_globalmetaid: string;
  episode_type: string;
  source_channel: string;
  source_key: string;
  session_id: string | null;
  external_conversation_id: string | null;
  task_id: string | null;
  order_id: string | null;
  status: string;
  started_at: number | string;
  ended_at: number | string | null;
  metadata_json: string | null;
  created_at: number | string;
  updated_at: number | string;
}

interface ParticipantRow {
  episode_id: string;
  participant_key: string;
  globalmetaid: string | null;
  unresolved_actor_key: string | null;
  identity_state: string;
  role: string;
  display_name: string | null;
  source: string;
  created_at: number | string;
}

interface EvidenceRow {
  id: string;
  episode_id: string;
  evidence_type: string;
  source_key: string;
  pin_id: string | null;
  publisher_globalmetaid: string | null;
  message_id: string | null;
  content_hash: string | null;
  occurred_at: number | string;
  retrieved_at: number | string | null;
  metadata_json: string | null;
  created_at: number | string;
}

const EPISODE_TYPES_SQL = METAID_EXPERIENCE_EPISODE_TYPES.map((value) => `'${value}'`).join(', ');
const EPISODE_STATUSES_SQL = "'open', 'completed', 'failed', 'abandoned'";

/** Create the cognition ledger schema without changing existing user data. */
export function ensureMetaIDExperienceSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS metaid_experience_episodes (
      id TEXT PRIMARY KEY,
      owner_globalmetaid TEXT NOT NULL,
      episode_type TEXT NOT NULL CHECK (episode_type IN (${EPISODE_TYPES_SQL})),
      source_channel TEXT NOT NULL CHECK (trim(source_channel) <> ''),
      source_key TEXT NOT NULL CHECK (trim(source_key) <> ''),
      session_id TEXT,
      external_conversation_id TEXT,
      task_id TEXT,
      order_id TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (${EPISODE_STATUSES_SQL})),
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(owner_globalmetaid, source_channel, source_key)
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_experience_episodes_owner_time
      ON metaid_experience_episodes(owner_globalmetaid, started_at DESC);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_experience_episodes_session
      ON metaid_experience_episodes(session_id, started_at DESC);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_experience_episodes_external_conversation
      ON metaid_experience_episodes(external_conversation_id, started_at DESC);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_experience_episodes_task
      ON metaid_experience_episodes(task_id, started_at DESC);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_experience_episodes_order
      ON metaid_experience_episodes(order_id, started_at DESC);
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS metaid_experience_participants (
      episode_id TEXT NOT NULL,
      participant_key TEXT NOT NULL,
      globalmetaid TEXT,
      unresolved_actor_key TEXT,
      identity_state TEXT NOT NULL CHECK (identity_state IN ('known', 'unknown')),
      role TEXT NOT NULL CHECK (trim(role) <> ''),
      display_name TEXT,
      source TEXT NOT NULL CHECK (trim(source) <> ''),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (episode_id, participant_key, role),
      CHECK (
        (globalmetaid IS NOT NULL AND trim(globalmetaid) <> '' AND unresolved_actor_key IS NULL)
        OR (globalmetaid IS NULL AND unresolved_actor_key IS NOT NULL AND trim(unresolved_actor_key) <> '')
      ),
      FOREIGN KEY (episode_id) REFERENCES metaid_experience_episodes(id) ON DELETE CASCADE
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_experience_participants_global
      ON metaid_experience_participants(globalmetaid, episode_id);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_experience_participants_unresolved
      ON metaid_experience_participants(unresolved_actor_key, episode_id);
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS metaid_experience_evidence (
      id TEXT PRIMARY KEY,
      episode_id TEXT NOT NULL,
      evidence_type TEXT NOT NULL CHECK (trim(evidence_type) <> ''),
      source_key TEXT NOT NULL CHECK (trim(source_key) <> ''),
      pin_id TEXT,
      publisher_globalmetaid TEXT,
      message_id TEXT,
      content_hash TEXT NOT NULL DEFAULT '',
      occurred_at INTEGER NOT NULL,
      retrieved_at INTEGER,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      UNIQUE(episode_id, evidence_type, source_key),
      FOREIGN KEY (episode_id) REFERENCES metaid_experience_episodes(id) ON DELETE CASCADE
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_experience_evidence_pin
      ON metaid_experience_evidence(pin_id);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_experience_evidence_publisher
      ON metaid_experience_evidence(publisher_globalmetaid, occurred_at DESC);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_experience_evidence_message
      ON metaid_experience_evidence(message_id);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_experience_evidence_occurred
      ON metaid_experience_evidence(episode_id, occurred_at DESC);
  `);
}

const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function asTimestamp(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function serializeMetadata(value: Record<string, unknown> | undefined): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '{}';
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

function parseMetadata(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizeEpisodeType(value: unknown): MetaIDExperienceEpisodeType {
  if (typeof value === 'string' && (METAID_EXPERIENCE_EPISODE_TYPES as readonly string[]).includes(value)) {
    return value as MetaIDExperienceEpisodeType;
  }
  throw new Error(`Unsupported experience episode type: ${String(value)}`);
}

function normalizeEpisodeStatus(value: unknown): MetaIDExperienceEpisodeStatus {
  if (value == null || value === '') return 'open';
  if (value === 'open' || value === 'completed' || value === 'failed' || value === 'abandoned') {
    return value;
  }
  throw new Error(`Unsupported experience episode status: ${String(value)}`);
}

function normalizeLimit(value: unknown, fallback = 100): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(500, Math.max(1, Math.floor(parsed)));
}

function rowToEpisode(row: EpisodeRow): MetaIDExperienceEpisode {
  return {
    id: row.id,
    ownerGlobalMetaID: requireGlobalMetaID(row.owner_globalmetaid, 'episode owner_globalmetaid'),
    episodeType: normalizeEpisodeType(row.episode_type),
    sourceChannel: row.source_channel,
    sourceKey: row.source_key,
    sessionId: row.session_id ?? null,
    externalConversationId: row.external_conversation_id ?? null,
    taskId: row.task_id ?? null,
    orderId: row.order_id ?? null,
    status: normalizeEpisodeStatus(row.status),
    startedAt: asTimestamp(row.started_at, 0),
    endedAt: row.ended_at == null ? null : asTimestamp(row.ended_at, 0),
    metadata: parseMetadata(row.metadata_json),
    createdAt: asTimestamp(row.created_at, 0),
    updatedAt: asTimestamp(row.updated_at, 0),
  };
}

function rowToParticipant(row: ParticipantRow): MetaIDExperienceParticipant {
  return {
    episodeId: row.episode_id,
    participantKey: row.participant_key,
    globalMetaID: normalizeGlobalMetaID(row.globalmetaid),
    unresolvedActorKey: row.unresolved_actor_key ?? null,
    identityState: row.identity_state === 'known' ? 'known' : 'unknown',
    role: row.role,
    displayName: row.display_name ?? null,
    source: row.source,
    createdAt: asTimestamp(row.created_at, 0),
  };
}

function rowToEvidence(row: EvidenceRow): MetaIDExperienceEvidence {
  return {
    id: row.id,
    episodeId: row.episode_id,
    evidenceType: row.evidence_type,
    sourceKey: row.source_key,
    pinId: row.pin_id ?? null,
    publisherGlobalMetaID: normalizeGlobalMetaID(row.publisher_globalmetaid),
    messageId: row.message_id ?? null,
    contentHash: row.content_hash ?? '',
    occurredAt: asTimestamp(row.occurred_at, 0),
    retrievedAt: row.retrieved_at == null ? null : asTimestamp(row.retrieved_at, 0),
    metadata: parseMetadata(row.metadata_json),
    createdAt: asTimestamp(row.created_at, 0),
  };
}

export class MetaIDExperienceStore {
  constructor(
    private readonly db: Database,
    private readonly saveDb: () => void,
    private readonly now: () => number = Date.now,
  ) {
    ensureMetaIDExperienceSchema(db);
  }

  private getOne<T>(sql: string, params: unknown[] = []): T | null {
    const result = this.db.exec(sql, params);
    const columns = result[0]?.columns ?? [];
    const values = result[0]?.values?.[0];
    if (!values) return null;
    return Object.fromEntries(columns.map((column, index) => [column, values[index]])) as T;
  }

  private getAll<T>(sql: string, params: unknown[] = []): T[] {
    const result = this.db.exec(sql, params);
    const columns = result[0]?.columns ?? [];
    return (result[0]?.values ?? []).map((values) =>
      Object.fromEntries(columns.map((column, index) => [column, values[index]])) as T
    );
  }

  private getEpisodeOrThrow(episodeId: string): MetaIDExperienceEpisode {
    const episode = this.getEpisode(episodeId);
    if (!episode) throw new Error(`Experience episode not found: ${episodeId}`);
    return episode;
  }

  getEpisode(episodeId: string): MetaIDExperienceEpisode | null {
    const id = asText(episodeId);
    if (!id) return null;
    const row = this.getOne<EpisodeRow>(
      'SELECT * FROM metaid_experience_episodes WHERE id = ? LIMIT 1',
      [id],
    );
    return row ? rowToEpisode(row) : null;
  }

  createEpisode(input: CreateMetaIDExperienceEpisodeInput): { episode: MetaIDExperienceEpisode; created: boolean } {
    const ownerGlobalMetaID = requireGlobalMetaID(input.ownerGlobalMetaID, 'ownerGlobalMetaID');
    const sourceChannel = asText(input.sourceChannel);
    const sourceKey = asText(input.sourceKey);
    if (!sourceChannel || !sourceKey) throw new Error('Experience episode sourceChannel and sourceKey are required');
    const existing = this.getOne<EpisodeRow>(
      `SELECT * FROM metaid_experience_episodes
       WHERE owner_globalmetaid = ? AND source_channel = ? AND source_key = ? LIMIT 1`,
      [ownerGlobalMetaID, sourceChannel, sourceKey],
    );
    if (existing) return { episode: rowToEpisode(existing), created: false };

    const now = this.now();
    const id = asText(input.id) || uuidv4();
    const startedAt = asTimestamp(input.startedAt, now);
    const endedAt = input.endedAt == null ? null : asTimestamp(input.endedAt, startedAt);
    this.db.run(
      `INSERT INTO metaid_experience_episodes (
         id, owner_globalmetaid, episode_type, source_channel, source_key,
         session_id, external_conversation_id, task_id, order_id, status,
         started_at, ended_at, metadata_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        ownerGlobalMetaID,
        normalizeEpisodeType(input.episodeType),
        sourceChannel,
        sourceKey,
        asText(input.sessionId) || null,
        asText(input.externalConversationId) || null,
        asText(input.taskId) || null,
        asText(input.orderId) || null,
        normalizeEpisodeStatus(input.status),
        startedAt,
        endedAt,
        serializeMetadata(input.metadata),
        now,
        now,
      ],
    );
    this.saveDb();
    const episode = this.getEpisode(id);
    if (!episode) throw new Error(`Failed to create experience episode: ${id}`);
    return { episode, created: true };
  }

  updateEpisodeStatus(input: {
    episodeId: string;
    status: MetaIDExperienceEpisodeStatus;
    endedAt?: number | null;
  }): MetaIDExperienceEpisode {
    const id = asText(input.episodeId);
    const existing = this.getEpisodeOrThrow(id);
    const now = this.now();
    const endedAt = input.endedAt === undefined
      ? (input.status === 'open' ? existing.endedAt : existing.endedAt ?? now)
      : input.endedAt == null ? null : asTimestamp(input.endedAt, now);
    this.db.run(
      `UPDATE metaid_experience_episodes
       SET status = ?, ended_at = ?, updated_at = ?
       WHERE id = ?`,
      [normalizeEpisodeStatus(input.status), endedAt, now, id],
    );
    this.saveDb();
    return this.getEpisodeOrThrow(id);
  }

  addParticipant(input: AddMetaIDExperienceParticipantInput): MetaIDExperienceParticipant {
    const episodeId = asText(input.episodeId);
    this.getEpisodeOrThrow(episodeId);
    const role = asText(input.role);
    const source = asText(input.source);
    if (!role || !source) throw new Error('Experience participant role and source are required');
    const rawGlobalMetaID = input.globalMetaID;
    const hasGlobalValue = typeof rawGlobalMetaID === 'string' && rawGlobalMetaID.trim() !== '';
    const globalMetaID = normalizeGlobalMetaID(rawGlobalMetaID);
    if (hasGlobalValue && !globalMetaID) throw new Error('Participant GlobalMetaID is invalid');
    const unresolvedActorKey = asText(input.unresolvedActorKey);
    if ((globalMetaID && unresolvedActorKey) || (!globalMetaID && !unresolvedActorKey)) {
      throw new Error('Participant requires exactly one known or unresolved identity');
    }
    const participantKey = globalMetaID ? `global:${globalMetaID}` : `unresolved:${unresolvedActorKey}`;
    const existing = this.getOne<ParticipantRow>(
      `SELECT * FROM metaid_experience_participants
       WHERE episode_id = ? AND participant_key = ? AND role = ? LIMIT 1`,
      [episodeId, participantKey, role],
    );
    if (existing) return rowToParticipant(existing);

    const createdAt = this.now();
    this.db.run(
      `INSERT INTO metaid_experience_participants (
         episode_id, participant_key, globalmetaid, unresolved_actor_key,
         identity_state, role, display_name, source, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        episodeId,
        participantKey,
        globalMetaID,
        globalMetaID ? null : unresolvedActorKey,
        globalMetaID ? 'known' : 'unknown',
        role,
        asText(input.displayName) || null,
        source,
        createdAt,
      ],
    );
    this.saveDb();
    const participant = this.getOne<ParticipantRow>(
      `SELECT * FROM metaid_experience_participants
       WHERE episode_id = ? AND participant_key = ? AND role = ? LIMIT 1`,
      [episodeId, participantKey, role],
    );
    if (!participant) throw new Error(`Failed to create experience participant: ${participantKey}`);
    return rowToParticipant(participant);
  }

  listParticipants(episodeId: string): MetaIDExperienceParticipant[] {
    return this.getAll<ParticipantRow>(
      `SELECT * FROM metaid_experience_participants
       WHERE episode_id = ? ORDER BY created_at ASC, participant_key ASC, role ASC`,
      [asText(episodeId)],
    ).map(rowToParticipant);
  }

  addEvidence(input: AddMetaIDExperienceEvidenceInput): MetaIDExperienceEvidence {
    const episodeId = asText(input.episodeId);
    this.getEpisodeOrThrow(episodeId);
    const evidenceType = asText(input.evidenceType);
    const sourceKey = asText(input.sourceKey);
    if (!evidenceType || !sourceKey) throw new Error('Experience evidence type and sourceKey are required');
    const rawPublisher = input.publisherGlobalMetaID;
    const hasPublisherValue = typeof rawPublisher === 'string' && rawPublisher.trim() !== '';
    const publisherGlobalMetaID = normalizeGlobalMetaID(rawPublisher);
    if (hasPublisherValue && !publisherGlobalMetaID) throw new Error('Evidence publisher GlobalMetaID is invalid');
    const existing = this.getOne<EvidenceRow>(
      `SELECT * FROM metaid_experience_evidence
       WHERE episode_id = ? AND evidence_type = ? AND source_key = ? LIMIT 1`,
      [episodeId, evidenceType, sourceKey],
    );
    if (existing) return rowToEvidence(existing);

    const createdAt = this.now();
    const id = uuidv4();
    this.db.run(
      `INSERT INTO metaid_experience_evidence (
         id, episode_id, evidence_type, source_key, pin_id,
         publisher_globalmetaid, message_id, content_hash, occurred_at,
         retrieved_at, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        episodeId,
        evidenceType,
        sourceKey,
        asText(input.pinId) || null,
        publisherGlobalMetaID,
        asText(input.messageId) || null,
        asText(input.contentHash),
        asTimestamp(input.occurredAt, createdAt),
        input.retrievedAt == null ? null : asTimestamp(input.retrievedAt, createdAt),
        serializeMetadata(input.metadata),
        createdAt,
      ],
    );
    this.saveDb();
    const evidence = this.getOne<EvidenceRow>('SELECT * FROM metaid_experience_evidence WHERE id = ? LIMIT 1', [id]);
    if (!evidence) throw new Error(`Failed to create experience evidence: ${id}`);
    return rowToEvidence(evidence);
  }

  listEvidence(episodeId: string): MetaIDExperienceEvidence[] {
    return this.getAll<EvidenceRow>(
      `SELECT * FROM metaid_experience_evidence
       WHERE episode_id = ? ORDER BY occurred_at ASC, created_at ASC, id ASC`,
      [asText(episodeId)],
    ).map(rowToEvidence);
  }

  listEpisodes(options: ListMetaIDExperienceEpisodesOptions): MetaIDExperienceEpisode[] {
    const ownerGlobalMetaID = requireGlobalMetaID(options.ownerGlobalMetaID, 'ownerGlobalMetaID');
    const subjectGlobalMetaID = options.subjectGlobalMetaID === undefined
      ? null
      : normalizeGlobalMetaID(options.subjectGlobalMetaID);
    if (options.subjectGlobalMetaID !== undefined && !subjectGlobalMetaID) return [];
    const clauses = ['e.owner_globalmetaid = ?'];
    const params: unknown[] = [ownerGlobalMetaID];
    if (subjectGlobalMetaID) {
      clauses.push(`EXISTS (
        SELECT 1 FROM metaid_experience_participants p
        WHERE p.episode_id = e.id AND p.globalmetaid = ?
      )`);
      params.push(subjectGlobalMetaID);
    }
    if (options.fromTime != null) {
      clauses.push('e.started_at >= ?');
      params.push(asTimestamp(options.fromTime, 0));
    }
    if (options.toTime != null) {
      clauses.push('e.started_at < ?');
      params.push(asTimestamp(options.toTime, Number.MAX_SAFE_INTEGER));
    }
    params.push(normalizeLimit(options.limit));
    return this.getAll<EpisodeRow>(
      `SELECT e.* FROM metaid_experience_episodes e
       WHERE ${clauses.join(' AND ')}
       ORDER BY e.started_at DESC, e.created_at DESC, e.id DESC
       LIMIT ?`,
      params,
    ).map(rowToEpisode);
  }
}
