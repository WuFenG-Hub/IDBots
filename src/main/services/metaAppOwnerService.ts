import { createPin } from './metaidCore';
import type { MetabotStore } from '../metabotStore';
import {
  buildMetaAppProtocolPayload,
  buildMetaAppCreateWrite,
  buildMetaAppModifyWrite,
  buildMetaAppRevokeWrite,
} from './metaAppProtocol';
import type { MetaAppManifestInput } from './metaAppProtocol';
import { searchMetaApps } from './metaAppSearchService';
import type { MetaAppSearchItem } from './metaAppSearchService';

// `store` is a MetabotStore (from getMetabotStore()). It exposes getMetabotById,
// listMetaAppOwnerCache, upsertMetaAppOwnerCache (added in Task 2), and is what
// createPin expects as its first arg (metaidCore.ts:419).

const DEFAULT_SIZE = 12;

export interface OwnerListParams { cursor?: string; size?: number; }
export interface OwnerListResult {
  records: OwnerMetaAppRecord[];
  nextCursor: string;
  total: number;
}

export interface OwnerMetaAppRecord {
  pinId: string; firstPinId: string; operation: string; title: string; appName: string;
  prompt?: string; icon?: string; coverImg?: string; introImgs: string[]; intro?: string;
  runtime: string; version: string; contentType: string; content?: string; indexFile?: string;
  code?: string; contentHash?: string; metadata?: Record<string, unknown>; tags: string[];
  disabled: boolean; codeType?: string; ownerAddress: string; timestamp: number | null;
  txid?: string; txids: string[]; metaappUri: string; shareWebUrl: string; runUrl: string; raw?: unknown;
}

// --- MetaSo aggregator list (replaces raw MAN indexer parsing) ---
//
// The "My Apps" list used to read raw pin rows from the MAN indexer
// (manapi.metaid.io/address/pin/list) and do client-side JSON parsing, version
// folding (modify_history), and revoke filtering. The MAN indexer now returns
// `content` as a download URL (not the JSON body), which silently broke parsing,
// and its raw rows still surface revoked/superseded versions that the client had
// to filter itself.
//
// MetaSo's /api/metaapp/list?publisher=<address> returns the same data already
// aggregated: parsed manifest, version chain folded to one latest record per app,
// revoked apps excluded. So we just map each item to OwnerMetaAppRecord.

// Map a MetaSo aggregated MetaApp item to the owner-list record shape.
// `pinId`/`firstPinId` both use sourcePinId (the create root) so that edit/delete
// target the root pin and the local-cache merge key (first_pin_id) stays aligned.
function mapSearchItemToOwnerRecord(item: MetaAppSearchItem): OwnerMetaAppRecord {
  const pinId = (item.sourcePinId || item.pinId).toLowerCase();
  return {
    pinId,
    firstPinId: pinId,
    operation: 'create',
    title: item.title || item.appName || '',
    appName: item.appName || '',
    prompt: undefined,
    icon: item.icon || undefined,
    coverImg: item.coverImg || undefined,
    introImgs: [],
    intro: item.intro || undefined,
    runtime: item.runtime || 'browser',
    version: item.version || '',
    contentType: 'application/zip',
    content: item.content || undefined,
    indexFile: item.indexFile || undefined,
    code: item.content || undefined,
    tags: Array.isArray(item.tags) ? item.tags.filter((x: unknown): x is string => typeof x === 'string') : [],
    disabled: item.disabled === true,
    ownerAddress: item.publisherAddress || '',
    timestamp: item.updatedAt || null,
    txids: [],
    metaappUri: `metaapp://${pinId}`,
    shareWebUrl: `https://openagentinternet.org/browser/metaapp/${pinId}`,
    runUrl: `/browser/metaapp/${pinId}`,
    raw: item,
  };
}

