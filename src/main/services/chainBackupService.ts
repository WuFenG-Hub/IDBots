/**
 * Chain backup service (MVP): publishes each enabled Bot's "soul" data to the
 * chain, encrypted to the owner's backup key (see chainBackupCrypto.ts).
 *
 * Design: docs/design/2026-10-10-chain-backup-restore-design.md
 *
 * - Object pins at `/protocols/metabot-backup/object` carry encrypted segments
 *   (many small objects packed into one JSON container per pin).
 * - A public manifest at `/protocols/metabot-backup/manifest` (one per Bot,
 *   refreshed via `modify`) lists segment pinIds + content hashes only.
 * - Pins are published by each Bot's own wallet via createPin(), so the global
 *   traffic/selfpay fee setting applies and the write ledger is recorded.
 * - Incremental: objects are content-addressed (sha256 of canonical JSON);
 *   objects already listed in `chain_backup_state` are never re-uploaded.
 *
 * The whitelist lives in chainBackupData.ts and never includes user_identity
 * or raw metabot_wallets rows — the Bot mnemonic travels only inside the
 * encrypted `key_envelope` object.
 */

import { createPin } from './metaidCore';
import { buildModifyMetaidPayload } from './metaidPinMutationService';
import { getRate as getGlobalFeeRate } from './feeRateStore';
import { canonicalJson, deriveBackupKey, encryptJson, objectId } from './chainBackupCrypto';
import {
  extractBackupObjects,
  readChainBackupState,
  writeChainBackupState,
  type ChainBackupObject,
  type ChainBackupSegmentRef,
} from './chainBackupData';

export { listChainBackupStates, type ChainBackupStateRow } from './chainBackupData';
export type { ChainBackupSegmentRef } from './chainBackupData';
import type { SqliteDatabase } from '../sqliteTypes';
import type { MetabotStore } from '../metabotStore';
import type { UserIdentityStore } from '../userIdentityStore';
import type { Metabot } from '../types/metabot';

export const CHAIN_BACKUP_OBJECT_PATH = '/protocols/metabot-backup/object';
export const CHAIN_BACKUP_MANIFEST_PATH = '/protocols/metabot-backup/manifest';
export const CHAIN_BACKUP_VERSION = 1;
export const CHAIN_BACKUP_CIPHER = 'aes-256-gcm';
export const CHAIN_BACKUP_KDF = 'hkdf-sha256:user-globalmetaid';

/** Plaintext budget per segment pin; keeps single pins well under the 5 MiB /file ceiling. */
export const CHAIN_BACKUP_SEGMENT_PLAINTEXT_LIMIT = 256 * 1024;

export interface ChainBackupProgress {
  phase: 'extract' | 'publish' | 'manifest' | 'done' | 'error';
  botName?: string;
  botIndex?: number;
  botCount?: number;
  segmentsDone?: number;
  segmentsTotal?: number;
  message?: string;
}

export interface ChainBackupBotResult {
  globalMetaId: string;
  name: string;
  uploadedObjects: number;
  skippedObjects: number;
  segments: number;
  bytes: number;
  costSats: number;
  manifestPinId?: string;
  error?: string;
}

