// Cowork stream UI delta encoder (main process).
//
// Every streaming producer (the DSH kernel through DshStreamUiGate, the Claude
// SDK event path, the turn-submission controller) publishes the FULL
// accumulated text of a live assistant message on each tick. A 20k-character
// answer therefore crossed IPC as ~6MB for that single message: every tick
// re-serialized the whole string and every renderer-side copy was allocated
// again. This encoder converts that stream into append-only deltas — the first
// update of a message carries the full (capped) text, later updates carry only
// the tail that grew since the previous send plus the base length the renderer
// must already hold.
//
// The renderer assembles the same bytes it used to receive, so no display
// behavior changes. Every rule below degrades to a full send (never to a wrong
// concatenation):
//  - a key with no recorded state always gets the full text
//  - a payload carrying metadata is always sent full: metadata rides on
//    finalize, which stays the authoritative sync point for a message
//  - text that is not a prefix-extension of the previous send (rewrites, slot
//    conversions, re-truncation) is sent full
//  - text identical to the previous send is not sent at all
//
// State is bounded by key count and retained characters: each streamed message
// otherwise kept its (up to 120k-character) content alive for the whole app
// session. Eviction is safe — a dropped key simply means the next update for it
// is a full send again.

export type CoworkStreamUiUpdate = {
  sessionId: string;
  messageId: string;
  content?: string;
  delta?: string;
  baseLength?: number;
  metadata?: Record<string, unknown>;
};

export type CoworkStreamUiDeltaEncoderOptions = {
  /** Applies the same cap the old full-content forwarding used. */
  truncate: (value: string) => string;
  maxKeys?: number;
  maxChars?: number;
};

export const COWORK_STREAM_DELTA_MAX_KEYS = 256;
export const COWORK_STREAM_DELTA_MAX_CHARS = 4_000_000;

const streamKey = (sessionId: string, messageId: string): string => `${sessionId}\0${messageId}`;

export class CoworkStreamUiDeltaEncoder {
  private readonly state = new Map<string, string>();
  private readonly truncate: (value: string) => string;
  private readonly maxKeys: number;
  private readonly maxChars: number;
  private retainedChars = 0;

  constructor(options: CoworkStreamUiDeltaEncoderOptions) {
    this.truncate = options.truncate;
    this.maxKeys = Math.max(1, options.maxKeys ?? COWORK_STREAM_DELTA_MAX_KEYS);
    this.maxChars = Math.max(1, options.maxChars ?? COWORK_STREAM_DELTA_MAX_CHARS);
  }

  /**
   * Build the payload for one stream update, or null when nothing has to
   * cross the wire (metadata-only update with no content, or content that is
   * byte-identical to the previous send).
   */
  encode(input: {
    sessionId: string;
    messageId: string;
    content?: string;
    metadata?: Record<string, unknown>;
  }): CoworkStreamUiUpdate | null {
    const { sessionId, messageId, metadata } = input;
    if (!sessionId || !messageId) return null;

    if (input.content === undefined) {
      return metadata ? { sessionId, messageId, metadata } : null;
    }

    const capped = this.truncate(input.content);
    const key = streamKey(sessionId, messageId);
    const previous = this.state.get(key);

    if (metadata) {
      this.remember(key, capped);
      return { sessionId, messageId, content: capped, metadata };
    }
    if (previous === undefined) {
      this.remember(key, capped);
      return { sessionId, messageId, content: capped };
    }
    if (capped === previous) return null;
    if (capped.length > previous.length && capped.startsWith(previous)) {
      this.remember(key, capped);
      return {
        sessionId,
        messageId,
        delta: capped.slice(previous.length),
        baseLength: previous.length,
      };
    }
    this.remember(key, capped);
    return { sessionId, messageId, content: capped };
  }

  /**
   * The exact text a renderer that has applied every payload this encoder sent
   * is holding. Used by the renderer's resync request: when it is non-null the
   * encoder is in delta mode (so the next payload would be a delta the renderer
   * could not apply), and adopting this value realigns both sides.
   */
  liveContent(sessionId: string, messageId: string): string | null {
    if (!sessionId || !messageId) return null;
    return this.state.get(streamKey(sessionId, messageId)) ?? null;
  }

  clearSession(sessionId: string): void {
    if (!sessionId) return;
    const prefix = `${sessionId}\0`;
    for (const key of [...this.state.keys()]) {
      if (key.startsWith(prefix)) this.forget(key);
    }
  }

  reset(): void {
    this.state.clear();
    this.retainedChars = 0;
  }

  private remember(key: string, value: string): void {
    this.forget(key);
    this.state.set(key, value);
    this.retainedChars += value.length;
    while (this.state.size > this.maxKeys
      || (this.retainedChars > this.maxChars && this.state.size > 1)) {
      const oldest = this.state.keys().next().value as string | undefined;
      if (oldest === undefined || oldest === key) break;
      this.forget(oldest);
    }
  }

  private forget(key: string): void {
    const previous = this.state.get(key);
    if (previous === undefined) return;
    this.state.delete(key);
    this.retainedChars -= previous.length;
  }
}
