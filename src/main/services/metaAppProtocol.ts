// Pure protocol layer for the /protocols/metaapp path. Ports OAC appsProtocol.ts.

export const METAAPP_PIN_ID_PATTERN = /^[0-9a-f]{64}i0$/i;
export const METAAPP_METAFILE_REFERENCE_PATTERN = /^([0-9a-f]{64}i0)(?:\.[a-z0-9][a-z0-9+-]{0,31})?$/i;
export const METAAPP_PATH = '/protocols/metaapp';

export const METAAPP_RUNTIME_OPTIONS = ['browser', 'android', 'ios', 'windows', 'macOS', 'linux'] as const;
export type MetaAppRuntime = (typeof METAAPP_RUNTIME_OPTIONS)[number];

export const METAAPP_CONTENT_TYPE_OPTIONS = [
  'application/zip', 'application/x-tar', 'application/x-7z-compressed',
  'application/x-rar-compressed', 'application/gzip', 'application/json', 'application/xml',
  'text/plain', 'text/html', 'text/css', 'application/javascript', 'application/pdf',
  'image/jpeg', 'image/png', 'image/gif', 'image/svg+xml', 'image/webp',
  'video/mp4', 'video/webm', 'audio/mpeg', 'audio/wav', 'application/octet-stream',
] as const;

export const METAAPP_CODE_TYPE_OPTIONS = [
  'application/zip', 'application/x-tar', 'application/x-7z-compressed',
  'application/x-rar-compressed', 'application/gzip', 'application/json',
  'application/xml', 'text/html', 'text/css', 'application/javascript',
] as const;

export interface MetaAppManifestInput {
  title?: string;
  appName?: string;
  prompt?: string;
  icon?: string;
  coverImg?: string;
  introImgs?: string[];
  intro?: string;
  runtime?: string | string[];
  version?: string;
  contentType?: string;
  content?: string;
  indexFile?: string;
  code?: string;
  contentHash?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  disabled?: boolean;
  codeType?: string;
}

export type MetaAppManifest = ReturnType<typeof buildMetaAppProtocolPayload>;

const normalizeText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

// Strip an optional `metafile://` scheme prefix so the bare-pin reference regex can match.
const stripMetafileScheme = (value: string): string =>
  value.toLowerCase().startsWith('metafile://') ? value.slice('metafile://'.length) : value;

const normalizeMetafile = (value: string): string => {
  if (isHttpUrl(value)) return value;
  // Validate the reference with or without the `metafile://` prefix.
  if (!METAAPP_METAFILE_REFERENCE_PATTERN.test(stripMetafileScheme(value))) {
    throw new Error('Invalid metafile reference.');
  }
  return value.toLowerCase().startsWith('metafile://') ? value : `metafile://${value}`;
};

const normalizeImageRef = (value: string): string | undefined => {
  const text = normalizeText(value);
  if (!text) return undefined;
  if (isHttpUrl(text)) return text;
  if (!METAAPP_METAFILE_REFERENCE_PATTERN.test(stripMetafileScheme(text))) {
    throw new Error('Invalid image metafile reference.');
  }
  return text.toLowerCase().startsWith('metafile://') ? text : `metafile://${text}`;
};

const serializeRuntime = (runtime: string | string[] | undefined): string => {
  const list = Array.isArray(runtime)
    ? runtime
    : (normalizeText(runtime) ? normalizeText(runtime).split('/') : []);
  const allowed = new Set<string>(METAAPP_RUNTIME_OPTIONS as readonly string[]);
  const cleaned = Array.from(new Set(list.map((r) => normalizeText(r)).filter((r) => allowed.has(r))));
  const effective = cleaned.length ? cleaned : ['browser'];
  return effective.join('/');
};

export function buildMetaAppProtocolPayload(input: MetaAppManifestInput) {
  const appName = normalizeText(input.appName);
  if (!appName) throw new Error('appName is required.');
  const contentRaw = normalizeText(input.content);
  if (!contentRaw) throw new Error('content is required.');
  const content = normalizeMetafile(contentRaw);

  const contentType = normalizeText(input.contentType) || 'application/zip';
  if (!(METAAPP_CONTENT_TYPE_OPTIONS as readonly string[]).includes(contentType)) {
    throw new Error(`Unsupported contentType: ${contentType}`);
  }

  const codeTypeRaw = normalizeText(input.codeType);
  if (codeTypeRaw && !(METAAPP_CODE_TYPE_OPTIONS as readonly string[]).includes(codeTypeRaw)) {
    throw new Error(`Unsupported codeType: ${codeTypeRaw}`);
  }

  const introImgsRaw = Array.isArray(input.introImgs) ? input.introImgs : [];
  const introImgs = introImgsRaw.map((img) => normalizeImageRef(String(img))).filter((v): v is string => Boolean(v));

  let metadata: Record<string, unknown> | undefined;
  if (input.metadata != null) {
    if (typeof input.metadata === 'object' && !Array.isArray(input.metadata)) {
      metadata = input.metadata as Record<string, unknown>;
    }
  }

  const tags = Array.isArray(input.tags)
    ? input.tags.map((t) => normalizeText(t)).filter(Boolean)
    : [];

  return {
    title: normalizeText(input.title) || appName,
    appName,
    prompt: normalizeText(input.prompt) || undefined,
    icon: normalizeImageRef(input.icon || ''),
    coverImg: normalizeImageRef(input.coverImg || ''),
    introImgs,
    intro: normalizeText(input.intro) || undefined,
    runtime: serializeRuntime(input.runtime),
    version: normalizeText(input.version) || undefined,
    contentType,
    content,
    indexFile: normalizeText(input.indexFile) || undefined,
    code: normalizeText(input.code) ? normalizeMetafile(normalizeText(input.code)) : undefined,
    contentHash: normalizeText(input.contentHash) || undefined,
    metadata,
    tags,
    disabled: input.disabled === true,
    codeType: codeTypeRaw || undefined,
  };
}

export function buildMetaAppCreateWrite(manifest: MetaAppManifest) {
  return {
    operation: 'create' as const,
    path: METAAPP_PATH,
    contentType: 'application/json',
    payload: JSON.stringify(manifest),
  };
}

export function buildMetaAppModifyWrite(targetPinId: string, manifest: MetaAppManifest) {
  const target = normalizeText(targetPinId);
  if (!METAAPP_PIN_ID_PATTERN.test(target)) {
    throw new Error('targetPinId must be a MetaID pin id.');
  }
  return {
    operation: 'modify' as const,
    path: `@${target}`,
    contentType: 'application/json',
    payload: JSON.stringify(manifest),
  };
}

export function buildMetaAppRevokeWrite(targetPinId: string) {
  const target = normalizeText(targetPinId);
  if (!METAAPP_PIN_ID_PATTERN.test(target)) {
    throw new Error('targetPinId must be a MetaID pin id.');
  }
  return {
    operation: 'revoke' as const,
    path: `@${target}`,
    contentType: 'application/json',
    payload: '',
  };
}

export function bumpVersionValue(value: string | undefined): string {
  const text = normalizeText(value) || 'v1.0.0';
  const match = text.match(/^(.*?)(\d+)(\D*)$/u);
  if (!match) return `${text}.1`;
  return `${match[1]}${Number(match[2]) + 1}${match[3]}`;
}

export function isMetaAppPinId(value: string): boolean {
  return METAAPP_PIN_ID_PATTERN.test(normalizeText(value));
}
