import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { ensureMetaIDExperienceSchema } from './metaidExperienceStore';
import {
  normalizeGlobalMetaID,
  requireGlobalMetaID,
  type GlobalMetaID,
} from './shared/globalMetaId';
import type { SqliteDatabase as Database } from './sqliteTypes';

export const METAID_IMPRESSION_SNAPSHOT_VERSION = 2;

export type MetaIDCollaborationFact = {
  taskId: number;
  title: string;
  seatRole?: string;
  outcome: string;
  pinIds: string[];
  groupId?: string;
  at: number;
};

export type MetaIDImpressionObservationStatus = 'active' | 'superseded' | 'rejected';

export interface MetaIDImpressionObservation {
  id: string;
  observerGlobalMetaID: GlobalMetaID;
  subjectGlobalMetaID: GlobalMetaID;
  episodeId: string | null;
  observationText: string;
  interpretationText: string;
  dimensions: Record<string, unknown>;
  communicationGuidance: string | null;
  confidence: Record<string, unknown>;
  dreamDate: string;
  dreamVersion: number;
  modelId: string | null;
  sourceHash: string;
  idempotencyKey: string;
  supersedesObservationId: string | null;
  status: MetaIDImpressionObservationStatus;
  createdAt: number;
}

export interface MetaIDImpressionObservationEvidence {
  observationId: string;
  evidenceId: string;
  relevance: string | null;
  createdAt: number;
}

export interface MetaIDImpressionSnapshot {
  observerGlobalMetaID: GlobalMetaID;
  subjectGlobalMetaID: GlobalMetaID;
  firstSeenAt: number;
  lastSeenAt: number;
  interactionCount: number;
  directInteractionCount: number;
  summaryText: string;
  styleDescriptors: string[];
  cooperationContext: string | null;
  relationshipTemperature: string | null;
  communicationGuidance: string | null;
  uncertaintyText: string | null;
  capabilityTags: string[];
  collaborationFacts: MetaIDCollaborationFact[];
  latestObservationId: string;
  snapshotVersion: number;
  sourceHash: string;
  createdAt: number;
  updatedAt: number;
}

export interface AppendMetaIDImpressionObservationInput {
  id?: string;
  observerGlobalMetaID: unknown;
  subjectGlobalMetaID: unknown;
  episodeId?: string | null;
  evidenceIds: string[];
  evidenceRelevance?: Record<string, string>;
  observationText: string;
  interpretationText: string;
  dimensions?: Record<string, unknown>;
  communicationGuidance?: string | null;
  confidence?: Record<string, unknown>;
  dreamDate: string;
  dreamVersion: number;
  modelId?: string | null;
  sourceHash: string;
  idempotencyKey?: string;
  supersedesObservationId?: string | null;
}

interface ObservationRow {
  id: string;
  observer_globalmetaid: string;
  subject_globalmetaid: string;
  episode_id: string | null;
  observation_text: string;
  interpretation_text: string;
  dimensions_json: string;
  communication_guidance: string | null;
  confidence_json: string;
  dream_date: string;
  dream_version: number | string;
  model_id: string | null;
  source_hash: string;
  idempotency_key: string;
  supersedes_observation_id: string | null;
  status: string;
  created_at: number | string;
}

interface ObservationEvidenceRow {
  observation_id: string;
  evidence_id: string;
  relevance: string | null;
  created_at: number | string;
}

interface SnapshotRow {
  observer_globalmetaid: string;
  subject_globalmetaid: string;
  first_seen_at: number | string;
  last_seen_at: number | string;
  interaction_count: number | string;
  direct_interaction_count: number | string;
  summary_text: string;
  style_descriptors_json: string;
  cooperation_context: string | null;
  relationship_temperature: string | null;
  communication_guidance: string | null;
  uncertainty_text: string | null;
  capability_tags_json?: string | null;
  collaboration_facts_json?: string | null;
  latest_observation_id: string;
  snapshot_version: number | string;
  source_hash: string;
  created_at: number | string;
  updated_at: number | string;
}

