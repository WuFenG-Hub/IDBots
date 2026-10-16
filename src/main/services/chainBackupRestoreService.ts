/**
 * Chain backup restore (MVP): rebuilds the local Bot fleet from the user
 * mnemonic alone.
 *
 * Flow: user mnemonic → backup key (chainBackupCrypto) → /info/bots discovery
 * (owner's public manifest) → per-Bot `/protocols/metabot-backup/manifest`
 * (public pointers) → encrypted object segments → decrypt + verify → recreate
 * the Bot skeleton via restoreMetabotFromMnemonicCore → idempotent row-level
 * import (chainBackupData) with metabot_id remapped to the new local id.
 *
 * Reads go through the public MANAPI indexer; nothing here mutates chain
 * state.
 */

import { listPinsByPath, DEFAULT_MANAPI_BASE_URL } from './manapiPinService';
import { restoreMetabotFromMnemonicCore } from './metabotRestoreService';
import { decryptJson, deriveBackupKey, objectId } from './chainBackupCrypto';
import { importBackupObjects, rebuildChainBackupStateFromManifest, selectLatestBackupObjects, type ChainBackupObject } from './chainBackupData';
import {
  CHAIN_BACKUP_CIPHER,
  CHAIN_BACKUP_KDF,
  CHAIN_BACKUP_MANIFEST_PATH,
  type ChainBackupSegmentRef,
} from './chainBackupService';
import type { SqliteDatabase } from '../sqliteTypes';
import type { MetabotStore } from '../metabotStore';
import type { UserIdentityStore } from '../userIdentityStore';
import type { Metabot } from '../types/metabot';

const USER_BOTS_PATH = '/info/bots';
const DEFAULT_TIMEOUT_MS = 15_000;

export interface ChainBackupRestoreProgress {
  phase: 'discover' | 'manifest' | 'segments' | 'skeleton' | 'import' | 'done' | 'error';
  botName?: string;
  botIndex?: number;
  botCount?: number;
  segmentsDone?: number;
  segmentsTotal?: number;
  message?: string;
}

export interface ChainBackupRestoreBotResult {
  globalMetaId: string;
  name: string;
  restored: boolean;
  imported: number;
  skipped: number;
  error?: string;
  /**
   * Non-fatal per-segment failures: the bot restored from the segments that
   * did decrypt, but at least one manifest segment pin could not be fetched
   * or verified. The restore is partial by design rather than failing the
   * whole bot; the next full backup re-publishes a complete baseline.
   */
  warnings?: string[];
}

export interface ChainBackupRestoreResult {
  success: boolean;
  bots: ChainBackupRestoreBotResult[];
  error?: string;
}

// ---------------------------------------------------------------------------
// indexer fetch helpers
// ---------------------------------------------------------------------------

