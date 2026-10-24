import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type { SqliteDatabase as Database } from './sqliteTypes';
import { stripLoneSurrogates, truncateUtf16Units } from './libs/llmSafeText';

/**
 * Standing page store — the bot's always-current briefing pages (Hindsight's
 * mental models / knowledge pages, adapted).
 *
 * A standing page is ONE question with a standing answer ("我的主人是什么样
 * 的人？", "当前工作主线是什么？"). The nightly hygiene pass rewrites the
 * answer in the background whenever the sediments in the page's scope change;
 * reading it is a database row, so a bot (or the owner) gets a settled,
 * consistent briefing instead of re-ranking raw memories.
 *
 * Design constraints carried over from the memory-evolution line:
 *  - Sections are surgically edited: a refresh carries only the sections to
 *    upsert or delete; every unmentioned section is physically preserved, so
 *    a rewritten page stays the document it was instead of drifting into a
 *    paraphrase of itself.
 *  - Every applied change keeps the previous sections as a revision (bounded),
 *    so a page can explain how it got here and a rewrite is reversible.
 *  - Freshness is explicit: the page records the scope fingerprint it was
 *    built from; readers can tell a settled page from a stale one.
 *  - Zero per-turn cost: pages are read on demand (owner tool / settings),
 *    never injected into the volatile tail.
 */

export type StandingPageSpec = 'owner_profile' | 'work_threads' | 'playbook' | 'custom';
export type StandingPageStatus = 'active' | 'archived';

export const STANDING_PAGE_SPECS: readonly StandingPageSpec[] = ['owner_profile', 'work_threads', 'playbook', 'custom'];
export const STANDING_PAGE_DEFAULT_SPECS: readonly StandingPageSpec[] = ['owner_profile', 'work_threads', 'playbook'];
const SPECS_SQL = STANDING_PAGE_SPECS.map((value) => `'${value}'`).join(', ');

export const STANDING_PAGE_MAX_SECTIONS = 8;
export const STANDING_PAGE_SECTION_TITLE_MAX_CHARS = 80;
export const STANDING_PAGE_SECTION_BODY_MAX_CHARS = 600;
/** Revisions kept per page (mirrors the knowledge layer's keep-5 rule). */
export const STANDING_PAGE_REVISIONS_KEEP = 5;
/** Upper bound on custom pages per bot — pages are curation, not storage. */
export const STANDING_PAGE_MAX_CUSTOM_PER_BOT = 3;

export interface StandingPageSection {
  /** Stable ascii slug; survives refreshes so edits are surgical. */
  key: string;
  title: string;
  body: string;
}

