/**
 * User Identity Service: create/import/logout the local human user identity
 * and publish its MetaID info pins (/info/name, /info/avatar, /info/chatpubkey).
 *
 * Unlike MetaBot creation, chain publish is best-effort: the local identity
 * is kept even when pins fail, so the user can retry syncing later. Only one
 * user identity may exist at a time (enforced by UserIdentityStore).
 */

import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import type { UserIdentityStore } from '../userIdentityStore';
import type { UserIdentity } from '../types/userIdentity';
import { createMetaBotWallet } from './metabotWalletService';
import { requestMvcGasSubsidy } from './mvcSubsidyService';
import { fetchMetaidRestoreProfile } from './metabotRestoreService';
import {
  createPinForIdentity,
  parseDataUrlAvatar,
  type MvcCreatePinSessionSnapshot,
} from './metaidCore';
import { getRate as getGlobalFeeRate } from './feeRateStore';

export type UserInfoSyncStep = 'name' | 'avatar' | 'chatpubkey';

export interface UserInfoSyncStepPlan {
  key: UserInfoSyncStep;
  path: string;
  contentType: string;
  payload: string | Buffer;
  encoding?: 'base64';
}

export interface UserChainSyncResult {
  success: boolean;
  txids: string[];
  chatPublicKeyPinId?: string;
  failedSteps: UserInfoSyncStep[];
  error?: string;
}

export interface UserIdentityResult {
  success: boolean;
  error?: string;
  identity?: UserIdentity;
  /** Present only right after createUserIdentity so the UI can show the backup step. */
  mnemonic?: string;
  chainSync?: UserChainSyncResult;
  /** 'chain' when the profile came from on-chain data (import), 'local' otherwise. */
  profileSource?: 'chain' | 'local';
}

export interface UserIdentityServiceDeps {
  createPin?: typeof createPinForIdentity;
  requestSubsidy?: typeof requestMvcGasSubsidy;
  fetchProfile?: typeof fetchMetaidRestoreProfile;
  sleep?: (ms: number) => Promise<void>;
}

const USER_PIN_STEP_INTERVAL_MS = 3000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the pin plan for the current identity. Profile steps (name/avatar) are
 * included only when includeProfileSteps is true (fresh create, or import of an
 * account without on-chain profile); chatpubkey is included only while no
 * chat_public_key_pin_id is recorded (protocol: chatpubkey is immutable).
 */
export function buildUserInfoSyncSteps(
  identity: Pick<UserIdentity, 'name' | 'avatar' | 'chat_public_key' | 'chat_public_key_pin_id'>,
  options: { includeProfileSteps: boolean },
): UserInfoSyncStepPlan[] {
  const steps: UserInfoSyncStepPlan[] = [];

  if (options.includeProfileSteps) {
    steps.push({
      key: 'name',
      path: '/info/name',
      contentType: 'text/plain',
      payload: identity.name,
    });
    const avatarData = parseDataUrlAvatar(identity.avatar);
    if (avatarData) {
      steps.push({
        key: 'avatar',
        path: '/info/avatar',
        contentType: `${avatarData.mime};binary`,
        payload: avatarData.buffer,
        encoding: 'base64',
      });
    }
  }

  const chatPubKey = typeof identity.chat_public_key === 'string' ? identity.chat_public_key.trim() : '';
  if (!identity.chat_public_key_pin_id && chatPubKey) {
    steps.push({
      key: 'chatpubkey',
      path: '/info/chatpubkey',
      contentType: 'text/plain',
      payload: chatPubKey,
    });
  }

  return steps;
}

/**
 * Publish pending pins for the current identity. Best-effort per step with a
 * 3s gap (indexer delay) and threaded outpoint exclusions to avoid UTXO
 * double-spend across sequential pins of the same wallet.
 */
