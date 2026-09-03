import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type { SqliteDatabase as Database } from './sqliteTypes';
import { stripLoneSurrogates, truncateUtf16Units } from './libs/llmSafeText';

/**
 * Team culture store — the fleet-shared, low-entropy coordination prior
 * ("共享文化基座"). Unlike per-bot knowledge or per-pair impressions, these
 * entries belong to the owner's whole local fleet and are injected into every
 * group-task participant so the team stops re-calibrating definitions and
 * conventions ("鸡同鸭讲" = communication entropy).
 *
 * Three kinds:
 *  - glossary    term → definition/alias, kills definitional disputes;
 *  - convention  how this team works (owner-authored laws + distilled ones);
 *  - team_lesson cross-bot lessons that every member should know.
 *
 * Governance: owner-origin entries are protected from distillation rewrites
 * (the self_identity precedent); emergent entries are auto-applied with full
 * versioning and can be archived anytime. Per-kind active caps keep the layer
 * low-entropy — when a kind is full, a new entry displaces the least-used
 * active entry of that kind.
 */

export type TeamCultureKind = 'glossary' | 'convention' | 'team_lesson';
export type TeamCultureOrigin = 'owner' | 'distillation';
export type TeamCultureStatus = 'active' | 'superseded' | 'archived';

/**
 * Why one task-close distillation pass ended the way it did. Persisted per
 * close (bounded log) so the settings page can answer "why is the culture
 * base still empty" instead of leaving every skip/failure in a console.warn
 * nobody sees.
 */
export type TeamCultureDistillationOutcome =
  | 'applied'      // proposals were processed; counts carry the detail
  | 'empty'        // the LLM deliberately returned empty arrays (valid silence)
  | 'unparseable'  // the LLM reply was not usable JSON
  | 'llm-error'    // the distillation LLM call itself failed
  | 'few-members'  // acceptance summary listed fewer than 2 members
  | 'no-summary'   // the task closed without a recorded acceptance summary
  | 'disabled';    // the culture master switch was off

export interface TeamCultureDistillationRecord {
  at: number;
  taskId: number | null;
  taskTitle: string;
  outcome: TeamCultureDistillationOutcome;
  applied: number;
  pendingConventions: number;
  error?: string | null;
}

