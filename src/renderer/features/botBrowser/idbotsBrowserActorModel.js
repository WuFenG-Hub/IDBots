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
 * Resolve the runtime Actor list AND its default together.
 *
 * The default is chosen from the deduplicated list so it can never point at
 * an Actor the user cannot actually select:
 * 1. The existing default Bot is preserved when it survived dedup.
 * 2. If it was deduped against the human identity (same GlobalMetaId), the
 *    usable human account Actor — the same chain identity — takes over.
 * 3. Otherwise the next surviving Bot, then nothing.
 * The chosen Actor is marked isDefault in the returned list and returned by
 * reference, so `defaultActor` always exists in `actors` with matching flags.
 */
export function resolveBrowserRuntimeActors(metabots, human = null) {
  const actors = buildBrowserRuntimeActors(metabots, human);
  const rawDefaultBot = selectDefaultBrowserActor(metabots);
  let defaultActor = null;
  if (rawDefaultBot) {
    defaultActor = actors.find((actor) => actor.id === rawDefaultBot.id) ?? null;
  }
  if (!defaultActor && rawDefaultBot) {
    // The default Bot was deduped against the human identity: the usable
    // human Actor represents the same identity and takes over the default.
    const humanActor = actors.find((actor) => actor.kind === 'idbots-account') ?? null;
    if (humanActor && isUsableHumanIdentity(human)) {
      defaultActor = humanActor;
    } else {
      // Locked human: fall back to the next surviving Bot.
      defaultActor = actors.find((actor) => actor.kind === 'idbots-agent') ?? null;
    }
  }
  if (!defaultActor && isUsableHumanIdentity(human)) {
    // No Bot default at all: a usable human identity keeps generic signing
    // possible without forcing Bot creation.
    defaultActor = actors.find((actor) => actor.kind === 'idbots-account') ?? null;
  }
  for (const actor of actors) {
    actor.isDefault = defaultActor ? actor.id === defaultActor.id : false;
  }
  return { actors, defaultActor };
}

/**
 * Default Actor policy (see resolveBrowserRuntimeActors): an existing usable
 * Bot default is preserved when it is still selectable; a deduped default
 * falls back to the same-identity human account, then the next Bot; with no
 * usable Bot at all a usable human identity may be the default. A
 * visible-but-locked human is never the default. The returned Actor is the
 * same object that resolveBrowserRuntimeActors marks isDefault.
 */
export function selectDefaultBrowserRuntimeActor(metabots, human = null) {
  return resolveBrowserRuntimeActors(metabots, human).defaultActor;
}
