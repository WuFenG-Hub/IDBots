/**
 * SurfBriefing — the deterministic stage-0 of every surf run.
 *
 * For each registered protocol: fetch items newer than the bot's watermark
 * (first surf looks back SURF_FIRST_LOOKBACK_SECONDS), drop pins already in
 * the seen ledger, cap per protocol and in total, and mark the survivors
 * 'presented' so the next surf does not re-list them. The LLM session then
 * decides what to deep-read, save, and interact with.
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
  /** Newest createdAt seen in this fetch (unix seconds); watermark candidate. */
  newestTs: number | null;
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
      for (const item of fresh) {
        input.store.markSeen(input.metabotId, item.pinId, 'presented', nowIso);
      }
      kept.push(...fresh);
      protocols.push({
        key: descriptor.key,
        displayName: descriptor.displayName,
        fetchedCount: fetched.length,
        keptCount: fresh.length,
        newestTs: fetched.reduce<number | null>((max, item) => Math.max(max ?? 0, item.createdAt), null),
        error: null,
      });
    } catch (error) {
      protocols.push({
        key: descriptor.key,
        displayName: descriptor.displayName,
        fetchedCount: 0,
        keptCount: 0,
        newestTs: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Newest first, total cap — a bot offline for weeks still gets a bounded run.
  const items = kept
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, SURF_TOTAL_FETCH_LIMIT);

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
    if (!section.error && items.length === 0) {
      lines.push('- (nothing new)');
    }
    lines.push('');
  }
  return lines.join('\n');
}
