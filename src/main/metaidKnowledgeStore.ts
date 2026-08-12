import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type { SqliteDatabase as Database } from './sqliteTypes';

/**
 * Knowledge-point anchored memory ("经验/知识点").
 *
 * Sibling anchor to the ID-anchored impressions and the time-anchored daily
 * summaries. Like them it indexes the SAME shared fact source
 * (metaid_experience_episodes / evidence / cowork sessions) from a different
 * angle: a reusable knowledge point keyed by topic — a forward-looking,
 * updatable, KV-shaped summary the bot believes will help (or warn) future
 * tasks. A knowledge point may be a positive know-how ("do this"), a negative
 * pitfall ("this is a trap, avoid it"), or a general principle.
 *
 * Entries are upserted by topic fingerprint: rewriting an existing topic bumps
 * its version and records the prior text as a revision (experience is not
 * immutable). Writes come from two paths: the nightly dream consolidation
 * (origin='dream', which first reads the current set to decide create-vs-revise)
 * and the bot at runtime via the knowledge_upsert tool (origin='agent') when a
 * human asks it to remember something or it distills a point from a document.
 */

export const METAID_KNOWLEDGE_KINDS = ['know_how', 'pitfall', 'principle'] as const;
export type MetaIDKnowledgeKind = typeof METAID_KNOWLEDGE_KINDS[number];

export const METAID_KNOWLEDGE_ORIGINS = ['agent', 'dream', 'user'] as const;
export type MetaIDKnowledgeOrigin = typeof METAID_KNOWLEDGE_ORIGINS[number];

export type MetaIDKnowledgeStatus = 'active' | 'superseded' | 'archived';