async function fetchJson(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      throw new Error(`indexer returned an invalid response (HTTP ${response.status})`);
    }
    if (Number(body.code) !== 1) {
      throw new Error(`indexer error ${String(body.code)}: ${typeof body.message === 'string' ? body.message : 'unknown'}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPinContentText(
  pinId: string,
  options?: { baseUrl?: string; timeoutMs?: number },
): Promise<string> {
  const baseUrl = (options?.baseUrl || DEFAULT_MANAPI_BASE_URL).replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/content/${encodeURIComponent(pinId)}`, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`pin content fetch failed: HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Newest pins of one MetaID under one path (manapi /api/metaid/pin/list/{metaid}). */
async function listPinsByMetaid(
  metaid: string,
  path: string,
  options?: { baseUrl?: string },
): Promise<Array<{ pinId: string; timestamp: number }>> {
  const baseUrl = (options?.baseUrl || DEFAULT_MANAPI_BASE_URL).replace(/\/+$/, '');
  const query = new URLSearchParams({ path, size: '10' });
  const body = await fetchJson(`${baseUrl}/api/metaid/pin/list/${encodeURIComponent(metaid)}?${query.toString()}`);
  const data = (body.data && typeof body.data === 'object' ? body.data : {}) as Record<string, unknown>;
  const list = Array.isArray(data.list) ? data.list : [];
  return list.map((raw) => {
    const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
      pinId: typeof record.id === 'string' ? record.id.trim() : '',
      timestamp: Number(record.timestamp) || 0,
    };
  }).filter((item) => item.pinId);
}

interface UserBotsManifestEntry {
  globalMetaId: string;
  name: string;
  type: string;
  mvcAddress: string;
}

/** Decode the bot list out of one /info/bots pin text. */
function parseUserBotsManifest(text: string): UserBotsManifestEntry[] {
  const parsed = JSON.parse(text) as { bots?: unknown };
  const bots = Array.isArray(parsed.bots) ? parsed.bots : [];
  return bots.map((raw) => {
    const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
      globalMetaId: typeof record.globalMetaId === 'string' ? record.globalMetaId.trim() : '',
      name: typeof record.name === 'string' ? record.name : '',
      type: typeof record.type === 'string' ? record.type : 'worker',
      mvcAddress: typeof record.mvcAddress === 'string' ? record.mvcAddress.trim() : '',
    };
  }).filter((entry) => entry.globalMetaId);
}

/**
 * Locate the owner's newest /info/bots pin and decode the bot list.
 *
 * Primary source is the metaid-scoped pin listing: the platform-global path
 * feed carries every user's pins newest-first and each backup run publishes
 * a fresh pin, so a device-loss restore performed after ~1000 newer
 * platform pins would scan past the owner's manifest and find nothing even
 * though the data is on-chain. The scoped listing returns the owner's own
 * pins regardless of global feed depth; the global address scan stays only
 * as a fallback.
 */
async function fetchUserBotsEntries(
  identity: { globalMetaId: string; mvcAddress: string },
  options?: { baseUrl?: string },
): Promise<UserBotsManifestEntry[]> {
  const scopedPins = await listPinsByMetaid(identity.globalMetaId, USER_BOTS_PATH, options);
  for (const pin of scopedPins) {
    try {
      const entries = parseUserBotsManifest(await fetchPinContentText(pin.pinId, options));
      if (entries.length > 0) return entries;
    } catch {
      // fall through to the next (older) pin
    }
  }
  return fetchUserBotsEntriesByAddress(identity.mvcAddress, options);
}

/** Legacy discovery: match the owner's address against the global path feed. */
async function fetchUserBotsEntriesByAddress(
  userMvcAddress: string,
  options?: { baseUrl?: string },
): Promise<UserBotsManifestEntry[]> {
  const address = userMvcAddress.trim();
  if (!address) return [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await listPinsByPath(
      { path: USER_BOTS_PATH, size: 100, cursor },
      options?.baseUrl ? { baseUrl: options.baseUrl } : undefined,
    );
    const mine = result.items.find((item) => item.address.trim().toLowerCase() === address.toLowerCase());
    if (mine) {
      return parseUserBotsManifest(await fetchPinContentText(mine.pinId, options));
    }
    if (!result.hasMore || !result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return [];
}

interface BackupManifest {
  bot: string;
  botName: string;
  updatedAt?: number;
  segments: ChainBackupSegmentRef[];
}

async function fetchLatestBackupManifest(
  botGlobalMetaId: string,
  options?: { baseUrl?: string },
): Promise<{ pinId: string; manifest: BackupManifest } | null> {
  const pins = await listPinsByMetaid(botGlobalMetaId, CHAIN_BACKUP_MANIFEST_PATH, options);
  for (const pin of pins) {
    try {
      const text = await fetchPinContentText(pin.pinId, options);
      const parsed = JSON.parse(text) as BackupManifest;
      if (parsed && Array.isArray(parsed.segments)) {
        return { pinId: pin.pinId, manifest: parsed };
      }
    } catch {
      // fall through to the next (older) manifest candidate
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// restore run
// ---------------------------------------------------------------------------

export interface RunChainBackupRestoreDeps {
  db: SqliteDatabase;
  metabotStore: MetabotStore;
  userStore: UserIdentityStore;
  onProgress?: (progress: ChainBackupRestoreProgress) => void;
  /** Injected into restoreMetabotFromMnemonicCore (skill assignment mirror). */
  applyAssignedSkills?: (metabotId: number, skills: string[]) => void;
  /** Test hook: point at a stub indexer. */
  baseUrl?: string;
}

interface SegmentEnvelope {
  version: number;
  bot: string;
  segment: string;
  cipher: string;
  kdf: string;
  payload: string;
}

export async function runChainBackupRestore(deps: RunChainBackupRestoreDeps): Promise<ChainBackupRestoreResult> {
  const { db, metabotStore, userStore } = deps;
  const emit = (p: ChainBackupRestoreProgress) => deps.onProgress?.(p);
  const fetchOptions = deps.baseUrl ? { baseUrl: deps.baseUrl } : undefined;

  const identity = userStore.get();
  if (!identity?.mnemonic || !identity.globalmetaid?.trim()) {
    return { success: false, bots: [], error: 'USER_IDENTITY_MISSING' };
  }
  const backupKey = deriveBackupKey(identity.mnemonic, identity.globalmetaid.trim());

  emit({ phase: 'discover' });
  let entries: UserBotsManifestEntry[];
  try {
    entries = await fetchUserBotsEntries(
      { globalMetaId: identity.globalmetaid.trim(), mvcAddress: identity.mvc_address },
      fetchOptions,
    );
  } catch (error) {
    return { success: false, bots: [], error: error instanceof Error ? error.message : String(error) };
  }
  if (!entries.length) {
    return { success: false, bots: [], error: 'NO_BOTS_MANIFEST' };
  }

  const result: ChainBackupRestoreResult = { success: true, bots: [] };

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const botResult: ChainBackupRestoreBotResult = {
      globalMetaId: entry.globalMetaId,
      name: entry.name,
      restored: false,
      imported: 0,
      skipped: 0,
    };
    result.bots.push(botResult);
    try {
      emit({ phase: 'manifest', botName: entry.name, botIndex: i, botCount: entries.length });
      const manifestHit = await fetchLatestBackupManifest(entry.globalMetaId, fetchOptions);
      if (!manifestHit) {
        botResult.error = 'NO_BACKUP_MANIFEST';
        continue;
      }
      const { manifest } = manifestHit;

      // Decrypt + verify each segment. The manifest only ever grows, so any
      // historical segment pin (expired, pruned, indexer gap) would otherwise
      // be a single point of failure sinking the whole bot. A failed segment
      // is recorded as a warning instead; the bot restores from whatever
      // decrypted, and the next full backup re-publishes a fresh complete
      // baseline (the journal rebuild below is skipped for partial restores).
      const objects: ChainBackupObject[] = [];
      const warnings: string[] = [];
      for (let s = 0; s < manifest.segments.length; s += 1) {
        const ref = manifest.segments[s];
        try {
          const text = await fetchPinContentText(ref.pinId, fetchOptions);
          const envelope = JSON.parse(text) as SegmentEnvelope;
          if (envelope.cipher !== CHAIN_BACKUP_CIPHER || envelope.kdf !== CHAIN_BACKUP_KDF) {
            throw new Error(`unsupported backup envelope (cipher=${envelope.cipher}, kdf=${envelope.kdf})`);
          }
          const plaintext = decryptJson(backupKey, Buffer.from(envelope.payload, 'base64'));
          if (objectId(plaintext) !== ref.segment) {
            throw new Error(`segment hash mismatch for pin ${ref.pinId}`);
          }
          const segment = plaintext as { objects?: Array<{ id: string; kind: ChainBackupObject['kind']; data: Record<string, unknown> }> };
          for (const obj of segment.objects ?? []) {
            objects.push({ id: obj.id, kind: obj.kind, data: obj.data });
          }
        } catch (error) {
          warnings.push(`segment ${s + 1}/${manifest.segments.length} (${ref.pinId}): ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        emit({
          phase: 'segments', botName: entry.name, botIndex: i, botCount: entries.length,
          segmentsDone: s + 1, segmentsTotal: manifest.segments.length,
        });
      }
      if (warnings.length > 0) {
        botResult.warnings = warnings;
      }
      if (objects.length === 0 && warnings.length > 0) {
        // Every segment failed — there is nothing to import for this bot.
        botResult.error = warnings[warnings.length - 1] ?? 'ALL_SEGMENTS_FAILED';
        result.success = false;
        emit({ phase: 'error', botName: entry.name, botIndex: i, botCount: entries.length, message: botResult.error });
        continue;
      }

      // One final version per row: segments arrive oldest-first and in-place
      // edits re-publish the same row id, so without this the import's
      // first-wins semantics would restore the OLDEST snapshot of every
      // edited row, and rows deleted after their snapshot would resurrect.
      const latestObjects = selectLatestBackupObjects(objects);

      // Skeleton: reuse the local row when the bot already exists here.
      emit({ phase: 'skeleton', botName: entry.name, botIndex: i, botCount: entries.length });
      let metabot: Metabot | null = metabotStore
        .listMetabots()
        .find((m) => (m.globalmetaid ?? '').trim() === entry.globalMetaId) ?? null;

      if (!metabot) {
        const envelopeObj = latestObjects.find((obj) => obj.kind === 'key_envelope');
        const mnemonic = typeof envelopeObj?.data?.mnemonic === 'string' ? envelopeObj.data.mnemonic : '';
        if (!mnemonic) {
          botResult.error = 'KEY_ENVELOPE_MISSING';
          continue;
        }
        const restored = await restoreMetabotFromMnemonicCore(
          metabotStore,
          {
            mnemonic,
            path: typeof envelopeObj.data.path === 'string' ? envelopeObj.data.path : undefined,
          },
          { applyAssignedSkills: deps.applyAssignedSkills },
        );
        if (!restored.success) {
          botResult.error = 'error' in restored ? restored.error : 'RESTORE_FAILED';
          continue;
        }
        metabot = restored.metabot;
        botResult.restored = true;
      }

      emit({ phase: 'import', botName: entry.name, botIndex: i, botCount: entries.length });
      const { imported, skipped } = importBackupObjects(db, metabot.id, latestObjects);
      botResult.imported = imported;
      botResult.skipped = skipped;

      // Rebuild the local backup journal from the on-chain manifest so the
      // next backup on this device diffs against what is already on-chain
      // instead of re-uploading the restored objects as duplicates — but
      // only for a fully verified segment set: a partial restore must not
      // tell the next backup the missing objects are already on-chain, so
      // the next run re-publishes a complete fresh baseline instead.
      if (warnings.length === 0) {
        rebuildChainBackupStateFromManifest(db, {
          botGlobalMetaId: entry.globalMetaId,
          manifestPinId: manifestHit.pinId,
          segments: manifest.segments,
          manifestUpdatedAt: manifest.updatedAt ?? Math.floor(Date.now() / 1000),
        });
      }
    } catch (error) {
      botResult.error = error instanceof Error ? error.message : String(error);
      result.success = false;
      emit({ phase: 'error', botName: entry.name, botIndex: i, botCount: entries.length, message: botResult.error });
    }
  }

  emit({ phase: 'done', botCount: entries.length });
  return result;
}
