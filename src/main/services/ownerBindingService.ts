/**
 * MetaBot owner binding: the local human user signs a binding statement over
 * the MetaBot's GlobalMetaID with their MVC identity key (secp256k1, Bitcoin
 * Signed Message format). The signature is published by the MetaBot in an
 * /info/owner pin, so the binding carries both parties' consent:
 * the pin itself is signed by the MetaBot's key on-chain, and the embedded
 * signature proves the human owner's consent.
 *
 * Third-party verification is self-contained:
 *   1. decode payload.owner (GlobalMetaID) -> pubkey hash
 *   2. hash160(payload.ownerPublicKey) must equal that hash
 *   3. payload.signedMessage must match this bot's GlobalMetaID
 *   4. ECDSA-verify payload.signature over magicHash(signedMessage) with
 *      payload.ownerPublicKey
 */

import { mvc } from 'meta-contract';
import { getMvcWallet, parseAddressIndexFromPath } from './metabotWalletService';
import { decodeGlobalMetaIdPayload } from './globalMetaid';

export const OWNER_BINDING_PATH = '/info/owner';
export const OWNER_BINDING_MESSAGE_PREFIX = 'metabot-owner-binding:';
export const OWNER_BINDING_ALGORITHM = 'ecdsa-secp256k1-bitcoin-message';
export const OWNER_BINDING_VERSION = 1;

const ADDRESS_VERSION_P2PKH = 0;
const DEFAULT_PATH = "m/44'/10001'/0'/0/0";

export interface OwnerBindingPayload {
  version: number;
  owner: string;
  ownerPublicKey: string;
  signedMessage: string;
  signature: string;
  algorithm: string;
}

export function buildOwnerBindingMessage(botGlobalMetaId: string): string {
  return `${OWNER_BINDING_MESSAGE_PREFIX}${(botGlobalMetaId ?? '').trim().toLowerCase()}`;
}

export function buildOwnerBindingPayload(input: {
  ownerGlobalMetaId: string;
  ownerPublicKey: string;
  botGlobalMetaId: string;
  signature: string;
}): string {
  const payload: OwnerBindingPayload = {
    version: OWNER_BINDING_VERSION,
    owner: input.ownerGlobalMetaId.trim().toLowerCase(),
    ownerPublicKey: input.ownerPublicKey.trim(),
    signedMessage: buildOwnerBindingMessage(input.botGlobalMetaId),
    signature: input.signature,
    algorithm: OWNER_BINDING_ALGORITHM,
  };
  return JSON.stringify(payload);
}

export function parseOwnerBindingPayload(raw: string | null | undefined): OwnerBindingPayload | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { version, owner, ownerPublicKey, signedMessage, signature, algorithm } = parsed;
    if (typeof version !== 'number') return null;
    if (typeof owner !== 'string' || typeof ownerPublicKey !== 'string') return null;
    if (typeof signedMessage !== 'string' || typeof signature !== 'string') return null;
    if (typeof algorithm !== 'string') return null;
    return { version, owner, ownerPublicKey, signedMessage, signature, algorithm };
  } catch {
    return null;
  }
}

/**
 * Sign an owner-binding statement with the user identity's MVC key.
 * Returns the JSON payload ready to publish at /info/owner.
 */
export async function signOwnerBinding(
  identity: { mnemonic: string; path?: string; globalmetaid?: string | null },
  botGlobalMetaId: string,
): Promise<{ payload: string; signature: string; publicKey: string; signedMessage: string }> {
  const ownerGlobalMetaId = (identity.globalmetaid ?? '').trim();
  if (!ownerGlobalMetaId) {
    throw new Error('User identity has no globalmetaid');
  }
  const botId = (botGlobalMetaId ?? '').trim();
  if (!botId) {
    throw new Error('botGlobalMetaId is required');
  }
  const wallet = await getMvcWallet(identity.mnemonic, parseAddressIndexFromPath(identity.path || DEFAULT_PATH));
  const signedMessage = buildOwnerBindingMessage(botId);
  const signature = wallet.signMessage(signedMessage, 'base64');
  const publicKey = wallet.getPublicKey().toString('hex');
  const payload = buildOwnerBindingPayload({
    ownerGlobalMetaId,
    ownerPublicKey: publicKey,
    botGlobalMetaId: botId,
    signature,
  });
  return { payload, signature, publicKey, signedMessage };
}

/**
 * Verify an /info/owner payload against the GlobalMetaID of the MetaBot that
 * published it. Purely offline: no chain queries needed.
 */
export function verifyOwnerBinding(
  payloadRaw: string | null | undefined,
  expectedBotGlobalMetaId: string,
): boolean {
  const payload = parseOwnerBindingPayload(payloadRaw);
  if (!payload) return false;
  if (payload.version !== OWNER_BINDING_VERSION) return false;
  if (payload.algorithm !== OWNER_BINDING_ALGORITHM) return false;

  const expectedMessage = buildOwnerBindingMessage(expectedBotGlobalMetaId);
  if (!expectedMessage || payload.signedMessage !== expectedMessage) return false;

  try {
    // 1. The declared public key must hash to the owner GlobalMetaID's payload.
    const ownerDecoded = decodeGlobalMetaIdPayload(payload.owner);
    if (!ownerDecoded || ownerDecoded.version !== ADDRESS_VERSION_P2PKH) return false;
    const publicKey = mvc.PublicKey.fromString(payload.ownerPublicKey);
    const pubkeyHash = mvc.crypto.Hash.sha256ripemd160(publicKey.toBuffer() as Buffer);
    const ownerHash = Buffer.from(ownerDecoded.payload);
    if (pubkeyHash.length !== ownerHash.length || !pubkeyHash.equals(ownerHash)) return false;

    // 2. ECDSA-verify the Bitcoin Signed Message signature with that key.
    const signatureBuffer = Buffer.from(payload.signature, 'base64');
    if (signatureBuffer.length !== 65) return false;
    const sig = (mvc.crypto.Signature as unknown as { fromCompact(buf: Buffer): unknown }).fromCompact(signatureBuffer);
    // meta-contract's .d.ts misdeclares Message.magicHash as static and ECDSA
    // as non-constructable; both are instance APIs at runtime (see tests).
    const message = new mvc.Message(payload.signedMessage);
    const hashbuf = (message as unknown as { magicHash(): Buffer }).magicHash();
    const ecdsa = new (mvc.crypto.ECDSA as unknown as {
      new (opts: { hashbuf: Buffer; sig: unknown; pubkey: unknown }): { verify(): unknown; verified?: boolean };
    })({ hashbuf, sig, pubkey: publicKey });
    ecdsa.verify();
    return ecdsa.verified === true;
  } catch {
    return false;
  }
}