export interface MetaIDKnowledgeEntry {
  id: string;
  metabotId: number;
  topic: string;
  topicFingerprint: string;
  summary: string;
  kind: MetaIDKnowledgeKind;
  category: string | null;
  tags: string[];
  confidence: number;
  status: MetaIDKnowledgeStatus;
  origin: MetaIDKnowledgeOrigin;
  sourceDreamDate: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

export interface MetaIDKnowledgeSource {
  id: string;
  knowledgeId: string;
  episodeId: string | null;
  evidenceId: string | null;
  sessionId: string | null;
  sourceChannel: string | null;
  relevance: string | null;
  createdAt: number;
}

export interface MetaIDKnowledgeRevision {
  id: string;
  knowledgeId: string;
  version: number;
  summary: string;
  kind: MetaIDKnowledgeKind;
  origin: MetaIDKnowledgeOrigin;
  sourceDreamDate: string | null;
  createdAt: number;
}

export interface MetaIDKnowledgeSourceInput {
  episodeId?: string | null;
  evidenceId?: string | null;
  sessionId?: string | null;
  sourceChannel?: string | null;
  relevance?: string | null;
}

export interface UpsertMetaIDKnowledgeInput {
  id?: string;
  metabotId: number;
  topic: string;
  summary: string;
  kind?: MetaIDKnowledgeKind;
  category?: string | null;
  tags?: string[];
  confidence?: number;
  origin?: MetaIDKnowledgeOrigin;
  sourceDreamDate?: string | null;
  /** Matching key override; derived from the topic when omitted. */
  topicFingerprint?: string;
  /** Pointers back into the shared fact source (no raw text duplicated). */
  sources?: MetaIDKnowledgeSourceInput[];
}

export interface UpsertMetaIDKnowledgeResult {
  entry: MetaIDKnowledgeEntry;
  /** True when a brand-new entry was inserted. */
  created: boolean;
  /** True when an existing topic was revised (version bumped). */
  revised: boolean;
}

export interface ListMetaIDKnowledgeOptions {
  metabotId: number;
  kind?: MetaIDKnowledgeKind;
  category?: string;
  status?: MetaIDKnowledgeStatus | 'all';
  query?: string;
  limit?: number;
  offset?: number;
  /** Bump last_used_at on returned rows (recall reuse signal). */
  touchLastUsed?: boolean;
}

export interface DreamKnowledgeView {
  id: string;
  topic: string;
  summary: string;
  kind: MetaIDKnowledgeKind;
  category: string | null;
  version: number;
}

interface KnowledgeEntryRow {
  id: string;
  metabot_id: number | string;
  topic: string;
  topic_fingerprint: string;
  summary: string;
  kind: string;
  category: string | null;
  tags_json: string;
  confidence: number | string;
  status: string;
  origin: string;
  source_dream_date: string | null;
  version: number | string;
  created_at: number | string;
  updated_at: number | string;
  last_used_at: number | string | null;
}

interface KnowledgeSourceRow {
  id: string;
  knowledge_id: string;
  episode_id: string | null;
  evidence_id: string | null;
  session_id: string | null;
  source_channel: string | null;
  relevance: string | null;
  created_at: number | string;
}

interface KnowledgeRevisionRow {
  id: string;
  knowledge_id: string;
  version: number | string;
  summary: string;
  kind: string;
  origin: string;
  source_dream_date: string | null;
  created_at: number | string;
}

const KINDS_SQL = METAID_KNOWLEDGE_KINDS.map((value) => `'${value}'`).join(', ');
const ORIGINS_SQL = METAID_KNOWLEDGE_ORIGINS.map((value) => `'${value}'`).join(', ');
const STATUSES_SQL = "'active', 'superseded', 'archived'";

const MAX_TOPIC = 300;
const MAX_SUMMARY = 4_000;
const MAX_CATEGORY = 120;
const MAX_RELEVANCE = 500;
const MAX_TAGS = 12;
const MAX_TAG_LEN = 80;
const MAX_SOURCES = 50;

/** Create the knowledge schema without changing existing user data. */
export function ensureMetaIDKnowledgeSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS metaid_knowledge_entries (
      id TEXT PRIMARY KEY,
      metabot_id INTEGER NOT NULL REFERENCES metabots(id),
      topic TEXT NOT NULL CHECK (trim(topic) <> ''),
      topic_fingerprint TEXT NOT NULL CHECK (trim(topic_fingerprint) <> ''),
      summary TEXT NOT NULL CHECK (trim(summary) <> ''),
      kind TEXT NOT NULL DEFAULT 'know_how' CHECK (kind IN (${KINDS_SQL})),
      category TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      confidence REAL NOT NULL DEFAULT 0.75 CHECK (confidence >= 0 AND confidence <= 1),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (${STATUSES_SQL})),
      origin TEXT NOT NULL DEFAULT 'agent' CHECK (origin IN (${ORIGINS_SQL})),
      source_dream_date TEXT,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER,
      UNIQUE(metabot_id, topic_fingerprint)
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_knowledge_entries_metabot_updated
      ON metaid_knowledge_entries(metabot_id, status, updated_at DESC);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_knowledge_entries_metabot_kind
      ON metaid_knowledge_entries(metabot_id, kind, status);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_knowledge_entries_metabot_status_used
      ON metaid_knowledge_entries(metabot_id, status, last_used_at DESC);
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS metaid_knowledge_sources (
      id TEXT PRIMARY KEY,
      knowledge_id TEXT NOT NULL,
      episode_id TEXT,
      evidence_id TEXT,
      session_id TEXT,
      source_channel TEXT,
      relevance TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (knowledge_id) REFERENCES metaid_knowledge_entries(id) ON DELETE CASCADE
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_knowledge_sources_knowledge
      ON metaid_knowledge_sources(knowledge_id, created_at ASC);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_knowledge_sources_episode
      ON metaid_knowledge_sources(episode_id);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_knowledge_sources_session
      ON metaid_knowledge_sources(session_id);
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS metaid_knowledge_revisions (
      id TEXT PRIMARY KEY,
      knowledge_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      summary TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN (${KINDS_SQL})),
      origin TEXT NOT NULL CHECK (origin IN (${ORIGINS_SQL})),
      source_dream_date TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (knowledge_id) REFERENCES metaid_knowledge_entries(id) ON DELETE CASCADE
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_knowledge_revisions_knowledge
      ON metaid_knowledge_revisions(knowledge_id, version DESC);
  `);
}

const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function asInteger(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function normalizeKind(value: unknown): MetaIDKnowledgeKind {
  if (typeof value === 'string' && (METAID_KNOWLEDGE_KINDS as readonly string[]).includes(value)) {
    return value as MetaIDKnowledgeKind;
  }
  return 'know_how';
}

function normalizeOrigin(value: unknown): MetaIDKnowledgeOrigin {
  if (typeof value === 'string' && (METAID_KNOWLEDGE_ORIGINS as readonly string[]).includes(value)) {
    return value as MetaIDKnowledgeOrigin;
  }
  return 'agent';
}

function normalizeStatus(value: unknown): MetaIDKnowledgeStatus {
  if (value === 'superseded' || value === 'archived') return value;
  return 'active';
}

function normalizeConfidence(value: unknown): number {
  const num = asNumber(value, 0.75);
  return Math.min(1, Math.max(0, num));
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of value) {
    const tag = asText(raw).slice(0, MAX_TAG_LEN);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    result.push(tag);
    if (result.length >= MAX_TAGS) break;
  }
  return result;
}

function serializeTags(tags: string[]): string {
  try {
    return JSON.stringify(tags ?? []);
  } catch {
    return '[]';
  }
}

function parseTags(value: string | null | undefined): string[] {
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

function normalizeTopicKey(topic: string): string {
  return topic.trim().replace(/\s+/g, ' ').toLowerCase();
}

function topicFingerprintOf(topic: string): string {
  return createHash('sha256').update(normalizeTopicKey(topic), 'utf8').digest('hex');
}

function normalizeDreamDate(value: unknown): string | null {
  const date = asText(value);
  if (!date) return null;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00.000Z`) : Number.NaN;
  if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) {
    throw new Error('sourceDreamDate must be a valid YYYY-MM-DD date');
  }
  return date;
}

