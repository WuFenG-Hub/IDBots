import type { MetaAppRecord } from '../metaAppManager';

/**
 * Maps a Bot Browser tab's renderer URL back to the MetaApp's local source
 * directory. Two renderer URL families exist:
 *
 * - `/browser-cache/metaapp-preview/<previewId>/...` — chain packages served
 *   from the browser cache preview server (in-memory session → artifact dir).
 * - `http://127.0.0.1:<port>/<appId>/...` — locally installed apps served by
 *   the MetaApp local server (first path segment is the app id).
 */
export type MetaAppSourceLocation = {
  dir: string;
  indexFile: string;
  title: string;
};

/** Parse a /browser-cache/metaapp-preview/<previewId>/ URL → previewId. */
export function parseMetaAppPreviewId(renderUrl: string): string | null {
  const match = renderUrl.match(/\/browser-cache\/metaapp-preview\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Parse a 127.0.0.1 MetaApp local-server URL → first path segment (app id). */
export function parseLocalMetaAppServerAppId(renderUrl: string): string | null {
  try {
    const parsed = new URL(renderUrl);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') return null;
    const segment = parsed.pathname.split('/').filter(Boolean)[0];
    if (!segment || segment === 'browser-cache') return null;
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Defensively read {type, url} from a tab's resolve envelope (deep-cloned unknown). */
export function readRendererFromEnvelope(current: unknown): { type?: string; url?: string } {
  if (!current || typeof current !== 'object') return {};
  const renderer = (current as { renderer?: unknown }).renderer;
  if (!renderer || typeof renderer !== 'object') return {};
  const record = renderer as Record<string, unknown>;
  return {
    type: typeof record.type === 'string' ? record.type : undefined,
    url: typeof record.url === 'string' ? record.url : undefined,
  };
}

export async function resolveMetaAppSourceByRenderUrl(input: {
  renderUrl: string;
  listMetaApps: () => Promise<MetaAppRecord[]> | MetaAppRecord[];
  getPreviewSessionArtifactDir: (previewId: string) => Promise<{ artifactDir: string; indexFile: string } | null>;
}): Promise<MetaAppSourceLocation | null> {
  const renderUrl = input.renderUrl.trim();
  if (!renderUrl) return null;

  const previewId = parseMetaAppPreviewId(renderUrl);
  if (previewId) {
    const session = await input.getPreviewSessionArtifactDir(previewId);
    if (session) {
      return { dir: session.artifactDir, indexFile: session.indexFile, title: '' };
    }
    return null;
  }

  const appId = parseLocalMetaAppServerAppId(renderUrl);
  if (appId) {
    const apps = await input.listMetaApps();
    const app = apps.find((candidate) => candidate.id === appId);
    if (app?.appRoot) {
      return { dir: app.appRoot, indexFile: app.entry || 'index.html', title: app.name || appId };
    }
  }
  return null;
}
