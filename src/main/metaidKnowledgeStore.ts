import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type { SqliteDatabase as Database } from './sqliteTypes';
import { tokenizeKnowledgeBaseText } from './libs/knowledgeBaseText';
import { truncateUtf16Units } from './libs/llmSafeText';
import { recordChainBackupTombstones } from './libs/chainBackupTombstones';
import { normalizeProcedureHotReason, type ProcedureHotReason } from './libs/procedureProbation';

/**
 * Which dream pass flipped a procedure's hot eligibility (dream review P1) —
 * recorded on every append-only hot_event row so a procedure's standing is
 * traceable across probation flips, re-review demotions, pruning and
 * rollbacks instead of only remembering the LAST reason.
 */
export type ProcedureHotEventSource =
  | 'validation'
  | 'promotion'
  | 're_review'
  | 'pruning'
  | 'rollback'
  | 'dream';

/** One append-only row of metaid_knowledge_procedure_hot_events. */
export interface ProcedureHotEvent {
  id: number;
  procedureId: string;
  ts: number;
  reason: ProcedureHotReason | null;
  sourcePass: ProcedureHotEventSource;
}
import { PROCEDURE_PROMPT_MAX_ITEMS } from './libs/procedurePromptBlocks';
import { queryHotLayerUsageStats } from './libs/hotLayerUsageQueries';
import {
  HOT_LAYER_FRESH_SLOTS,
  HOT_LAYER_GRACE_DAYS,
  HOT_LAYER_UTILITY_WINDOW_DAYS,
  rankHotLayerItems,
} from './libs/hotLayerPruning';
import { shiftDateKey } from './libs/predictionLedger';
import { formatBotWorkspaceDate } from './libs/botWorkspace';

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
  /**
   * Hot-pool membership (dream review P1): false = cooled out of the proactive
   * <knowledge> injection pool by the nightly usage audit; recall paths keep
   * returning the entry. Defaults true.
   */
  hotEligible?: boolean;
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

/**
 * Procedure memory ("经验") — a proven way to GET A TASK DONE. Heavier than a
 * knowledge point (it carries an ordered checklist and pitfalls), lighter
 * than a skill (no script/package dependency). Learned at runtime after
 * completing a recurring task — typically after following a MetaWeb tutorial,
 * with sourcePinIds recording provenance. Upserted by title fingerprint:
 * re-saving the same title rewrites the record and bumps its version
 * (dedupe), and recall bumps useCount/lastUsedAt so frequently reused
 * procedures stay hot.
 */
export interface MetaIDProcedureEntry {
  id: string;
  metabotId: number;
  title: string;
  titleFingerprint: string;
  /** When to use this procedure ("when the user asks to …"). */
  triggerText: string;
  steps: string[];
  pitfalls: string[];
  /** MetaWeb pin ids this procedure was learned from. */
  sourcePinIds: string[];
  category: string | null;
  tags: string[];
  confidence: number;
  status: 'active' | 'archived';
  origin: MetaIDKnowledgeOrigin;
  useCount: number;
  lastUsedAt: number | null;
  version: number;
  createdAt: number;
  updatedAt: number;
  /** RRSI P2: false = recall-only (probation / gated out of the hot layer). */
  hotEligible: boolean;
  /** When the procedure last became hot (null = never hot). */
  hotSince: number | null;
  /** Why a recall-only procedure is not hot (null while hot). */
  hotReason: ProcedureHotReason | null;
}

export interface UpsertMetaIDProcedureInput {
  metabotId: number;
  title: string;
  triggerText: string;
  steps: string[];
  pitfalls?: string[];
  sourcePinIds?: string[];
  category?: string | null;
  tags?: string[];
  confidence?: number;
  origin?: MetaIDKnowledgeOrigin;
}

export interface UpsertMetaIDProcedureResult {
  entry: MetaIDProcedureEntry;
  created: boolean;
  revised: boolean;
  /** RRSI P2: the procedure entered (or stays in) agent probation — open a
   * probation draft so the dream gate judges it before it turns hot. */
  needsGate: boolean;
}

export interface ListMetaIDProcedureOptions {
  metabotId: number;
  category?: string;
  status?: 'active' | 'archived' | 'all';
  query?: string;
  limit?: number;
  offset?: number;
  /** Bump use_count/last_used_at on returned rows (recall reuse signal). */
  touchUsed?: boolean;
}

