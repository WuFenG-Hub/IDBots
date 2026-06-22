const RAW_GLOBAL_META_ID_VERSION_CHARS = new Set(['q', 'p', 'z', 'r', 'y', 't']);

export function normalizeBrowserGlobalMetaId(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.startsWith('metaid:')) return '';
  if (!normalized.startsWith('id')) return '';
  if (!RAW_GLOBAL_META_ID_VERSION_CHARS.has(normalized[2] ?? '')) return '';
  if (normalized[3] !== '1') return '';
  return normalized;
}

export function buildBotPageBrowserUri(globalMetaId) {
  const normalized = normalizeBrowserGlobalMetaId(globalMetaId);
  return normalized ? `metaid://${encodeURIComponent(normalized)}` : '';
}

export function buildMetaAppBrowserUri(sourcePinId) {
  const normalized = typeof sourcePinId === 'string' ? sourcePinId.trim().toLowerCase() : '';
  return normalized ? `metaapp://${encodeURIComponent(normalized)}` : '';
}

export function buildLocalMetabotActorId(metabotId) {
  const text = typeof metabotId === 'number' ? String(metabotId) : typeof metabotId === 'string' ? metabotId.trim() : '';
  if (!/^[1-9]\d*$/.test(text)) return '';
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) && parsed > 0 ? `idbots-metabot-${parsed}` : '';
}

export function parseLocalMetabotActorId(actorId) {
  const text = typeof actorId === 'string' ? actorId.trim() : '';
  const match = /^idbots-metabot-(\d+)$/.exec(text);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function sortMetabotsForBrowser(metabots) {
  return [...(Array.isArray(metabots) ? metabots : [])].sort((left, right) => {
    const leftCreated = Number.isFinite(left?.created_at) ? left.created_at : 0;
    const rightCreated = Number.isFinite(right?.created_at) ? right.created_at : 0;
    if (leftCreated !== rightCreated) return leftCreated - rightCreated;
    const leftId = Number.isFinite(left?.id) ? left.id : 0;
    const rightId = Number.isFinite(right?.id) ? right.id : 0;
    return leftId - rightId;
  });
}

export function selectDefaultBrowserMetabot(metabots) {
  return (
    sortMetabotsForBrowser(metabots).find((metabot) => {
      return normalizeBrowserGlobalMetaId(metabot?.globalmetaid) !== '';
    }) || null
  );
}