export interface TeamCultureEntry {
  id: string;
  kind: TeamCultureKind;
  topic: string;
  topicFingerprint: string;
  text: string;
  status: TeamCultureStatus;
  version: number;
  origin: TeamCultureOrigin;
  /** 1 = distilled convention awaiting owner approval; never injected. */
  pendingApproval: boolean;
  timesInjected: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertTeamCultureInput {
  id?: string;
  kind: TeamCultureKind;
  topic: string;
  text: string;
  origin?: TeamCultureOrigin;
  /** Distillation conventions land pending until the owner approves them. */
  pendingApproval?: boolean;
  /** Provenance for distilled entries: which task taught this. */
  taskId?: number | null;
  acceptanceSummaryId?: string | null;
}

export interface UpsertTeamCultureResult {
  entry: TeamCultureEntry | null;
  created: boolean;
  revised: boolean;
  /** True when an owner-authored entry shielded itself from a distillation write. */
  protected: boolean;
  /** True when a distillation insert was rejected because the kind is at cap
   * with no displacable emergent entry (owner entries always win). */
  capacitySkipped: boolean;
  /** Topic of the entry displaced to make room under the per-kind cap. */
  displacedTopic: string | null;
}

interface CultureEntryRow {
  id: string;
  kind: string;
  topic: string;
  topic_fingerprint: string;
  text: string;
  status: string;
  version: number | string;
  origin: string;
  pending_approval?: number | string | null;
  times_injected: number | string;
  last_used_at: number | string | null;
  created_at: number | string;
  updated_at: number | string;
}

const KINDS_SQL = "'glossary', 'convention', 'team_lesson'";
const ORIGINS_SQL = "'owner', 'distillation'";
const STATUSES_SQL = "'active', 'superseded', 'archived'";
const MAX_TOPIC_CHARS = 200;
const MAX_TEXT_CHARS = 2_000;
/** Per-kind active caps — the low-entropy guarantee for the culture layer. */
const TEAM_CULTURE_MAX_ACTIVE: Record<TeamCultureKind, number> = {
  glossary: 20,
  convention: 20,
  team_lesson: 10,
};
/** Injection inventory: how many entries of each kind the prompt block carries. */
const TEAM_CULTURE_PROMPT_ITEMS: Record<TeamCultureKind, number> = {
  glossary: 20,
  convention: 8,
  team_lesson: 5,
};

const KIND_VALUES: TeamCultureKind[] = ['glossary', 'convention', 'team_lesson'];

export function normalizeTeamCultureKind(value: unknown): TeamCultureKind {
  const kind = String(value ?? '').trim();
  return kind === 'convention' || kind === 'team_lesson' ? kind : 'glossary';
}

const MAX_DISTILLATION_LOG_ERROR_CHARS = 300;
const TEAM_CULTURE_DISTILLATION_LOG_KEY = 'teamCultureDistillationLog';
/** Bounded ring: the settings panel shows the recent close-out attempts. */
const TEAM_CULTURE_DISTILLATION_LOG_LIMIT = 20;

const DISTILLATION_OUTCOMES: readonly TeamCultureDistillationOutcome[] = [
  'applied', 'empty', 'unparseable', 'llm-error', 'few-members', 'no-summary', 'disabled',
];

/** Defensive read normalization for the kv-persisted log (user data). */
function normalizeDistillationRecord(value: unknown): TeamCultureDistillationRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const outcome = String(record.outcome ?? '') as TeamCultureDistillationOutcome;
  if (!DISTILLATION_OUTCOMES.includes(outcome)) return null;
  const at = Number(record.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  return {
    at,
    taskId: Number.isFinite(Number(record.taskId)) ? Math.floor(Number(record.taskId)) : null,
    taskTitle: String(record.taskTitle ?? ''),
    outcome,
    applied: Math.max(0, Math.floor(Number(record.applied) || 0)),
    pendingConventions: Math.max(0, Math.floor(Number(record.pendingConventions) || 0)),
    error: typeof record.error === 'string' && record.error
      ? truncateUtf16Units(record.error, MAX_DISTILLATION_LOG_ERROR_CHARS)
      : null,
  };
}

export function teamCultureFingerprintOf(topic: string): string {
  const normalized = topic.trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha256').update(`team-culture:${normalized}`).digest('hex');
}

function boundedText(value: unknown, label: string, max: number): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} must not be empty`);
  // Lone surrogates (half an emoji, corrupt tails) would poison strict
  // upstream JSON/prompt channels — strip, then cut without splitting pairs.
  return stripLoneSurrogates(truncateUtf16Units(text, max));
}

function rowToEntry(row: CultureEntryRow): TeamCultureEntry {
  return {
    id: row.id,
    kind: normalizeTeamCultureKind(row.kind),
    topic: row.topic,
    topicFingerprint: row.topic_fingerprint,
    text: row.text,
    status: row.status === 'superseded' || row.status === 'archived' ? row.status : 'active',
    version: Math.max(1, Math.floor(Number(row.version) || 1)),
    origin: row.origin === 'distillation' ? 'distillation' : 'owner',
    pendingApproval: Number(row.pending_approval ?? 0) === 1,
    timesInjected: Math.max(0, Math.floor(Number(row.times_injected) || 0)),
    lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** Create the shared culture schema without touching existing user data. */
export function ensureTeamCultureSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS team_culture_entries (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN (${KINDS_SQL})),
      topic TEXT NOT NULL CHECK (trim(topic) <> ''),
      topic_fingerprint TEXT NOT NULL,
      text TEXT NOT NULL CHECK (trim(text) <> ''),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (${STATUSES_SQL})),
      version INTEGER NOT NULL DEFAULT 1,
      origin TEXT NOT NULL DEFAULT 'owner' CHECK (origin IN (${ORIGINS_SQL})),
      pending_approval INTEGER NOT NULL DEFAULT 0,
      times_injected INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(topic_fingerprint)
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_team_culture_entries_status_kind_updated
      ON team_culture_entries(status, kind, updated_at DESC);
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS team_culture_revisions (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN (${KINDS_SQL})),
      topic TEXT NOT NULL,
      text TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN (${ORIGINS_SQL})),
      created_at INTEGER NOT NULL,
      FOREIGN KEY (entry_id) REFERENCES team_culture_entries(id) ON DELETE CASCADE
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_team_culture_revisions_entry
      ON team_culture_revisions(entry_id, version DESC);
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS team_culture_sources (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      task_id INTEGER,
      acceptance_summary_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (entry_id) REFERENCES team_culture_entries(id) ON DELETE CASCADE
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_team_culture_sources_task
      ON team_culture_sources(task_id, entry_id);
  `);
  try {
    const cols = db.exec('PRAGMA table_info(team_culture_entries)');
    const columns = (cols[0]?.values ?? []).map((row) => String(row[1]));
    if (!columns.includes('pending_approval')) {
      db.run('ALTER TABLE team_culture_entries ADD COLUMN pending_approval INTEGER NOT NULL DEFAULT 0');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/duplicate column name/i.test(message)) {
      console.warn('[TeamCulture] pending_approval column migrate failed:', message);
    }
  }
}