async function fetchOwnerFromMetaso(
  mvcAddress: string, cursor: string, size: number,
): Promise<{ records: OwnerMetaAppRecord[]; nextCursor: string; total: number }> {
  const page = await searchMetaApps({ publisher: mvcAddress, cursor: cursor || undefined, size });
  const records = page.items.map(mapSearchItemToOwnerRecord);
  // MetaSo sorts by updatedAt desc server-side; keep that order stable.
  return {
    records,
    nextCursor: page.nextCursor || '',
    total: records.length, // MetaSo has no explicit total; the list is the source of truth.
  };
}

// --- local cache merge (port of localCache.ts listMerged hide logic) ---

// NOTE on merge semantics (intentional minor deviation from OAC, documented):
// OAC localCache.listMerged builds hiddenGroupKeys from BOTH indexer + local streams.
// Here, indexer-side revokes are already filtered out by parseManList's isHiddenOperation
// (the record is dropped before reaching this function), so an indexer revoke never appears
// in indexRecords. Therefore computing cacheHidden from local cache rows alone is sufficient:
// the only revoke records that can reach a user are local ones (just-deleted, pre-indexer-sync).
function mergeWithLocalCache(
  indexRecords: OwnerMetaAppRecord[],
  cacheRows: Array<{ pin_id: string; first_pin_id: string | null; operation: string; payload: string | null }>,
): OwnerMetaAppRecord[] {
  // Hidden group keys: any locally-recorded revoke hides its whole group.
  const cacheHidden = new Set<string>();
  for (const row of cacheRows) {
    if (row.operation === 'revoke') {
      cacheHidden.add((row.first_pin_id || row.pin_id).toLowerCase());
    }
  }
  // Build the LATEST local create/modify record per group key (by created_at desc, since cacheRows
  // are already ORDER BY created_at DESC the first match wins). These local records reflect
  // user actions (publish/edit) that may not yet be synced by the indexer, so they take priority
  // over the indexer's (possibly stale) record for the same group.
  const localLatestByGroup = new Map<string, OwnerMetaAppRecord>();
  for (const row of cacheRows) {
    if (row.operation === 'revoke') continue;
    const rowKey = (row.first_pin_id || row.pin_id).toLowerCase();
    if (cacheHidden.has(rowKey)) continue; // group was revoked locally
    if (localLatestByGroup.has(rowKey)) continue; // already have a newer local record for this group
    let payload: any = null;
    try { payload = row.payload ? JSON.parse(row.payload) : null; } catch { payload = null; }
    if (!payload) continue;
    localLatestByGroup.set(rowKey, {
      pinId: row.pin_id, firstPinId: row.first_pin_id || row.pin_id,
      operation: row.operation,
      title: payload.title || payload.appName || '',
      appName: payload.appName || '',
      prompt: payload.prompt, icon: payload.icon, coverImg: payload.coverImg,
      introImgs: Array.isArray(payload.introImgs) ? payload.introImgs : [],
      intro: payload.intro,
      runtime: payload.runtime || 'browser',
      version: payload.version || '',
      contentType: payload.contentType || 'application/zip',
      content: payload.content, indexFile: payload.indexFile, code: payload.code,
      contentHash: payload.contentHash, metadata: payload.metadata,
      tags: Array.isArray(payload.tags) ? payload.tags : [],
      disabled: payload.disabled === true, codeType: payload.codeType,
      ownerAddress: '', timestamp: null, txids: [],
      metaappUri: `metaapp://${row.pin_id}`,
      shareWebUrl: `https://openagentinternet.org/browser/metaapp/${row.pin_id}`,
      runUrl: `/browser/metaapp/${row.pin_id}`,
    });
  }

  const out: OwnerMetaAppRecord[] = [];
  const coveredGroupKeys = new Set<string>();
  for (const rec of indexRecords) {
    const key = (rec.firstPinId || rec.pinId).toLowerCase();
    if (cacheHidden.has(key)) continue;
    coveredGroupKeys.add(key);
    // Prefer the latest local create/modify record for this group (immediate feedback after
    // publish/edit, before the indexer syncs); otherwise show the indexer record.
    out.push(localLatestByGroup.get(key) || rec);
  }
  // Append local records for groups the indexer doesn't show yet (e.g. a brand-new publish
  // not yet indexed).
  for (const [key, rec] of localLatestByGroup) {
    if (coveredGroupKeys.has(key)) continue;
    out.push(rec);
  }
  return out;
}

