import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { KnowledgeBaseRecord, KnowledgeBaseStore } from '../knowledgeBaseStore';
import { openKnowledgeBaseIndex, type KnowledgeBaseIndexStore } from '../knowledgeBaseIndexStore';
import {
  SUPPORTED_KB_EXTENSIONS,
  buildKbCitationSnippet,
  buildKbFtsQuery,
  chunkKnowledgeBaseText,
  cleanKnowledgeBaseText,
  extractKbDocTitle,
  extractKnowledgeBaseTextAsync,
  phraseScore,
  sha256FileAsync,
  sha256Text,
  toKnowledgeBaseFtsText,
  tokenizeKnowledgeBaseText,
} from '../libs/knowledgeBaseText';

/**
 * Built-in per-MetaBot knowledge base service ("知识库").
 *
 * Orchestrates everything around a bot's document corpora: registry CRUD
 * (via KnowledgeBaseStore in the main db), incremental learning of raw
 * documents into the per-KB search index, citation queries across KBs, and
 * writing bot-collected documents (Web2 finds as SimpleNote-protocol JSON,
 * MetaWeb pins verbatim) into a KB's raw directory for the next learn run.
 *
 * Nightly auto-learning runs in the same [00:00, 06:00) local window as the
 * dream service but is deliberately decoupled from it: learning is a
 * deterministic, LLM-free job that must not depend on dream gating/success.
 */

export const KNOWLEDGE_BASE_LEARN_STATUS_CHANNEL = 'knowledgeBase:learnStatus';
export const KNOWLEDGE_BASE_AUTO_LEARN_WINDOW = { startHour: 0, endHour: 6 } as const;
const AUTO_LEARN_TICK_MS = 30 * 60 * 1000;

const MAX_KB_NAME_CHARS = 80;
const MAX_KB_DESCRIPTION_CHARS = 500;
/** Provenance bounds for addDocument sources — unbounded strings would land verbatim in the JSON payload. */
const MAX_KB_SOURCE_URL_CHARS = 500;
const MAX_KB_SOURCE_PIN_ID_CHARS = 128;
const MAX_KB_SOURCE_TAGS = 20;
const MAX_KB_SOURCE_TAG_CHARS = 80;
const DEFAULT_QUERY_TOP_K = 8;
const DEFAULT_QUERY_MIN_SCORE = 0.18;
const LEXICAL_WEIGHT = 0.85;
const PHRASE_WEIGHT = 0.15;

export interface KnowledgeBaseLearnSummary {
  kbId: string;
  full: boolean;
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  failed: Array<{ relpath: string; error: string }>;
  docsTotal: number;
  chunksTotal: number;
}

export interface KnowledgeBaseCitation {
  kbId: string;
  kbName: string;
  docTitle: string;
  relpath: string;
  sourcePath: string;
  snippet: string;
  score: number;
}

export interface KnowledgeBaseDocumentSource {
  type: 'web' | 'metaweb' | 'manual';
  url?: string;
  pinId?: string;
  protocol?: string;
  tags?: string[];
}

export interface KnowledgeBaseServiceDeps {
  store: KnowledgeBaseStore;
  resolveUserDataDir: () => string;
  emitToRenderer?: (channel: string, payload: unknown) => void;
  now?: () => Date;
}

const asTrimmed = (value: unknown): string => String(value ?? '').trim();

const toLocalDateStr = (date: Date): string => {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};

const slugifyFileName = (title: string): string => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'doc';
};

export class KnowledgeBaseService {
  private readonly store: KnowledgeBaseStore;
  private readonly resolveUserDataDir: () => string;
  private readonly emitToRenderer?: (channel: string, payload: unknown) => void;
  private readonly now: () => Date;
  private readonly learnQueues = new Map<string, Promise<unknown>>();
  private autoLearnTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Per-process cache of bots whose default KB directory was verified this
   * run. listKnowledgeBases → ensureDefaultKnowledgeBase is called EVERY
   * TURN by the volatile prompt block; without this cache each turn pays a
   * mkdirSync (and the create path an INSERT) on the hot path.
   */
  private readonly ensuredDefaultKb = new Set<number>();

  constructor(deps: KnowledgeBaseServiceDeps) {
    this.store = deps.store;
    this.resolveUserDataDir = deps.resolveUserDataDir;
    this.emitToRenderer = deps.emitToRenderer;
    this.now = deps.now ?? (() => new Date());
  }

