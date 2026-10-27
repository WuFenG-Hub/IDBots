import type { CoworkComposerAttachment } from '../components/cowork/coworkComposerAttachments';
import type { VersionedComposerField } from '../components/cowork/coworkPromptSubmission';

export const MOBILE_DRAFTS_V2_STORAGE_KEY = 'idbots.mobile.sessionDrafts.v2';

export interface MobileChatAttachment extends CoworkComposerAttachment {
  size: number;
  mime: string;
}

export interface CoworkSessionDraft {
  text: string;
  attachments: MobileChatAttachment[];
}

export function normalizeCoworkAttachments(input: unknown): MobileChatAttachment[] {
  if (!Array.isArray(input)) return [];
  const attachments: MobileChatAttachment[] = [];
  const paths = new Set<string>();
  for (const value of input) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.path !== 'string' || !candidate.path.trim()) continue;
    if (typeof candidate.name !== 'string' || !candidate.name.trim()) continue;
    if (paths.has(candidate.path)) continue;
    paths.add(candidate.path);
    attachments.push({
      path: candidate.path,
      name: candidate.name,
      size: typeof candidate.size === 'number' && Number.isFinite(candidate.size) && candidate.size >= 0
        ? candidate.size
        : 0,
      mime: typeof candidate.mime === 'string' ? candidate.mime : '',
    });
  }
  return attachments;
}

function normalizeDrafts(input: unknown): Record<string, CoworkSessionDraft> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const drafts: Record<string, CoworkSessionDraft> = {};
  for (const [key, value] of Object.entries(input)) {
    const draft = typeof value === 'string'
      ? { text: value, attachments: [] }
      : value && typeof value === 'object' && !Array.isArray(value)
        ? {
            text: typeof (value as Record<string, unknown>).text === 'string'
              ? (value as Record<string, unknown>).text as string
              : '',
            attachments: normalizeCoworkAttachments((value as Record<string, unknown>).attachments),
          }
        : null;
    if (draft && (draft.text || draft.attachments.length > 0)) drafts[key] = draft;
  }
  return drafts;
}

function parseDrafts(raw: string | null, version: 1 | 2): Record<string, CoworkSessionDraft> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (version === 2) {
      const envelope = parsed as Record<string, unknown>;
      if (envelope.version !== 2 || !envelope.drafts || typeof envelope.drafts !== 'object') return null;
      return normalizeDrafts(envelope.drafts);
    }
    return normalizeDrafts(parsed);
  } catch {
    return null;
  }
}

export function loadCoworkSessionDrafts(
  storage: { getItem: (key: string) => string | null } | null,
  legacyKey: string,
): Record<string, CoworkSessionDraft> {
  if (!storage) return {};
  try {
    return parseDrafts(storage.getItem(MOBILE_DRAFTS_V2_STORAGE_KEY), 2)
      ?? parseDrafts(storage.getItem(legacyKey), 1)
      ?? {};
  } catch {
    return {};
  }
}

export function serializeCoworkSessionDrafts(drafts: Record<string, CoworkSessionDraft>): string {
  return JSON.stringify({ version: 2, drafts });
}

export class CoworkSessionDraftStore {
  private drafts: Record<string, CoworkSessionDraft>;
  private revisions: Record<string, { text: number; attachments: number }> = {};
  private aliases = new Map<string, string>();
  private newGeneration = 0;

  constructor(
    private readonly storage: {
      getItem: (key: string) => string | null;
      setItem: (key: string, value: string) => void;
    } | null,
    legacyKey: string,
    private readonly onChange: () => void,
  ) {
    this.drafts = loadCoworkSessionDrafts(storage, legacyKey);
  }

  snapshot(): Readonly<Record<string, CoworkSessionDraft>> {
    return this.drafts;
  }

  tokenForSession(sessionId: string | null): string {
    return sessionId ?? `new:${this.newGeneration}`;
  }

  resetNew(): void {
    this.newGeneration += 1;
  }

  getText(sessionId: string | null): string {
    return this.drafts[this.keyForToken(this.tokenForSession(sessionId)) ?? '']?.text ?? '';
  }

  getAttachments(sessionId: string | null): MobileChatAttachment[] {
    return (this.drafts[this.keyForToken(this.tokenForSession(sessionId)) ?? '']?.attachments ?? [])
      .map((attachment) => ({ ...attachment }));
  }

  setText(sessionId: string | null, text: string): void {
    this.setField(this.tokenForSession(sessionId), 'text', text);
  }

