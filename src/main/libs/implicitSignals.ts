import type { DreamDayActivity, DreamImplicitSignal, DreamImplicitSignalKind } from '../dreamStore';

/**
 * Implicit activity signals (隐式信号) — the mechanical collection layer.
 *
 * Design rule (owner-approved 2026-09-17): this layer records only
 * STRUCTURAL FACTS — computable numbers like similarity scores, time gaps,
 * repeat counts. It never assigns sentiment and never pattern-matches
 * keywords ("太慢了" ≠ negative). What a fact MEANS is decided by the
 * dreaming bot, which sees the full conversation context; false alarms are
 * absorbed downstream by the counterfactual replay's margin gate.
 */

/** Two user messages closer than this (and similar enough) count as a re-ask. */
export const IMPLICIT_REASK_WINDOW_MS = 10 * 60 * 1000;
/** Character-bigram Jaccard threshold for "the user restated the same request". */
export const IMPLICIT_REASK_MIN_SIMILARITY = 0.55;
const REASK_MIN_CONTENT_CHARS = 8;
const MAX_IMPLICIT_SIGNALS = 5;

export type { DreamImplicitSignal, DreamImplicitSignalKind } from '../dreamStore';

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Character-bigram Jaccard similarity; 0 for anything too short to compare. */
export function bigramSimilarity(a: string, b: string): number {
  const left = normalize(a);
  const right = normalize(b);
  if (left.length < 2 || right.length < 2) return 0;
  const bigrams = (text: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
    return set;
  };
  const aSet = bigrams(left);
  const bSet = bigrams(right);
  let intersection = 0;
  for (const gram of aSet) {
    if (bSet.has(gram)) intersection += 1;
  }
  return intersection / (aSet.size + bSet.size - intersection);
}

/**
 * Extract the day's structural implicit signals. Pure: same activity in, same
 * signals out. At most one re-ask per session (the strongest), and the whole
 * list is capped so busy days stay bounded.
 */
export function extractImplicitSignals(activity: DreamDayActivity): DreamImplicitSignal[] {
  const signals: DreamImplicitSignal[] = [];

  for (const session of activity.sessions) {
    // Re-ask: a user message that closely restates the previous user message
    // within the re-ask window. The assistant reply between them may or may
    // not exist — that distinction is the dream's job, not ours.
    let bestReask: { index: number; similarity: number; gapMin: number } | null = null;
    let prevUserIndex = -1;
    session.messages.forEach((message, index) => {
      if (message.type !== 'user') return;
      if (prevUserIndex >= 0) {
        const prev = session.messages[prevUserIndex];
        const gap = message.createdAt - prev.createdAt;
        if (gap >= 0 && gap <= IMPLICIT_REASK_WINDOW_MS
          && normalize(message.content).length >= REASK_MIN_CONTENT_CHARS
          && normalize(prev.content).length >= REASK_MIN_CONTENT_CHARS) {
          const similarity = bigramSimilarity(prev.content, message.content);
          if (similarity >= IMPLICIT_REASK_MIN_SIMILARITY
            && (bestReask == null || similarity > bestReask.similarity)) {
            bestReask = { index, similarity, gapMin: Math.round(gap / 60000) };
          }
        }
      }
      prevUserIndex = index;
    });
    if (bestReask != null) {
      const reask: { index: number; similarity: number; gapMin: number } = bestReask;
      signals.push({
        kind: 'reask',
        sessionId: session.sessionId,
        messageIndex: reask.index,
        text: `会话「${session.title}」:用户在 ${reask.gapMin} 分钟后重述了同一诉求(相似度 ${reask.similarity.toFixed(2)})`,
      });
    }

    // Unanswered burst: the session's tail is ≥2 consecutive user messages.
    let tailUserCount = 0;
    for (let index = session.messages.length - 1; index >= 0; index -= 1) {
      if (session.messages[index].type === 'user') tailUserCount += 1;
      else break;
    }
    if (tailUserCount >= 2) {
      signals.push({
        kind: 'unanswered_burst',
        sessionId: session.sessionId,
        messageIndex: session.messages.length - 1,
        text: `会话「${session.title}」:会话末尾用户连发 ${tailUserCount} 条消息,之后没有我的回复`,
      });
    }
  }

  // Repeat orders: the same peer opened ≥2 order sessions that day.
  const orderCountByPeer = new Map<string, number>();
  for (const session of activity.sessions) {
    if (!session.isOrder || !session.peerName) continue;
    orderCountByPeer.set(session.peerName, (orderCountByPeer.get(session.peerName) ?? 0) + 1);
  }
  for (const [peer, count] of orderCountByPeer) {
    if (count >= 2) {
      signals.push({
        kind: 'repeat_order',
        sessionId: null,
        text: `同一对象「${peer}」当天发起了 ${count} 笔服务订单`,
      });
    }
  }

  return signals.slice(0, MAX_IMPLICIT_SIGNALS);
}