export interface StandingPage {
  id: string;
  metabotId: number;
  /** Stable identity: the spec for default pages, a uuid for custom ones. */
  pageKey: string;
  spec: StandingPageSpec;
  name: string;
  question: string;
  sections: StandingPageSection[];
  /** Markdown rendering of `sections` — the cheap read surface. */
  content: string;
  scopeFingerprint: string | null;
  builtAt: number | null;
  status: StandingPageStatus;
  isDefault: boolean;
  lastRefreshError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface StandingPageRevision {
  id: string;
  pageId: string;
  reason: string;
  previousSections: StandingPageSection[];
  createdAt: number;
}

export interface StandingPageSectionOperation {
  action: 'upsert' | 'delete';
  key: string;
  title?: string;
  body?: string;
}

const normalizeText = (value: string | null | undefined, maxChars: number): string => {
  const text = stripLoneSurrogates(String(value ?? '')).replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  return `${truncateUtf16Units(text, maxChars - 1)}…`;
};

/** Stable ascii slug for a section key: lowercase, dash-separated, <= 40 chars. */
export function normalizeStandingSectionKey(value: string | null | undefined): string {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || `s-${createHash('sha1').update(String(value ?? '')).digest('hex').slice(0, 8)}`;
}

export function normalizeStandingSection(input: {
  key?: string | null;
  title?: string | null;
  body?: string | null;
}): StandingPageSection | null {
  const title = normalizeText(input.title, STANDING_PAGE_SECTION_TITLE_MAX_CHARS);
  const body = normalizeText(input.body, STANDING_PAGE_SECTION_BODY_MAX_CHARS);
  if (!title && !body) return null;
  return {
    key: normalizeStandingSectionKey(input.key ?? title ?? body),
    title: title || body.slice(0, STANDING_PAGE_SECTION_TITLE_MAX_CHARS),
    body,
  };
}

export function renderStandingPageMarkdown(sections: readonly StandingPageSection[]): string {
  return sections
    .map((section) => `## ${section.title}\n\n${section.body}`.trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Apply one refresh's operations to the current sections — the surgical-edit
 * core. Unmentioned sections are KEPT (a truncated or lazy model output can
 * never silently drop a page's content); upserts replace or insert by key;
 * deletes remove by key. Duplicate keys keep the first occurrence. Returns
 * null when nothing changed (no revision, no version bump).
 */
export function applyStandingSectionOperations(
  current: readonly StandingPageSection[],
  operations: readonly StandingPageSectionOperation[]
): StandingPageSection[] | null {
  const deleteKeys = new Set(
    operations
      .filter((operation) => operation.action === 'delete')
      .map((operation) => normalizeStandingSectionKey(operation.key))
  );
  const upserts: StandingPageSection[] = [];
  for (const operation of operations) {
    if (operation.action !== 'upsert') continue;
    const section = normalizeStandingSection(operation);
    if (!section) continue;
    const existingIndex = upserts.findIndex((existing) => existing.key === section.key);
    if (existingIndex >= 0) {
      // Later operations override earlier ones for the same key.
      upserts[existingIndex] = section;
    } else {
      upserts.push(section);
    }
  }
  // Cap the merged page at the section limit, preserving current order first.
  const kept = current.filter((section) => !deleteKeys.has(section.key));
  const merged: StandingPageSection[] = [];
  const seen = new Set<string>();
  for (const section of [...kept, ...upserts]) {
    if (seen.has(section.key)) {
      // Replace the kept copy in place with the upserted one.
      const index = merged.findIndex((existing) => existing.key === section.key);
      if (index >= 0) merged[index] = section;
      continue;
    }
    seen.add(section.key);
    merged.push(section);
    if (merged.length >= STANDING_PAGE_MAX_SECTIONS) break;
  }
  const same = current.length === merged.length
    && current.every((section, index) =>
      section.key === merged[index].key
      && section.title === merged[index].title
      && section.body === merged[index].body);
  return same ? null : merged;
}

interface StandingPageRow {
  id: string;
  metabot_id: number;
  page_key: string;
  spec: string;
  name: string;
  question: string;
  sections_json: string;
  content: string;
  scope_fingerprint: string | null;
  built_at: number | null;
  status: string;
  is_default: number;
  last_refresh_error: string | null;
  created_at: number;
  updated_at: number;
}

const DEFAULT_PAGE_DEFS: Record<Exclude<StandingPageSpec, 'custom'>, { name: string; question: string }> = {
  owner_profile: {
    name: 'Owner profile',
    question: 'Who is my owner — stable profile, preferences, working style and boundaries?',
  },
  work_threads: {
    name: 'Current work threads',
    question: 'What are the current work threads with my owner — active topics, ongoing tasks, recent turns and their state?',
  },
  playbook: {
    name: 'My playbook',
    question: 'What proven techniques, knowledge points and procedures have I validated that I should reuse?',
  },
};

function parseSections(json: string): StandingPageSection[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    const sections: StandingPageSection[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const section = normalizeStandingSection({
        key: typeof record.key === 'string' ? record.key : null,
        title: typeof record.title === 'string' ? record.title : null,
        body: typeof record.body === 'string' ? record.body : null,
      });
      if (section && !sections.some((existing) => existing.key === section.key)) {
        sections.push(section);
      }
    }
    return sections;
  } catch {
    return [];
  }
}

/** Create the standing-page schema without changing existing user data. */
export function ensureStandingPageSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS metabot_standing_pages (
      id TEXT PRIMARY KEY,
      metabot_id INTEGER NOT NULL REFERENCES metabots(id),
      page_key TEXT NOT NULL,
      spec TEXT NOT NULL CHECK (spec IN (${SPECS_SQL})),
      name TEXT NOT NULL,
      question TEXT NOT NULL,
      sections_json TEXT NOT NULL DEFAULT '[]',
      content TEXT NOT NULL DEFAULT '',
      scope_fingerprint TEXT,
      built_at INTEGER,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      is_default INTEGER NOT NULL DEFAULT 0,
      last_refresh_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(metabot_id, page_key)
    )
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metabot_standing_pages_metabot
    ON metabot_standing_pages(metabot_id, status, updated_at DESC)
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS metabot_standing_page_revisions (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      previous_sections_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (page_id) REFERENCES metabot_standing_pages(id) ON DELETE CASCADE
    )
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metabot_standing_page_revisions_page
    ON metabot_standing_page_revisions(page_id, created_at DESC)
  `);
}

export class StandingPageStore {
  constructor(
    private readonly db: Database,
    private readonly saveDb: () => void
  ) {
    ensureStandingPageSchema(db);
  }

  /** Idempotently create the three default pages for a bot (archived defaults stay archived). */
  seedDefaultPages(metabotId: number): number {
    let seeded = 0;
    for (const spec of STANDING_PAGE_DEFAULT_SPECS) {
      const existing = this.getOne<StandingPageRow>(
        'SELECT * FROM metabot_standing_pages WHERE metabot_id = ? AND page_key = ?',
        [metabotId, spec]
      );
      if (existing) continue;
      const def = DEFAULT_PAGE_DEFS[spec];
      const now = Date.now();
      this.db.run(
        `INSERT INTO metabot_standing_pages (
          id, metabot_id, page_key, spec, name, question, sections_json, content,
          status, is_default, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, '[]', '', 'active', 1, ?, ?)`,
        [uuidv4(), metabotId, spec, spec, def.name, def.question, now, now]
      );
      seeded += 1;
    }
    if (seeded > 0) this.saveDb();
    return seeded;
  }

  listStandingPages(
    metabotId: number,
    options?: { includeArchived?: boolean }
  ): StandingPage[] {
    const archiveFilter = options?.includeArchived ? '' : " AND status = 'active'";
    const rows = this.getAll<StandingPageRow>(
      `SELECT * FROM metabot_standing_pages WHERE metabot_id = ?${archiveFilter}
       ORDER BY is_default DESC, created_at ASC`,
      [metabotId]
    );
    return rows.map((row) => this.mapRow(row));
  }

  getStandingPage(metabotId: number, key: string): StandingPage | null {
    const row = this.getOne<StandingPageRow>(
      'SELECT * FROM metabot_standing_pages WHERE metabot_id = ? AND (page_key = ? OR id = ?)',
      [metabotId, key, key]
    );
    return row ? this.mapRow(row) : null;
  }

  /** Owner-created custom page (question → standing answer). */
  createCustomPage(input: { metabotId: number; name: string; question: string }): StandingPage {
    const name = normalizeText(input.name, STANDING_PAGE_SECTION_TITLE_MAX_CHARS);
    const question = normalizeText(input.question, 300);
    if (!name || !question) {
      throw new Error('Standing page name and question are required');
    }
    const customs = this.listStandingPages(input.metabotId).filter((page) => page.spec === 'custom');
    if (customs.length >= STANDING_PAGE_MAX_CUSTOM_PER_BOT) {
      throw new Error(`A bot keeps at most ${STANDING_PAGE_MAX_CUSTOM_PER_BOT} custom standing pages`);
    }
    const pageKey = uuidv4();
    const now = Date.now();
    this.db.run(
      `INSERT INTO metabot_standing_pages (
        id, metabot_id, page_key, spec, name, question, sections_json, content,
        status, is_default, created_at, updated_at
      ) VALUES (?, ?, ?, 'custom', ?, ?, '[]', '', 'active', 0, ?, ?)`,
      [uuidv4(), input.metabotId, pageKey, name, question, now, now]
    );
    this.saveDb();
    const page = this.getStandingPage(input.metabotId, pageKey);
    if (!page) throw new Error('Failed to load created standing page');
    return page;
  }

  /** Defaults archive (reversible, skips future refreshes); custom pages delete. */
  removeStandingPage(metabotId: number, key: string): boolean {
    const page = this.getStandingPage(metabotId, key);
    if (!page) return false;
    if (page.isDefault) {
      this.db.run(
        "UPDATE metabot_standing_pages SET status = 'archived', updated_at = ? WHERE id = ?",
        [Date.now(), page.id]
      );
    } else {
      this.db.run('DELETE FROM metabot_standing_page_revisions WHERE page_id = ?', [page.id]);
      this.db.run('DELETE FROM metabot_standing_pages WHERE id = ?', [page.id]);
    }
    this.saveDb();
    return true;
  }

  restoreStandingPage(metabotId: number, key: string): boolean {
    const page = this.getStandingPage(metabotId, key);
    if (!page || !page.isDefault) return false;
    this.db.run(
      "UPDATE metabot_standing_pages SET status = 'active', updated_at = ? WHERE id = ?",
      [Date.now(), page.id]
    );
    this.saveDb();
    return true;
  }

  setRefreshError(pageId: string, message: string | null): void {
    this.db.run(
      'UPDATE metabot_standing_pages SET last_refresh_error = ?, updated_at = ? WHERE id = ?',
      [normalizeText(message, 300) || null, Date.now(), pageId]
    );
    this.saveDb();
  }

  /**
   * Commit one refresh: apply the operations surgically, record a revision
   * when the sections changed, stamp the scope fingerprint so unchanged
   * scopes never re-run, and clear any stale error. Returns the updated page
   * (or the untouched page when the operations changed nothing — the
   * fingerprint is still stamped: "looked, nothing to do" is a build).
   */
  commitPageRefresh(input: {
    pageId: string;
    operations: readonly StandingPageSectionOperation[];
    scopeFingerprint: string;
    reason: string;
  }): StandingPage | null {
    const row = this.getOne<StandingPageRow>(
      'SELECT * FROM metabot_standing_pages WHERE id = ?',
      [input.pageId]
    );
    if (!row) return null;
    const current = parseSections(row.sections_json);
    const merged = applyStandingSectionOperations(current, input.operations);
    const now = Date.now();
    if (merged) {
      this.db.run(
        `INSERT INTO metabot_standing_page_revisions (id, page_id, reason, previous_sections_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), input.pageId, input.reason, JSON.stringify(current), now]
      );
      this.db.run(
        `DELETE FROM metabot_standing_page_revisions
         WHERE page_id = ?
           AND id NOT IN (
             SELECT id FROM metabot_standing_page_revisions
             WHERE page_id = ?
             ORDER BY created_at DESC, ROWID DESC
             LIMIT ?
           )`,
        [input.pageId, input.pageId, STANDING_PAGE_REVISIONS_KEEP]
      );
      this.db.run(
        `UPDATE metabot_standing_pages
         SET sections_json = ?, content = ?, built_at = ?, scope_fingerprint = ?,
             last_refresh_error = NULL, updated_at = ?
         WHERE id = ?`,
        [JSON.stringify(merged), renderStandingPageMarkdown(merged), now, input.scopeFingerprint, now, input.pageId]
      );
    } else {
      this.db.run(
        `UPDATE metabot_standing_pages
         SET built_at = ?, scope_fingerprint = ?, last_refresh_error = NULL, updated_at = ?
         WHERE id = ?`,
        [now, input.scopeFingerprint, now, input.pageId]
      );
    }
    this.saveDb();
    const updated = this.getOne<StandingPageRow>(
      'SELECT * FROM metabot_standing_pages WHERE id = ?',
      [input.pageId]
    );
    return updated ? this.mapRow(updated) : null;
  }

  listPageRevisions(pageId: string, limit: number = STANDING_PAGE_REVISIONS_KEEP): StandingPageRevision[] {
    const rows = this.getAll<{ id: string; page_id: string; reason: string; previous_sections_json: string; created_at: number }>(
      `SELECT id, page_id, reason, previous_sections_json, created_at
       FROM metabot_standing_page_revisions
       WHERE page_id = ?
       ORDER BY created_at DESC, ROWID DESC
       LIMIT ?`,
      [pageId, Math.max(1, Math.min(50, Math.floor(limit)))]
    );
    return rows.map((row) => ({
      id: row.id,
      pageId: row.page_id,
      reason: row.reason,
      previousSections: parseSections(row.previous_sections_json),
      createdAt: Number(row.created_at),
    }));
  }

  private mapRow(row: StandingPageRow): StandingPage {
    return {
      id: row.id,
      metabotId: Number(row.metabot_id),
      pageKey: row.page_key,
      spec: (STANDING_PAGE_SPECS as readonly string[]).includes(row.spec) ? row.spec as StandingPageSpec : 'custom',
      name: row.name,
      question: row.question,
      sections: parseSections(row.sections_json),
      content: row.content,
      scopeFingerprint: row.scope_fingerprint ?? null,
      builtAt: row.built_at == null ? null : Number(row.built_at),
      status: row.status === 'archived' ? 'archived' : 'active',
      isDefault: Number(row.is_default) === 1,
      lastRefreshError: row.last_refresh_error ?? null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private getAll<T>(sql: string, params: Array<string | number> = []): T[] {
    const result = this.db.exec(sql, params);
    if (!result[0]?.values) return [];
    const columns = result[0].columns;
    return result[0].values.map((values) => {
      const row: Record<string, unknown> = {};
      columns.forEach((column, index) => { row[column] = values[index]; });
      return row as T;
    });
  }

  private getOne<T>(sql: string, params: Array<string | number> = []): T | null {
    return this.getAll<T>(sql, params)[0] ?? null;
  }
}

const formatBuiltDate = (builtAt: number | null): string => {
  if (builtAt == null) return 'not built yet';
  const date = new Date(builtAt);
  if (!Number.isFinite(date.getTime())) return 'not built yet';
  return `built ${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
};

/**
 * Tool/read-side formatting (pure): the list view shows one line per page —
 * key, name, section titles, freshness. Only BUILT pages belong in the agent
 * surface; an unbuilt page has nothing settled to say.
 */
export function formatStandingPagesList(pages: readonly StandingPage[]): string {
  const built = pages.filter((page) => page.builtAt != null);
  if (built.length === 0) {
    return 'No standing pages are built yet. The nightly memory pass builds them once there is enough material; nothing to read now.';
  }
  const lines = built.map((page) => {
    const titles = page.sections.map((section) => section.title).join(' / ');
    return `- ${page.pageKey} | ${page.name} — ${formatBuiltDate(page.builtAt)}${titles ? ` — ${titles}` : ' (empty)'}${page.lastRefreshError ? ` — last refresh failed: ${page.lastRefreshError}` : ''}`;
  });
  return [`Your standing pages (${built.length}):`, ...lines].join('\n');
}

/** Tool/read-side formatting (pure): one page's full markdown with a freshness header. */
export function formatStandingPageRead(page: StandingPage): string {
  const header = `# ${page.name} (${page.pageKey}) — ${formatBuiltDate(page.builtAt)}`;
  const question = `Question it answers: ${page.question}`;
  const body = page.content.trim() || '(This page has no sections yet.)';
  const warning = page.lastRefreshError ? `\n\n(Last refresh failed: ${page.lastRefreshError} — content may be behind.)` : '';
  return `${header}\n\n${question}\n\n${body}${warning}`;
}

/** Find a page by key or name (case-insensitive) for the read action. */
export function findStandingPageForRead(
  pages: readonly StandingPage[],
  keyOrName: string
): StandingPage | null {
  const needle = keyOrName.trim().toLowerCase();
  if (!needle) return null;
  return (
    pages.find((page) => page.pageKey.toLowerCase() === needle)
    ?? pages.find((page) => page.name.toLowerCase() === needle)
    ?? pages.find((page) => page.name.toLowerCase().includes(needle))
    ?? null
  );
}
