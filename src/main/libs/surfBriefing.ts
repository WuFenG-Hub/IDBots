/**
 * SurfBriefing — the deterministic stage-0 of every surf run.
 *
 * For each registered protocol: fetch items newer than the bot's watermark
 * (first surf looks back SURF_FIRST_LOOKBACK_SECONDS), drop pins already in
 * the seen ledger, and cap per protocol and in total. The LLM session then
 * decides what to deep-read, save, and interact with.
 *
 * This builder is side-effect free by design: survivors are marked
 * 'presented' by surfService ONLY when the run succeeds, so a failed run
 * (LLM timeout, network outage) re-presents this same window on the next
 * surf instead of silently dropping it (catch-up semantics, review P1).
 */

import type { MetawebSurfStore } from '../metawebSurfStore';
import {
  DEFAULT_SURF_PROTOCOLS,
  type SurfItem,
  type SurfProtocolDescriptor,
} from './surfProtocols';

export const SURF_FIRST_LOOKBACK_SECONDS = 7 * 24 * 60 * 60;
export const SURF_PROTOCOL_FETCH_LIMIT = 50;
export const SURF_TOTAL_FETCH_LIMIT = 150;

export interface SurfBriefingProtocolSection {
  key: string;
  displayName: string;
  fetchedCount: number;
  keptCount: number;
  /** Newest createdAt seen in this fetch (unix seconds); reporting only. */
  newestTs: number | null;
  /**
   * Kept items dropped by the TOTAL run cap (SURF_TOTAL_FETCH_LIMIT). These
   * stay OUT of the seen ledger and the watermark does not pass them, so the
   * cap defers them to the next surf instead of silently dropping them
   * (round 3, live evidence: 8 Q&A items once vanished without a trace).
   */
  droppedByTotalCap: number;
  /**
   * Watermark to store after a successful run: the OLDEST kept item that made
   * the final capped list. Presented items are ledger-filtered on the next
   * run anyway, and crowded-out items survive that filter — so this cursor
   * re-fetches a bounded overlap and nothing is lost. null = do not advance
   * (fetch error, or this protocol was crowded out entirely).
   */
  nextWatermarkTs: number | null;
  error: string | null;
}

export interface SurfBriefing {
  generatedAtIso: string;
  items: SurfItem[];
  protocols: SurfBriefingProtocolSection[];
  /** Chain-writing interactions allowed for this run (from bot settings). */
  interactionBudget: number;
}

export async function buildSurfBriefing(input: {
  store: MetawebSurfStore;
  metabotId: number;
  interactionBudget: number;
  registry?: SurfProtocolDescriptor[];
  nowMs?: number;
}): Promise<SurfBriefing> {
  const registry = input.registry ?? DEFAULT_SURF_PROTOCOLS;
  const nowMs = input.nowMs ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const firstLookbackSince = nowSec - SURF_FIRST_LOOKBACK_SECONDS;
  const nowIso = new Date(nowMs).toISOString();

  const protocols: SurfBriefingProtocolSection[] = [];
  const kept: SurfItem[] = [];

  for (const descriptor of registry) {
    const watermark = input.store.getProtocolState(input.metabotId, descriptor.key);
    const sinceTs = watermark?.lastSeenTs ?? firstLookbackSince;
    try {
      const fetched = await descriptor.fetchFresh({ sinceTs, limit: SURF_PROTOCOL_FETCH_LIMIT });
      const unseenIds = new Set(input.store.filterUnseen(input.metabotId, fetched.map((item) => item.pinId)));
      const fresh = fetched.filter((item) => unseenIds.has(item.pinId));
      kept.push(...fresh);
      protocols.push({
        key: descriptor.key,
        displayName: descriptor.displayName,
        fetchedCount: fetched.length,
        keptCount: fresh.length,
        newestTs: fetched.reduce<number | null>((max, item) => Math.max(max ?? 0, item.createdAt), null),
        droppedByTotalCap: 0,
        nextWatermarkTs: null,
        error: null,
      });
    } catch (error) {
      protocols.push({
        key: descriptor.key,
        displayName: descriptor.displayName,
        fetchedCount: 0,
        keptCount: 0,
        newestTs: null,
        droppedByTotalCap: 0,
        nextWatermarkTs: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Newest first, total cap — a bot offline for weeks still gets a bounded run.
  const items = kept
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, SURF_TOTAL_FETCH_LIMIT);

  // Cap semantics (round 3): the cap DEFERS, never drops. Per protocol the
  // next watermark is the oldest item that survived the total cap — presented
  // items are ledger-filtered next run, crowded-out items survive the filter
  // and come back. A protocol crowded out entirely keeps its old cursor.
  for (const section of protocols) {
    if (section.error) continue;
    const inList = items.filter((item) => item.protocolKey === section.key);
    if (inList.length > 0) {
      section.droppedByTotalCap = section.keptCount - inList.length;
      section.nextWatermarkTs = inList.reduce((min, item) => Math.min(min, item.createdAt), inList[0].createdAt);
    } else if (section.keptCount > 0) {
      section.droppedByTotalCap = section.keptCount;
      section.nextWatermarkTs = null;
    } else if (section.newestTs !== null) {
      // Everything fetched was already in the seen ledger — nothing to
      // rescue, so the cursor can advance past the scanned window.
      section.nextWatermarkTs = section.newestTs;
    }
  }

  return {
    generatedAtIso: nowIso,
    items,
    protocols,
    interactionBudget: input.interactionBudget,
  };
}

const formatItemLine = (item: SurfItem): string => {
  const date = item.createdAt > 0 ? new Date(item.createdAt * 1000).toISOString().slice(0, 10) : '?';
  const title = item.title || item.summary.slice(0, 60) || '(untitled)';
  const stats = [
    item.likeCount !== null ? `${item.likeCount} likes` : null,
    item.commentCount !== null ? `${item.commentCount} comments` : null,
    item.extra,
  ].filter(Boolean).join(', ');
  return `- [${item.pinId}] ${title} (${date}${stats ? `; ${stats}` : ''})`;
};

/**
 * Phase-2 digest report rendered when no LLM session ran (and always used as
 * the briefing appendix of the full report).
 */
export function renderSurfBriefingMarkdown(briefing: SurfBriefing): string {
  const lines: string[] = [
    '# Surf digest',
    '',
    `Generated: ${briefing.generatedAtIso}`,
    `Interaction budget: ${briefing.interactionBudget}`,
    '',
  ];
  for (const section of briefing.protocols) {
    lines.push(`## ${section.displayName} — ${section.keptCount} new`);
    if (section.error) {
      lines.push(`(fetch failed: ${section.error})`);
    }
    const items = briefing.items.filter((item) => item.protocolKey === section.key);
    for (const item of items.slice(0, 20)) {
      lines.push(formatItemLine(item));
    }
    if (items.length > 20) {
      lines.push(`- … and ${items.length - 20} more`);
    }
    if (section.droppedByTotalCap > 0) {
      lines.push(`- … plus ${section.droppedByTotalCap} more held back by the run cap — they stay unseen and return next surf`);
    }
    if (!section.error && section.keptCount === 0) {
      lines.push('- (nothing new)');
    }
    lines.push('');
  }
  return lines.join('\n');
}