  kbRootDir(metabotId: number, kbId: string): string {
    return path.join(this.resolveUserDataDir(), 'knowledge-bases', String(metabotId), kbId);
  }

  private defaultRawDir(metabotId: number, kbId: string): string {
    return path.join(this.kbRootDir(metabotId, kbId), 'raw');
  }

  /**
   * Open a KB's derived index with one self-heal retry: the index is always
   * rebuildable from the raw documents, so a corrupt index directory (failed
   * schema open, half-written db) is deleted and rebuilt once instead of
   * breaking every learn/query until manual intervention. A null return
   * (native sqlite unavailable) is passed through — retrying is pointless
   * there.
   */
  private openIndexWithSelfHeal(kbRootDir: string): KnowledgeBaseIndexStore | null {
    try {
      return openKnowledgeBaseIndex(kbRootDir);
    } catch {
      try {
        fs.rmSync(path.join(kbRootDir, 'index'), { recursive: true, force: true });
      } catch {
        // best effort; the retry below surfaces any remaining problem
      }
      return openKnowledgeBaseIndex(kbRootDir);
    }
  }

  private emitLearnStatus(payload: Record<string, unknown>): void {
    this.emitToRenderer?.(KNOWLEDGE_BASE_LEARN_STATUS_CHANNEL, payload);
  }

