/**
 * Chain-grounded evidence digest for the dream-time replay gate (design
 * 2026-10-10 §5).
 *
 * The replay gate used to judge chain-action claims ("I published the
 * service", "the payment confirmed") against diary prose only. The chain is
 * one read away and immutable — so before validation, the host collects the
 * pin/txid references from tonight's drafts and the day's chain activity,
 * verifies each against chain state (bounded per night, per-ref timeout,
 * failures degrade to UNVERIFIED rather than error), and hands the judge a
 * compact dated digest. Pure collection/render code plus an
 * injected-verifier runner; dreamService owns the pipeline and the store
 * writes. All reads are read-only.
 */

import type { DreamChainReadActivity, DreamChainWriteActivity } from '../dreamStore';

/** Per-night verification cap (design §5.2). */
export const CHAIN_EVIDENCE_MAX_REFS = 8;
/** Per-ref verification timeout; a timeout degrades to UNVERIFIED. */
export const CHAIN_EVIDENCE_TIMEOUT_MS = 8000;

export type ChainRefKind = 'pin' | 'txid';

export interface ChainRef {
  kind: ChainRefKind;
  /** Lowercased id (pin ids and txids are case-insensitive hex). */
  id: string;
}

/** A collected reference with the drafts that cite it (empty = day activity). */
export interface CollectedChainRef extends ChainRef {
  sourceDraftIds: number[];
}

// A MetaID pin id is a 64-hex txid plus an output-index suffix (`i0`…). A bare
// 64-hex token is a txid: pin ids never match TXID_RE because the hash→`i`
// transition is word→word (no \b), and `i` itself is not a hex char.
const PIN_ID_RE = /\b[0-9a-f]{64}i\d+\b/gi;
const TXID_RE = /\b[0-9a-f]{64}\b/gi;
const PIN_URI_RE = /(?:pin|metafile):\/\/([0-9a-f]{64}i\d+)/gi;

/**
 * Regex-extract pin/txid references from free text (draft title/description /
 * verdict rationale). Explicit pin:// and metafile:// URIs are pins; bare
 * pin-shaped ids are pins; bare 64-hex tokens are txids. metaid:// URIs carry
 * identities, not pins — deliberately not extracted (no verifier for them).
 */