function rowToEntry(row: KnowledgeEntryRow): MetaIDKnowledgeEntry {
  return {
    id: row.id,
    metabotId: asInteger(row.metabot_id),
    topic: row.topic,
    topicFingerprint: row.topic_fingerprint,
    summary: row.summary,
    kind: normalizeKind(row.kind),
    category: row.category ?? null,
    tags: parseTags(row.tags_json),
    confidence: asNumber(row.confidence, 0.75),
    status: normalizeStatus(row.status),
    origin: normalizeOrigin(row.origin),
    sourceDreamDate: row.source_dream_date ?? null,
    version: Math.max(1, asInteger(row.version, 1)),
    createdAt: asInteger(row.created_at),
    updatedAt: asInteger(row.updated_at),
    lastUsedAt: row.last_used_at == null ? null : asInteger(row.last_used_at),
  };
}

function rowToSource(row: KnowledgeSourceRow): MetaIDKnowledgeSource {
  return {
    id: row.id,
    knowledgeId: row.knowledge_id,
    episodeId: row.episode_id ?? null,
    evidenceId: row.evidence_id ?? null,
    sessionId: row.session_id ?? null,
    sourceChannel: row.source_channel ?? null,
    relevance: row.relevance ?? null,
    createdAt: asInteger(row.created_at),
  };
}

function rowToRevision(row: KnowledgeRevisionRow): MetaIDKnowledgeRevision {
  return {
    id: row.id,
    knowledgeId: row.knowledge_id,
    version: Math.max(1, asInteger(row.version, 1)),
    summary: row.summary,
    kind: normalizeKind(row.kind),
    origin: normalizeOrigin(row.origin),
    sourceDreamDate: row.source_dream_date ?? null,
    createdAt: asInteger(row.created_at),
  };
}

function normalizeSources(value: unknown): MetaIDKnowledgeSourceInput[] {
  if (!Array.isArray(value)) return [];
  const result: MetaIDKnowledgeSourceInput[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const source = raw as MetaIDKnowledgeSourceInput;
    const episodeId = asText(source.episodeId) || null;
    const evidenceId = asText(source.evidenceId) || null;
    const sessionId = asText(source.sessionId) || null;
    if (!episodeId && !evidenceId && !sessionId) continue;
    result.push({
      episodeId,
      evidenceId,
      sessionId,
      sourceChannel: boundedOptionalText(source.sourceChannel, 'sourceChannel', 120),
      relevance: boundedOptionalText(source.relevance, 'relevance', MAX_RELEVANCE),
    });
    if (result.length >= MAX_SOURCES) break;
  }
  return result;
}