  ensureDefaultKnowledgeBase(metabotId: number): KnowledgeBaseRecord {
    this.assertMetabotId(metabotId);
    const existing = this.store.getDefault(metabotId);
    if (existing) {
      if (!this.ensuredDefaultKb.has(metabotId)) {
        fs.mkdirSync(existing.rawDir, { recursive: true });
        this.ensuredDefaultKb.add(metabotId);
      }
      return existing;
    }
    const nowIso = this.now().toISOString();
    const record: KnowledgeBaseRecord = {
      id: 'default',
      metabotId,
      name: 'Default',
      description: 'Default knowledge base. Documents saved by the bot land here when no specific knowledge base is chosen.',
      rawDir: this.defaultRawDir(metabotId, 'default'),
      isDefault: true,
      autoLearn: true,
      docCount: 0,
      chunkCount: 0,
      lastLearnedAt: null,
      lastAutoLearnDate: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    fs.mkdirSync(record.rawDir, { recursive: true });
    this.store.insert(record);
    this.ensuredDefaultKb.add(metabotId);
    return record;
  }

  listKnowledgeBases(metabotId: number): KnowledgeBaseRecord[] {
    this.ensureDefaultKnowledgeBase(metabotId);
    return this.store.listByMetabot(metabotId);
  }

  createKnowledgeBase(
    metabotId: number,
    input: { name: string; description?: string; rawDir?: string },
  ): KnowledgeBaseRecord {
    this.assertMetabotId(metabotId);
    const name = asTrimmed(input.name).slice(0, MAX_KB_NAME_CHARS);
    if (!name) throw new Error('Knowledge base name is required');
    const description = asTrimmed(input.description).slice(0, MAX_KB_DESCRIPTION_CHARS);
    const id = `kb_${crypto.randomBytes(6).toString('hex')}`;
    const rawDir = asTrimmed(input.rawDir)
      ? path.resolve(asTrimmed(input.rawDir))
      : this.defaultRawDir(metabotId, id);
    fs.mkdirSync(rawDir, { recursive: true });
    fs.mkdirSync(this.kbRootDir(metabotId, id), { recursive: true });
    const nowIso = this.now().toISOString();
    const record: KnowledgeBaseRecord = {
      id,
      metabotId,
      name,
      description,
      rawDir,
      isDefault: false,
      autoLearn: true,
      docCount: 0,
      chunkCount: 0,
      lastLearnedAt: null,
      lastAutoLearnDate: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.store.insert(record);
    return record;
  }

  updateKnowledgeBase(
    metabotId: number,
    kbId: string,
    patch: { name?: string; description?: string; autoLearn?: boolean },
  ): KnowledgeBaseRecord {
    const record = this.requireKnowledgeBase(metabotId, kbId);
    const name = patch.name === undefined ? undefined : asTrimmed(patch.name).slice(0, MAX_KB_NAME_CHARS);
    if (name !== undefined && !name) throw new Error('Knowledge base name is required');
    const description =
      patch.description === undefined
        ? undefined
        : asTrimmed(patch.description).slice(0, MAX_KB_DESCRIPTION_CHARS);
    this.store.update(metabotId, kbId, { name, description, autoLearn: patch.autoLearn }, this.now().toISOString());
    return this.requireKnowledgeBase(metabotId, record.id);
  }

  removeKnowledgeBase(metabotId: number, kbId: string): void {
    const record = this.requireKnowledgeBase(metabotId, kbId);
    if (record.isDefault) throw new Error('The default knowledge base cannot be deleted');
    // Only the managed root (index + internal raw/) is removed. A user-chosen
    // external raw directory is never touched.
    fs.rmSync(this.kbRootDir(metabotId, kbId), { recursive: true, force: true });
    this.store.remove(metabotId, kbId);
  }

  /**
   * Every public entry validates the bot id: an NaN/0/negative metabotId
   * (e.g. a malformed IPC payload) must never reach a store INSERT or a
   * filesystem path. requireKnowledgeBase + ensureDefaultKnowledgeBase funnel
   * nearly all methods, so validating these two covers the surface.
   */
  private assertMetabotId(metabotId: number): void {
    if (!Number.isInteger(metabotId) || metabotId <= 0) {
      throw new Error(`Invalid metabotId: ${String(metabotId)}`);
    }
  }

  requireKnowledgeBase(metabotId: number, kbId: string): KnowledgeBaseRecord {
    this.assertMetabotId(metabotId);
    const record = this.store.getById(metabotId, kbId);
    if (!record) throw new Error(`Knowledge base not found: ${kbId}`);
    return record;
  }

  private resolveKnowledgeBase(metabotId: number, kbId?: string): KnowledgeBaseRecord {
    const trimmed = asTrimmed(kbId);
    if (trimmed) return this.requireKnowledgeBase(metabotId, trimmed);
    return this.ensureDefaultKnowledgeBase(metabotId);
  }

  private scanRawDir(rawDir: string): Array<{ relpath: string; absPath: string; size: number; mtimeMs: number }> {
    const results: Array<{ relpath: string; absPath: string; size: number; mtimeMs: number }> = [];
    const walk = (dir: string, prefix: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const absPath = path.join(dir, entry.name);
        const relpath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(absPath, relpath);
        } else if (entry.isFile() && SUPPORTED_KB_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          try {
            const stat = fs.statSync(absPath);
            results.push({ relpath, absPath, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) });
          } catch {
            // file vanished mid-scan; skip
          }
        }
      }
    };
    walk(rawDir, '');
    return results;
  }

  /**
   * Learns the raw directory into the index. Incremental by default: only new
   * or changed files are extracted/chunked/indexed, deleted files are dropped.
   * `full: true` wipes the derived index first and rebuilds from scratch.
   */
  async learnKnowledgeBase(
    metabotId: number,
    kbId: string,
    options: { full?: boolean } = {},
  ): Promise<KnowledgeBaseLearnSummary> {
    const queueKey = `${metabotId}/${kbId}`;
    const previous = this.learnQueues.get(queueKey) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.learnKnowledgeBaseNow(metabotId, kbId, options));
    this.learnQueues.set(queueKey, run);
    try {
      return await run;
    } finally {
      if (this.learnQueues.get(queueKey) === run) this.learnQueues.delete(queueKey);
    }
  }

  private async learnKnowledgeBaseNow(
    metabotId: number,
    kbId: string,
    options: { full?: boolean },
  ): Promise<KnowledgeBaseLearnSummary> {
    const record = this.requireKnowledgeBase(metabotId, kbId);
    const full = options.full === true;
    this.emitLearnStatus({ metabotId, kbId, state: 'running', full });

    // Open inside the failure boundary: an index that fails to open (even
    // after the self-heal retry) must emit 'error' — otherwise every window's
    // learn spinner stays stuck on the 'running' event forever.
    let index: KnowledgeBaseIndexStore | null = null;
    try {
      index = this.openIndexWithSelfHeal(this.kbRootDir(metabotId, kbId));
    } catch (error) {
      const message = `Knowledge base index could not be opened (rebuild retry also failed): ${error instanceof Error ? error.message : String(error)}`;
      this.emitLearnStatus({ metabotId, kbId, state: 'error', error: message });
      throw new Error(message);
    }
    if (!index) {
      const error = 'Native SQLite (node:sqlite) is unavailable in this runtime; knowledge base indexing is not supported here.';
      this.emitLearnStatus({ metabotId, kbId, state: 'error', error });
      throw new Error(error);
    }

    const summary: KnowledgeBaseLearnSummary = {
      kbId,
      full,
      added: 0,
      updated: 0,
      removed: 0,
      unchanged: 0,
      failed: [],
      docsTotal: 0,
      chunksTotal: 0,
    };

    try {
      if (full) index.clear();
      const known = new Map(index.listDocs().map((doc) => [doc.relpath, doc]));
      const seen = new Set<string>();
      const files = this.scanRawDir(record.rawDir);
      const ingestedAt = this.now().toISOString();

      for (const file of files) {
        seen.add(file.relpath);
        const existing = known.get(file.relpath);
        try {
          if (existing && existing.size === file.size && existing.mtimeMs === file.mtimeMs) {
            summary.unchanged += 1;
            continue;
          }
          // Async I/O + a per-file yield: learn runs in the nightly window and
          // big documents must never freeze the main process (review M9).
          const sha256 = await sha256FileAsync(file.absPath);
          if (existing && existing.sha256 === sha256) {
            index.touchDoc(file.relpath, { size: file.size, mtimeMs: file.mtimeMs, sha256 });
            summary.unchanged += 1;
            continue;
          }
          const extraction = await extractKnowledgeBaseTextAsync(file.absPath);
          const text = cleanKnowledgeBaseText(extraction.text);
          const title = extraction.title || extractKbDocTitle(file.absPath, text);
          const chunks = chunkKnowledgeBaseText(text).map((chunk, ord) => ({
            ord,
            text: chunk.text,
            tokenText: toKnowledgeBaseFtsText(chunk.text),
            startOffset: chunk.startOffset,
            endOffset: chunk.endOffset,
          }));
          index.replaceDoc(
            {
              relpath: file.relpath,
              sha256,
              size: file.size,
              mtimeMs: file.mtimeMs,
              title,
              ingestedAt,
            },
            chunks,
          );
          if (existing) summary.updated += 1;
          else summary.added += 1;
        } catch (error) {
          summary.failed.push({
            relpath: file.relpath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        // Let the event loop breathe between files (chunking/tokenizing is
        // sync CPU work bounded per file; the await points above cover I/O).
        await new Promise((resolve) => setImmediate(resolve));
      }

      for (const relpath of known.keys()) {
        if (!seen.has(relpath)) {
          index.removeDoc(relpath);
          summary.removed += 1;
        }
      }

      const counts = index.counts();
      summary.docsTotal = counts.docs;
      summary.chunksTotal = counts.chunks;
      this.store.updateLearnStats(kbId, {
        docCount: counts.docs,
        chunkCount: counts.chunks,
        lastLearnedAt: ingestedAt,
      });
      this.emitLearnStatus({ metabotId, kbId, state: 'done', summary });
      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitLearnStatus({ metabotId, kbId, state: 'error', error: message });
      throw error;
    } finally {
      index.close();
    }
  }

  async learnAllKnowledgeBases(
    metabotId: number,
    options: { full?: boolean } = {},
  ): Promise<KnowledgeBaseLearnSummary[]> {
    const records = this.listKnowledgeBases(metabotId);
    const summaries: KnowledgeBaseLearnSummary[] = [];
    for (const record of records) {
      summaries.push(await this.learnKnowledgeBase(metabotId, record.id, options));
    }
    return summaries;
  }

  /** Citation query over one KB or, when kbId is omitted, across all of the bot's KBs. */
  queryKnowledgeBase(
    metabotId: number,
    input: { query: string; kbId?: string; topK?: number; minScore?: number },
  ): KnowledgeBaseCitation[] {
    const query = asTrimmed(input.query);
    if (!query) return [];
    const topK = Math.max(1, Math.min(50, Math.floor(input.topK ?? DEFAULT_QUERY_TOP_K)));
    const minScore = input.minScore ?? DEFAULT_QUERY_MIN_SCORE;

    const records = asTrimmed(input.kbId)
      ? [this.requireKnowledgeBase(metabotId, asTrimmed(input.kbId))]
      : this.listKnowledgeBases(metabotId).filter((record) => record.docCount > 0);

    const citations: KnowledgeBaseCitation[] = [];
    for (const record of records) {
      citations.push(...this.querySingleKnowledgeBase(record, query, topK, minScore));
    }
    citations.sort((left, right) => right.score - left.score);
    return citations.slice(0, topK);
  }

  private querySingleKnowledgeBase(
    record: KnowledgeBaseRecord,
    query: string,
    topK: number,
    minScore: number,
  ): KnowledgeBaseCitation[] {
    const index = this.openIndexWithSelfHeal(this.kbRootDir(record.metabotId, record.id));
    if (!index) return [];
    try {
      const candidateLimit = topK * 4;
      interface Candidate {
        chunk: { docRelpath: string; text: string };
        lexical: number;
      }
      let candidates: Candidate[] = [];

      if (index.ftsEnabled) {
        const matchQuery = buildKbFtsQuery(query);
        const hits = index.searchFts(matchQuery, candidateLimit);
        const chunks = index.getChunksByRowids(hits.map((hit) => hit.rowid));
        const rankByRowid = new Map(hits.map((hit) => [hit.rowid, hit.rank]));
        candidates = chunks.map((chunk) => ({
          chunk: { docRelpath: chunk.docRelpath, text: chunk.text },
          // bm25 ranks are negative; better matches are more negative.
          lexical: -(rankByRowid.get(chunk.rowid) ?? 0),
        }));
      } else {
        const tokens = [...new Set(tokenizeKnowledgeBaseText(query))];
        const specific = tokens.filter((token) => token.length >= 2);
        const terms = (specific.length ? specific : tokens).slice(0, 8);
        const chunks = index.searchLike(terms, candidateLimit * 4);
        candidates = chunks.map((chunk) => {
          const lower = chunk.text.toLowerCase();
          let lexical = 0;
          for (const token of tokens) {
            lexical += lower.split(token).length - 1;
          }
          return { chunk: { docRelpath: chunk.docRelpath, text: chunk.text }, lexical };
        });
      }

      if (!candidates.length) return [];

      const scored = candidates.map((candidate) => ({
        ...candidate,
        phrase: phraseScore(query, candidate.chunk.text),
      }));
      const maxLexical = Math.max(...scored.map((candidate) => candidate.lexical), 0);
      const maxPhrase = Math.max(...scored.map((candidate) => candidate.phrase), 0);
      const titleByRelpath = new Map(index.listDocs().map((doc) => [doc.relpath, doc.title || doc.relpath]));

      return scored
        .map((candidate) => {
          const lexicalNorm = maxLexical > 0 ? candidate.lexical / maxLexical : 0;
          const phraseNorm = maxPhrase > 0 ? candidate.phrase / maxPhrase : 0;
          const score = LEXICAL_WEIGHT * lexicalNorm + PHRASE_WEIGHT * phraseNorm;
          return { candidate, score };
        })
        .filter((entry) => entry.score >= minScore)
        .sort((left, right) => right.score - left.score)
        .slice(0, topK)
        .map((entry) => ({
          kbId: record.id,
          kbName: record.name,
          docTitle: titleByRelpath.get(entry.candidate.chunk.docRelpath) || entry.candidate.chunk.docRelpath,
          relpath: entry.candidate.chunk.docRelpath,
          sourcePath: path.join(record.rawDir, entry.candidate.chunk.docRelpath),
          snippet: buildKbCitationSnippet(entry.candidate.chunk.text),
          score: Math.round(entry.score * 1000) / 1000,
        }));
    } finally {
      index.close();
    }
  }

  /**
   * Saves a bot-collected document into a KB's raw directory (metabot-inbox/).
   * Free-form content is wrapped in a SimpleNote-protocol JSON payload; content
   * that already is note-style JSON (e.g. a MetaWeb simplenote pin body) is
   * kept verbatim apart from an injected `x-kb-source` provenance field.
   * The document becomes searchable at the next learn run.
   */
  addDocument(
    metabotId: number,
    input: { kbId?: string; title: string; content: string; source?: KnowledgeBaseDocumentSource },
  ): { kbId: string; filePath: string; relpath: string } {
    const record = this.resolveKnowledgeBase(metabotId, input.kbId);
    const title = asTrimmed(input.title).slice(0, 200);
    const content = String(input.content ?? '');
    if (!title) throw new Error('Document title is required');
    if (!content.trim()) throw new Error('Document content is required');

    const rawSource: KnowledgeBaseDocumentSource = input.source ?? { type: 'manual' };
    // Bounded provenance: these strings land verbatim in the stored JSON.
    const source: KnowledgeBaseDocumentSource = { type: rawSource.type };
    if (rawSource.url) source.url = asTrimmed(rawSource.url).slice(0, MAX_KB_SOURCE_URL_CHARS);
    if (rawSource.pinId) source.pinId = asTrimmed(rawSource.pinId).slice(0, MAX_KB_SOURCE_PIN_ID_CHARS);
    if (rawSource.protocol) source.protocol = asTrimmed(rawSource.protocol).slice(0, MAX_KB_SOURCE_TAG_CHARS);
    if (Array.isArray(rawSource.tags)) {
      source.tags = rawSource.tags
        .map((tag) => asTrimmed(tag).slice(0, MAX_KB_SOURCE_TAG_CHARS))
        .filter(Boolean)
        .slice(0, MAX_KB_SOURCE_TAGS);
    }
    let payload: Record<string, unknown>;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = null;
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).content === 'string'
    ) {
      payload = { ...(parsed as Record<string, unknown>), 'x-kb-source': source };
    } else {
      payload = {
        title,
        subtitle: '',
        coverImg: '',
        contentType: 'text/markdown',
        content,
        encryption: '',
        createTime: this.now().toISOString(),
        tags: source.tags ?? [],
        attachments: [],
        'x-kb-source': source,
      };
    }

    const inboxDir = path.join(record.rawDir, 'metabot-inbox');
    fs.mkdirSync(inboxDir, { recursive: true });
    const fileName = `${slugifyFileName(title)}-${sha256Text(content).slice(0, 8)}.json`;
    const filePath = path.join(inboxDir, fileName);
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return {
      kbId: record.id,
      filePath,
      relpath: `metabot-inbox/${fileName}`,
    };
  }

  /** Copies user-picked files into the KB raw directory (unsupported types skipped). */
  importFiles(
    metabotId: number,
    kbId: string,
    filePaths: string[],
  ): { imported: string[]; skipped: Array<{ filePath: string; reason: string }> } {
    const record = this.requireKnowledgeBase(metabotId, kbId);
    fs.mkdirSync(record.rawDir, { recursive: true });
    const imported: string[] = [];
    const skipped: Array<{ filePath: string; reason: string }> = [];
    for (const filePath of filePaths) {
      const ext = path.extname(filePath).toLowerCase();
      if (!SUPPORTED_KB_EXTENSIONS.has(ext)) {
        skipped.push({ filePath, reason: `Unsupported file type: ${ext || '(none)'}` });
        continue;
      }
      try {
        const baseName = path.basename(filePath);
        let destPath = path.join(record.rawDir, baseName);
        let counter = 2;
        while (fs.existsSync(destPath)) {
          destPath = path.join(record.rawDir, `${path.basename(baseName, ext)}-${counter}${ext}`);
          counter += 1;
        }
        fs.copyFileSync(filePath, destPath);
        imported.push(destPath);
      } catch (error) {
        skipped.push({ filePath, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { imported, skipped };
  }

  // --- Nightly auto-learn (dream window) -------------------------------------

  startAutoLearnSchedule(): void {
    if (this.autoLearnTimer) return;
    this.autoLearnTimer = setInterval(() => {
      void this.runAutoLearnTick().catch(() => undefined);
    }, AUTO_LEARN_TICK_MS);
    this.autoLearnTimer.unref?.();
  }

  stopAutoLearnSchedule(): void {
    if (this.autoLearnTimer) {
      clearInterval(this.autoLearnTimer);
      this.autoLearnTimer = null;
    }
  }

  /** Runs one auto-learn pass over all due KBs when inside the nightly window. */
  async runAutoLearnTick(): Promise<{ learned: number }> {
    const now = this.now();
    const hour = now.getHours();
    if (hour < KNOWLEDGE_BASE_AUTO_LEARN_WINDOW.startHour || hour >= KNOWLEDGE_BASE_AUTO_LEARN_WINDOW.endHour) {
      return { learned: 0 };
    }
    const todayStr = toLocalDateStr(now);
    const due = this.store.listDueForAutoLearn(todayStr);
    let learned = 0;
    for (const record of due) {
      try {
        await this.learnKnowledgeBase(record.metabotId, record.id, { full: false });
        this.store.markAutoLearned(record.id, todayStr);
        learned += 1;
      } catch {
        // Leave last_auto_learn_date untouched so a later tick retries.
      }
    }
    return { learned };
  }
}