export function extractChainRefs(text: string): ChainRef[] {
  const refs: ChainRef[] = [];
  const seen = new Set<string>();
  const add = (kind: ChainRefKind, id: string) => {
    const normalized = id.toLowerCase();
    const key = `${kind}:${normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ kind, id: normalized });
  };
  for (const match of text.matchAll(PIN_URI_RE)) {
    add('pin', match[1] ?? '');
  }
  for (const match of text.matchAll(PIN_ID_RE)) {
    add('pin', match[0]);
  }
  for (const match of text.matchAll(TXID_RE)) {
    add('txid', match[0]);
  }
  return refs.filter((ref) => ref.id);
}

/**
 * Merge references from tonight's drafts (title + description + notes) and the
 * day's chain activity. Draft-cited refs come first (they are the claims under
 * test); activity refs follow. Uncapped — the verification cap applies at
 * verify time, and the grounding gate checks against every collected ref.
 */
export function collectChainEvidenceRefs(input: {
  chainWrites?: DreamChainWriteActivity[];
  chainReads?: DreamChainReadActivity[];
  drafts?: Array<{ id: number; text: string }>;
}): CollectedChainRef[] {
  const byKey = new Map<string, CollectedChainRef>();
  const add = (kind: ChainRefKind, id: string, draftId: number | null) => {
    const normalized = String(id ?? '').trim().toLowerCase();
    if (!normalized) return;
    const key = `${kind}:${normalized}`;
    const existing = byKey.get(key);
    if (existing) {
      if (draftId != null && !existing.sourceDraftIds.includes(draftId)) {
        existing.sourceDraftIds.push(draftId);
      }
      return;
    }
    byKey.set(key, { kind, id: normalized, sourceDraftIds: draftId == null ? [] : [draftId] });
  };
  for (const draft of input.drafts ?? []) {
    for (const ref of extractChainRefs(draft.text)) {
      add(ref.kind, ref.id, draft.id);
    }
  }
  for (const write of input.chainWrites ?? []) add('pin', write.pinId, null);
  for (const read of input.chainReads ?? []) add('pin', read.pinId, null);
  return [...byKey.values()];
}

/** EXISTS/CONFIRMED = verified on chain; NOT FOUND = verified absent; UNVERIFIED = could not check. */
export type ChainEvidenceLabel = 'EXISTS' | 'NOT FOUND' | 'CONFIRMED' | 'UNVERIFIED';

export interface ChainEvidenceEntry {
  /** 'pin://<id>' | 'txid:<id>' — the display/reference form. */
  ref: string;
  kind: ChainRefKind;
  label: ChainEvidenceLabel;
  detail: string;
  sourceDraftIds: number[];
}

export interface ChainEvidenceDigest {
  /** ISO timestamp of the host verification pass. */
  verifiedAt: string;
  entries: ChainEvidenceEntry[];
  /** `${kind}:${id}` of every collected ref, including refs beyond the cap. */
  knownRefIds: string[];
  counts: { refs: number; supported: number; contradicted: number; notFound: number; errors: number };
}

export interface ChainEvidenceVerifierDeps {
  /** readMetawebPin adapter; resolve null to mean NOT FOUND, throw on failure. */
  readPin?: (pinId: string) => Promise<{ path?: string; protocol?: string; createdAt?: number } | null>;
  /** Raw-tx fetch (non-empty hex = the txid exists on chain). */
  fetchRawTx?: (txid: string) => Promise<string>;
  /** Local order cross-ref for a payment txid (read-only SQLite). */
  findOrdersByPaymentTxid?: (txid: string) => Array<{ id: string; status: string }>;
  /** Maps a readPin error to NOT FOUND (the service's typed 404). */
  isPinNotFound?: (error: unknown) => boolean;
  timeoutMs?: number;
  now?: () => number;
}

/** Failure-terminal order statuses: a claim of success against these is contradicted. */
const CONTRADICTING_ORDER_STATUSES = new Set(['failed', 'refunded']);

function withTimeoutMs<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`chain evidence verification timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

async function verifyPinRef(
  ref: CollectedChainRef,
  deps: ChainEvidenceVerifierDeps,
  timeoutMs: number,
): Promise<ChainEvidenceEntry> {
  const base = { ref: `pin://${ref.id}`, kind: ref.kind, sourceDraftIds: ref.sourceDraftIds };
  if (!deps.readPin) {
    return { ...base, label: 'UNVERIFIED', detail: 'verifier unavailable' };
  }
  try {
    const pin = await withTimeoutMs(deps.readPin(ref.id), timeoutMs);
    if (!pin) {
      return { ...base, label: 'NOT FOUND', detail: '' };
    }
    const detail = [
      pin.path ? `path=${pin.path}` : '',
      pin.protocol ? `protocol=${pin.protocol}` : '',
      pin.createdAt ? `created=${new Date(pin.createdAt * 1000).toISOString().slice(0, 10)}` : '',
    ].filter(Boolean).join(' ');
    return { ...base, label: 'EXISTS', detail };
  } catch (error) {
    if (deps.isPinNotFound?.(error)) {
      return { ...base, label: 'NOT FOUND', detail: '' };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ...base, label: 'UNVERIFIED', detail: message.slice(0, 120) };
  }
}

async function verifyTxidRef(
  ref: CollectedChainRef,
  deps: ChainEvidenceVerifierDeps,
  timeoutMs: number,
): Promise<ChainEvidenceEntry> {
  const base = { ref: `txid:${ref.id}`, kind: ref.kind, sourceDraftIds: ref.sourceDraftIds };
  let label: ChainEvidenceLabel = 'UNVERIFIED';
  let detail = '';
  if (deps.fetchRawTx) {
    try {
      const rawHex = await withTimeoutMs(deps.fetchRawTx(ref.id), timeoutMs);
      label = rawHex ? 'CONFIRMED' : 'NOT FOUND';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      detail = message.slice(0, 120);
    }
  } else {
    detail = 'verifier unavailable';
  }
  // Local cross-ref: a service order paid by this txid rides the digest line
  // as deterministic extra context (read-only, no chain call).
  try {
    const orders = deps.findOrdersByPaymentTxid?.(ref.id) ?? [];
    if (orders.length > 0) {
      const orderText = orders
        .map((order) => `order ${order.id.slice(0, 8)} status=${order.status}`)
        .join('; ');
      detail = detail ? `${detail} | ${orderText}` : orderText;
    }
  } catch {
    // A sick order store never changes the chain verdict.
  }
  return { ...base, label, detail };
}

/**
 * Verify the collected refs (capped at CHAIN_EVIDENCE_MAX_REFS, draft-cited
 * first) and build the digest. Every per-ref failure degrades to UNVERIFIED.
 */
export async function buildChainEvidenceDigest(
  refs: CollectedChainRef[],
  deps: ChainEvidenceVerifierDeps,
): Promise<ChainEvidenceDigest> {
  const now = deps.now ?? Date.now;
  const capped = refs.slice(0, CHAIN_EVIDENCE_MAX_REFS);
  const entries: ChainEvidenceEntry[] = [];
  for (const ref of capped) {
    entries.push(
      ref.kind === 'pin'
        ? await verifyPinRef(ref, deps, deps.timeoutMs ?? CHAIN_EVIDENCE_TIMEOUT_MS)
        : await verifyTxidRef(ref, deps, deps.timeoutMs ?? CHAIN_EVIDENCE_TIMEOUT_MS),
    );
  }
  let supported = 0;
  let notFound = 0;
  let errors = 0;
  let contradicted = 0;
  for (const entry of entries) {
    if (entry.label === 'EXISTS' || entry.label === 'CONFIRMED') supported += 1;
    else if (entry.label === 'NOT FOUND') notFound += 1;
    else errors += 1;
  }
  // Host-computable contradiction proxy: a cited ref verified absent, or a
  // cross-referenced local order in a failure-terminal status. The judge
  // applies the claim-level comparison; this count tracks the hard cases.
  contradicted = entries.filter(
    (entry) => entry.label === 'NOT FOUND'
      || [...CONTRADICTING_ORDER_STATUSES].some((status) => entry.detail.includes(`status=${status}`)),
  ).length;
  return {
    verifiedAt: new Date(now()).toISOString(),
    entries,
    knownRefIds: refs.map((ref) => `${ref.kind}:${ref.id}`),
    counts: { refs: entries.length, supported, contradicted, notFound, errors },
  };
}

/** Compact dated list for the validation prompt (design §5.2's format). */
export function renderChainEvidenceDigest(digest: ChainEvidenceDigest): string {
  const lines = digest.entries.map((entry) =>
    `- ${entry.ref}  ${entry.label}${entry.detail ? `  ${entry.detail}` : ''}`,
  );
  return [
    `Chain evidence (verified by host at ${digest.verifiedAt}):`,
    ...(lines.length > 0 ? lines : ['(no chain references collected tonight)']),
  ].join('\n');
}

/** Every ref id cited in a text (the grounding gate's membership check shape). */
export function chainRefKeysOf(text: string): string[] {
  return extractChainRefs(text).map((ref) => `${ref.kind}:${ref.id}`);
}
