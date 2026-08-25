/**
 * Per-MetaBot skill assignment storage.
 *
 * Skills stay single-copy on disk (bundled root + writable user-data root);
 * which bot may use an externally installed skill is pure data:
 * - `metabot_skill_assignments` rows (bot ↔ skill), and
 * - a `skills_scope` KV map marking skills the owner explicitly shared with
 *   ALL bots (`is_global`).
 *
 * Visibility rule (enforced by SkillManager, not here):
 *   bundled skill            → every bot, implicitly
 *   scope=global skill       → every bot
 *   assigned skill           → that bot only
 *   anything else (library)  → nobody, until assigned or globalized
 *
 * The metabots.allow_chat_skills JSON column remains the on-chain published
 * projection of "this bot's assigned external skills"; assignment writes are
 * expected to keep it in sync (see updateMetaBotCore), never the reverse.
 */

import type { SqliteDatabase } from '../sqliteTypes';
import type { SqliteStore } from '../sqliteStore';

export type SkillScope = 'library' | 'global';
export type SkillAssignmentVia = 'ui' | 'skill_tool' | 'metabot_update' | 'migration';

/** KV key holding `Record<skillId, 'global'>` — only global skills are listed. */
export const SKILL_SCOPE_KEY = 'skills_scope';
/** One-time legacy migration marker (seed global scope + convert allowlists). */
export const SKILL_ASSIGNMENT_MIGRATION_KEY = 'skills_assignment_migrated_v1';

const ASSIGNMENT_TABLE = 'metabot_skill_assignments';

export function ensureSkillAssignmentSchema(db: SqliteDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS ${ASSIGNMENT_TABLE} (
      metabot_id INTEGER NOT NULL,
      skill_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      assigned_at INTEGER NOT NULL,
      assigned_via TEXT NOT NULL DEFAULT 'ui',
      PRIMARY KEY (metabot_id, skill_id)
    )
  `);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_${ASSIGNMENT_TABLE}_skill ON ${ASSIGNMENT_TABLE}(skill_id)`
  );
}

export type SkillAssignmentRow = {
  metabotId: number;
  skillId: string;
  enabled: boolean;
  assignedAt: number;
  assignedVia: string;
};

function parseId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function listAssignments(db: SqliteDatabase, metabotId: number): SkillAssignmentRow[] {
  const result = db.exec(
    `SELECT metabot_id, skill_id, enabled, assigned_at, assigned_via
     FROM ${ASSIGNMENT_TABLE} WHERE metabot_id = ? ORDER BY assigned_at ASC, skill_id ASC`,
    [metabotId]
  );
  const rows = result[0]?.values ?? [];
  return rows
    .map((row) => {
      const metabotId = parseId(row[0]);
      const skillId = typeof row[1] === 'string' ? row[1] : '';
      if (metabotId == null || !skillId) return null;
      return {
        metabotId,
        skillId,
        enabled: row[2] !== 0,
        assignedAt: Number(row[3]) || 0,
        assignedVia: typeof row[4] === 'string' ? row[4] : 'ui',
      } satisfies SkillAssignmentRow;
    })
    .filter((row): row is SkillAssignmentRow => row !== null);
}

/** Enabled-assigned skill ids for one bot (bundled/global skills never appear). */
export function listAssignedSkillIds(db: SqliteDatabase, metabotId: number): string[] {
  const result = db.exec(
    `SELECT skill_id FROM ${ASSIGNMENT_TABLE} WHERE metabot_id = ? AND enabled = 1 ORDER BY assigned_at ASC`,
    [metabotId]
  );
  return (result[0]?.values ?? [])
    .map((row) => (typeof row[0] === 'string' ? row[0] : ''))
    .filter(Boolean);
}

/** Bot ids an external skill is assigned to (reverse lookup for the Library UI). */
export function listAssignmentMetabotIds(db: SqliteDatabase, skillId: string): number[] {
  const result = db.exec(
    `SELECT metabot_id FROM ${ASSIGNMENT_TABLE} WHERE skill_id = ? AND enabled = 1 ORDER BY metabot_id ASC`,
    [skillId]
  );
  return (result[0]?.values ?? [])
    .map((row) => parseId(row[0]))
    .filter((id): id is number => id !== null);
}

/**
 * Replace one bot's assignment set (bot-side editor + metabot_update path).
 * Bundled skill ids are normalized out: they are implicitly visible to every
 * bot and must not consume rows. Unlisted skills are unassigned.
 */
