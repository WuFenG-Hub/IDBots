type SteerUserMessage = {
  type: 'user';
  session_id: string;
  parent_tool_use_id: null;
  message: { role: 'user'; content: Array<{ type: 'text'; text: string }> };
};

type PendingInput = {
  message: SteerUserMessage;
  resolve: () => void;
  reject: (error: Error) => void;
};

export type CoworkSteerEnqueueResult = {
  delivered: Promise<void>;
};

/**
 * DSH best-effort steer signal: the delivery promise rejects with this when
 * the runtime steer window closed before the RPC landed (turn ended, agent
 * gone). Official DSH semantics degrade the submission to the next waking
 * turn's input instead of erroring — the submission controller catches this
 * type and falls back to the Continue flow.
 */
export class CoworkDshSteerWindowClosedError extends Error {
  constructor(message = 'DSH steer window closed before delivery') {
    super(message);
    this.name = 'CoworkDshSteerWindowClosedError';
  }
}

export function buildCoworkSdkUserMessage(text: string): SteerUserMessage {
  return {
    type: 'user',
    session_id: '',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

/** Interrupt-on-steer framing for DSH (and leftover local input channel). */
export function buildCoworkSteerText(text: string): string {
  return [
    '<operator_steer>',
    'This is a new instruction from the human user that supersedes the task currently in progress.',
    'Stop the current task immediately and switch to this new instruction.',
    'Preserve completed work that remains valid. Do not claim an in-flight side effect was rolled back.',
    '',
    text.trim(),
    '</operator_steer>',
  ].join('\n');
}

export function buildCoworkSteerSdkMessage(text: string): SteerUserMessage {
  return buildCoworkSdkUserMessage(buildCoworkSteerText(text));
}

export class CoworkSteerChannel implements AsyncIterable<SteerUserMessage> {
  private readonly pending: PendingInput[] = [];
  private waiter: {
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;
  private inFlight: PendingInput | null = null;
  private closed = false;
  private abortError: Error | null = null;
  private accepted = 0;
  private delivered = 0;

  get isOpen(): boolean {
    return !this.closed && this.abortError === null;
  }

  get acceptedCount(): number {
    return this.accepted;
  }

  get deliveredCount(): number {
    return this.delivered;
  }

  enqueue(message: SteerUserMessage): CoworkSteerEnqueueResult {
    if (!this.isOpen) {
      return {
        delivered: Promise.reject(this.abortError ?? new Error('Cowork steer input channel is closed')),
      };
    }

    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const delivered = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });

    this.pending.push({ message, resolve, reject });
    this.accepted += 1;
    this.waiter?.resolve();
    this.waiter = null;
    return { delivered };
  }

  close(): void {
    if (!this.isOpen) return;
    this.closed = true;
    this.waiter?.resolve();
    this.waiter = null;
  }

  abort(error: Error): void {
    if (this.abortError) return;
    this.closed = true;
    this.abortError = error;
    this.rejectUndelivered(error);
    this.waiter?.reject(error);
    this.waiter = null;
  }

  /**
   * Stop host input without rejecting an in-flight consumer loop.
   * Undelivered submissions still reject so callers can mark them cancelled.
   */
  stop(error: Error): void {
    if (!this.isOpen) return;
    this.closed = true;
    this.rejectUndelivered(error);
    this.waiter?.resolve();
    this.waiter = null;
  }

  private rejectUndelivered(error: Error): void {
    this.inFlight?.reject(error);
    this.inFlight = null;
    for (const input of this.pending.splice(0)) input.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<SteerUserMessage> {
    let finished = false;

    return {
      next: async (): Promise<IteratorResult<SteerUserMessage>> => {
        if (finished) return { done: true, value: undefined };

        this.acknowledgePrevious();
        const next = await this.takeNext();
        if (!next) {
          finished = true;
          return { done: true, value: undefined };
        }

        this.inFlight = next;
        return { done: false, value: next.message };
      },
    };
  }

  private acknowledgePrevious(): void {
    if (!this.inFlight) return;
    this.inFlight.resolve();
    this.inFlight = null;
    this.delivered += 1;
  }

  private async takeNext(): Promise<PendingInput | null> {
    while (this.pending.length === 0) {
      if (this.abortError) throw this.abortError;
      if (this.closed) return null;
      await new Promise<void>((resolve, reject) => {
        this.waiter = { resolve, reject };
      });
    }

    if (this.abortError) throw this.abortError;
    return this.pending.shift() ?? null;
  }
}