export class TeamCultureStore {
  private readonly maxActive: Record<TeamCultureKind, number>;

  constructor(
    private readonly db: Database,
    private readonly saveDb: () => void,
    private readonly now: () => number = Date.now,
    capsOverride?: Partial<Record<TeamCultureKind, number>>,
  ) {
    ensureTeamCultureSchema(this.db);
    this.maxActive = { ...TEAM_CULTURE_MAX_ACTIVE, ...capsOverride };
  }

  private getOne<T>(sql: string, params: (string | number | null)[] = []): T | null {
    const result = this.db.exec(sql, params);
    const columns = result[0]?.columns ?? [];
    const values = result[0]?.values?.[0];
    if (!values) return null;
    return Object.fromEntries(columns.map((column, index) => [column, values[index]])) as T;
  }

  private getAll<T>(sql: string, params: (string | number | null)[] = []): T[] {
    const result = this.db.exec(sql, params);
    const columns = result[0]?.columns ?? [];
    return (result[0]?.values ?? []).map((values) =>
      Object.fromEntries(columns.map((column, index) => [column, values[index]])) as T
    );
  }

  getCulture(id: string): TeamCultureEntry | null {
    const row = this.getOne<CultureEntryRow>(
      'SELECT * FROM team_culture_entries WHERE id = ? LIMIT 1',
      [id],
    );
    return row ? rowToEntry(row) : null;
  }

