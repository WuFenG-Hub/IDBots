/**
 * One-click "sync bots to mobile": publish the user's bot manifest as an
 * /info/bots pin so any device that imports the user mnemonic can restore the
 * bot list (design doc: IDBots-App/docs/DESIGN-one-click-binding.md).
 *
 * Trust model: the manifest is a DISCOVERY index only — it is a one-sided
 * statement by the owner and carries no authority by itself. Authorization
 * stays with each bot's /info/owner pin (owner-signed binding the mobile client
 * verifies offline). Bots without an owner-binding pin get one published during
 * this sync: the local user signs the binding statement, the bot's own wallet
 * publishes the /info/owner pin.
 *
 * The manifest contains only data that is already public on-chain
 * (addresses / GlobalMetaIDs / chat pubkeys).
 */

import type { UserIdentityStore } from '../userIdentityStore';
import type { MetabotStore } from '../metabotStore';
import {
  createPinForIdentity,
  syncMetaBotEditChangesToChain,
  type MvcCreatePinSessionSnapshot,
} from './metaidCore';
import { signOwnerBinding } from './ownerBindingService';
import { getRate as getGlobalFeeRate } from './feeRateStore';

export const USER_BOTS_PIN_PATH = '/info/bots';
export const USER_BOTS_PIN_VERSION = 1;

const PIN_STEP_INTERVAL_MS = 3000;

export interface UserBotsPinBotEntry {
  globalMetaId: string;
  name: string;
  type: 'twin' | 'worker';
  role: string;
  mvcAddress: string;
  chatPublicKey: string;
  ownerBindingPinId: string | null;
}

export interface UserBotsPinPayload {
  version: number;
  updatedAt: number;
  bots: UserBotsPinBotEntry[];
}

export interface SyncUserBotsToMobileResult {
  success: boolean;
  botCount: number;
  /** Bots that have an owner-binding pin after this sync. */
  boundCount: number;
  /** Bots that received a fresh /info/owner pin during this sync. */
  newlyBound: number;
  /** Bot names that could not be bound (mobile will show them as unverified). */
  skippedUnbound: string[];
  pinId?: string;
  txids: string[];
  error?: string;
}