export async function syncUserIdentityToChain(
  userStore: UserIdentityStore,
  options: { includeProfileSteps: boolean },
  deps: UserIdentityServiceDeps = {},
): Promise<UserChainSyncResult> {
  const createPin = deps.createPin ?? createPinForIdentity;
  const sleep = deps.sleep ?? defaultSleep;

  const identity = userStore.get();
  if (!identity) {
    return { success: false, txids: [], failedSteps: [], error: 'USER_IDENTITY_MISSING' };
  }

  const steps = buildUserInfoSyncSteps(identity, options);
  const txids: string[] = [];
  const failedSteps: UserInfoSyncStep[] = [];
  let lastError = '';
  const sessionSnapshot: MvcCreatePinSessionSnapshot = {
    excludeOutpoints: [],
    preferredFundingUtxos: [],
  };

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    try {
      const result = await createPin({
        mnemonic: identity.mnemonic,
        path: identity.path,
        metaidData: {
          operation: 'create',
          path: step.path,
          contentType: step.contentType,
          payload: step.payload,
          encoding: step.encoding,
        },
        options: { feeRate: getGlobalFeeRate('mvc') },
        sessionSnapshot,
      });
      const txid = result.txids[0];
      if (!txid) {
        failedSteps.push(step.key);
        lastError = `${step.key} pin failed: no txid`;
      } else {
        txids.push(txid);
        if (step.key === 'chatpubkey') {
          const pinId = result.pinId ?? `${txid}i0`;
          userStore.update({ chat_public_key_pin_id: pinId });
        }
        if (Array.isArray(result.spentOutpoints) && result.spentOutpoints.length > 0) {
          sessionSnapshot.excludeOutpoints.push(...result.spentOutpoints);
        }
        sessionSnapshot.preferredFundingUtxos = result.changeUtxo ? [result.changeUtxo] : [];
      }
    } catch (error) {
      failedSteps.push(step.key);
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (index < steps.length - 1) {
      await sleep(USER_PIN_STEP_INTERVAL_MS);
    }
  }

  return {
    success: failedSteps.length === 0,
    txids,
    chatPublicKeyPinId: userStore.get()?.chat_public_key_pin_id ?? undefined,
    failedSteps,
    error: failedSteps.length > 0 ? lastError : undefined,
  };
}

/** Create a brand-new user identity with a fresh mnemonic. */
export async function createUserIdentity(
  userStore: UserIdentityStore,
  input: { name: string; avatar?: string | null },
  deps: UserIdentityServiceDeps = {},
): Promise<UserIdentityResult> {
  if (userStore.get()) {
    return { success: false, error: 'USER_IDENTITY_EXISTS' };
  }
  const name = (input.name ?? '').trim();
  if (!name) {
    return { success: false, error: 'NAME_EMPTY' };
  }
  const avatar = (input.avatar ?? '').trim() || null;
  if (avatar && !parseDataUrlAvatar(avatar)) {
    return { success: false, error: 'INVALID_AVATAR' };
  }

  const requestSubsidy = deps.requestSubsidy ?? requestMvcGasSubsidy;
  const wallet = await createMetaBotWallet({});
  try {
    await requestSubsidy({ mvcAddress: wallet.mvc_address, mnemonic: wallet.mnemonic, path: wallet.path });
  } catch {
    // Best-effort gas subsidy; pin steps surface their own errors.
  }

  const identity = userStore.insert({
    mnemonic: wallet.mnemonic,
    path: wallet.path,
    mvc_address: wallet.mvc_address,
    btc_address: wallet.btc_address,
    doge_address: wallet.doge_address,
    public_key: wallet.public_key,
    chat_public_key: wallet.chat_public_key,
    chat_public_key_pin_id: null,
    metaid: wallet.metaid,
    globalmetaid: wallet.globalmetaid,
    name,
    avatar,
  });

  const chainSync = await syncUserIdentityToChain(userStore, { includeProfileSteps: true }, deps);
  return {
    success: true,
    identity,
    mnemonic: wallet.mnemonic,
    chainSync,
    profileSource: 'local',
  };
}

/**
 * Import a user identity from an existing mnemonic (12 or 24 words, matching
 * Metalet's import algorithm: plain BIP39 validation + identical derivation).
 * When the account already has an on-chain profile, its name/avatar win and
 * are not re-published; the derived chat key must match the on-chain
 * /info/chatpubkey (mismatch means a wrong derivation path). Without an
 * on-chain profile the identity imports with an empty name — the user sets it
 * later from the profile panel (which publishes /info/name).
 */