// --- public API ---

export async function listOwnerMetaApps(
  store: MetabotStore, metabotId: number, params: OwnerListParams = {},
): Promise<OwnerListResult> {
  const metabot = store.getMetabotById(metabotId);
  if (!metabot || !metabot.mvc_address) {
    return { records: [], nextCursor: '', total: 0 };
  }
  const mvcAddress = metabot.mvc_address;
  const cursor = typeof params.cursor === 'string' ? params.cursor : '';
  const size = Number.isFinite(params.size) && (params.size as number) > 0 ? (params.size as number) : DEFAULT_SIZE;

  let indexResult: { records: OwnerMetaAppRecord[]; nextCursor: string; total: number };
  try {
    indexResult = await fetchOwnerFromMetaso(mvcAddress, cursor, size);
  } catch (err) {
    // On aggregator failure, fall back to local cache only so recently published apps remain visible.
    const cacheRows = store.listMetaAppOwnerCache(mvcAddress);
    return { records: mergeWithLocalCache([], cacheRows), nextCursor: '', total: 0 };
  }

  const cacheRows = store.listMetaAppOwnerCache(mvcAddress);
  const records = mergeWithLocalCache(indexResult.records, cacheRows);
  return { records, nextCursor: indexResult.nextCursor, total: indexResult.total };
}

async function resolveMetabotAndAddress(store: MetabotStore, metabotId: number): Promise<{ mvcAddress: string }> {
  const metabot = store.getMetabotById(metabotId);
  if (!metabot) throw new Error('MetaBot not found.');
  if (!metabot.mvc_address) throw new Error('This MetaBot has no MVC address and cannot publish MetaApps.');
  return { mvcAddress: metabot.mvc_address };
}

function ensureConfirm(confirm: unknown, action: string): void {
  if (confirm !== true) throw new Error(`confirmation_required: MetaApp ${action} requires confirm.`);
}

// createPin signature (metaidCore.ts:418): createPin(metabotStore, metabot_id, metaidData, options?).
// `network` goes in the 4th-arg options object, NOT in metaidData. Match publishSkillServiceOrderPin
// (main.ts:641-674) as the authoritative caller. MetaidDataPayload fields: operation, path, encryption,
// version, contentType, payload, encoding (metaidCore.ts:62).
export async function publishMetaApp(
  store: MetabotStore, metabotId: number, manifestInput: MetaAppManifestInput,
  options: { confirm?: boolean; network?: string } = {},
): Promise<{ pinId: string; chainWrite: { txids: string[]; pinId: string; totalCost: number }; metaappUri: string; shareWebUrl: string }> {
  ensureConfirm(options.confirm, 'publish');
  const { mvcAddress } = await resolveMetabotAndAddress(store, metabotId);
  const manifest = buildMetaAppProtocolPayload(manifestInput);
  const write = buildMetaAppCreateWrite(manifest);
  const chainWrite = await createPin(store, metabotId, {
    operation: write.operation,
    path: write.path,
    contentType: write.contentType,
    payload: write.payload,
    encryption: '0',
    version: '1.0',
    encoding: 'utf-8',
  }, { network: options.network });
  const pinId = String(chainWrite.pinId).toLowerCase();
  store.upsertMetaAppOwnerCache({
    metabot_id: metabotId,
    pin_id: pinId,
    first_pin_id: pinId,
    operation: 'create',
    mvc_address: mvcAddress,
    payload: JSON.stringify(manifest),
    txids: JSON.stringify(chainWrite.txids || []),
  });
  return {
    pinId,
    chainWrite,
    metaappUri: `metaapp://${pinId}`,
    shareWebUrl: `https://openagentinternet.org/browser/metaapp/${pinId}`,
  };
}

