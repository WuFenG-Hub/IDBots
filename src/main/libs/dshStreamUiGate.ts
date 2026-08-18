// DSH stream UI gate: the Claude kernel already throttles renderer updates
// (~90ms) and persists only on finalize. The DSH adapter originally wrote
// SQLite and emitted IPC on every assistant/chunk, which backpressured the
// single notification pump and froze session switching under concurrent turns.
// This gate restores the Claude performance contract without changing the
// mapper's event shapes.

export type DshLiveMessageOverlay = {
  messageId: string;
  content: string;
};

export type DshStreamUiGateClock = {
  now: () => number;
  schedule: (fn: () => void, delayMs: number) => () => void;
};

const defaultClock: DshStreamUiGateClock = {
  now: () => Date.now(),
  schedule: (fn, delayMs) => {
    const timer = setTimeout(fn, delayMs);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

const streamKey = (sessionId: string, messageId: string): string => `${sessionId}\0${messageId}`;

export class DshStreamUiGate {
  private readonly throttleMs: number;
  private readonly emitUpdate: (
    sessionId: string,
    messageId: string,
    content: string,
    metadata?: Record<string, unknown>,
  ) => void;
  private readonly persistFinalize: (sessionId: string, messageId: string, content: string, metadata?: Record<string, unknown>) => void;
  private readonly clock: DshStreamUiGateClock;
  private readonly liveContent = new Map<string, string>();
  private readonly lastEmitAt = new Map<string, number>();
  private readonly cancelFlush = new Map<string, () => void>();

  constructor(options: {
    throttleMs: number;
    emitUpdate: (
      sessionId: string,
      messageId: string,
      content: string,
      metadata?: Record<string, unknown>,
    ) => void;
    persistFinalize: (sessionId: string, messageId: string, content: string, metadata?: Record<string, unknown>) => void;
    clock?: DshStreamUiGateClock;
  }) {
    this.throttleMs = Math.max(0, options.throttleMs);
    this.emitUpdate = options.emitUpdate;
    this.persistFinalize = options.persistFinalize;
    this.clock = options.clock ?? defaultClock;
  }

  onUpdate(sessionId: string, messageId: string, content: string): void {
    const key = streamKey(sessionId, messageId);
    this.liveContent.set(key, content);
    const now = this.clock.now();
    const lastEmitAt = this.lastEmitAt.get(key) ?? 0;
    if (now - lastEmitAt >= this.throttleMs) {
      this.flushEmit(sessionId, messageId, content, now);
      return;
    }
    if (this.cancelFlush.has(key)) return;
    const wait = Math.max(0, this.throttleMs - (now - lastEmitAt));
    const cancel = this.clock.schedule(() => {
      this.cancelFlush.delete(key);
      const latest = this.liveContent.get(key);
      if (latest === undefined) return;
      this.flushEmit(sessionId, messageId, latest, this.clock.now());
    }, wait);
    this.cancelFlush.set(key, cancel);
  }

  onFinalize(sessionId: string, messageId: string, content: string, metadata?: Record<string, unknown>): void {
    const key = streamKey(sessionId, messageId);
    this.clearTimer(key);
    this.liveContent.set(key, content);
    this.persistFinalize(sessionId, messageId, content, metadata);
    this.lastEmitAt.set(key, this.clock.now());
    this.emitUpdate(sessionId, messageId, content, { isStreaming: false, isFinal: true, ...metadata });
  }

  overlays(sessionId: string): DshLiveMessageOverlay[] {
    const prefix = `${sessionId}\0`;
    const result: DshLiveMessageOverlay[] = [];
    for (const [key, content] of this.liveContent) {
      if (!key.startsWith(prefix)) continue;
      result.push({ messageId: key.slice(prefix.length), content });
    }
    return result;
  }

  applyOverlays<T extends { id: string; messages?: Array<{ id: string; content: string }> }>(session: T): T {
    const messages = session.messages;
    if (!messages?.length) return session;
    const overlayById = new Map(this.overlays(session.id).map((entry) => [entry.messageId, entry.content]));
    if (overlayById.size === 0) return session;
    let changed = false;
    const nextMessages = messages.map((message) => {
      const live = overlayById.get(message.id);
      if (live === undefined || live === message.content) return message;
      changed = true;
      return { ...message, content: live };
    });
    return changed ? { ...session, messages: nextMessages } as T : session;
  }

  clearSession(sessionId: string): void {
    const prefix = `${sessionId}\0`;
    for (const key of [...this.liveContent.keys()]) {
      if (!key.startsWith(prefix)) continue;
      this.clearTimer(key);
      this.liveContent.delete(key);
      this.lastEmitAt.delete(key);
    }
  }

  dispose(): void {
    for (const cancel of this.cancelFlush.values()) cancel();
    this.cancelFlush.clear();
    this.liveContent.clear();
    this.lastEmitAt.clear();
  }

  private flushEmit(sessionId: string, messageId: string, content: string, now: number): void {
    const key = streamKey(sessionId, messageId);
    this.clearTimer(key);
    this.lastEmitAt.set(key, now);
    this.emitUpdate(sessionId, messageId, content);
  }

  private clearTimer(key: string): void {
    const cancel = this.cancelFlush.get(key);
    if (!cancel) return;
    cancel();
    this.cancelFlush.delete(key);
  }
}