export class MetaIDKnowledgeStore {
  constructor(
    private readonly db: Database,
    private readonly saveDb: () => void,
    private readonly now: () => number = Date.now,
  ) {
    ensureMetaIDKnowledgeSchema(db);
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

  getKnowledge(id: string): MetaIDKnowledgeEntry | null {
    const knowledgeId = asText(id);
    if (!knowledgeId) return null;
    const row = this.getOne<KnowledgeEntryRow>(
      'SELECT * FROM metaid_knowledge_entries WHERE id = ? LIMIT 1',
      [knowledgeId],
    );
    return row ? rowToEntry(row) : null;
  }

  /**
   * Create a new knowledge point or rewrite an existing one keyed by topic.
   * Rewriting bumps the version and archives the prior summary as a revision;
   * an archived/superseded topic is reactivated. Returns created/revised flags
   * so callers (dream, agent tool) can tell a brand-new point from an update.
   */
  upsertKnowledge(input: UpsertMetaIDKnowledgeInput): UpsertMetaIDKnowledgeResult {
    const metabotId = asInteger(input.metabotId);
    if (!metabotId) throw new Error('metabotId is required');
    const topic = boundedRequiredText(input.topic, 'topic', MAX_TOPIC);
    const summary = boundedRequiredText(input.summary, 'summary', MAX_SUMMARY);
    const kind = normalizeKind(input.kind);
    const category = boundedOptionalText(input.category, 'category', MAX_CATEGORY);
    const tags = normalizeTags(input.tags);
    const confidence = normalizeConfidence(input.confidence);
    const origin = normalizeOrigin(input.origin);
    const sourceDreamDate = normalizeDreamDate(input.sourceDreamDate);
    const sources = normalizeSources(input.sources);
    const topicFingerprint = asText(input.topicFingerprint) || topicFingerprintOf(topic);
    const now = this.now();

    const existing = this.getOne<KnowledgeEntryRow>(
      `SELECT * FROM metaid_knowledge_entries
       WHERE metabot_id = ? AND topic_fingerprint = ? LIMIT 1`,
      [metabotId, topicFingerprint],
    );

    if (!existing) {
      const id = asText(input.id) || uuidv4();
      try {
        this.db.run('BEGIN IMMEDIATE');
        this.db.run(
          `INSERT INTO metaid_knowledge_entries (
             id, metabot_id, topic, topic_fingerprint, summary, kind, category,
             tags_json, confidence, status, origin, source_dream_date, version,
             created_at, updated_at, last_used_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 1, ?, ?, NULL)`,
          [
            id,
            metabotId,
            topic,
            topicFingerprint,
            summary,
            kind,
            category,
            serializeTags(tags),
            confidence,
            origin,
            sourceDreamDate,
            now,
            now,
          ],
        );
        for (const source of sources) {
          this.insertSource(id, source, now);
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
      const entry = this.getKnowledge(id);
      if (!entry) throw new Error(`Failed to create knowledge entry: ${id}`);
      return { entry, created: true, revised: false };
    }

    // No-op rewrite (same topic, same summary, same kind) avoids fake revisions.
    const sameContent = existing.summary === summary
      && existing.kind === kind
      && (existing.category ?? null) === (category ?? null);
    if (sameContent) {
      return { entry: rowToEntry(existing), created: false, revised: false };
    }

    const nextVersion = Math.max(1, asInteger(existing.version, 1)) + 1;
    const existingId = existing.id;
    try {
      this.db.run('BEGIN IMMEDIATE');
      // Archive the prior text as a revision before overwriting.
      this.db.run(
        `INSERT INTO metaid_knowledge_revisions (
           id, knowledge_id, version, summary, kind, origin, source_dream_date, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          existingId,
          asInteger(existing.version, 1),
          existing.summary,
          normalizeKind(existing.kind),
          normalizeOrigin(existing.origin),
          existing.source_dream_date ?? null,
          asInteger(existing.updated_at, now),
        ],
      );
      this.db.run(
        `UPDATE metaid_knowledge_entries
         SET topic = ?, summary = ?, kind = ?, category = ?, tags_json = ?,
             confidence = ?, status = 'active', origin = ?, source_dream_date = ?,
             version = ?, updated_at = ?
         WHERE id = ?`,
        [
          topic,
          summary,
          kind,
          category,
          serializeTags(tags),
          confidence,
          origin,
          sourceDreamDate,
          nextVersion,
          now,
          existingId,
        ],
      );
      // Dream and agent rewrites restate the point's sources from their own
      // evidence view; replace the prior pointer set rather than stacking.
      this.db.run('DELETE FROM metaid_knowledge_sources WHERE knowledge_id = ?', [existingId]);
      for (const source of sources) {
        this.insertSource(existingId, source, now);
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
    const entry = this.getKnowledge(existingId);
    if (!entry) throw new Error(`Failed to revise knowledge entry: ${existingId}`);
    return { entry, created: false, revised: true };
  }

  private insertSource(knowledgeId: string, source: MetaIDKnowledgeSourceInput, createdAt: number): void {
    this.db.run(
      `INSERT INTO metaid_knowledge_sources (
         id, knowledge_id, episode_id, evidence_id, session_id, source_channel, relevance, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        knowledgeId,
        source.episodeId,
        source.evidenceId,
        source.sessionId,
        source.sourceChannel,
        source.relevance,
        createdAt,
      ],
    );
  }

  addKnowledgeSource(input: {
    knowledgeId: string;
  } & MetaIDKnowledgeSourceInput): MetaIDKnowledgeSource | null {
    const knowledgeId = asText(input.knowledgeId);
    if (!knowledgeId || !this.getKnowledge(knowledgeId)) return null;
    const sources = normalizeSources([input]);
    if (sources.length === 0) return null;
    const createdAt = this.now();
    this.insertSource(knowledgeId, sources[0], createdAt);
    this.saveDb();
    const row = this.getOne<KnowledgeSourceRow>(
      `SELECT * FROM metaid_knowledge_sources
       WHERE knowledge_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      [knowledgeId],
    );
    return row ? rowToSource(row) : null;
  }

  listKnowledgeSources(knowledgeId: string): MetaIDKnowledgeSource[] {
    return this.getAll<KnowledgeSourceRow>(
      `SELECT * FROM metaid_knowledge_sources
       WHERE knowledge_id = ? ORDER BY created_at ASC, id ASC`,
      [asText(knowledgeId)],
    ).map(rowToSource);
  }

  listKnowledgeRevisions(knowledgeId: string): MetaIDKnowledgeRevision[] {
    return this.getAll<KnowledgeRevisionRow>(
      `SELECT * FROM metaid_knowledge_revisions
       WHERE knowledge_id = ? ORDER BY version DESC, created_at DESC, id DESC`,
      [asText(knowledgeId)],
    ).map(rowToRevision);
  }

  listKnowledge(options: ListMetaIDKnowledgeOptions): MetaIDKnowledgeEntry[] {
    const metabotId = asInteger(options.metabotId);
    if (!metabotId) return [];
    const clauses = ['metabot_id = ?'];
    const params: unknown[] = [metabotId];
    const statusFilter = options.status === 'all' ? null : normalizeStatus(options.status ?? 'active');
    if (statusFilter) {
      clauses.push('status = ?');
      params.push(statusFilter);
    }
    if (options.kind) {
      clauses.push('kind = ?');
      params.push(normalizeKind(options.kind));
    }
    if (options.category) {
      clauses.push('category = ?');
      params.push(boundedOptionalText(options.category, 'category', MAX_CATEGORY));
    }
    if (options.query) {
      const like = `%${asText(options.query).toLowerCase()}%`;
      clauses.push('(LOWER(topic) LIKE ? OR LOWER(summary) LIKE ?)');
      params.push(like, like);
    }
    const limit = Math.min(500, Math.max(1, asInteger(options.limit, 100)));
    const offset = Math.max(0, asInteger(options.offset, 0));
    params.push(limit, offset);
    const rows = this.getAll<KnowledgeEntryRow>(
      `SELECT * FROM metaid_knowledge_entries
       WHERE ${clauses.join(' AND ')}
       ORDER BY updated_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      params,
    ).map(rowToEntry);

    if (options.touchLastUsed && rows.length > 0) {
      const now = this.now();
      const ids = rows.map((row) => row.id);
      this.db.run(
        `UPDATE metaid_knowledge_entries SET last_used_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
        [now, ...ids],
      );
      this.saveDb();
      for (const row of rows) {
        row.lastUsedAt = now;
      }
    }
    return rows;
  }

  /** Keyword search across topic + summary for the recall tool. */
  searchKnowledge(input: {
    metabotId: number;
    query?: string;
    kind?: MetaIDKnowledgeKind;
    limit?: number;
    touchLastUsed?: boolean;
  }): MetaIDKnowledgeEntry[] {
    return this.listKnowledge({
      metabotId: input.metabotId,
      query: input.query,
      kind: input.kind,
      status: 'active',
      limit: input.limit,
      touchLastUsed: input.touchLastUsed,
    });
  }

  archiveKnowledge(input: { id: string; metabotId: number }): MetaIDKnowledgeEntry | null {
    const id = asText(input.id);
    const metabotId = asInteger(input.metabotId);
    const existing = this.getKnowledge(id);
    if (!existing || existing.metabotId !== metabotId) return null;
    const now = this.now();
    this.db.run(
      `UPDATE metaid_knowledge_entries SET status = 'archived', updated_at = ? WHERE id = ?`,
      [now, id],
    );
    this.saveDb();
    return this.getKnowledge(id);
  }

  /**
   * Compact active set handed to the dream prompt so the model can decide
   * create-vs-revise: it sees what the bot already believes about each topic
   * and either extends the list or rewrites an existing entry.
   */
  listKnowledgeForDream(metabotId: number, limit = 60): DreamKnowledgeView[] {
    const rows = this.listKnowledge({
      metabotId,
      status: 'active',
      limit: Math.min(200, Math.max(1, asInteger(limit, 60))),
    });
    return rows.map((row) => ({
      id: row.id,
      topic: row.topic,
      summary: row.summary,
      kind: row.kind,
      category: row.category,
      version: row.version,
    }));
  }

  countActive(metabotId: number): number {
    const row = this.getOne<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM metaid_knowledge_entries
       WHERE metabot_id = ? AND status = 'active'`,
      [asInteger(metabotId)],
    );
    return asInteger(row?.count, 0);
  }
}