export async function importUserIdentity(
  userStore: UserIdentityStore,
  input: { mnemonic: string; path?: string },
  deps: UserIdentityServiceDeps = {},
): Promise<UserIdentityResult> {
  if (userStore.get()) {
    return { success: false, error: 'USER_IDENTITY_EXISTS' };
  }
  const mnemonic = (input.mnemonic ?? '').trim().toLowerCase().split(/\s+/).join(' ');
  const words = mnemonic ? mnemonic.split(' ') : [];
  if ((words.length !== 12 && words.length !== 24) || !bip39.validateMnemonic(mnemonic, wordlist)) {
    return { success: false, error: 'INVALID_MNEMONIC' };
  }
  const path = (input.path ?? '').trim() || "m/44'/10001'/0'/0/0";

  const fetchProfile = deps.fetchProfile ?? fetchMetaidRestoreProfile;
  const wallet = await createMetaBotWallet({ mnemonic, path });

  let profile: Awaited<ReturnType<typeof fetchMetaidRestoreProfile>> | null = null;
  try {
    profile = await fetchProfile(wallet.mvc_address);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== 'CHAIN_INFO_EMPTY' && message !== 'NAME_EMPTY') {
      return { success: false, error: message };
    }
  }

  let name: string;
  let avatar: string | null;
  let chatPublicKeyPinId: string | null = null;
  let profileSource: 'chain' | 'local';
  if (profile) {
    const onChainChatPubKey = (profile.raw.chatpubkey ?? profile.raw.chatPublicKey ?? '').trim();
    if (onChainChatPubKey && onChainChatPubKey !== wallet.chat_public_key) {
      return { success: false, error: 'CHAT_PUBKEY_MISMATCH' };
    }
    name = profile.name;
    avatar = profile.avatarDataUrl ?? null;
    chatPublicKeyPinId = profile.chatpubkeyPinId ?? null;
    profileSource = 'chain';
  } else {
    // No on-chain profile: import with an empty name; the user sets (and
    // publishes) it later from the profile panel.
    name = '';
    avatar = null;
    profileSource = 'local';
  }

  const requestSubsidy = deps.requestSubsidy ?? requestMvcGasSubsidy;
  try {
    await requestSubsidy({ mvcAddress: wallet.mvc_address, mnemonic, path });
  } catch {
    // Best-effort gas subsidy; pin steps surface their own errors.
  }

  const identity = userStore.insert({
    mnemonic,
    path,
    mvc_address: wallet.mvc_address,
    btc_address: wallet.btc_address,
    doge_address: wallet.doge_address,
    public_key: wallet.public_key,
    chat_public_key: wallet.chat_public_key,
    chat_public_key_pin_id: chatPublicKeyPinId,
    metaid: wallet.metaid,
    globalmetaid: wallet.globalmetaid,
    name,
    avatar,
  });

  const chainSync = await syncUserIdentityToChain(
    userStore,
    { includeProfileSteps: false },
    deps,
  );
  return { success: true, identity, chainSync, profileSource };
}

/** Log out: delete the local identity (on-chain pins stay as-is). */
export function logoutUserIdentity(userStore: UserIdentityStore): boolean {
  return userStore.remove();
}

/**
 * Set/rename the user's name and publish it as /info/name (Bot Info
 * semantics: latest pin wins). The pin is published FIRST; the local record
 * is updated only on success, so local state never claims an unpublished
 * name.
 */
export async function updateUserIdentityName(
  userStore: UserIdentityStore,
  input: { name: string },
  deps: UserIdentityServiceDeps = {},
): Promise<UserIdentityResult> {
  const identity = userStore.get();
  if (!identity) {
    return { success: false, error: 'USER_IDENTITY_MISSING' };
  }
  const name = (input.name ?? '').trim();
  if (!name) {
    return { success: false, error: 'NAME_EMPTY' };
  }
  if (name === identity.name) {
    return { success: true, identity, profileSource: 'local' };
  }

  const createPin = deps.createPin ?? createPinForIdentity;
  let result: Awaited<ReturnType<typeof createPinForIdentity>>;
  try {
    result = await createPin({
      mnemonic: identity.mnemonic,
      path: identity.path,
      metaidData: {
        operation: 'create',
        path: '/info/name',
        contentType: 'text/plain',
        payload: name,
      },
      options: { feeRate: getGlobalFeeRate('mvc') },
    });
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!result.txids[0]) {
    return { success: false, error: 'name pin failed: no txid' };
  }

  const updated = userStore.update({ name });
  return {
    success: true,
    identity: updated ?? undefined,
    chainSync: { success: true, txids: result.txids, failedSteps: [] },
    profileSource: 'local',
  };
}
