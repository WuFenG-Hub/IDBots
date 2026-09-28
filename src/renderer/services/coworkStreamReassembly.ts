import type { CoworkMessage } from '../types/cowork';

/**
 * Renderer-side reassembly of the incremental cowork stream protocol.
 *
 * The main process sends the first update of a live message as full content and
 * every later update as `{ delta, baseLength }` (see
 * src/main/libs/coworkStreamUiDelta.ts). This state machine turns both shapes
 * back into the accumulated text the store has always held, and never invents
 * content when the two sides disagree: a delta whose base length does not match
 * the text held here is reported as a desync, and the caller resyncs (see
 * `resolveResync`) or waits for the next full update — the finalize payload is
 * always full, so a dropped delta can only cost live smoothness, never content.
 *
 * Kept framework-free so tests can drive it directly.
 */

export type CoworkStreamUpdatePayload = {
  sessionId: string;
  messageId: string;
  content?: string;
  delta?: string;
  baseLength?: number;
  metadata?: CoworkMessage['metadata'];
};

export type CoworkStreamApplyResult =
  | { kind: 'full'; sessionId: string; messageId: string; text: string; metadata?: CoworkMessage['metadata'] }
  | { kind: 'append'; sessionId: string; messageId: string; text: string }
  | { kind: 'metadata'; sessionId: string; messageId: string; metadata: CoworkMessage['metadata'] }
  | { kind: 'desync'; sessionId: string; messageId: string }
  | { kind: 'ignored'; reason: 'awaiting-full' | 'resync-pending' | 'malformed' };

type StreamEntry = {
  /** Accumulated text, or null while a resync for this key is outstanding. */
  text: string | null;
  resyncPending: boolean;
  /**
   * A resync found no live content on the main side, which means every further
   * payload for this key is a full send. Ignore deltas until one arrives so a
   * stranded key cannot spin on resync requests.
   */
  awaitingFull: boolean;
};

export const COWORK_STREAM_MAX_TRACKED = 128;

const streamKey = (sessionId: string, messageId: string): string => `${sessionId}\0${messageId}`;

export class CoworkStreamReassembler {
  private readonly entries = new Map<string, StreamEntry>();
  private readonly maxTracked: number;

  constructor(options?: { maxTracked?: number }) {
    this.maxTracked = Math.max(1, options?.maxTracked ?? COWORK_STREAM_MAX_TRACKED);
  }

  apply(payload: CoworkStreamUpdatePayload): CoworkStreamApplyResult {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
    const messageId = typeof payload?.messageId === 'string' ? payload.messageId : '';
    if (!sessionId || !messageId) return { kind: 'ignored', reason: 'malformed' };

    if (payload.delta !== undefined) {
      return this.applyDelta(sessionId, messageId, payload.delta, payload.baseLength);
    }

    if (payload.content !== undefined) {
      const entry = this.entry(sessionId, messageId);
      entry.text = payload.content;
      entry.resyncPending = false;
      entry.awaitingFull = false;
      return {
        kind: 'full',
        sessionId,
        messageId,
        text: payload.content,
        ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {}),
      };
    }

    if (payload.metadata === undefined) return { kind: 'ignored', reason: 'malformed' };
    return { kind: 'metadata', sessionId, messageId, metadata: payload.metadata };
  }

  /** Resync answer: the authoritative text, or null when the main side has none. */
  resolveResync(sessionId: string, messageId: string, content: string | null): CoworkStreamApplyResult {
    const key = streamKey(sessionId, messageId);
    if (typeof content === 'string') {
      const entry = this.entry(sessionId, messageId);
      entry.text = content;
      entry.resyncPending = false;
      entry.awaitingFull = false;
      return { kind: 'full', sessionId, messageId, text: content };
    }
    const entry = this.entries.get(key);
    if (entry) entry.text = null;
    const next = entry ?? this.entry(sessionId, messageId);
    next.resyncPending = false;
    next.awaitingFull = true;
    return { kind: 'ignored', reason: 'awaiting-full' };
  }

  /** Accumulated text for a key, or null when nothing is tracked. */
  text(sessionId: string, messageId: string): string | null {
    return this.entries.get(streamKey(sessionId, messageId))?.text ?? null;
  }

  forget(sessionId: string, messageId: string): void {
    this.entries.delete(streamKey(sessionId, messageId));
  }

  reset(): void {
    this.entries.clear();
  }

  private applyDelta(
    sessionId: string,
    messageId: string,
    delta: string,
    baseLength: number | undefined,
  ): CoworkStreamApplyResult {
    const key = streamKey(sessionId, messageId);
    const entry = this.entries.get(key);
    if (entry && entry.text !== null && baseLength === entry.text.length) {
      entry.text += delta;
      return { kind: 'append', sessionId, messageId, text: entry.text };
    }
    if (entry?.resyncPending) return { kind: 'ignored', reason: 'resync-pending' };
    if (entry?.awaitingFull) return { kind: 'ignored', reason: 'awaiting-full' };
    const next = entry ?? this.entry(sessionId, messageId);
    next.resyncPending = true;
    return { kind: 'desync', sessionId, messageId };
  }

  private entry(sessionId: string, messageId: string): StreamEntry {
    const key = streamKey(sessionId, messageId);
    const existing = this.entries.get(key);
    if (existing) {
      // Re-insert so eviction removes the least recently touched stream.
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing;
    }
    const created: StreamEntry = { text: null, resyncPending: false, awaitingFull: false };
    this.entries.set(key, created);
    while (this.entries.size > this.maxTracked) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined || oldest === key) break;
      this.entries.delete(oldest);
    }
    return created;
  }
}
