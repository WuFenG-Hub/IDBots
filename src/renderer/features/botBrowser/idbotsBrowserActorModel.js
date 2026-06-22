import {
  buildLocalMetabotActorId,
  normalizeBrowserGlobalMetaId,
  selectDefaultBrowserMetabot,
  sortMetabotsForBrowser,
} from './botBrowserIntent.js';

export function metabotToBrowserActor(metabot, defaultMetabotId = null) {
  const id = Number.isFinite(metabot?.id) ? metabot.id : 0;
  const actorId = buildLocalMetabotActorId(id);
  const globalMetaId = normalizeBrowserGlobalMetaId(metabot?.globalmetaid);
  if (!actorId || !globalMetaId) return null;

  const label =
    typeof metabot?.name === 'string' && metabot.name.trim()
      ? metabot.name.trim()
      : `MetaBot ${id}`;
  const avatar =
    typeof metabot?.avatar === 'string' && metabot.avatar.trim()
      ? metabot.avatar.trim()
      : undefined;

  return {
    id: actorId,
    label,
    kind: 'idbots-agent',
    globalMetaId,
    ...(avatar ? { avatar } : {}),
    isDefault: id === defaultMetabotId,
    capabilities: ['private-chat', 'message-view', 'profile-management', 'chat-configuration'],
    localMetabotId: id,
  };
}

export function metabotsToBrowserActors(metabots) {
  const defaultMetabot = selectDefaultBrowserMetabot(metabots);
  const defaultMetabotId = defaultMetabot?.id ?? null;
  return sortMetabotsForBrowser(metabots)
    .map((metabot) => metabotToBrowserActor(metabot, defaultMetabotId))
    .filter(Boolean);
}

export function selectDefaultBrowserActor(metabots) {
  const defaultMetabot = selectDefaultBrowserMetabot(metabots);
  if (!defaultMetabot) return null;
  return metabotToBrowserActor(defaultMetabot, defaultMetabot.id);
}