export async function updateMetaApp(
  store: MetabotStore, metabotId: number, targetPinId: string, manifestInput: MetaAppManifestInput,
  options: { confirm?: boolean; network?: string; firstPinId?: string } = {},
): Promise<{ pinId: string; targetPinId: string; chainWrite: { txids: string[]; pinId: string; totalCost: number }; metaappUri: string; shareWebUrl: string }> {
  ensureConfirm(options.confirm, 'update');
  const { mvcAddress } = await resolveMetabotAndAddress(store, metabotId);
  const manifest = buildMetaAppProtocolPayload(manifestInput);
  const write = buildMetaAppModifyWrite(targetPinId, manifest);
  const chainWrite = await createPin(store, metabotId, {
    operation: write.operation,
    path: write.path,
    contentType: write.contentType,
    payload: write.payload,
    encryption: '0',
    version: '1.0',
    encoding: 'utf-8',
  }, { network: options.network });
  const pinId = String(chainWrite.pinId).toLowerCase();
  // Use the record's true create-root firstPinId as the modify cache group key when available,
  // so the modified record collapses onto the same indexer group (create + all modifies) instead
  // of appearing as a duplicate card next to the stale create record.
  const modifyGroupKey = (options.firstPinId || targetPinId).toLowerCase();
  store.upsertMetaAppOwnerCache({
    metabot_id: metabotId,
    pin_id: pinId,
    first_pin_id: modifyGroupKey,
    operation: 'modify',
    mvc_address: mvcAddress,
    payload: JSON.stringify(manifest),
    txids: JSON.stringify(chainWrite.txids || []),
  });
  return {
    pinId, targetPinId: targetPinId.toLowerCase(),
    chainWrite,
    metaappUri: `metaapp://${pinId}`,
    shareWebUrl: `https://openagentinternet.org/browser/metaapp/${pinId}`,
  };
}

export async function removeMetaApp(
  store: MetabotStore, metabotId: number, targetPinId: string,
  options: { confirm?: boolean; network?: string; firstPinId?: string } = {},
): Promise<{ revokedPinId: string; pinId: string; chainWrite: { txids: string[]; pinId: string; totalCost: number } }> {
  ensureConfirm(options.confirm, 'delete');
  const { mvcAddress } = await resolveMetabotAndAddress(store, metabotId);
  const write = buildMetaAppRevokeWrite(targetPinId);
  const chainWrite = await createPin(store, metabotId, {
    operation: write.operation,
    path: write.path,
    contentType: write.contentType,
    payload: write.payload,
    encryption: '0',
    version: '1.0',
    encoding: 'utf-8',
  }, { network: options.network });
  const pinId = String(chainWrite.pinId).toLowerCase();
  // Use the record's true firstPinId (the create root) as the revoke cache group key when available,
  // so a revoke hides the whole group (create + all modifies) and the app doesn't reappear after a
  // manual refresh even for previously-modified apps, until the indexer syncs the on-chain revoke.
  // Falls back to targetPinId (the modify/create pin) when firstPinId isn't supplied.
  const revokeGroupKey = (options.firstPinId || targetPinId).toLowerCase();
  store.upsertMetaAppOwnerCache({
    metabot_id: metabotId,
    pin_id: pinId,
    first_pin_id: revokeGroupKey,
    operation: 'revoke',
    mvc_address: mvcAddress,
    payload: null,
    txids: JSON.stringify(chainWrite.txids || []),
  });
  return { revokedPinId: targetPinId.toLowerCase(), pinId, chainWrite };
}
