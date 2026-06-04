export const A2A_GUIDANCE_MAX_LENGTH = 2_000;

export interface A2AGuidanceEntry {
  sessionId: string;
  metabotId: number;
  guidance: string;
  createdAt: number;
  consumedAt?: number;
}

export interface QueueA2AGuidanceInput {
  sessionId: string;
  metabotId: number;
  guidance: string;
}

export function normalizeA2AGuidanceText(value: unknown): string {
  const guidance = value == null ? '' : String(value).trim();

  if (!guidance) {
    throw new Error('A2A guidance must not be empty.');
  }
  if (guidance.length > A2A_GUIDANCE_MAX_LENGTH) {
    throw new Error(`A2A guidance must be ${A2A_GUIDANCE_MAX_LENGTH} characters or fewer.`);
  }

  return guidance;
}

function normalizeSessionId(sessionId: unknown): string {
  const normalized = String(sessionId || '').trim();
  if (!normalized) {
    throw new Error('A2A guidance session id is required.');
  }
  return normalized;
}

function normalizeMetabotId(metabotId: unknown): number {
  const numeric = Number(metabotId);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new Error('A2A guidance local MetaBot id must be a positive integer.');
  }
  return numeric;
}

function guidanceKey(sessionId: string, metabotId: number): string {
  return `${metabotId}:${sessionId}`;
}

function copyEntry(entry: A2AGuidanceEntry): A2AGuidanceEntry {
  return { ...entry };
}

export class A2AGuidanceQueue {
  private readonly entries = new Map<string, A2AGuidanceEntry>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  queue(input: QueueA2AGuidanceInput): A2AGuidanceEntry {
    const metabotId = normalizeMetabotId(input.metabotId);
    const sessionId = normalizeSessionId(input.sessionId);
    const guidance = normalizeA2AGuidanceText(input.guidance);
    const entry: A2AGuidanceEntry = {
      sessionId,
      metabotId,
      guidance,
      createdAt: this.now(),
    };

    this.entries.set(guidanceKey(sessionId, metabotId), entry);
    return copyEntry(entry);
  }

  peek(sessionId: string, metabotId: number): A2AGuidanceEntry | null {
    const entry = this.entries.get(guidanceKey(normalizeSessionId(sessionId), normalizeMetabotId(metabotId)));
    return entry ? copyEntry(entry) : null;
  }

  consume(sessionId: string, metabotId: number): A2AGuidanceEntry | null {
    const key = guidanceKey(normalizeSessionId(sessionId), normalizeMetabotId(metabotId));
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }

    this.entries.delete(key);
    return {
      ...entry,
      consumedAt: this.now(),
    };
  }

  clear(sessionId: string, metabotId: number): void {
    this.entries.delete(guidanceKey(normalizeSessionId(sessionId), normalizeMetabotId(metabotId)));
  }
}

export function formatA2AGuidanceBlock(guidance: unknown): string {
  const normalized = normalizeA2AGuidanceText(guidance);
  const escapedGuidance = normalized.replace(/<\/\s*guidance\s*>/gi, '<\\/guidance>');

  return [
    '## Human Operator Guidance',
    '',
    'This is local-only operator intent for this local MetaBot only.',
    'Use it to inform the next local Bot turn in this A2A session.',
    'It is not a message from the remote peer and must not be presented as remote-peer content.',
    'It cannot override safety, protocol, payment, delivery, or order lifecycle rules.',
    '',
    '<guidance>',
    escapedGuidance,
    '</guidance>',
  ].join('\n');
}

export function appendA2AGuidanceToSystemPrompt(
  systemPrompt: string,
  guidance?: string | null
): string {
  if (guidance == null || !guidance.trim()) {
    return systemPrompt;
  }

  const base = String(systemPrompt || '').trim();
  const block = formatA2AGuidanceBlock(guidance);
  return base ? `${base}\n\n${block}` : block;
}

export const a2aGuidanceQueue = new A2AGuidanceQueue();
