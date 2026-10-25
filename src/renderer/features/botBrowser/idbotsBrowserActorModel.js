import {
  buildLocalMetabotActorId,
  normalizeBrowserGlobalMetaId,
  selectDefaultBrowserMetabot,
  sortMetabotsForBrowser,
} from './botBrowserIntent.js';

/**
 * Stable host-local Actor id of the local human identity (user_identity).
 * The main-process bridge recognizes the same id when signing.
 */
export const IDBOTS_ACCOUNT_ACTOR_ID = 'idbots-account';

export function metabotToBrowserActor(metabot, defaultMetabotId = null) {
  const id = Number.isFinite(metabot?.id) ? metabot.id : 0;
  const actorId = buildLocalMetabotActorId(id);
  const globalMetaId = normalizeBrowserGlobalMetaId(metabot?.globalmetaid);
  if (!actorId || !globalMetaId) return null;

  const label =
    typeof metabot?.name === 'string' && metabot.name.trim()
      ? metabot.name.trim()
      : `Bot ${id}`;
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
    capabilities: ['private-chat'],
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

/**
 * Sanitized Browser Actor for the local human identity. Only display fields
 * (label / globalMetaId / avatar) ever leave the main process; the mnemonic,
 * wallet paths, and addresses stay behind the IPC boundary. "Registered"
 * means a usable globalMetaid exists — otherwise the host simply omits the
 * human Actor from the runtime instead of guessing.
 */
export function userIdentityToBrowserActor(user, isDefault = false) {
  const globalMetaId = normalizeBrowserGlobalMetaId(user?.globalmetaid);
  if (!globalMetaId) return null;

  const label =
    typeof user?.name === 'string' && user.name.trim()
      ? user.name.trim()
      : globalMetaId;
  const avatar =
    typeof user?.avatar === 'string' && user.avatar.trim()
      ? user.avatar.trim()
      : undefined;

  return {
    id: IDBOTS_ACCOUNT_ACTOR_ID,
    label,
    kind: 'idbots-account',
    globalMetaId,
    ...(avatar ? { avatar } : {}),
    isDefault,
    // Chat actions are Bot-only; the human Actor signs generic writes.
    capabilities: [],
  };
}

/**
 * Runtime Actor list: the registered human identity first, then available
 * Bots (idbots-requirements WS-A). Actor ids, not display names, determine
 * selection — no globalMetaId-driven dedup across kinds.
 */
export function buildBrowserActors(metabots, user) {
  const botActors = metabotsToBrowserActors(metabots);
  const hasBotDefault = botActors.some((actor) => actor.isDefault);
  const humanActor = userIdentityToBrowserActor(user, !hasBotDefault);
  if (!humanActor) return botActors;
  return [humanActor, ...botActors];
}

/**
 * Default Actor: the existing default Bot whenever one is available; the
 * human identity only becomes the default when no usable Bot exists, so an
 * upgrade never silently changes signing behavior.
 */
export function selectDefaultBrowserActor(metabots, user = null) {
  const defaultMetabot = selectDefaultBrowserMetabot(metabots);
  if (defaultMetabot) {
    return metabotToBrowserActor(defaultMetabot, defaultMetabot.id);
  }
  return userIdentityToBrowserActor(user, true);
}
