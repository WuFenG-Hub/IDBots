import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

type PendingInput = {
  message: SDKUserMessage;
  resolve: () => void;
  reject: (error: Error) => void;
};

export type CoworkSteerEnqueueResult = {
  delivered: Promise<void>;
};

export function buildCoworkSdkUserMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    session_id: '',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

export function buildCoworkSteerSdkMessage(text: string): SDKUserMessage {
  const escaped = text.trim();
  return buildCoworkSdkUserMessage([
    '<operator_steer>',
    'This is a new instruction from the human user that supersedes the task currently in progress.',
    'Stop the current task immediately and switch to this new instruction.',
    'Preserve completed work that remains valid. Do not claim an in-flight side effect was rolled back.',
    '',
    escaped,
    '</operator_steer>',
  ].join('\n'));
}

export class CoworkSteerChannel implements AsyncIterable<SDKUserMessage> {
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

  enqueue(message: SDKUserMessage): CoworkSteerEnqueueResult {
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
   * Stop host input without rejecting the SDK's detached streamInput loop.
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

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    let finished = false;

    return {
      next: async (): Promise<IteratorResult<SDKUserMessage>> => {
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
