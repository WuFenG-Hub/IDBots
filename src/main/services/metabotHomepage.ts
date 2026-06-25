export type MetabotHomepageRenderer = 'auto' | 'metaapp';

export interface MetabotHomepage {
  uri: string; // metafile://<pinId> 或 metaapp://<pinId>
  renderer: MetabotHomepageRenderer;
  contentType: string;
}

const METAFILE_URI_RE = /^metafile:\/\/\S+$/iu;
const METAAPP_URI_RE = /^metaapp:\/\/\S+$/iu;

/** Build a homepage pointer for a MetaFile source (uploaded file pin). */
export function buildMetafileHomepage(input: { pinId: string; contentType: string }): MetabotHomepage {
  const pinId = String(input.pinId ?? '').trim();
  const uri = `metafile://${pinId}`;
  if (!METAFILE_URI_RE.test(uri)) {
    throw new Error('Invalid MetaFile pin id');
  }
  const contentType = String(input.contentType ?? 'application/octet-stream').trim() || 'application/octet-stream';
  return { uri, renderer: 'auto', contentType };
}

/**
 * Build a homepage pointer for a MetaApp source from a raw pin input.
 * Accepts a bare pin or a `metaapp://<pin>` prefix; rejects whitespace or embedded `://`.
 */
export function buildMetaappHomepage(rawPin: string): MetabotHomepage {
  let pin = String(rawPin ?? '').trim();
  if (/^metaapp:\/\//i.test(pin)) {
    pin = pin.slice('metaapp://'.length).trim();
  }
  if (!pin || /\s/u.test(pin) || /:\/\//.test(pin)) {
    throw new Error('Enter a MetaApp pin ID without spaces.');
  }
  return { uri: `metaapp://${pin}`, renderer: 'metaapp', contentType: 'application/vnd.metaapp' };
}

/** Serialize to the compact JSON payload pinned to /info/homepage. Empty string for Default (null). */
export function serializeMetabotHomepagePayload(homepage: MetabotHomepage | null): string {
  if (!homepage) return '';
  return JSON.stringify({
    uri: homepage.uri,
    renderer: homepage.renderer,
    contentType: homepage.contentType,
  });
}

/** Parse a stored homepage JSON string into a validated object, or null for Default/invalid. */
export function parseHomepage(raw: string | null | undefined): MetabotHomepage | null {
  if (!raw || typeof raw !== 'string' || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Partial<MetabotHomepage>;
  const uri = String(obj.uri ?? '').trim();
  if (!METAFILE_URI_RE.test(uri) && !METAAPP_URI_RE.test(uri)) return null;
  const renderer: MetabotHomepageRenderer = obj.renderer === 'metaapp' ? 'metaapp' : 'auto';
  return {
    uri,
    renderer,
    contentType: String(obj.contentType ?? '').trim() || (renderer === 'metaapp' ? 'application/vnd.metaapp' : 'application/octet-stream'),
  };
}

/** Structural equality of two homepage pointers (null === null). */
export function homepageEquals(a: MetabotHomepage | null, b: MetabotHomepage | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a.uri === b.uri && a.renderer === b.renderer && a.contentType === b.contentType;
}
