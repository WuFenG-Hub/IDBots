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
import { importBackupObjects, type ChainBackupObject } from './chainBackupData';
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

/** Locate the owner's newest /info/bots pin and decode the bot list. */
async function fetchUserBotsEntries(
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
      const text = await fetchPinContentText(mine.pinId, options);
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
    if (!result.hasMore || !result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return [];
}

interface BackupManifest {
  bot: string;
  botName: string;
  segments: ChainBackupSegmentRef[];
}

async function fetchLatestBackupManifest(
  botGlobalMetaId: string,
  options?: { baseUrl?: string },
): Promise<BackupManifest | null> {
  const pins = await listPinsByMetaid(botGlobalMetaId, CHAIN_BACKUP_MANIFEST_PATH, options);
  for (const pin of pins) {
    try {
      const text = await fetchPinContentText(pin.pinId, options);
      const parsed = JSON.parse(text) as BackupManifest;
      if (parsed && Array.isArray(parsed.segments)) {
        return parsed;
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
    entries = await fetchUserBotsEntries(identity.mvc_address, fetchOptions);
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
      const manifest = await fetchLatestBackupManifest(entry.globalMetaId, fetchOptions);
      if (!manifest) {
        botResult.error = 'NO_BACKUP_MANIFEST';
        continue;
      }

      // Decrypt + verify every segment.
      const objects: ChainBackupObject[] = [];
      for (let s = 0; s < manifest.segments.length; s += 1) {
        const ref = manifest.segments[s];
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
        emit({
          phase: 'segments', botName: entry.name, botIndex: i, botCount: entries.length,
          segmentsDone: s + 1, segmentsTotal: manifest.segments.length,
        });
      }

      // Skeleton: reuse the local row when the bot already exists here.
      emit({ phase: 'skeleton', botName: entry.name, botIndex: i, botCount: entries.length });
      let metabot: Metabot | null = metabotStore
        .listMetabots()
        .find((m) => (m.globalmetaid ?? '').trim() === entry.globalMetaId) ?? null;

      if (!metabot) {
        const envelopeObj = objects.find((obj) => obj.kind === 'key_envelope');
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
      const { imported, skipped } = importBackupObjects(db, metabot.id, objects);
      botResult.imported = imported;
      botResult.skipped = skipped;
    } catch (error) {
      botResult.error = error instanceof Error ? error.message : String(error);
      result.success = false;
      emit({ phase: 'error', botName: entry.name, botIndex: i, botCount: entries.length, message: botResult.error });
    }
  }

  emit({ phase: 'done', botCount: entries.length });
  return result;
}
