import { createPin } from './metaidCore';
import type { MetabotStore } from '../metabotStore';
import {
  buildMetaAppProtocolPayload,
  buildMetaAppCreateWrite,
  buildMetaAppModifyWrite,
  buildMetaAppRevokeWrite,
  isMetaAppPinId,
} from './metaAppProtocol';
import type { MetaAppManifestInput } from './metaAppProtocol';
import { parseProtocolPinContent } from './protocolPinContent';

// `store` is a MetabotStore (from getMetabotStore()). It exposes getMetabotById,
// listMetaAppOwnerCache, upsertMetaAppOwnerCache (added in Task 2), and is what
// createPin expects as its first arg (metaidCore.ts:419).

const MAN_BASE_URL = 'https://manapi.metaid.io';
const METAAPP_PATH = '/protocols/metaapp';
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

// --- MAN indexer list + parse (port of manOwnerList.ts) ---

async function fetchOwnerIndex(mvcAddress: string, cursor: string, size: number): Promise<any> {
  const url = `${MAN_BASE_URL}/address/pin/list/${encodeURIComponent(mvcAddress)}`
    + `?cursor=${encodeURIComponent(cursor)}&size=${size}&path=${encodeURIComponent(METAAPP_PATH)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MAN MetaAPP list failed: HTTP ${res.status}`);
  const root = await res.json();
  if (root && typeof root === 'object' && root.code !== 1) {
    throw new Error(`MAN MetaAPP list failed: ${root.message || 'unknown error'}`);
  }
  return root;
}

const normalizeOperation = (value: unknown): string => {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return text || 'create';
};
const isHiddenOperation = (op: string): boolean =>
  op === 'revoke' || op === 'delete' || op === 'deleted';

// Read modify_history from various shapes.
function readHistory(raw: any): any[] {
  const candidates = [raw?.modify_history, raw?.modifyHistory, raw?.history];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

function parseTargetPathPinId(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  const match = path.match(/^@([0-9a-f]{64}i0)$/i);
  return match ? match[1].toLowerCase() : null;
}

function pickFirstPinId(raw: any, event: any, fallbackPin: string): string {
  const explicit = (obj: any) => {
    const v = obj?.firstPinId || obj?.first_pin_id || obj?.originPinId || obj?.origin_pin_id
      || obj?.rootPinId || obj?.root_pin_id || obj?.originalId || obj?.original_id;
    return typeof v === 'string' && v ? v : null;
  };
  return explicit(event) || parseTargetPathPinId(event?.path) || explicit(raw) || fallbackPin;
}

function readTimestamp(event: any): number | null {
  const t = event?.timestamp ?? event?.createdAt ?? event?.created_at ?? event?.time;
  const n = typeof t === 'number' ? t : (typeof t === 'string' ? Date.parse(t) : NaN);
  return Number.isFinite(n) ? n : null;
}

function readPinId(event: any): string | null {
  const id = event?.id || event?.pinId || event?.pin_id || event?.pin;
  return typeof id === 'string' && isMetaAppPinId(id) ? id.toLowerCase() : null;
}

// Parse the MetaApp manifest out of a MAN indexer event using the shared
// protocol-pin selector. This skips the content-download URL that MAN now puts
// in `content` (which previously poisoned JSON.parse and left owner MetaApps
// with no title/cover/intro — the "shows raw pin data" bug). See
// protocolPinContent.ts for the full rationale.
function readContent(event: any): any {
  return parseProtocolPinContent(event) ?? null;
}

function buildRecord(raw: any, ownerAddress: string): OwnerMetaAppRecord | null {
  const pinId = readPinId(raw);
  if (!pinId) return null;
  const op = normalizeOperation(raw?.operation);
  const firstPinId = pickFirstPinId(raw, raw, pinId);
  const content = readContent(raw) || {};
  const introImgs = Array.isArray(content.introImgs) ? content.introImgs.filter((x: any) => typeof x === 'string') : [];
  const tags = Array.isArray(content.tags) ? content.tags.filter((x: any) => typeof x === 'string') : [];
  const txids = Array.isArray(raw?.txids) ? raw.txids : (raw?.txid ? [raw.txid] : []);
  const timestamp = readTimestamp(raw);
  return {
    pinId, firstPinId, operation: op,
    title: content.title || content.appName || '',
    appName: content.appName || '',
    prompt: content.prompt, icon: content.icon, coverImg: content.coverImg,
    introImgs, intro: content.intro,
    runtime: content.runtime || 'browser',
    version: content.version || '',
    contentType: content.contentType || 'application/zip',
    content: content.content, indexFile: content.indexFile, code: content.code,
    contentHash: content.contentHash, metadata: content.metadata,
    tags, disabled: content.disabled === true, codeType: content.codeType,
    ownerAddress, timestamp,
    txid: raw?.txid, txids,
    metaappUri: `metaapp://${pinId}`,
    shareWebUrl: `https://openagentinternet.org/browser/metaapp/${pinId}`,
    runUrl: `/browser/metaapp/${pinId}`,
    raw,
  };
}

function parseManList(root: any, ownerAddress: string): { records: OwnerMetaAppRecord[]; nextCursor: string; total: number } {
  const data = root?.data ?? root;
  const list: any[] = Array.isArray(data?.list) ? data.list : [];
  const nextCursor = typeof data?.nextCursor === 'string' ? data.nextCursor : '';
  const total = typeof data?.total === 'number' ? data.total : list.length;

  type Cand = { rec: OwnerMetaAppRecord; ts: number; listIdx: number; histIdx: number };
  const groups = new Map<string, Cand>();

  list.forEach((raw, listIdx) => {
    const events = [raw, ...readHistory(raw)];
    events.forEach((event, histIdx) => {
      const rec = buildRecord(event, ownerAddress);
      if (!rec) return;
      const key = rec.firstPinId || rec.pinId;
      const ts = rec.timestamp ?? Number.NEGATIVE_INFINITY;
      const prev = groups.get(key);
      const shouldReplace = !prev
        || (ts > prev.ts)
        || (ts === prev.ts && listIdx < prev.listIdx)
        || (ts === prev.ts && listIdx === prev.listIdx && histIdx > prev.histIdx);
      if (shouldReplace) groups.set(key, { rec, ts, listIdx, histIdx });
    });
  });

  const records: OwnerMetaAppRecord[] = [];
  for (const { rec } of groups.values()) {
    if (isHiddenOperation(rec.operation)) continue;
    records.push(rec);
  }
  records.sort((a, b) => (b.timestamp ?? -1) - (a.timestamp ?? -1));
  return { records, nextCursor, total };
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
    const root = await fetchOwnerIndex(mvcAddress, cursor, size);
    indexResult = parseManList(root, mvcAddress);
  } catch (err) {
    // On indexer failure, fall back to local cache only so recently published apps remain visible.
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