export function setMetabotAssignedSkills(
  db: SqliteDatabase,
  saveDb: () => void,
  metabotId: number,
  skillIds: readonly string[],
  via: SkillAssignmentVia
): void {
  const normalized = Array.from(new Set(skillIds.map((id) => id.trim()).filter(Boolean)));
  db.run('BEGIN TRANSACTION');
  try {
    db.run(`DELETE FROM ${ASSIGNMENT_TABLE} WHERE metabot_id = ?`, [metabotId]);
    const now = Date.now();
    for (const skillId of normalized) {
      db.run(
        `INSERT OR REPLACE INTO ${ASSIGNMENT_TABLE}
         (metabot_id, skill_id, enabled, assigned_at, assigned_via)
         VALUES (?, ?, 1, ?, ?)`,
        [metabotId, skillId, now, via]
      );
    }
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
  saveDb();
}

/**
 * Replace one skill's assignment set (skill-side scope editor: switching
 * "全部 bot" → "指定 bot" writes exactly the checked bots).
 */
export function setSkillAssignments(
  db: SqliteDatabase,
  saveDb: () => void,
  skillId: string,
  metabotIds: readonly number[],
  via: SkillAssignmentVia
): void {
  const normalized = Array.from(
    new Set(metabotIds.map((id) => parseId(id)).filter((id): id is number => id !== null))
  );
  db.run('BEGIN TRANSACTION');
  try {
    db.run(`DELETE FROM ${ASSIGNMENT_TABLE} WHERE skill_id = ?`, [skillId]);
    const now = Date.now();
    for (const metabotId of normalized) {
      db.run(
        `INSERT OR REPLACE INTO ${ASSIGNMENT_TABLE}
         (metabot_id, skill_id, enabled, assigned_at, assigned_via)
         VALUES (?, ?, 1, ?, ?)`,
        [metabotId, skillId, now, via]
      );
    }
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
  saveDb();
}

/** Assign one skill to one bot without touching the bot's other rows. */
export function assignSkillToMetabot(
  db: SqliteDatabase,
  saveDb: () => void,
  skillId: string,
  metabotId: number,
  via: SkillAssignmentVia
): void {
  db.run(
    `INSERT OR REPLACE INTO ${ASSIGNMENT_TABLE}
     (metabot_id, skill_id, enabled, assigned_at, assigned_via)
     VALUES (?, ?, 1, ?, ?)`,
    [metabotId, skillId, Date.now(), via]
  );
  saveDb();
}

/** Uninstall cleanup: drop every assignment row plus the scope entry. */
export function removeSkillFromAssignmentStore(
  db: SqliteDatabase,
  saveDb: () => void,
  store: SqliteStore,
  skillId: string
): void {
  db.run(`DELETE FROM ${ASSIGNMENT_TABLE} WHERE skill_id = ?`, [skillId]);
  saveDb();
  const scope = getGlobalScopeMap(store);
  if (skillId in scope) {
    delete scope[skillId];
    store.set(SKILL_SCOPE_KEY, scope);
  }
}

/** KV map of skills explicitly shared with all bots. */
export function getGlobalScopeMap(store: SqliteStore): Record<string, 'global'> {
  const raw = store.get<Record<string, unknown>>(SKILL_SCOPE_KEY);
  if (!raw || typeof raw !== 'object') return {};
  const map: Record<string, 'global'> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === 'global') map[key] = 'global';
  }
  return map;
}

export function getSkillScope(store: SqliteStore, skillId: string): SkillScope {
  return getGlobalScopeMap(store)[skillId] === 'global' ? 'global' : 'library';
}

export function setSkillScope(store: SqliteStore, skillId: string, scope: SkillScope): void {
  const map = getGlobalScopeMap(store);
  if (scope === 'global') {
    map[skillId] = 'global';
  } else {
    delete map[skillId];
  }
  store.set(SKILL_SCOPE_KEY, map);
}

export type SkillAssignmentMigrationInput = {
  db: SqliteDatabase;
  saveDb: () => void;
  store: SqliteStore;
  /** Current skill registry snapshot (listSkills()). */
  listSkills: () => Array<{ id: string; isBuiltIn: boolean }>;
  /** Every metabot carrying a legacy allow_chat_skills allowlist. */
  listMetabots: () => Array<{ id: number; allow_chat_skills: string[] }>;
  /** Resolve an allowlist entry (id or name) to a registry skill id. */
  resolveSkillId: (idOrName: string) => string | null;
  now?: () => number;
};

export type SkillAssignmentMigrationResult = {
  ran: boolean;
  globalSeeded: number;
  assignmentsMigrated: number;
};

/**
 * One-time upgrade bridge for existing installs (Database Upgrade Safety:
 * idempotent, behavior-preserving):
 * 1. Every already-installed external skill is seeded scope=global — the
 *    pre-assignment behavior (all bots, everything enabled) stays intact.
 * 2. Each metabot's allow_chat_skills entries become that bot's assignment
 *    rows, so chat routing keeps resolving the exact same skill set.
 * New installs after this point land library-scoped until explicitly
 * assigned or globalized by the owner.
 */
export function runSkillAssignmentMigration(
  input: SkillAssignmentMigrationInput
): SkillAssignmentMigrationResult {
  const { db, saveDb, store, listSkills, listMetabots, resolveSkillId } = input;
  if (store.get(SKILL_ASSIGNMENT_MIGRATION_KEY) === true) {
    return { ran: false, globalSeeded: 0, assignmentsMigrated: 0 };
  }

  ensureSkillAssignmentSchema(db);

  const scope = getGlobalScopeMap(store);
  let globalSeeded = 0;
  for (const skill of listSkills()) {
    if (skill.isBuiltIn) continue;
    if (scope[skill.id] === 'global') continue;
    scope[skill.id] = 'global';
    globalSeeded += 1;
  }
  store.set(SKILL_SCOPE_KEY, scope);

  const now = (input.now ?? Date.now)();
  let assignmentsMigrated = 0;
  db.run('BEGIN TRANSACTION');
  try {
    for (const metabot of listMetabots()) {
      const seen = new Set<string>();
      for (const entry of metabot.allow_chat_skills ?? []) {
        const idOrName = String(entry ?? '').trim();
        if (!idOrName) continue;
        const skillId = resolveSkillId(idOrName);
        if (!skillId || seen.has(skillId)) continue;
        seen.add(skillId);
        db.run(
          `INSERT OR REPLACE INTO ${ASSIGNMENT_TABLE}
           (metabot_id, skill_id, enabled, assigned_at, assigned_via)
           VALUES (?, ?, 1, ?, 'migration')`,
          [metabot.id, skillId, now]
        );
        assignmentsMigrated += 1;
      }
    }
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    // The scope seed above already persisted; flag stays unset so the next
    // launch retries the assignment half. INSERT OR REPLACE keeps it idempotent.
    throw error;
  }
  saveDb();

  store.set(SKILL_ASSIGNMENT_MIGRATION_KEY, true);
  return { ran: true, globalSeeded, assignmentsMigrated };
}