export interface ListMetaIDKnowledgeOptions {
  metabotId: number;
  kind?: MetaIDKnowledgeKind;
  category?: string;
  status?: MetaIDKnowledgeStatus | 'all';
  query?: string;
  limit?: number;
  offset?: number;
  /** Cold recall channel: widen the default/'active' filter to active+archived. Never widens to superseded. */
  includeArchived?: boolean;
  /**
   * Hot-pool filter (dream review P1): true keeps only entries the usage
   * audit has not cooled out (COALESCE(hot_eligible,1) = 1). Recall paths
   * leave this unset so cooled entries stay reachable.
   */
  hotEligibleOnly?: boolean;
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
  hot_eligible?: number | string | null;
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
      hot_eligible INTEGER NOT NULL DEFAULT 1,
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
  // Dream review P1 (2026-10-23): hot-pool membership flag. The nightly usage
  // audit's knowledge cooling flips it to 0 (never deletes) — a cooled entry
  // leaves the proactive <knowledge> hot pool but stays fully recallable.
  try {
    const knowledgeCols = (db.exec('PRAGMA table_info(metaid_knowledge_entries)')[0]?.values?.map((row) => row[1]) || []) as string[];
    if (!knowledgeCols.includes('hot_eligible')) {
      db.run('ALTER TABLE metaid_knowledge_entries ADD COLUMN hot_eligible INTEGER NOT NULL DEFAULT 1;');
    }
  } catch (error) {
    console.warn('migrate metaid_knowledge_entries hot_eligible:', error);
  }

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

  db.run(`
    CREATE TABLE IF NOT EXISTS metaid_knowledge_procedures (
      id TEXT PRIMARY KEY,
      metabot_id INTEGER NOT NULL REFERENCES metabots(id),
      title TEXT NOT NULL CHECK (trim(title) <> ''),
      title_fingerprint TEXT NOT NULL CHECK (trim(title_fingerprint) <> ''),
      trigger_text TEXT NOT NULL CHECK (trim(trigger_text) <> ''),
      steps_json TEXT NOT NULL DEFAULT '[]',
      pitfalls_json TEXT NOT NULL DEFAULT '[]',
      source_pin_ids_json TEXT NOT NULL DEFAULT '[]',
      category TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      confidence REAL NOT NULL DEFAULT 0.75 CHECK (confidence >= 0 AND confidence <= 1),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      origin TEXT NOT NULL DEFAULT 'agent' CHECK (origin IN (${ORIGINS_SQL})),
      use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
      last_used_at INTEGER,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(metabot_id, title_fingerprint)
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_knowledge_procedures_metabot_updated
      ON metaid_knowledge_procedures(metabot_id, status, updated_at DESC);
  `);

  // RRSI P2 hot-layer columns (design §6.2 P2.2): PRAGMA-guarded and additive;
  // the DEFAULT 1 grandfathers every pre-migration procedure as hot-eligible.
  try {
    const procedureCols = (db.exec('PRAGMA table_info(metaid_knowledge_procedures)')[0]?.values?.map((row) => row[1]) || []) as string[];
    if (!procedureCols.includes('hot_eligible')) db.run('ALTER TABLE metaid_knowledge_procedures ADD COLUMN hot_eligible INTEGER NOT NULL DEFAULT 1');
    if (!procedureCols.includes('hot_since')) db.run('ALTER TABLE metaid_knowledge_procedures ADD COLUMN hot_since INTEGER');
    if (!procedureCols.includes('hot_reason')) db.run('ALTER TABLE metaid_knowledge_procedures ADD COLUMN hot_reason TEXT');
  } catch (error) {
    console.warn('migrate metaid_knowledge_procedures hot columns:', error);
  }

