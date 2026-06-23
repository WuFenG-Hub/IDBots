import {
  buildMetaAppBrowserUri,
  canOpenMetaAppInBrowser,
  normalizeMetaAppSourcePinId,
} from '../../components/metaapps/metaAppLaunch.js';

export { normalizeMetaAppSourcePinId };

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function browserRenderableUrl(value) {
  const url = text(value);
  if (!url) return '';
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : '';
  } catch {
    return '';
  }
}

function codeContentReference(app) {
  const codePinId = text(app?.codePinId);
  return codePinId ? `metafile://${codePinId}` : '';
}

export function localMetaAppToBrowserRecord(app, resolvedUrl) {
  if (!canOpenMetaAppInBrowser(app)) return null;
  const runUrl = browserRenderableUrl(resolvedUrl);
  if (!runUrl) return null;

  const sourcePinId = normalizeMetaAppSourcePinId(app.sourcePinId);
  const name = text(app.name) || sourcePinId;
  const ownerGlobalMetaId = text(app.creatorMetaId);
  const contentReference = codeContentReference(app);

  return {
    pinId: sourcePinId,
    firstPinId: sourcePinId,
    operation: 'local-installed',
    title: name,
    appName: name,
    prompt: text(app.prompt) || undefined,
    icon: text(app.icon) || undefined,
    coverImg: text(app.cover) || undefined,
    intro: text(app.description) || undefined,
    version: text(app.version) || '0.0.0',
    runtime: 'idbots-local',
    indexFile: text(app.entry) || 'index.html',
    code: contentReference,
    content: contentReference,
    contentType: 'text/html',
    codeType: contentReference ? 'application/zip' : 'text/html',
    tags: [],
    ownerGlobalMetaId,
    network: 'mvc',
    localUiUrl: runUrl,
    runUrl,
    updatedAt: Number.isFinite(app.updatedAt) ? app.updatedAt : Date.now(),
    source: text(app.sourceType) || 'idbots-local',
    raw: {
      app,
      browserUri: buildMetaAppBrowserUri(app),
    },
  };
}