export interface ChainBackupResult {
  success: boolean;
  bots: ChainBackupBotResult[];
  totalBytes: number;
  totalCostSats: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// segment packing + envelope
// ---------------------------------------------------------------------------

function packSegments(botGlobalMetaId: string, objects: ChainBackupObject[]): Array<{
  plaintext: Record<string, unknown>;
  objects: ChainBackupObject[];
}> {
  const segments: Array<{ plaintext: Record<string, unknown>; objects: ChainBackupObject[] }> = [];
  let current: ChainBackupObject[] = [];
  let currentSize = 64; // envelope framing allowance
  for (const obj of objects) {
    const size = canonicalJson(obj).length;
    if (current.length > 0 && currentSize + size > CHAIN_BACKUP_SEGMENT_PLAINTEXT_LIMIT) {
      segments.push(buildSegment(botGlobalMetaId, current));
      current = [];
      currentSize = 64;
    }
    current.push(obj);
    currentSize += size;
  }
  if (current.length > 0) {
    segments.push(buildSegment(botGlobalMetaId, current));
  }
  return segments;
}

function buildSegment(botGlobalMetaId: string, objects: ChainBackupObject[]): {
  plaintext: Record<string, unknown>;
  objects: ChainBackupObject[];
} {
  return {
    plaintext: {
      version: CHAIN_BACKUP_VERSION,
      bot: botGlobalMetaId,
      createdAt: Math.floor(Date.now() / 1000),
      objects: objects.map((o) => ({ id: o.id, kind: o.kind, data: o.data })),
    },
    objects,
  };
}

/** On-chain object-pin content (public envelope around the encrypted segment). */
export function buildObjectPinContent(
  backupKey: Buffer,
  botGlobalMetaId: string,
  segmentPlaintext: Record<string, unknown>,
): string {
  const encrypted = encryptJson(backupKey, segmentPlaintext);
  return canonicalJson({
    version: CHAIN_BACKUP_VERSION,
    bot: botGlobalMetaId,
    segment: objectId(segmentPlaintext),
    cipher: CHAIN_BACKUP_CIPHER,
    kdf: CHAIN_BACKUP_KDF,
    payload: encrypted.toString('base64'),
  });
}

/** Public manifest content (hashes/pointers only, no secrets). */
export function buildManifestContent(input: {
  botGlobalMetaId: string;
  botName: string;
  segments: ChainBackupSegmentRef[];
}): string {
  const totalObjects = input.segments.reduce((sum, s) => sum + s.objectIds.length, 0);
  const totalBytes = input.segments.reduce((sum, s) => sum + s.bytes, 0);
  return canonicalJson({
    version: CHAIN_BACKUP_VERSION,
    bot: input.botGlobalMetaId,
    botName: input.botName,
    keyCustody: 'envelope',
    updatedAt: Math.floor(Date.now() / 1000),
    segments: input.segments,
    stats: { objects: totalObjects, bytes: totalBytes },
  });
}

// ---------------------------------------------------------------------------
// backup run
// ---------------------------------------------------------------------------

export interface RunChainBackupDeps {
  db: SqliteDatabase;
  metabotStore: MetabotStore;
  userStore: UserIdentityStore;
  onProgress?: (progress: ChainBackupProgress) => void;
  /** Test hook. */
  createPinImpl?: typeof createPin;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runChainBackup(deps: RunChainBackupDeps): Promise<ChainBackupResult> {
  const { db, metabotStore, userStore } = deps;
  const createPinFn = deps.createPinImpl ?? createPin;
  const sleep = deps.sleep ?? defaultSleep;
  const emit = (p: ChainBackupProgress) => deps.onProgress?.(p);

  const identity = userStore.get();
  if (!identity?.mnemonic || !identity.globalmetaid?.trim()) {
    return { success: false, bots: [], totalBytes: 0, totalCostSats: 0, error: 'USER_IDENTITY_MISSING' };
  }
  const backupKey = deriveBackupKey(identity.mnemonic, identity.globalmetaid.trim());

  const bots = metabotStore
    .listMetabots()
    .filter((bot) => bot.enabled && bot.metabot_type !== 'welcome' && (bot.globalmetaid ?? '').trim());

  const result: ChainBackupResult = { success: true, bots: [], totalBytes: 0, totalCostSats: 0 };
  const feeRate = getGlobalFeeRate('mvc');

  for (let i = 0; i < bots.length; i += 1) {
    const bot: Metabot = bots[i];
    const botGid = (bot.globalmetaid ?? '').trim();
    const botResult: ChainBackupBotResult = {
      globalMetaId: botGid,
      name: bot.name,
      uploadedObjects: 0,
      skippedObjects: 0,
      segments: 0,
      bytes: 0,
      costSats: 0,
    };
    result.bots.push(botResult);
    try {
      emit({ phase: 'extract', botName: bot.name, botIndex: i, botCount: bots.length });

      const wallet = metabotStore.getMetabotWalletByMetabotId(bot.id);
      const objects = extractBackupObjects(db, bot.id, wallet);
      const state = readChainBackupState(db, botGid);
      const alreadyUploaded = new Set<string>(
        JSON.parse(state?.uploaded_object_ids_json || '[]') as string[],
      );
      const previousSegments = state
        ? (JSON.parse(state.segments_json || '[]') as ChainBackupSegmentRef[])
        : [];

      const newObjects = objects.filter((o) => !alreadyUploaded.has(o.id));
      botResult.skippedObjects = objects.length - newObjects.length;

      const newSegmentRefs: ChainBackupSegmentRef[] = [];
      const segments = packSegments(botGid, newObjects);
      emit({
        phase: 'publish', botName: bot.name, botIndex: i, botCount: bots.length,
        segmentsDone: 0, segmentsTotal: segments.length,
      });

      for (let s = 0; s < segments.length; s += 1) {
        const segment = segments[s];
        const content = buildObjectPinContent(backupKey, botGid, segment.plaintext);
        const pin = await createPinFn(metabotStore, bot.id, {
          operation: 'create',
          path: CHAIN_BACKUP_OBJECT_PATH,
          encryption: '0',
          version: '1.0.0',
          contentType: 'application/json',
          payload: content,
        }, { feeRate, origin: 'internal:chain-backup' });
        newSegmentRefs.push({
          pinId: pin.pinId,
          segment: objectId(segment.plaintext),
          bytes: content.length,
          kinds: [...new Set(segment.objects.map((o) => o.kind))],
          objectIds: segment.objects.map((o) => o.id),
        });
        botResult.bytes += content.length;
        botResult.costSats += pin.totalCost || 0;
        emit({
          phase: 'publish', botName: bot.name, botIndex: i, botCount: bots.length,
          segmentsDone: s + 1, segmentsTotal: segments.length,
        });
        if (s + 1 < segments.length) await sleep(500);
      }

      emit({ phase: 'manifest', botName: bot.name, botIndex: i, botCount: bots.length });
      const allSegments = [...previousSegments, ...newSegmentRefs];
      const manifestContent = buildManifestContent({
        botGlobalMetaId: botGid,
        botName: bot.name,
        segments: allSegments,
      });

      let manifestPinId: string;
      if (state?.manifest_pinid) {
        const modify = await createPinFn(
          metabotStore,
          bot.id,
          buildModifyMetaidPayload({ targetPinId: state.manifest_pinid, payload: manifestContent }),
          { feeRate, origin: 'internal:chain-backup' },
        );
        manifestPinId = state.manifest_pinid;
        botResult.costSats += modify.totalCost || 0;
      } else {
        const created = await createPinFn(metabotStore, bot.id, {
          operation: 'create',
          path: CHAIN_BACKUP_MANIFEST_PATH,
          encryption: '0',
          version: '1.0.0',
          contentType: 'application/json',
          payload: manifestContent,
        }, { feeRate, origin: 'internal:chain-backup' });
        manifestPinId = created.pinId;
        botResult.costSats += created.totalCost || 0;
      }

      const uploadedIds = [...alreadyUploaded, ...newObjects.map((o) => o.id)];
      writeChainBackupState(db, {
        botGlobalMetaId: botGid,
        manifestPinId,
        segments: allSegments,
        uploadedObjectIds: uploadedIds,
        lastBackupAt: Date.now(),
      });

      botResult.uploadedObjects = newObjects.length;
      botResult.segments = newSegmentRefs.length;
      botResult.manifestPinId = manifestPinId;
      result.totalBytes += botResult.bytes;
      result.totalCostSats += botResult.costSats;
    } catch (error) {
      botResult.error = error instanceof Error ? error.message : String(error);
      result.success = false;
      emit({ phase: 'error', botName: bot.name, botIndex: i, botCount: bots.length, message: botResult.error });
    }
  }

  emit({ phase: 'done', botCount: bots.length });
  return result;
}