  // Dream review P1: append-only history of hot-layer eligibility flips.
  // hot_reason stays the LATEST reason for legacy readers; every flip lands
  // one row here (which pass, when, and why) so probation flips, re-review
  // demotions, pruning and rollbacks all stay traceable. New table — plain
  // CREATE IF NOT EXISTS is the idempotent migration.
  db.run(`
    CREATE TABLE IF NOT EXISTS metaid_knowledge_procedure_hot_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      procedure_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      reason TEXT,
      source_pass TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_knowledge_procedure_hot_events_procedure
      ON metaid_knowledge_procedure_hot_events(procedure_id, ts ASC);
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
    const tag = truncateUtf16Units(asText(raw), MAX_TAG_LEN);
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
    hotEligible: row.hot_eligible == null ? true : Number(row.hot_eligible) !== 0,
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

interface ProcedureRow {
  id: string;
  metabot_id: number | string;
  title: string;
  title_fingerprint: string;
  trigger_text: string;
  steps_json: string;
  pitfalls_json: string;
  source_pin_ids_json: string;
  category: string | null;
  tags_json: string;
  confidence: number | string;
  status: string;
  origin: string;
  use_count: number | string;
  last_used_at: number | string | null;
  version: number | string;
  created_at: number | string;
  updated_at: number | string;
  hot_eligible?: number | string | null;
  hot_since?: number | string | null;
  hot_reason?: string | null;
}

const MAX_PROCEDURE_TITLE = 300;
const MAX_PROCEDURE_TRIGGER = 500;
const MAX_PROCEDURE_STEPS = 20;
const MAX_PROCEDURE_STEP_LEN = 500;
const MAX_PROCEDURE_PITFALLS = 10;
const MAX_PROCEDURE_PITFALL_LEN = 300;
const MAX_PROCEDURE_PIN_IDS = 20;
const MAX_PROCEDURE_PIN_ID_LEN = 100;

function normalizeStringArray(value: unknown, maxItems: number, maxItemLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const raw of value) {
    const item = truncateUtf16Units(asText(raw), maxItemLength);
    if (item) result.push(item);
    if (result.length >= maxItems) break;
  }
  return result;
}

function normalizeProcedureStatus(value: unknown): 'active' | 'archived' {
  return value === 'archived' ? 'archived' : 'active';
}

function rowToProcedure(row: ProcedureRow): MetaIDProcedureEntry {
  return {
    id: row.id,
    metabotId: asInteger(row.metabot_id),
    title: row.title,
    titleFingerprint: row.title_fingerprint,
    triggerText: row.trigger_text,
    steps: parseTags(row.steps_json),
    pitfalls: parseTags(row.pitfalls_json),
    sourcePinIds: parseTags(row.source_pin_ids_json),
    category: row.category ?? null,
    tags: parseTags(row.tags_json),
    confidence: asNumber(row.confidence, 0.75),
    status: normalizeProcedureStatus(row.status),
    origin: normalizeOrigin(row.origin),
    useCount: Math.max(0, asInteger(row.use_count, 0)),
    lastUsedAt: row.last_used_at == null ? null : asInteger(row.last_used_at),
    version: Math.max(1, asInteger(row.version, 1)),
    createdAt: asInteger(row.created_at),
    updatedAt: asInteger(row.updated_at),
    hotEligible: Number(row.hot_eligible ?? 1) !== 0,
    hotSince: row.hot_since == null ? null : asInteger(row.hot_since),
    hotReason: normalizeProcedureHotReason(row.hot_reason),
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

const PROCEDURE_QUERY_MAX_TERMS = 12;

/**
 * Score procedures against a free-form recall query. Terms come from
 * tokenizeKnowledgeBaseText (latin words + CJK unigrams/bigrams); precision
 * terms (≥2 chars: latin words, CJK bigrams) carry the query, single CJK
 * chars only when the query has nothing else (same rule as the KB LIKE
 * fallback). A whole-substring match can't hit "MetaWeb 安装 技能" against a
 * title phrased differently ("…学习并安装链上技能"), so a procedure qualifies
 * when ANY precision term appears in its title/trigger/steps, and ranking
 * favors title hits over trigger over steps (3/2/1 per matched term,
 * normalized to [0,1]). Input order is recency, so ties stay recent-first
 * (Array.sort is stable). Single-character fallback (no ≥2-char term at all)
 * matches TITLES only — one common CJK char appears in almost every steps
 * text, which would otherwise recall nearly the whole library.
 */
function scoreProceduresForQuery(
  entries: MetaIDProcedureEntry[],
  query: string,
): MetaIDProcedureEntry[] {
  const tokens = [...new Set(tokenizeKnowledgeBaseText(query))];
  const specific = tokens.filter((token) => token.length >= 2);
  const terms = (specific.length > 0 ? specific : tokens).slice(0, PROCEDURE_QUERY_MAX_TERMS);
  if (terms.length === 0) return entries;
  const titleOnly = specific.length === 0;
  const scored: Array<{ entry: MetaIDProcedureEntry; score: number }> = [];
  for (const entry of entries) {
    const title = entry.title.toLowerCase();
    const trigger = entry.triggerText.toLowerCase();
    const steps = entry.steps.join('\n').toLowerCase();
    let raw = 0;
    for (const term of terms) {
      if (title.includes(term)) raw += 3;
      else if (!titleOnly && trigger.includes(term)) raw += 2;
      else if (!titleOnly && steps.includes(term)) raw += 1;
    }
    if (raw > 0) scored.push({ entry, score: raw / (3 * terms.length) });
  }
  return scored
    .sort((left, right) => right.score - left.score)
    .map((item) => item.entry);
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
      if (statusFilter === 'active' && options.includeArchived) {
        clauses.push(`status IN ('active', 'archived')`);
      } else {
        clauses.push('status = ?');
        params.push(statusFilter);
      }
    }
    if (options.kind) {
      clauses.push('kind = ?');
      params.push(normalizeKind(options.kind));
    }
    if (options.hotEligibleOnly) {
      clauses.push('COALESCE(hot_eligible, 1) = 1');
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
      const touchedAt = this.touchKnowledgeLastUsed(metabotId, rows.map((row) => row.id));
      if (touchedAt != null) {
        for (const row of rows) {
          row.lastUsedAt = touchedAt;
        }
      }
    }
    return rows;
  }

  /**
   * Bump last_used_at on the given knowledge entries (recall reuse signal).
   * Callers that post-filter a listKnowledge pool must touch only the rows
   * that actually render. Returns the touch timestamp, or null for a no-op.
   */
  touchKnowledgeLastUsed(metabotId: number, knowledgeIds: string[]): number | null {
    const ownerId = asInteger(metabotId);
    if (!ownerId) return null;
    const ids = Array.from(new Set(
      knowledgeIds.map((id) => asText(id)).filter((id) => id.length > 0),
    ));
    if (ids.length === 0) return null;
    const now = this.now();
    this.db.run(
      `UPDATE metaid_knowledge_entries SET last_used_at = ? WHERE metabot_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
      [now, ownerId, ...ids],
    );
    this.saveDb();
    return now;
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
   * Human edit of a knowledge point from the Settings UI: rewrite the entry
   * in place by id (so editing the topic does not fork into a new entry the
   * way upsert-by-fingerprint would). The prior summary/kind are archived as
   * a revision and the version is bumped — experience is not immutable.
   */
  updateKnowledge(input: {
    id: string;
    metabotId: number;
    topic?: string;
    summary?: string;
    kind?: MetaIDKnowledgeKind;
  }): MetaIDKnowledgeEntry | null {
    const id = asText(input.id);
    const metabotId = asInteger(input.metabotId);
    const existing = this.getKnowledge(id);
    if (!existing || existing.metabotId !== metabotId) return null;

    const nextTopic = input.topic !== undefined ? boundedRequiredText(input.topic, 'topic', MAX_TOPIC) : existing.topic;
    const nextSummary = input.summary !== undefined ? boundedRequiredText(input.summary, 'summary', MAX_SUMMARY) : existing.summary;
    const nextKind = input.kind !== undefined ? normalizeKind(input.kind) : existing.kind;
    const noChange = nextTopic === existing.topic && nextSummary === existing.summary && nextKind === existing.kind;
    if (noChange) return existing;

    const nextFingerprint = topicFingerprintOf(nextTopic);
    const nextVersion = Math.max(1, asInteger(existing.version, 1)) + 1;
    const now = this.now();
    try {
      this.db.run('BEGIN IMMEDIATE');
      this.db.run(
        `INSERT INTO metaid_knowledge_revisions (
           id, knowledge_id, version, summary, kind, origin, source_dream_date, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          id,
          asInteger(existing.version, 1),
          existing.summary,
          normalizeKind(existing.kind),
          normalizeOrigin(existing.origin),
          existing.sourceDreamDate ?? null,
          asInteger(existing.updatedAt, now),
        ],
      );
      this.db.run(
        `UPDATE metaid_knowledge_entries
         SET topic = ?, topic_fingerprint = ?, summary = ?, kind = ?, status = 'active',
             version = ?, updated_at = ?
         WHERE id = ?`,
        [nextTopic, nextFingerprint, nextSummary, nextKind, nextVersion, now, id],
      );
      this.db.run('COMMIT');
    } catch (error) {
      try { this.db.run('ROLLBACK'); } catch { /* keep original error */ }
      throw error;
    }
    this.saveDb();
    return this.getKnowledge(id);
  }

  /**
   * Hard-delete a knowledge point and its sources/revisions (FK ON DELETE
   * CASCADE handles the children). Returns true when a row was removed.
   * Note: the nightly dream may regenerate a similar point afterwards — use
   * archiveKnowledge instead when the goal is "keep this out of recall". The
   * deletion is recorded in the chain-backup tombstone ledger so a chain
   * restore does not resurrect the entry from an older backup segment.
   */
  deleteKnowledge(input: { id: string; metabotId: number }): boolean {
    const id = asText(input.id);
    const metabotId = asInteger(input.metabotId);
    const existing = this.getKnowledge(id);
    if (!existing || existing.metabotId !== metabotId) return false;
    recordChainBackupTombstones(this.db, [{ kind: 'knowledge', ref: id, metabotId }]);
    this.db.run('DELETE FROM metaid_knowledge_entries WHERE id = ?', [id]);
    this.saveDb();
    return true;
  }

  /**
   * Hygiene revision overflow: each entry keeps its newest `keepPerEntry`
   * historical revisions; older ones are physically removed. Revisions are
   * redundant historical copies of text that is itself superseded — the live
   * entry and the recent undo trail stay intact. Bounded per pass.
   */
  pruneKnowledgeRevisions(input: {
    keepPerEntry: number;
    excludeMetabotIds?: ReadonlySet<number>;
    limit?: number;
  }): { entriesPruned: number; revisionsDeleted: number } {
    const keep = Math.max(1, Math.min(50, Math.floor(input.keepPerEntry)));
    const limit = Math.min(20_000, Math.max(1, Math.floor(input.limit ?? 5_000)));
    const excluded = input.excludeMetabotIds ? [...input.excludeMetabotIds] : [];
    const candidates = this.getAll<{ knowledge_id: string }>(
      `SELECT knowledge_id, COUNT(*) AS revision_count
       FROM metaid_knowledge_revisions
       GROUP BY knowledge_id
       HAVING COUNT(*) > ?
       LIMIT ?`,
      [keep, limit],
    );
    let entriesPruned = 0;
    let revisionsDeleted = 0;
    for (const candidate of candidates) {
      if (excluded.length > 0) {
        const owner = this.getOne<{ metabot_id: number }>(
          'SELECT metabot_id FROM metaid_knowledge_entries WHERE id = ? LIMIT 1',
          [candidate.knowledge_id],
        );
        if (owner && excluded.includes(Number(owner.metabot_id))) continue;
      }
      const result = this.db.run(
        `DELETE FROM metaid_knowledge_revisions
         WHERE knowledge_id = ?
           AND id NOT IN (
             SELECT id FROM metaid_knowledge_revisions
             WHERE knowledge_id = ?
             ORDER BY version DESC, created_at DESC
             LIMIT ?
           )`,
        [candidate.knowledge_id, candidate.knowledge_id, keep],
      );
      const removed = this.db.getRowsModified?.() || 0;
      if (removed > 0) {
        entriesPruned += 1;
        revisionsDeleted += removed;
      }
    }
    if (revisionsDeleted > 0) {
      this.saveDb();
    }
    return { entriesPruned, revisionsDeleted };
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

  /**
   * Upsert a procedure ("经验") by title fingerprint: a fresh title inserts,
   * an existing title rewrites in place (version bump) — that dedupe keeps
   * the dream/runtime paths from stacking near-duplicates.
   *
   * RRSI P2 hot-layer semantics by origin (design §6.2 P2.2): an `agent`
   * insert or a revision of an ARCHIVED row re-activates recall-only on
   * probation (closes the resurrection hole); an agent revision of a hot
   * procedure stays hot; an agent revision of a non-hot procedure goes back
   * to probation unless its reason is `unused` / `situational` (those states
   * are P3/P5 lifecycle verdicts, not gate tickets); `dream` / `user` writes
   * are always hot. `needsGate` on the result flags probation entry.
   */
  upsertProcedure(input: UpsertMetaIDProcedureInput): UpsertMetaIDProcedureResult {
    const metabotId = asInteger(input.metabotId);
    if (!metabotId) throw new Error('metabotId is required');
    const title = boundedRequiredText(input.title, 'title', MAX_PROCEDURE_TITLE);
    const triggerText = boundedRequiredText(input.triggerText, 'triggerText', MAX_PROCEDURE_TRIGGER);
    const steps = normalizeStringArray(input.steps, MAX_PROCEDURE_STEPS, MAX_PROCEDURE_STEP_LEN);
    if (steps.length === 0) throw new Error('steps is required (at least one step)');
    const pitfalls = normalizeStringArray(input.pitfalls ?? [], MAX_PROCEDURE_PITFALLS, MAX_PROCEDURE_PITFALL_LEN);
    const sourcePinIds = normalizeStringArray(input.sourcePinIds ?? [], MAX_PROCEDURE_PIN_IDS, MAX_PROCEDURE_PIN_ID_LEN);
    const category = boundedOptionalText(input.category, 'category', MAX_CATEGORY);
    const tags = normalizeTags(input.tags);
    const confidence = normalizeConfidence(input.confidence);
    const origin = normalizeOrigin(input.origin);
    const titleFingerprint = topicFingerprintOf(title);
    const now = this.now();

    const existing = this.getOne<ProcedureRow>(
      `SELECT * FROM metaid_knowledge_procedures
       WHERE metabot_id = ? AND title_fingerprint = ? LIMIT 1`,
      [metabotId, titleFingerprint],
    );

    if (!existing) {
      const id = uuidv4();
      const agentProbation = origin === 'agent';
      this.db.run(
        `INSERT INTO metaid_knowledge_procedures (
           id, metabot_id, title, title_fingerprint, trigger_text, steps_json,
           pitfalls_json, source_pin_ids_json, category, tags_json, confidence,
           status, origin, use_count, last_used_at, version, created_at, updated_at,
           hot_eligible, hot_since, hot_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 0, NULL, 1, ?, ?, ?, ?, ?)`,
        [
          id, metabotId, title, titleFingerprint, triggerText, serializeTags(steps),
          serializeTags(pitfalls), serializeTags(sourcePinIds), category, serializeTags(tags),
          confidence, origin, now, now,
          agentProbation ? 0 : 1,
          agentProbation ? null : now,
          agentProbation ? 'probation' : null,
        ],
      );
      this.saveDb();
      const entry = this.getProcedure(id);
      if (!entry) throw new Error('failed to load the procedure after insert');
      return { entry, created: true, revised: false, needsGate: entry.hotEligible === false && entry.hotReason === 'probation' };
    }

    // Hot-column bookkeeping per the P2 semantics table; computed in JS so
    // every branch is explicit about what it preserves.
    const existingHot = Number(existing.hot_eligible ?? 1) !== 0;
    const existingReason = normalizeProcedureHotReason(existing.hot_reason);
    const existingHotSince = existing.hot_since == null ? null : asInteger(existing.hot_since);
    let nextHotEligible: 0 | 1;
    let nextHotReason: string | null;
    let nextHotSince: number | null;
    if (origin !== 'agent') {
      nextHotEligible = 1;
      nextHotReason = null;
      // An ARCHIVED dream/user procedure re-activates as a fresh hot stint
      // (hot_since = now); a still-active revision keeps its original stamp.
      nextHotSince = existing.status === 'archived' ? now : (existingHotSince ?? now);
    } else if (existing.status === 'archived') {
      nextHotEligible = 0;
      nextHotReason = 'probation';
      nextHotSince = null;
    } else if (existingHot) {
      nextHotEligible = 1;
      nextHotReason = null;
      nextHotSince = existingHotSince;
    } else if (existingReason === 'unused' || existingReason === 'situational') {
      nextHotEligible = 0;
      nextHotReason = existingReason;
      nextHotSince = existingHotSince;
    } else {
      nextHotEligible = 0;
      nextHotReason = 'probation';
      nextHotSince = null;
    }

    this.db.run(
      `UPDATE metaid_knowledge_procedures
       SET title = ?, trigger_text = ?, steps_json = ?, pitfalls_json = ?, source_pin_ids_json = ?,
           category = ?, tags_json = ?, confidence = ?, origin = ?, status = 'active',
           version = ?, updated_at = ?,
           hot_eligible = ?, hot_reason = ?, hot_since = ?
       WHERE id = ?`,
      [
        title, triggerText, serializeTags(steps), serializeTags(pitfalls), serializeTags(sourcePinIds),
        category, serializeTags(tags), confidence, origin,
        asInteger(existing.version, 1) + 1, now,
        nextHotEligible, nextHotReason, nextHotSince, existing.id,
      ],
    );
    this.saveDb();
    const entry = this.getProcedure(existing.id);
    if (!entry) throw new Error('failed to load the procedure after update');
    return { entry, created: false, revised: true, needsGate: entry.hotEligible === false && entry.hotReason === 'probation' };
  }

  getProcedure(id: string): MetaIDProcedureEntry | null {
    const row = this.getOne<ProcedureRow>(
      `SELECT * FROM metaid_knowledge_procedures WHERE id = ? LIMIT 1`,
      [asText(id)],
    );
    return row ? rowToProcedure(row) : null;
  }

  /**
   * Memory reconciliation `merge` action (design 2026-10-10 §4.3): append ONE
   * host-templated pitfall line referencing a merged draft to an active
   * procedure. No free-form edit of the procedure body; the pitfalls cap
   * applies (a full list refuses the append instead of silently dropping an
   * existing entry).
   */
  appendProcedurePitfall(id: string, line: string): boolean {
    const text = asText(line).trim();
    if (!text) return false;
    const row = this.getOne<ProcedureRow>(
      `SELECT * FROM metaid_knowledge_procedures WHERE id = ? AND status = 'active' LIMIT 1`,
      [asText(id)],
    );
    if (!row) return false;
    const pitfalls = parseTags(row.pitfalls_json);
    if (pitfalls.length >= MAX_PROCEDURE_PITFALLS) return false;
    pitfalls.push(text.length > MAX_PROCEDURE_PITFALL_LEN ? `${text.slice(0, MAX_PROCEDURE_PITFALL_LEN - 1)}…` : text);
    this.db.run(
      `UPDATE metaid_knowledge_procedures SET pitfalls_json = ?, updated_at = ? WHERE id = ?`,
      [serializeTags(pitfalls), this.now(), row.id],
    );
    this.saveDb();
    return true;
  }

  /**
   * Retire an active procedure by exact title (fingerprint match). The record
   * is kept (status='archived') so recall/hot layers stop surfacing it while
   * history stays inspectable — the lifecycle counterpart to upsert.
   */
  archiveProcedureByTitle(metabotId: number, title: string): MetaIDProcedureEntry | null {
    const id = asInteger(metabotId);
    const titleText = asText(title);
    if (!id || !titleText) return null;
    const row = this.getOne<ProcedureRow>(
      `SELECT * FROM metaid_knowledge_procedures
       WHERE metabot_id = ? AND title_fingerprint = ? AND status = 'active' LIMIT 1`,
      [id, topicFingerprintOf(titleText)],
    );
    if (!row) return null;
    this.db.run(
      `UPDATE metaid_knowledge_procedures SET status = 'archived', updated_at = ? WHERE id = ?`,
      [this.now(), row.id],
    );
    this.saveDb();
    return this.getProcedure(row.id);
  }

  /**
   * RRSI P2 hot-eligibility switch (design §6.2 P2.2): the gate, re-review,
   * and rollback flip eligibility on ACTIVE procedures only — an
   * agent-authored procedure is never archived by a gate outcome. Eligibility
   * is not a content revision, so `updated_at` stays untouched. Turning hot
   * stamps `hot_since` (first time or fresh re-entry); turning cold records
   * the reason. Returns whether a row changed.
   */
  setProcedureHotEligibility(
    id: string,
    input: {
      eligible: boolean;
      reason: ProcedureHotReason | null;
      atMs?: number;
      /** Dream review P1: which pass caused the flip ('dream' when unknown). */
      sourcePass?: ProcedureHotEventSource;
    },
  ): boolean {
    const procedureId = asText(id);
    if (!procedureId) return false;
    const atMs = asInteger(input.atMs ?? this.now());
    const row = this.getOne<ProcedureRow>(
      `SELECT * FROM metaid_knowledge_procedures WHERE id = ? AND status = 'active' LIMIT 1`,
      [procedureId],
    );
    if (!row) return false;
    if (input.eligible) {
      const wasHot = Number(row.hot_eligible ?? 1) !== 0;
      const existingHotSince = row.hot_since == null ? null : asInteger(row.hot_since);
      this.db.run(
        `UPDATE metaid_knowledge_procedures
         SET hot_eligible = 1, hot_reason = NULL, hot_since = ?
         WHERE id = ? AND status = 'active'`,
        [wasHot ? (existingHotSince ?? atMs) : atMs, procedureId],
      );
    } else {
      this.db.run(
        `UPDATE metaid_knowledge_procedures
         SET hot_eligible = 0, hot_reason = ?
         WHERE id = ? AND status = 'active'`,
        [normalizeProcedureHotReason(input.reason), procedureId],
      );
    }
    const changed = (this.db.getRowsModified?.() || 0) > 0;
    if (changed) {
      // Dream review P1: append-only history — the hot_reason column keeps
      // only the LATEST reason; the event row preserves what happened, when,
      // and which pass did it. Best-effort: history must never break the flip.
      try {
        this.db.run(
          `INSERT INTO metaid_knowledge_procedure_hot_events (procedure_id, ts, reason, source_pass)
           VALUES (?, ?, ?, ?)`,
          [procedureId, atMs, input.eligible ? null : normalizeProcedureHotReason(input.reason), input.sourcePass ?? 'dream'],
        );
      } catch (error) {
        console.warn('record procedure hot event failed:', error);
      }
      this.saveDb();
    }
    return changed;
  }

  /**
   * Dream review P1: the append-only hot-standing history of one procedure,
   * oldest first. Null when the events table does not exist yet.
   */
  listProcedureHotEvents(procedureId: string, options?: { limit?: number }): ProcedureHotEvent[] {
    const id = asText(procedureId);
    if (!id) return [];
    const limit = Math.min(500, Math.max(1, asInteger(options?.limit, 100)));
    try {
      const rows = this.getAll<{
        id: number | string;
        procedure_id: string;
        ts: number | string;
        reason: string | null;
        source_pass: string;
      }>(
        `SELECT id, procedure_id, ts, reason, source_pass
         FROM metaid_knowledge_procedure_hot_events
         WHERE procedure_id = ?
         ORDER BY ts ASC, id ASC
         LIMIT ?`,
        [id, limit],
      );
      return rows.map((row) => ({
        id: asInteger(row.id),
        procedureId: String(row.procedure_id),
        ts: asInteger(row.ts),
        reason: normalizeProcedureHotReason(row.reason),
        sourcePass: (['validation', 'promotion', 're_review', 'pruning', 'rollback', 'dream'] as const)
          .includes(row.source_pass as ProcedureHotEventSource)
          ? row.source_pass as ProcedureHotEventSource
          : 'dream',
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('no such table')) return [];
      throw error;
    }
  }

  /**
   * Dream review P1: flip one ACTIVE knowledge entry's hot-pool membership.
   * The nightly usage audit's knowledge cooling (≥5 audited hot nights in the
   * trailing window, 0 applied) calls this with eligible=false — the entry
   * leaves the proactive <knowledge> injection pool but stays active and fully
   * recallable. Nothing is ever deleted. Idempotent: re-cooling a cooled entry
   * touches no row and returns false.
   */
  setKnowledgeHotEligibility(id: string, input: { eligible: boolean; atMs?: number }): boolean {
    const knowledgeId = asText(id);
    if (!knowledgeId) return false;
    this.db.run(
      `UPDATE metaid_knowledge_entries
       SET hot_eligible = ?
       WHERE id = ? AND status = 'active'`,
      [input.eligible ? 1 : 0, knowledgeId],
    );
    const changed = (this.db.getRowsModified?.() || 0) > 0;
    if (changed) {
      this.saveDb();
    }
    return changed;
  }
  /**
   * RRSI P2 hot layer (design §6.2 P2.3): active, hot-eligible procedures —
   * the only ones injected as always-on. Recall-only rows stay reachable
   * through listProcedures (the procedure_recall tool).
   * RRSI P3 utility ordering (design §6.3 P3.2): ranked by applied nights in
   * the trailing 30 days, then recency, with one slot reserved for a newcomer
   * still inside the 14-day grace period.
   */
  listHotProcedures(metabotId: number, options?: { limit?: number; nowMs?: number }): MetaIDProcedureEntry[] {
    const id = asInteger(metabotId);
    if (!id) return [];
    const limit = Math.min(200, Math.max(1, asInteger(options?.limit, PROCEDURE_PROMPT_MAX_ITEMS)));
    const pool = this.getAll<ProcedureRow>(
      `SELECT * FROM metaid_knowledge_procedures
       WHERE metabot_id = ? AND status = 'active' AND hot_eligible = 1
       ORDER BY updated_at DESC, id DESC
       LIMIT 200`,
      [id],
    ).map(rowToProcedure);
    if (pool.length === 0) return [];
    const nowMs = options?.nowMs ?? this.now();
    const today = formatBotWorkspaceDate(new Date(nowMs));
    const stats = queryHotLayerUsageStats(this.db, {
      metabotId: id,
      kind: 'procedure',
      sinceDate: shiftDateKey(today, -(HOT_LAYER_UTILITY_WINDOW_DAYS - 1)),
      untilDate: today,
      itemIds: pool.map((entry) => entry.id),
    });
    return rankHotLayerItems(
      pool.map((entry) => ({
        entry,
        key: entry.id,
        kind: 'procedure' as const,
        hotSinceMs: entry.hotSince ?? entry.createdAt,
        appliedNights: stats.get(entry.id)?.appliedNights ?? 0,
        exposedNights: stats.get(entry.id)?.exposedNights ?? 0,
      })),
      { cap: limit, nowMs, freshSlots: HOT_LAYER_FRESH_SLOTS, graceDays: HOT_LAYER_GRACE_DAYS },
    ).map((candidate) => candidate.entry);
  }

  /**
   * RRSI P3 re-entry pool (design §6.3 P3.3): active procedures demoted for
   * never being applied — the ONLY hot_reason that usage evidence can make
   * hot again. gate_rejected / demoted / rollback / situational / probation
   * never re-enter through this path.
   */
  listUnusedProcedures(metabotId: number, options?: { limit?: number }): MetaIDProcedureEntry[] {
    const id = asInteger(metabotId);
    if (!id) return [];
    const limit = Math.min(200, Math.max(1, asInteger(options?.limit, 200)));
    return this.getAll<ProcedureRow>(
      `SELECT * FROM metaid_knowledge_procedures
       WHERE metabot_id = ? AND status = 'active' AND hot_eligible = 0 AND hot_reason = 'unused'
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`,
      [id, limit],
    ).map(rowToProcedure);
  }

  /** Keyword search across title + trigger + steps for the recall tool / hot layer. */
  listProcedures(options: ListMetaIDProcedureOptions): MetaIDProcedureEntry[] {
    const metabotId = asInteger(options.metabotId);
    if (!metabotId) return [];
    const clauses = ['metabot_id = ?'];
    const params: unknown[] = [metabotId];
    const status = options.status === 'all' ? null : normalizeProcedureStatus(options.status ?? 'active');
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    if (options.category) {
      clauses.push('category = ?');
      params.push(boundedOptionalText(options.category, 'category', MAX_CATEGORY));
    }
    const limit = Math.min(500, Math.max(1, asInteger(options.limit, 100)));
    const offset = Math.max(0, asInteger(options.offset, 0));
    const queryText = asText(options.query).trim();
    // Query path: tokenized coverage scoring, NOT one whole-substring LIKE —
    // "MetaWeb 安装 技能" must hit a title phrased "…学习并安装链上技能", and
    // colloquial "装技能" must hit via its 技能 bigram. Per-bot procedure sets
    // are small, so scoring in JS beats a clause-explosion SQL OR.
    const rows = this.getAll<ProcedureRow>(
      `SELECT * FROM metaid_knowledge_procedures
       WHERE ${clauses.join(' AND ')}
       ORDER BY updated_at DESC, id DESC`,
      params,
    ).map(rowToProcedure);
    const ranked = queryText ? scoreProceduresForQuery(rows, queryText) : rows;
    const page = ranked.slice(offset, offset + limit);

    if (options.touchUsed && page.length > 0) {
      const now = this.now();
      const ids = page.map((row) => row.id);
      this.db.run(
        `UPDATE metaid_knowledge_procedures SET use_count = use_count + 1, last_used_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
        [now, ...ids],
      );
      this.saveDb();
      for (const row of page) {
        row.useCount += 1;
        row.lastUsedAt = now;
      }
    }
    return page;
  }
}
