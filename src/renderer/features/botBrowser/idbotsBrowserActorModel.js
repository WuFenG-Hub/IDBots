import {
  buildLocalMetabotActorId,
  normalizeBrowserGlobalMetaId,
  selectDefaultBrowserMetabot,
  sortMetabotsForBrowser,
} from './botBrowserIntent.js';

/**
 * Stable host-local Actor id for the single local human identity
 * (user_identity is a single-row store; the row id is always 1). Actor ids,
 * not display names, determine selection and signing.
 */
export const HUMAN_ACCOUNT_ACTOR_ID = 'idbots-account-1';

/**
 * Map the sanitized human identity descriptor to a Browser Actor.
 *
 * The input is expected to come from the host's sanitized path and carry only
 * display fields — label, globalMetaId, optional avatar, and the
 * signingAvailable flag. No mnemonic, addresses, keys, wallet snapshots,
 * filesystem paths, or raw store rows may ride along in the runtime Actor.
 */
export function humanIdentityToBrowserActor(human) {
  const globalMetaId = normalizeBrowserGlobalMetaId(human?.globalMetaId);
  if (!globalMetaId) return null;
  const name = typeof human?.label === 'string' && human.label.trim()
    ? human.label.trim()
    : 'Account';
  return {
    id: HUMAN_ACCOUNT_ACTOR_ID,
    label: `${name} · Account`,
    kind: 'idbots-account',
    globalMetaId,
    ...(typeof human?.avatar === 'string' && human.avatar.trim()
      ? { avatar: human.avatar.trim() }
      : {}),
    isDefault: false,
    capabilities: [],
  };
}

/**
 * A registered human identity whose signer is usable (identity row exists
 * with a GlobalMetaID and the gas subsidy is not failed/missing). A visible
 * but locked signer stays selectable; writes then fail with an explicit
 * error instead of falling back to a Bot.
 */
export function isUsableHumanIdentity(human) {
  if (!humanIdentityToBrowserActor(human)) return false;
  return human?.signingAvailable === true;
}

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

export function selectDefaultBrowserActor(metabots) {
  const defaultMetabot = selectDefaultBrowserMetabot(metabots);
  if (!defaultMetabot) return null;
  return metabotToBrowserActor(defaultMetabot, defaultMetabot.id);
}

/**
 * Full runtime Actor list: the registered human identity first (when it
 * exists), then the available Bots. Bots sharing the human identity's
 * GlobalMetaId are skipped so one chain identity appears once; Actor ids —
 * not display names — remain the selection key.
 */
export function buildBrowserRuntimeActors(metabots, human = null) {
  const humanActor = humanIdentityToBrowserActor(human);
  const botActors = metabotsToBrowserActors(metabots).filter((actor) => {
    return !humanActor || actor.globalMetaId !== humanActor.globalMetaId;
  });
  return humanActor ? [humanActor, ...botActors] : botActors;
}

/**
 * Default Actor policy: an existing usable Bot default is preserved when Bots
 * exist (adding the human Actor must not change signing behavior on upgrade);
 * with no usable Bot but a usable human identity, the human becomes the
 * default so generic signing remains possible without forcing Bot creation.
 * A visible-but-locked human is never the default.
 */
export function selectDefaultBrowserRuntimeActor(metabots, human = null) {
  const botDefault = selectDefaultBrowserActor(metabots);
  if (botDefault) return botDefault;
  if (isUsableHumanIdentity(human)) return humanIdentityToBrowserActor(human);
  return null;
}
