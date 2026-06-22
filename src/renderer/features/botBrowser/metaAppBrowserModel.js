import { buildMetaAppBrowserUri, canOpenMetaAppInBrowser } from '../../components/metaapps/metaAppLaunch.js';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function localMetaAppToBrowserRecord(app, resolvedUrl) {
  if (!canOpenMetaAppInBrowser(app)) return null;
  const runUrl = text(resolvedUrl);
  if (!runUrl) return null;

  const sourcePinId = text(app.sourcePinId).toLowerCase();
  const name = text(app.name) || sourcePinId;
  const ownerGlobalMetaId = text(app.creatorMetaId);

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
    code: text(app.codePinId),
    content: text(app.codePinId),
    contentType: 'text/html',
    codeType: 'html',
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