  addAttachments(token: string, attachments: MobileChatAttachment[]): void {
    const key = this.keyForToken(token);
    if (!key) return;
    const existing = this.drafts[key]?.attachments ?? [];
    const paths = new Set(existing.map((attachment) => attachment.path));
    const additions = attachments.filter((attachment) => !paths.has(attachment.path));
    if (additions.length > 0) this.setField(token, 'attachments', [...existing, ...additions]);
  }

  removeAttachment(token: string, path: string): void {
    const key = this.keyForToken(token);
    if (!key) return;
    const attachments = this.drafts[key]?.attachments ?? [];
    const remaining = attachments.filter((attachment) => attachment.path !== path);
    if (remaining.length !== attachments.length) this.setField(token, 'attachments', remaining);
  }

  migrateNew(sessionId: string): void {
    const token = this.tokenForSession(null);
    this.aliases.set(token, sessionId);
    const source = this.drafts.new;
    if (!source || this.drafts[sessionId]) return;
    const drafts = { ...this.drafts, [sessionId]: source };
    delete drafts.new;
    this.drafts = drafts;
    this.persist();
    this.onChange();
  }

  clearIfUnchanged(token: string, text: string, attachments: MobileChatAttachment[]): void {
    const key = this.keyForToken(token);
    if (!key) return;
    const current = this.drafts[key];
    if (!current || current.text !== text) return;
    if (JSON.stringify(current.attachments) !== JSON.stringify(attachments)) return;
    const drafts = { ...this.drafts };
    delete drafts[key];
    this.drafts = drafts;
    this.bumpRevision(key, 'text');
    this.bumpRevision(key, 'attachments');
    this.persist();
    this.onChange();
  }

  field<K extends keyof CoworkSessionDraft>(
    token: string,
    field: K,
    initialValue: CoworkSessionDraft[K],
    options: { clearOnTake?: boolean } = {},
  ): VersionedComposerField<CoworkSessionDraft[K]> {
    let generation = 0;
    let disposed = false;
    const get = (): CoworkSessionDraft[K] => {
      const key = this.keyForToken(token);
      return (key ? this.drafts[key]?.[field] : undefined) ?? initialValue;
    };
    const set = (value: CoworkSessionDraft[K]): number => {
      if (disposed) return this.revision(token, field);
      this.setField(token, field, value);
      return this.revision(token, field);
    };
    return {
      get,
      set,
      takeAndClear: () => {
        const value = get();
        const clearedRevision = options.clearOnTake === false
          ? this.revision(token, field)
          : set((field === 'text' ? '' : []) as CoworkSessionDraft[K]);
        return { value, clearedRevision, generation };
      },
      restoreIfUnchanged: (snapshot) => {
        if (disposed || generation !== snapshot.generation) return false;
        if (this.revision(token, field) !== snapshot.clearedRevision) return false;
        set(snapshot.value);
        return true;
      },
      invalidate: () => {
        if (disposed) return;
        generation += 1;
        const key = this.keyForToken(token);
        if (key) this.bumpRevision(key, field);
      },
      dispose: () => {
        disposed = true;
        generation += 1;
      },
    };
  }

  private keyForToken(token: string): string | null {
    const alias = this.aliases.get(token);
    if (alias) return alias;
    if (token === `new:${this.newGeneration}`) return 'new';
    return token.startsWith('new:') ? null : token;
  }

  private revision<K extends keyof CoworkSessionDraft>(token: string, field: K): number {
    const key = this.keyForToken(token);
    return (key ? this.revisions[key]?.[field] : undefined) ?? 0;
  }

  private bumpRevision(key: string, field: keyof CoworkSessionDraft): void {
    const current = this.revisions[key] ?? { text: 0, attachments: 0 };
    this.revisions = {
      ...this.revisions,
      [key]: { ...current, [field]: current[field] + 1 },
    };
  }

  private setField<K extends keyof CoworkSessionDraft>(
    token: string,
    field: K,
    value: CoworkSessionDraft[K],
  ): void {
    const key = this.keyForToken(token);
    if (!key) return;
    const current = this.drafts[key] ?? { text: '', attachments: [] };
    const next: CoworkSessionDraft = { ...current, [field]: value };
    const drafts = { ...this.drafts };
    if (!next.text && next.attachments.length === 0) delete drafts[key];
    else drafts[key] = next;
    this.drafts = drafts;
    this.bumpRevision(key, field);
    this.persist();
    this.onChange();
  }

  private persist(): void {
    try {
      this.storage?.setItem(MOBILE_DRAFTS_V2_STORAGE_KEY, serializeCoworkSessionDrafts(this.drafts));
    } catch {
      return;
    }
  }
}