interface EpisodeStatsRow {
  first_seen_at: number | string | null;
  last_seen_at: number | string | null;
  interaction_count: number | string;
  direct_interaction_count: number | string;
}

const OBSERVATION_STATUSES_SQL = "'active', 'superseded', 'rejected'";
const MAX_OBSERVATION_TEXT = 4_000;
const MAX_INTERPRETATION_TEXT = 4_000;
const MAX_GUIDANCE_TEXT = 2_000;
const MAX_RELEVANCE_TEXT = 500;
const MAX_JSON_TEXT = 8_000;
const MAX_EVIDENCE_REFS = 100;
const MAX_STYLE_DESCRIPTORS = 16;

/** Create the private impression schema without changing existing user data. */
export function ensureMetaIDImpressionSchema(db: Database): void {
  ensureMetaIDExperienceSchema(db);
  db.run(`
    CREATE TABLE IF NOT EXISTS metaid_impression_observations (
      id TEXT PRIMARY KEY,
      observer_globalmetaid TEXT NOT NULL CHECK (trim(observer_globalmetaid) <> ''),
      subject_globalmetaid TEXT NOT NULL CHECK (trim(subject_globalmetaid) <> ''),
      episode_id TEXT,
      observation_text TEXT NOT NULL CHECK (trim(observation_text) <> ''),
      interpretation_text TEXT NOT NULL CHECK (trim(interpretation_text) <> ''),
      dimensions_json TEXT NOT NULL DEFAULT '{}',
      communication_guidance TEXT,
      confidence_json TEXT NOT NULL DEFAULT '{}',
      dream_date TEXT NOT NULL,
      dream_version INTEGER NOT NULL CHECK (dream_version > 0),
      model_id TEXT,
      source_hash TEXT NOT NULL CHECK (trim(source_hash) <> ''),
      idempotency_key TEXT NOT NULL UNIQUE CHECK (trim(idempotency_key) <> ''),
      supersedes_observation_id TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (${OBSERVATION_STATUSES_SQL})),
      created_at INTEGER NOT NULL,
      CHECK (observer_globalmetaid <> subject_globalmetaid),
      FOREIGN KEY (episode_id) REFERENCES metaid_experience_episodes(id) ON DELETE RESTRICT,
      FOREIGN KEY (supersedes_observation_id) REFERENCES metaid_impression_observations(id) ON DELETE RESTRICT
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_impression_observations_pair_time
      ON metaid_impression_observations(observer_globalmetaid, subject_globalmetaid, created_at DESC);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_impression_observations_dream
      ON metaid_impression_observations(observer_globalmetaid, dream_date, dream_version);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_impression_observations_episode
      ON metaid_impression_observations(episode_id);
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS metaid_impression_observation_evidence (
      observation_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      relevance TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (observation_id, evidence_id),
      FOREIGN KEY (observation_id) REFERENCES metaid_impression_observations(id) ON DELETE CASCADE,
      FOREIGN KEY (evidence_id) REFERENCES metaid_experience_evidence(id) ON DELETE RESTRICT
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_impression_observation_evidence_source
      ON metaid_impression_observation_evidence(evidence_id, observation_id);
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS metaid_impression_snapshots (
      observer_globalmetaid TEXT NOT NULL,
      subject_globalmetaid TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      interaction_count INTEGER NOT NULL CHECK (interaction_count >= 0),
      direct_interaction_count INTEGER NOT NULL CHECK (direct_interaction_count >= 0),
      summary_text TEXT NOT NULL,
      style_descriptors_json TEXT NOT NULL DEFAULT '[]',
      cooperation_context TEXT,
      relationship_temperature TEXT,
      communication_guidance TEXT,
      uncertainty_text TEXT,
      capability_tags_json TEXT NOT NULL DEFAULT '[]',
      collaboration_facts_json TEXT NOT NULL DEFAULT '[]',
      latest_observation_id TEXT NOT NULL,
      snapshot_version INTEGER NOT NULL,
      source_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (observer_globalmetaid, subject_globalmetaid),
      CHECK (observer_globalmetaid <> subject_globalmetaid),
      FOREIGN KEY (latest_observation_id) REFERENCES metaid_impression_observations(id) ON DELETE RESTRICT
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_impression_snapshots_observer_updated
      ON metaid_impression_snapshots(observer_globalmetaid, updated_at DESC);
  `);
  try {
    const colsResult = db.exec('PRAGMA table_info(metaid_impression_snapshots)');
    const columns = (colsResult[0]?.values?.map((row) => String(row[1])) ?? []);
    if (!columns.includes('capability_tags_json')) {
      db.run(`ALTER TABLE metaid_impression_snapshots ADD COLUMN capability_tags_json TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!columns.includes('collaboration_facts_json')) {
      db.run(`ALTER TABLE metaid_impression_snapshots ADD COLUMN collaboration_facts_json TEXT NOT NULL DEFAULT '[]'`);
    }
  } catch {
    // Brand-new table already has the columns.
  }
}

const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function asInteger(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function boundedRequiredText(value: unknown, label: string, maxLength: number): string {
  const result = asText(value);
  if (!result) throw new Error(`${label} is required`);
  if (result.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters`);
  return result;
}

function boundedOptionalText(value: unknown, label: string, maxLength: number): string | null {
  const result = asText(value);
  if (!result) return null;
  if (result.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters`);
  return result;
}

function serializeJsonObject(value: unknown, label: string): string {
  if (value == null) return '{}';
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON-serializable`);
  }
  if (serialized.length > MAX_JSON_TEXT) throw new Error(`${label} exceeds ${MAX_JSON_TEXT} characters`);
  return serialized;
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
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

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function parseCollaborationFacts(value: string | null | undefined): MetaIDCollaborationFact[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const row = item as Record<string, unknown>;
      const pinIds = Array.isArray(row.pinIds)
        ? row.pinIds.map((pin) => String(pin ?? '').trim()).filter(Boolean)
        : [];
      const taskId = Number(row.taskId);
      const title = typeof row.title === 'string' ? row.title.trim() : '';
      const outcome = typeof row.outcome === 'string' ? row.outcome.trim() : '';
      if (!Number.isInteger(taskId) || taskId <= 0 || !title || !outcome || pinIds.length === 0) {
        return [];
      }
      return [{
        taskId,
        title,
        seatRole: typeof row.seatRole === 'string' ? row.seatRole : undefined,
        outcome,
        pinIds,
        groupId: typeof row.groupId === 'string' ? row.groupId : undefined,
        at: asInteger(row.at),
      }];
    });
  } catch {
    return [];
  }
}