export interface SyncUserBotsToMobileDeps {
  createPin?: typeof createPinForIdentity;
  signOwner?: typeof signOwnerBinding;
  syncBotOwnerPin?: typeof syncMetaBotEditChangesToChain;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function base64Of(json: string): string {
  return Buffer.from(json, 'utf8').toString('base64');
}

/** Build the manifest payload from the current bot list (public data only). */
export function buildUserBotsPinPayload(
  bots: Array<{
    name: string;
    metabot_type: string;
    role: string;
    mvc_address: string;
    globalmetaid: string | null;
    chat_public_key: string;
    owner_binding_pinid: string | null;
  }>,
  now: () => number = Date.now,
): string {
  const entries: UserBotsPinBotEntry[] = [];
  for (const bot of bots) {
    const globalMetaId = (bot.globalmetaid ?? '').trim();
    if (!globalMetaId) continue;
    entries.push({
      globalMetaId,
      name: bot.name ?? '',
      type: bot.metabot_type === 'twin' ? 'twin' : 'worker',
      role: bot.role ?? '',
      mvcAddress: bot.mvc_address ?? '',
      chatPublicKey: bot.chat_public_key ?? '',
      ownerBindingPinId: (bot.owner_binding_pinid ?? '').trim() || null,
    });
  }
  const payload: UserBotsPinPayload = {
    version: USER_BOTS_PIN_VERSION,
    updatedAt: Math.floor(now() / 1000),
    bots: entries,
  };
  return JSON.stringify(payload);
}

/**
 * Publish (or refresh) the /info/bots manifest for the current identity.
 * Bots missing an owner-binding pin are bound first (user signs, bot wallet
 * publishes); bots whose binding fails are still listed but flagged by the
 * mobile client as unverified.
 */
export async function syncUserBotsToMobile(
  userStore: UserIdentityStore,
  metabotStore: MetabotStore,
  deps: SyncUserBotsToMobileDeps = {},
): Promise<SyncUserBotsToMobileResult> {
  const createPin = deps.createPin ?? createPinForIdentity;
  const signOwner = deps.signOwner ?? signOwnerBinding;
  const syncBotOwnerPin = deps.syncBotOwnerPin ?? syncMetaBotEditChangesToChain;
  const sleep = deps.sleep ?? defaultSleep;

  const identity = userStore.get();
  if (!identity) {
    return { success: false, botCount: 0, boundCount: 0, newlyBound: 0, skippedUnbound: [], txids: [], error: 'USER_IDENTITY_MISSING' };
  }
  const ownerGlobalMetaId = (identity.globalmetaid ?? '').trim();
  if (!ownerGlobalMetaId) {
    return { success: false, botCount: 0, boundCount: 0, newlyBound: 0, skippedUnbound: [], txids: [], error: 'USER_IDENTITY_GLOBALMETAID_MISSING' };
  }
  // Publishing pins needs gas — same guard as updateUserIdentityName.
  if (
    identity.subsidy_state === 'failed' ||
    (!identity.subsidy_state && !identity.chat_public_key_pin_id)
  ) {
    return { success: false, botCount: 0, boundCount: 0, newlyBound: 0, skippedUnbound: [], txids: [], error: 'SUBSIDY_NOT_CLAIMED' };
  }

  const bots = metabotStore
    .listMetabots()
    .filter((bot) => bot.enabled && bot.metabot_type !== 'welcome' && (bot.globalmetaid ?? '').trim());

  const txids: string[] = [];
  const skippedUnbound: string[] = [];
  let newlyBound = 0;
  let firstError = '';

  // 1. Complete missing owner bindings (bot wallet publishes /info/owner).
  for (const bot of bots) {
    if ((bot.owner_binding_pinid ?? '').trim()) continue;
    try {
      const signed = await signOwner(identity, (bot.globalmetaid ?? '').trim());
      const result = await syncBotOwnerPin(metabotStore, {
        metabotId: bot.id,
        syncOwner: true,
        ownerBindingPayload: signed.payload,
      });
      if (result.success) {
        newlyBound += 1;
        if (Array.isArray(result.txids)) txids.push(...result.txids);
        await sleep(PIN_STEP_INTERVAL_MS);
      } else {
        skippedUnbound.push(bot.name);
        firstError = firstError || `bind ${bot.name}: ${result.error ?? 'failed'}`;
      }
    } catch (error) {
      skippedUnbound.push(bot.name);
      firstError = firstError || `bind ${bot.name}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // 2. Re-read pin ids (syncBotOwnerPin persisted them) and build the manifest.
  const freshBots = metabotStore
    .listMetabots()
    .filter((bot) => bot.enabled && bot.metabot_type !== 'welcome' && (bot.globalmetaid ?? '').trim());
  const payloadJson = buildUserBotsPinPayload(freshBots);
  const boundCount = freshBots.filter((bot) => (bot.owner_binding_pinid ?? '').trim()).length;

  // 3. Publish the manifest as the user's /info/bots pin (base64 JSON payload).
  let pinId: string | undefined;
  try {
    const sessionSnapshot: MvcCreatePinSessionSnapshot = {
      excludeOutpoints: [],
      preferredFundingUtxos: [],
    };
    const result = await createPin({
      mnemonic: identity.mnemonic,
      path: identity.path,
      metaidData: {
        operation: 'create',
        path: USER_BOTS_PIN_PATH,
        contentType: 'application/json',
        payload: base64Of(payloadJson),
        encoding: 'base64',
      },
      options: { feeRate: getGlobalFeeRate('mvc') },
      sessionSnapshot,
    });
    const txid = result.txids[0];
    if (!txid) {
      return {
        success: false,
        botCount: freshBots.length,
        boundCount,
        newlyBound,
        skippedUnbound,
        txids,
        error: 'bots manifest pin failed: no txid',
      };
    }
    txids.push(txid);
    pinId = result.pinId ?? `${txid}i0`;
  } catch (error) {
    return {
      success: false,
      botCount: freshBots.length,
      boundCount,
      newlyBound,
      skippedUnbound,
      txids,
      error: `bots manifest: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return {
    success: true,
    botCount: freshBots.length,
    boundCount,
    newlyBound,
    skippedUnbound,
    pinId,
    txids,
    error: skippedUnbound.length > 0 ? firstError : undefined,
  };
}
