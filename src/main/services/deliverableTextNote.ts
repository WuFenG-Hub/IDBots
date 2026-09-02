/**
 * Text-document deliverable publishing (MetaWeb URI convention).
 *
 * A deliverable that is a readable text document (Markdown / plain text) does
 * NOT belong on `/file`: the metafile:// scheme is reserved for pins whose
 * payload is a binary file (image, video, audio, PDF, archive…) — those get
 * the dedicated file indexer and CDN acceleration. Readable documents are
 * published as simplenote pins (`/protocols/simplenote`) and referenced as
 * `pin://<pinId>`, the universal scheme every MAN indexer supports.
 *
 * Shared by the group-task daemon and the OpenTeam guest daemon when they
 * upgrade a worker's local-file deliverable on-chain: text documents go
 * through publishTextFileAsNote (pin://), binaries keep the metafile upload
 * path (metafile://).
 */

import fs from 'fs';
import path from 'path';

/** Extensions treated as readable text documents (→ simplenote, pin://). */
const TEXT_NOTE_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.markdown', '.txt']);

/**
 * Upper bound for an on-chain note body. Past this the document stays on the
 * metafile path — giant text blobs as inline note content are fee-expensive
 * and nobody reads them in a note view anyway.
 */
export const MAX_TEXT_NOTE_BYTES = 256 * 1024;

/** Narrow createPin seam (wired to services/metaidCore.ts createPin in main.ts). */
export type TextNoteCreatePin = (
  metabotId: number,
  metaidData: {
    operation: 'create';
    path: string;
    encryption: '0';
    version: string;
    contentType: string;
    payload: string;
  },
  options?: { network?: string; origin?: string },
) => Promise<{ pinId?: string; txids?: string[] }>;

/**
 * True when a local deliverable file is a readable text document that should
 * be published as a simplenote note instead of a /file metafile. Extension
 * wins; a text/markdown|text/plain content type is accepted as the fallback
 * signal for extension-less names.
 */
export function isTextDocumentDeliverable(filePath: string, contentType?: string): boolean {
  const ext = path.extname(String(filePath ?? '')).toLowerCase();
  if (TEXT_NOTE_EXTENSIONS.has(ext)) return true;
  const mime = String(contentType ?? '').trim().toLowerCase();
  if (!ext && (mime === 'text/markdown' || mime === 'text/plain')) return true;
  return false;
}

function noteContentTypeFor(filePath: string, contentType?: string): string {
  const ext = path.extname(String(filePath ?? '')).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'text/markdown';
  const mime = String(contentType ?? '').trim().toLowerCase();
  if (mime === 'text/markdown' || mime === 'text/plain') return mime;
  return 'text/plain';
}

/**
 * Read a local text document into note form. Returns null when the file is
 * unreadable as utf8 or exceeds MAX_TEXT_NOTE_BYTES (caller falls back to the
 * metafile upload path).
 */
export function readTextNoteDocument(
  filePath: string,
  contentType?: string,
): { title: string; content: string; contentType: string } | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_TEXT_NOTE_BYTES) return null;
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  if (!content.trim()) return null;
  const base = path.basename(filePath, path.extname(filePath)).trim();
  return {
    title: base || 'Untitled note',
    content,
    contentType: noteContentTypeFor(filePath, contentType),
  };
}

/** Simplenote payload shape — mirrors postSimpleNoteAgentTools (verified against live pins). */
export function buildTextNotePayload(doc: { title: string; content: string; contentType: string }): string {
  return JSON.stringify({
    title: doc.title,
    subtitle: '',
    coverImg: '',
    contentType: doc.contentType,
    content: doc.content,
    encryption: '0',
    createTime: Date.now(),
    tags: [],
    attachments: [],
  });
}

/**
 * Publish a local text document as a simplenote pin paid by the given
 * MetaBot's wallet. Returns { pinId } on success, null when the file does not
 * qualify as a text note (too large / unreadable / empty) so the caller can
 * fall back to the metafile path. Chain/IO errors propagate.
 */
export async function publishTextFileAsNote(deps: {
  createPin: TextNoteCreatePin;
  metabotId: number;
  filePath: string;
  contentType?: string;
}): Promise<{ pinId: string } | null> {
  const doc = readTextNoteDocument(deps.filePath, deps.contentType);
  if (!doc) return null;
  const result = await deps.createPin(
    deps.metabotId,
    {
      operation: 'create',
      path: '/protocols/simplenote',
      encryption: '0',
      version: '1.0.1',
      contentType: 'application/json',
      payload: buildTextNotePayload(doc),
    },
    // Deliverable notes already live in the group-task deliverable records;
    // the origin keeps them out of the chain write ledger.
    { network: 'mvc', origin: 'internal:group-task-deliverable' },
  );
  const pinId = typeof result?.pinId === 'string' ? result.pinId.trim() : '';
  return pinId ? { pinId } : null;
}