function collectCapabilityTags(observations: MetaIDImpressionObservation[]): string[] {
  const tags = new Set<string>();
  for (const observation of observations) {
    for (const tag of extractStringList(observation.dimensions.capabilityTags)) {
      tags.add(tag.slice(0, 80));
    }
    const weak = extractText(observation.dimensions.weakSeat);
    if (weak) tags.add(`weak:${weak.slice(0, 60)}`);
  }
  return [...tags].slice(0, 24);
}

function collectCollaborationFacts(observations: MetaIDImpressionObservation[]): MetaIDCollaborationFact[] {
  const facts: MetaIDCollaborationFact[] = [];
  const seen = new Set<string>();
  for (const observation of observations) {
    const rawFacts = Array.isArray(observation.dimensions.collaborationFacts)
      ? observation.dimensions.collaborationFacts
      : observation.dimensions.collaborationFact
        ? [observation.dimensions.collaborationFact]
        : [];
    for (const item of rawFacts) {
      const parsed = parseCollaborationFacts(JSON.stringify([item]));
      for (const fact of parsed) {
        const key = `${fact.taskId}:${fact.outcome}:${fact.pinIds.join(',')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        facts.push(fact);
      }
    }
  }
  return facts.slice(-20);
}

function normalizeObservationStatus(value: unknown): MetaIDImpressionObservationStatus {
  if (value === 'superseded' || value === 'rejected') return value;
  return 'active';
}

function normalizeDreamDate(value: unknown): string {
  const date = asText(value);
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? Date.parse(`${date}T00:00:00.000Z`)
    : Number.NaN;
  if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) {
    throw new Error('dreamDate must be a valid YYYY-MM-DD date');
  }
  return date;
}

function normalizeDreamVersion(value: unknown): number {
  const version = Number(value);
  if (!Number.isInteger(version) || version <= 0) throw new Error('dreamVersion must be a positive integer');
  return version;
}

function normalizeSourceHash(value: unknown): string {
  const sourceHash = asText(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error('sourceHash must be a SHA-256 hex digest');
  return sourceHash;
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function deriveIdempotencyKey(input: {
  observerGlobalMetaID: GlobalMetaID;
  subjectGlobalMetaID: GlobalMetaID;
  dreamDate: string;
  dreamVersion: number;
  sourceHash: string;
}): string {
  return `metaid-impression:${hash(JSON.stringify(input))}`;
}

function rowToObservation(row: ObservationRow): MetaIDImpressionObservation {
  return {
    id: row.id,
    observerGlobalMetaID: requireGlobalMetaID(row.observer_globalmetaid, 'observation observer_globalmetaid'),
    subjectGlobalMetaID: requireGlobalMetaID(row.subject_globalmetaid, 'observation subject_globalmetaid'),
    episodeId: row.episode_id ?? null,
    observationText: row.observation_text,
    interpretationText: row.interpretation_text,
    dimensions: parseJsonObject(row.dimensions_json),
    communicationGuidance: row.communication_guidance ?? null,
    confidence: parseJsonObject(row.confidence_json),
    dreamDate: row.dream_date,
    dreamVersion: asInteger(row.dream_version),
    modelId: row.model_id ?? null,
    sourceHash: row.source_hash,
    idempotencyKey: row.idempotency_key,
    supersedesObservationId: row.supersedes_observation_id ?? null,
    status: normalizeObservationStatus(row.status),
    createdAt: asInteger(row.created_at),
  };
}

function rowToObservationEvidence(row: ObservationEvidenceRow): MetaIDImpressionObservationEvidence {
  return {
    observationId: row.observation_id,
    evidenceId: row.evidence_id,
    relevance: row.relevance ?? null,
    createdAt: asInteger(row.created_at),
  };
}

function rowToSnapshot(row: SnapshotRow): MetaIDImpressionSnapshot {
  return {
    observerGlobalMetaID: requireGlobalMetaID(row.observer_globalmetaid, 'snapshot observer_globalmetaid'),
    subjectGlobalMetaID: requireGlobalMetaID(row.subject_globalmetaid, 'snapshot subject_globalmetaid'),
    firstSeenAt: asInteger(row.first_seen_at),
    lastSeenAt: asInteger(row.last_seen_at),
    interactionCount: asInteger(row.interaction_count),
    directInteractionCount: asInteger(row.direct_interaction_count),
    summaryText: row.summary_text,
    styleDescriptors: parseStringArray(row.style_descriptors_json),
    cooperationContext: row.cooperation_context ?? null,
    relationshipTemperature: row.relationship_temperature ?? null,
    communicationGuidance: row.communication_guidance ?? null,
    uncertaintyText: row.uncertainty_text ?? null,
    capabilityTags: parseStringArray(row.capability_tags_json),
    collaborationFacts: parseCollaborationFacts(row.collaboration_facts_json),
    latestObservationId: row.latest_observation_id,
    snapshotVersion: asInteger(row.snapshot_version),
    sourceHash: row.source_hash,
    createdAt: asInteger(row.created_at),
    updatedAt: asInteger(row.updated_at),
  };
}

function normalizeEvidenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('evidenceIds must be an array');
  const result = [...new Set(value.map(asText).filter(Boolean))];
  if (result.length === 0) throw new Error('At least one evidence ID is required');
  if (result.length > MAX_EVIDENCE_REFS) throw new Error(`evidenceIds exceeds ${MAX_EVIDENCE_REFS} entries`);
  return result;
}

function extractText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return boundedOptionalText(value, 'snapshot dimension', 1_000);
}

function extractStringList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function latestDimensionText(
  dimensions: Map<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const result = extractText(dimensions.get(key));
    if (result) return result;
  }
  return null;
}

export class MetaIDImpressionStore {
  constructor(
    private readonly db: Database,
    private readonly saveDb: () => void,
    private readonly now: () => number = Date.now,
  ) {
    ensureMetaIDImpressionSchema(db);
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

  getObservation(id: string): MetaIDImpressionObservation | null {
    const observationId = asText(id);
    if (!observationId) return null;
    const row = this.getOne<ObservationRow>(
      'SELECT * FROM metaid_impression_observations WHERE id = ? LIMIT 1',
      [observationId],
    );
    return row ? rowToObservation(row) : null;
  }

  getObservationEvidence(observationId: string): MetaIDImpressionObservationEvidence[] {
    return this.getAll<ObservationEvidenceRow>(
      `SELECT * FROM metaid_impression_observation_evidence
       WHERE observation_id = ? ORDER BY created_at ASC, evidence_id ASC`,
      [asText(observationId)],
    ).map(rowToObservationEvidence);
  }

  listObservations(input: {
    observerGlobalMetaID: unknown;
    subjectGlobalMetaID: unknown;
    includeSuperseded?: boolean;
    limit?: number;
  }): MetaIDImpressionObservation[] {
    const observer = requireGlobalMetaID(input.observerGlobalMetaID, 'observerGlobalMetaID');
    const subject = requireGlobalMetaID(input.subjectGlobalMetaID, 'subjectGlobalMetaID');
    const limit = Math.min(500, Math.max(1, asInteger(input.limit, 100)));
    return this.getAll<ObservationRow>(
      `SELECT * FROM metaid_impression_observations
       WHERE observer_globalmetaid = ? AND subject_globalmetaid = ?
         ${input.includeSuperseded ? '' : "AND status = 'active'"}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      [observer, subject, limit],
    ).map(rowToObservation);
  }

  private requireOwnedSubjectEpisode(
    episodeId: string,
    observerGlobalMetaID: GlobalMetaID,
    subjectGlobalMetaID: GlobalMetaID,
  ): void {
    const row = this.getOne<{ id: string }>(
      `SELECT e.id FROM metaid_experience_episodes e
       WHERE e.id = ? AND e.owner_globalmetaid = ?
         AND EXISTS (
           SELECT 1 FROM metaid_experience_participants p
           WHERE p.episode_id = e.id AND p.globalmetaid = ?
         )
       LIMIT 1`,
      [episodeId, observerGlobalMetaID, subjectGlobalMetaID],
    );
    if (!row) throw new Error(`Episode is not accessible for this observer and subject: ${episodeId}`);
  }

  private requireOwnedSubjectEvidence(
    evidenceId: string,
    observerGlobalMetaID: GlobalMetaID,
    subjectGlobalMetaID: GlobalMetaID,
  ): void {
    const row = this.getOne<{ id: string }>(
      `SELECT ev.id FROM metaid_experience_evidence ev
       JOIN metaid_experience_episodes e ON e.id = ev.episode_id
       WHERE ev.id = ? AND e.owner_globalmetaid = ?
         AND (
           ev.publisher_globalmetaid = ?
           OR EXISTS (
             SELECT 1 FROM metaid_experience_participants p
             WHERE p.episode_id = e.id AND p.globalmetaid = ?
           )
         )
       LIMIT 1`,
      [evidenceId, observerGlobalMetaID, subjectGlobalMetaID, subjectGlobalMetaID],
    );
    if (!row) throw new Error(`Evidence is not accessible for this observer and subject: ${evidenceId}`);
  }

  appendObservation(
    input: AppendMetaIDImpressionObservationInput,
  ): { observation: MetaIDImpressionObservation; created: boolean } {
    const observerGlobalMetaID = requireGlobalMetaID(input.observerGlobalMetaID, 'observerGlobalMetaID');
    const subjectGlobalMetaID = requireGlobalMetaID(input.subjectGlobalMetaID, 'subjectGlobalMetaID');
    if (observerGlobalMetaID === subjectGlobalMetaID) throw new Error('Self-impressions are not accepted');
    const episodeId = asText(input.episodeId) || null;
    const evidenceIds = normalizeEvidenceIds(input.evidenceIds);
    const observationText = boundedRequiredText(input.observationText, 'observationText', MAX_OBSERVATION_TEXT);
    const interpretationText = boundedRequiredText(input.interpretationText, 'interpretationText', MAX_INTERPRETATION_TEXT);
    const dimensionsJson = serializeJsonObject(input.dimensions, 'dimensions');
    const communicationGuidance = boundedOptionalText(
      input.communicationGuidance,
      'communicationGuidance',
      MAX_GUIDANCE_TEXT,
    );
    const confidenceJson = serializeJsonObject(input.confidence, 'confidence');
    const dreamDate = normalizeDreamDate(input.dreamDate);
    const dreamVersion = normalizeDreamVersion(input.dreamVersion);
    const sourceHash = normalizeSourceHash(input.sourceHash);
    const idempotencyKey = asText(input.idempotencyKey) || deriveIdempotencyKey({
      observerGlobalMetaID,
      subjectGlobalMetaID,
      dreamDate,
      dreamVersion,
      sourceHash,
    });
    if (idempotencyKey.length > 500) throw new Error('idempotencyKey exceeds 500 characters');
    const existing = this.getOne<ObservationRow>(
      'SELECT * FROM metaid_impression_observations WHERE idempotency_key = ? LIMIT 1',
      [idempotencyKey],
    );
    if (existing) {
      if (existing.observer_globalmetaid !== observerGlobalMetaID
        || existing.subject_globalmetaid !== subjectGlobalMetaID) {
        throw new Error('idempotencyKey is already owned by another observer/subject pair');
      }
      return { observation: rowToObservation(existing), created: false };
    }

    if (episodeId) this.requireOwnedSubjectEpisode(episodeId, observerGlobalMetaID, subjectGlobalMetaID);
    for (const evidenceId of evidenceIds) {
      this.requireOwnedSubjectEvidence(evidenceId, observerGlobalMetaID, subjectGlobalMetaID);
    }

    const supersedesObservationId = asText(input.supersedesObservationId) || null;
    if (supersedesObservationId) {
      const superseded = this.getObservation(supersedesObservationId);
      if (!superseded
        || superseded.observerGlobalMetaID !== observerGlobalMetaID
        || superseded.subjectGlobalMetaID !== subjectGlobalMetaID
        || superseded.status !== 'active') {
        throw new Error('supersedesObservationId must identify an active observation for the same pair');
      }
    }

    const observationId = asText(input.id) || uuidv4();
    const createdAt = this.now();
    try {
      this.db.run('BEGIN IMMEDIATE');
      this.db.run(
        `INSERT INTO metaid_impression_observations (
           id, observer_globalmetaid, subject_globalmetaid, episode_id,
           observation_text, interpretation_text, dimensions_json,
           communication_guidance, confidence_json, dream_date, dream_version,
           model_id, source_hash, idempotency_key, supersedes_observation_id,
           status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        [
          observationId,
          observerGlobalMetaID,
          subjectGlobalMetaID,
          episodeId,
          observationText,
          interpretationText,
          dimensionsJson,
          communicationGuidance,
          confidenceJson,
          dreamDate,
          dreamVersion,
          boundedOptionalText(input.modelId, 'modelId', 300),
          sourceHash,
          idempotencyKey,
          supersedesObservationId,
          createdAt,
        ],
      );
      for (const evidenceId of evidenceIds) {
        const relevance = boundedOptionalText(
          input.evidenceRelevance?.[evidenceId],
          'evidence relevance',
          MAX_RELEVANCE_TEXT,
        );
        this.db.run(
          `INSERT INTO metaid_impression_observation_evidence
             (observation_id, evidence_id, relevance, created_at)
           VALUES (?, ?, ?, ?)`,
          [observationId, evidenceId, relevance, createdAt],
        );
      }
      if (supersedesObservationId) {
        this.db.run(
          `UPDATE metaid_impression_observations SET status = 'superseded'
           WHERE id = ? AND status = 'active'`,
          [supersedesObservationId],
        );
      }
      this.db.run('COMMIT');
    } catch (error) {
      try {
        this.db.run('ROLLBACK');
      } catch {
        // Preserve the original write error.
      }
      throw error;
    }
    this.saveDb();
    const observation = this.getObservation(observationId);
    if (!observation) throw new Error(`Failed to append impression observation: ${observationId}`);
    return { observation, created: true };
  }

  getSnapshot(
    observerGlobalMetaID: unknown,
    subjectGlobalMetaID: unknown,
  ): MetaIDImpressionSnapshot | null {
    const observer = requireGlobalMetaID(observerGlobalMetaID, 'observerGlobalMetaID');
    const subject = requireGlobalMetaID(subjectGlobalMetaID, 'subjectGlobalMetaID');
    const row = this.getOne<SnapshotRow>(
      `SELECT * FROM metaid_impression_snapshots
       WHERE observer_globalmetaid = ? AND subject_globalmetaid = ? LIMIT 1`,
      [observer, subject],
    );
    return row ? rowToSnapshot(row) : null;
  }

  listSnapshots(observerGlobalMetaID: unknown, limit = 100): MetaIDImpressionSnapshot[] {
    const observer = requireGlobalMetaID(observerGlobalMetaID, 'observerGlobalMetaID');
    return this.getAll<SnapshotRow>(
      `SELECT * FROM metaid_impression_snapshots
       WHERE observer_globalmetaid = ?
       ORDER BY updated_at DESC, subject_globalmetaid ASC LIMIT ?`,
      [observer, Math.min(500, Math.max(1, asInteger(limit, 100)))],
    ).map(rowToSnapshot);
  }

  rebuildSnapshot(
    observerGlobalMetaID: unknown,
    subjectGlobalMetaID: unknown,
  ): MetaIDImpressionSnapshot | null {
    const observer = requireGlobalMetaID(observerGlobalMetaID, 'observerGlobalMetaID');
    const subject = requireGlobalMetaID(subjectGlobalMetaID, 'subjectGlobalMetaID');
    const observations = this.getAll<ObservationRow>(
      `SELECT * FROM metaid_impression_observations
       WHERE observer_globalmetaid = ? AND subject_globalmetaid = ? AND status = 'active'
       ORDER BY dream_date ASC, dream_version ASC, created_at ASC, id ASC`,
      [observer, subject],
    ).map(rowToObservation);
    if (observations.length === 0) {
      this.db.run(
        `DELETE FROM metaid_impression_snapshots
         WHERE observer_globalmetaid = ? AND subject_globalmetaid = ?`,
        [observer, subject],
      );
      this.saveDb();
      return null;
    }

    const stats = this.getOne<EpisodeStatsRow>(
      `SELECT
         MIN(e.started_at) AS first_seen_at,
         MAX(e.started_at) AS last_seen_at,
         COUNT(DISTINCT e.id) AS interaction_count,
         COUNT(DISTINCT CASE WHEN e.episode_type = 'direct_interaction' THEN e.id END)
           AS direct_interaction_count
       FROM metaid_experience_episodes e
       WHERE e.owner_globalmetaid = ?
         AND EXISTS (
           SELECT 1 FROM metaid_experience_participants p
           WHERE p.episode_id = e.id AND p.globalmetaid = ?
         )`,
      [observer, subject],
    );
    const latest = observations[observations.length - 1];
    const latestDimensions = new Map<string, unknown>();
    const descriptorCandidates = new Set<string>();
    let communicationGuidance: string | null = null;
    let uncertaintyText: string | null = null;
    for (const observation of observations) {
      for (const [key, value] of Object.entries(observation.dimensions)) {
        latestDimensions.set(key, value);
        if (['styleDescriptors', 'style_descriptors', 'communicationStyle', 'communication_style', 'style'].includes(key)) {
          for (const descriptor of extractStringList(value)) descriptorCandidates.add(descriptor);
        }
      }
      if (observation.communicationGuidance) communicationGuidance = observation.communicationGuidance;
      const uncertainty = extractText(observation.confidence.uncertainty);
      if (uncertainty) uncertaintyText = uncertainty;
    }
    const descriptors = new Set<string>();
    for (const descriptor of descriptorCandidates) {
      if (descriptors.size >= MAX_STYLE_DESCRIPTORS) break;
      descriptors.add(descriptor.slice(0, 200));
    }
    const firstSeenAt = asInteger(stats?.first_seen_at, latest.createdAt);
    const lastSeenAt = asInteger(stats?.last_seen_at, firstSeenAt);
    const interactionCount = asInteger(stats?.interaction_count);
    const directInteractionCount = asInteger(stats?.direct_interaction_count);
    const capabilityTags = collectCapabilityTags(observations);
    const collaborationFacts = collectCollaborationFacts(observations);
    const subjectKind = latestDimensionText(latestDimensions, ['subjectKind', 'subject_kind']);
    const relationshipTemperature = subjectKind === 'owner'
      ? latestDimensionText(latestDimensions, ['relationshipTemperature', 'relationship_temperature', 'temperature'])
      : null;
    const sourceHash = hash(JSON.stringify({
      snapshotVersion: METAID_IMPRESSION_SNAPSHOT_VERSION,
      observer,
      subject,
      observations: observations.map((observation) => ({
        id: observation.id,
        sourceHash: observation.sourceHash,
        dreamVersion: observation.dreamVersion,
      })),
      firstSeenAt,
      lastSeenAt,
      interactionCount,
      directInteractionCount,
    }));
    const now = this.now();
    this.db.run(
      `INSERT INTO metaid_impression_snapshots (
         observer_globalmetaid, subject_globalmetaid, first_seen_at, last_seen_at,
         interaction_count, direct_interaction_count, summary_text,
         style_descriptors_json, cooperation_context, relationship_temperature,
         communication_guidance, uncertainty_text, capability_tags_json,
         collaboration_facts_json, latest_observation_id,
         snapshot_version, source_hash, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(observer_globalmetaid, subject_globalmetaid) DO UPDATE SET
         first_seen_at = excluded.first_seen_at,
         last_seen_at = excluded.last_seen_at,
         interaction_count = excluded.interaction_count,
         direct_interaction_count = excluded.direct_interaction_count,
         summary_text = excluded.summary_text,
         style_descriptors_json = excluded.style_descriptors_json,
         cooperation_context = excluded.cooperation_context,
         relationship_temperature = excluded.relationship_temperature,
         communication_guidance = excluded.communication_guidance,
         uncertainty_text = excluded.uncertainty_text,
         capability_tags_json = excluded.capability_tags_json,
         collaboration_facts_json = excluded.collaboration_facts_json,
         latest_observation_id = excluded.latest_observation_id,
         snapshot_version = excluded.snapshot_version,
         source_hash = excluded.source_hash,
         updated_at = excluded.updated_at`,
      [
        observer,
        subject,
        firstSeenAt,
        lastSeenAt,
        interactionCount,
        directInteractionCount,
        latest.interpretationText || latest.observationText,
        JSON.stringify([...descriptors]),
        latestDimensionText(latestDimensions, ['cooperationContext', 'cooperation_context', 'cooperation', 'cooperationPattern']),
        relationshipTemperature,
        communicationGuidance,
        uncertaintyText,
        JSON.stringify(capabilityTags),
        JSON.stringify(collaborationFacts),
        latest.id,
        METAID_IMPRESSION_SNAPSHOT_VERSION,
        sourceHash,
        now,
        now,
      ],
    );
    this.saveDb();
    return this.getSnapshot(observer, subject);
  }
}