  listCulture(input: {
    kind?: TeamCultureKind | 'all';
    status?: TeamCultureStatus | 'all';
    query?: string;
    limit?: number;
    offset?: number;
  }): TeamCultureEntry[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (input.kind && input.kind !== 'all') {
      clauses.push('kind = ?');
      params.push(normalizeTeamCultureKind(input.kind));
    }
    if (input.status && input.status !== 'all') {
      clauses.push('status = ?');
      params.push(input.status);
    }
    if (input.query?.trim()) {
      clauses.push('(LOWER(topic) LIKE ? OR LOWER(text) LIKE ?)');
      const needle = `%${input.query.trim().toLowerCase()}%`;
      params.push(needle, needle);
    }
    const limit = Math.min(200, Math.max(1, Math.floor(input.limit ?? 100)));
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    return this.getAll<CultureEntryRow>(
      `SELECT * FROM team_culture_entries
       ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY updated_at DESC, id ASC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ).map(rowToEntry);
  }

  countCultureByKind(status: TeamCultureStatus = 'active'): Record<TeamCultureKind, number> {
    // Pending (unapproved) entries never count toward capacity — they don't
    // occupy injection slots until the owner approves them.
    const rows = this.getAll<{ kind: string; n: number | string }>(
      "SELECT kind, COUNT(*) AS n FROM team_culture_entries WHERE status = ? AND pending_approval = 0 GROUP BY kind",
      [status],
    );
    const counts: Record<TeamCultureKind, number> = { glossary: 0, convention: 0, team_lesson: 0 };
    for (const row of rows) {
      counts[normalizeTeamCultureKind(row.kind)] = Number(row.n) || 0;
    }
    return counts;
  }

  /**
   * Fingerprint upsert mirroring the knowledge store: same-topic rewrites
   * version-bump with the prior text archived as a revision. Distillation
   * writes never touch owner-origin entries (protected); owner edits promote
   * the entry to origin='owner'. When a kind is at its active cap, the
   * least-used active entry of that kind is archived to make room.
   */
  upsertCulture(input: UpsertTeamCultureInput): UpsertTeamCultureResult {
    const kind = normalizeTeamCultureKind(input.kind);
    const topic = boundedText(input.topic, 'topic', MAX_TOPIC_CHARS);
    const text = boundedText(input.text, 'text', MAX_TEXT_CHARS);
    const origin: TeamCultureOrigin = input.origin === 'distillation' ? 'distillation' : 'owner';
    const fingerprint = teamCultureFingerprintOf(topic);
    const now = this.now();

    const existing = this.getOne<CultureEntryRow>(
      'SELECT * FROM team_culture_entries WHERE topic_fingerprint = ? LIMIT 1',
      [fingerprint],
    );

    if (existing) {
      // Archived entries were deliberately retired — distillation must never
      // revive them (that would silently undo an owner's curation). Only an
      // explicit restoreCulture (or an owner upsert) brings them back.
      if (rowToEntry(existing).status === 'archived' && origin === 'distillation') {
        const entry = rowToEntry(existing);
        return { entry, created: false, revised: false, protected: true, capacitySkipped: false, displacedTopic: null };
      }
      if (origin === 'distillation' && rowToEntry(existing).origin === 'owner') {
        const entry = rowToEntry(existing);
        return { entry, created: false, revised: false, protected: true, capacitySkipped: false, displacedTopic: null };
      }
      if (existing.text === text && existing.kind === kind) {
        const entry = rowToEntry(existing);
        return { entry, created: false, revised: false, protected: false, capacitySkipped: false, displacedTopic: null };
      }
      try {
        this.db.run('BEGIN IMMEDIATE');
        this.db.run(
          `INSERT INTO team_culture_revisions (id, entry_id, version, kind, topic, text, origin, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [uuidv4(), existing.id, Math.floor(Number(existing.version) || 1), existing.kind, existing.topic, existing.text, existing.origin, now],
        );
        this.db.run(
          `UPDATE team_culture_entries
           SET kind = ?, topic = ?, text = ?, status = 'active', version = ?, origin = ?, pending_approval = ?, updated_at = ?
           WHERE id = ?`,
          [kind, topic, text, Math.floor(Number(existing.version) || 1) + 1, origin, input.pendingApproval ? 1 : 0, now, existing.id],
        );
        if (input.taskId != null) {
          this.db.run(
            `INSERT INTO team_culture_sources (id, entry_id, task_id, acceptance_summary_id, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            [uuidv4(), existing.id, Math.floor(input.taskId), input.acceptanceSummaryId ?? null, now],
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
      const entry = this.getCulture(existing.id);
      if (!entry) throw new Error(`Failed to load culture entry ${existing.id}`);
      return { entry, created: false, revised: true, protected: false, capacitySkipped: false, displacedTopic: null };
    }

    let displacedTopic: string | null = null;
    try {
      this.db.run('BEGIN IMMEDIATE');
      const cap = this.maxActive[kind];
      const activeCount = this.getOne<{ n: number | string }>(
        "SELECT COUNT(*) AS n FROM team_culture_entries WHERE kind = ? AND status = 'active'",
        [kind],
      );
      if (Number(activeCount?.n || 0) >= cap) {
        // Displacement only ever archives emergent entries — owner entries
        // are sovereign. When the kind is full of owner entries, a
        // distillation insert yields (capacitySkipped) while an owner insert
        // proceeds past the soft cap.
        const victim = this.getOne<CultureEntryRow>(
          `SELECT * FROM team_culture_entries
           WHERE kind = ? AND status = 'active' AND origin = 'distillation'
           ORDER BY COALESCE(last_used_at, created_at) ASC, times_injected ASC
           LIMIT 1`,
          [kind],
        );
        if (victim) {
          this.db.run("UPDATE team_culture_entries SET status = 'archived', updated_at = ? WHERE id = ?", [now, victim.id]);
          displacedTopic = victim.topic;
        } else if (origin === 'distillation') {
          this.db.run('ROLLBACK');
          return { entry: null, created: false, revised: false, protected: false, capacitySkipped: true, displacedTopic: null };
        }
      }
      const id = input.id?.trim() || uuidv4();
      this.db.run(
        `INSERT INTO team_culture_entries (
           id, kind, topic, topic_fingerprint, text, status, version, origin, pending_approval, times_injected, last_used_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, 0, NULL, ?, ?)`,
        [id, kind, topic, fingerprint, text, origin, input.pendingApproval ? 1 : 0, now, now],
      );
      if (input.taskId != null) {
        this.db.run(
          `INSERT INTO team_culture_sources (id, entry_id, task_id, acceptance_summary_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [uuidv4(), id, Math.floor(input.taskId), input.acceptanceSummaryId ?? null, now],
        );
      }
      this.db.run('COMMIT');
      this.saveDb();
      const entry = this.getCulture(id);
      if (!entry) throw new Error(`Failed to load culture entry ${id}`);
      return { entry, created: true, revised: false, protected: false, capacitySkipped: false, displacedTopic };
    } catch (error) {
      try {
        this.db.run('ROLLBACK');
      } catch {
        // Preserve the original write error.
      }
      throw error;
    }
  }

  /** Owner edit by id: rewrites in place (revision kept), promotes to origin='owner'. */
  updateCulture(input: {
    id: string;
    kind?: TeamCultureKind;
    topic?: string;
    text?: string;
  }): TeamCultureEntry | null {
    const existing = this.getCulture(input.id);
    if (!existing) return null;
    const kind = input.kind ? normalizeTeamCultureKind(input.kind) : existing.kind;
    const topic = boundedText(input.topic ?? existing.topic, 'topic', MAX_TOPIC_CHARS);
    const text = boundedText(input.text ?? existing.text, 'text', MAX_TEXT_CHARS);
    const now = this.now();
    try {
      this.db.run('BEGIN IMMEDIATE');
      this.db.run(
        `INSERT INTO team_culture_revisions (id, entry_id, version, kind, topic, text, origin, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), existing.id, existing.version, existing.kind, existing.topic, existing.text, existing.origin, now],
      );
      this.db.run(
        `UPDATE team_culture_entries
         SET kind = ?, topic = ?, topic_fingerprint = ?, text = ?, origin = 'owner', version = ?, pending_approval = 0, updated_at = ?
         WHERE id = ?`,
        [kind, topic, teamCultureFingerprintOf(topic), text, existing.version + 1, now, existing.id],
      );
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
    return this.getCulture(existing.id);
  }

  /** Owner approves a distilled (pending) convention: it joins injection. */
  approveCulture(id: string): TeamCultureEntry | null {
    const existing = this.getCulture(id);
    if (!existing) return null;
    this.db.run('UPDATE team_culture_entries SET pending_approval = 0, updated_at = ? WHERE id = ?', [this.now(), id]);
    this.saveDb();
    return this.getCulture(id);
  }

  archiveCulture(id: string): TeamCultureEntry | null {
    const existing = this.getCulture(id);
    if (!existing) return null;
    this.db.run("UPDATE team_culture_entries SET status = 'archived', updated_at = ? WHERE id = ?", [this.now(), id]);
    this.saveDb();
    return this.getCulture(id);
  }

  restoreCulture(id: string): TeamCultureEntry | null {
    const existing = this.getCulture(id);
    if (!existing) return null;
    this.db.run("UPDATE team_culture_entries SET status = 'active', updated_at = ? WHERE id = ?", [this.now(), id]);
    this.saveDb();
    return this.getCulture(id);
  }

  /** Hard delete with cascade (revisions/sources follow). The dream analog:
   * distillation may re-derive a similar entry later — archive keeps it out
   * without that risk. */
  deleteCulture(id: string): boolean {
    const existing = this.getCulture(id);
    if (!existing) return false;
    this.db.run('DELETE FROM team_culture_entries WHERE id = ?', [id]);
    this.saveDb();
    return true;
  }

  /**
   * Hygiene revision overflow, mirroring the knowledge store: each entry keeps
   * its newest `keepPerEntry` revisions; older redundant copies of
   * already-superseded text are physically removed.
   */
  pruneCultureRevisions(input: { keepPerEntry: number }): number {
    const keep = Math.max(1, Math.min(50, Math.floor(input.keepPerEntry)));
    const candidates = this.getAll<{ entry_id: string }>(
      `SELECT entry_id, COUNT(*) AS revision_count
       FROM team_culture_revisions
       GROUP BY entry_id
       HAVING COUNT(*) > ?
       LIMIT 5000`,
      [keep],
    );
    let revisionsDeleted = 0;
    for (const candidate of candidates) {
      this.db.run(
        `DELETE FROM team_culture_revisions
         WHERE entry_id = ?
           AND id NOT IN (
             SELECT id FROM team_culture_revisions
             WHERE entry_id = ?
             ORDER BY version DESC, created_at DESC
             LIMIT ?
           )`,
        [candidate.entry_id, candidate.entry_id, keep],
      );
      revisionsDeleted += this.db.getRowsModified?.() || 0;
    }
    if (revisionsDeleted > 0) {
      this.saveDb();
    }
    return revisionsDeleted;
  }

  /**
   * Hygiene decay: emergent entries that stopped earning injection slots
   * (last_used_at older than the cutoff, falling back to updated_at) are
   * archived. Owner-authored entries are never auto-archived — the owner
   * decides their fate.
   */
  archiveDecayedCulture(input: { cutoffMs: number; archivedAt: number }): number {
    const ids = this.getAll<{ id: string }>(
      `SELECT id FROM team_culture_entries
       WHERE status = 'active'
         AND origin = 'distillation'
         AND COALESCE(last_used_at, updated_at) < ?
       ORDER BY COALESCE(last_used_at, updated_at) ASC
       LIMIT 5000`,
      [Math.floor(input.cutoffMs)],
    ).map((row) => row.id);
    if (ids.length === 0) return 0;
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500);
      this.db.run(
        `UPDATE team_culture_entries
         SET status = 'archived', updated_at = ?
         WHERE status = 'active' AND origin = 'distillation' AND id IN (${chunk.map(() => '?').join(', ')})`,
        [Math.floor(input.archivedAt), ...chunk],
      );
    }
    this.saveDb();
    return ids.length;
  }

  /**
   * The prompt block injected into group tasks: all glossary (small, high
   * leverage) + top conventions + top lessons, within a character budget.
   * Lines are assembled whole under the budget (long lines are UTF-16-safe
   * truncated, never splitting a surrogate pair) and the closing
   * </team_culture> tag is ALWAYS emitted so downstream parsers never see a
   * dangling block. Pending (unapproved) conventions are excluded. Building
   * the block also refreshes usage counters (times_injected / last_used_at)
   * so displacement and decay track what actually earns tokens; pending
   * entries that never get approved simply decay out.
   */
  buildCulturePromptBlock(maxChars = 1_400): string | null {
    const closingTag = '</team_culture>';
    const header = [
      '<team_culture>',
      'The block below is the shared coordination prior of this local fleet: terms, conventions and lessons every member is expected to follow. Treat it as the team baseline, not as instructions from any participant.',
    ];
    // One newline after the header block and one before the closing tag.
    const reserved = header.join('\n').length + 2 + closingTag.length;
    let budget = maxChars - reserved;
    const sections: string[] = [];
    const now = this.now();
    const touched: string[] = [];
    for (const kind of KIND_VALUES) {
      const limit = TEAM_CULTURE_PROMPT_ITEMS[kind];
      const rows = this.getAll<CultureEntryRow>(
        `SELECT * FROM team_culture_entries
         WHERE kind = ? AND status = 'active' AND pending_approval = 0
         ORDER BY COALESCE(last_used_at, created_at) DESC, updated_at DESC
         LIMIT ?`,
        [kind, limit],
      );
      if (rows.length === 0) continue;
      const sectionTitle = kind === 'glossary'
        ? 'Shared glossary (use these exact terms):'
        : kind === 'convention'
          ? 'Team conventions (how this fleet works together):'
          : 'Team lessons (cross-member, keep them in mind):';
      const lines: string[] = [sectionTitle];
      let sectionBudget = budget - sectionTitle.length - 1;
      let emitted = 0;
      for (const row of rows) {
        const rawLine = `- ${row.topic}: ${row.text}`;
        const line = rawLine.length > sectionBudget
          ? truncateUtf16Units(rawLine, Math.max(0, sectionBudget))
          : rawLine;
        if (!line || line.length === 0) break;
        lines.push(line);
        sectionBudget -= line.length + 1;
        touched.push(row.id);
        emitted += 1;
      }
      if (emitted === 0) continue;
      const section = lines.join('\n');
      sections.push(section);
      budget -= section.length + 2;
      if (budget <= 0) break;
    }
    if (sections.length === 0) return null;
    for (const id of touched) {
      this.db.run(
        'UPDATE team_culture_entries SET times_injected = times_injected + 1, last_used_at = ? WHERE id = ?',
        [now, id],
      );
    }
    this.saveDb();
    return [...header, ...sections, closingTag].join('\n');
  }

  // --- culture master switch (gates BOTH distillation LLM calls and prompt
  //     injection; one row in cowork_config) ---

  getCultureConfig(): { enabled: boolean } {
    const row = this.getOne<{ value: string }>(
      "SELECT value FROM cowork_config WHERE key = 'teamCultureConfig'",
    );
    if (!row?.value) return { enabled: true };
    try {
      const parsed = JSON.parse(row.value) as { enabled?: unknown };
      return { enabled: parsed.enabled !== false };
    } catch {
      return { enabled: true };
    }
  }

  setCultureConfig(enabled: boolean): { enabled: boolean } {
    this.db.run(`
      INSERT INTO cowork_config (key, value, updated_at)
      VALUES ('teamCultureConfig', ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `, [JSON.stringify({ enabled }), this.now()]);
    this.saveDb();
    return { enabled };
  }

  // --- distillation outcome log (kv ring in cowork_config; the settings ---
  //     culture tab renders it as "why did the last task closes distill or
  //     not" instead of leaving every skip in an invisible console.warn) ---

  recordCultureDistillation(record: TeamCultureDistillationRecord): void {
    const normalized = normalizeDistillationRecord(record);
    if (!normalized) return;
    const log = [normalized, ...this.listCultureDistillationLog()]
      .slice(0, TEAM_CULTURE_DISTILLATION_LOG_LIMIT);
    this.db.run(
      `INSERT INTO cowork_config (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
      [TEAM_CULTURE_DISTILLATION_LOG_KEY, JSON.stringify(log), this.now()],
    );
    this.saveDb();
  }

  listCultureDistillationLog(): TeamCultureDistillationRecord[] {
    const row = this.getOne<{ value: string }>(
      'SELECT value FROM cowork_config WHERE key = ?',
      [TEAM_CULTURE_DISTILLATION_LOG_KEY],
    );
    if (!row?.value) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeDistillationRecord)
      .filter((record): record is TeamCultureDistillationRecord => record !== null);
  }
}
