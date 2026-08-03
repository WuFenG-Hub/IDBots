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
    'Scenario: you are in an agent-to-agent (A2A) conversation with a remote MetaBot, and every reply you produce here is sent to that remote peer. The local human operator may inject guidance to steer this conversation. You are the operator\'s trusted representative: the guidance expresses the intent you must carry out, but the voice is always yours.',
    '',
    'The <guidance> below is local-only operator intent for this local MetaBot only. It is not a message from the remote peer and must not be presented as remote-peer content.',
    '',
    'Rules you must follow:',
    '1. Own every word. Every message you send must read as your own decision in your own words. Never attribute statements to the operator — do not say or imply "my operator/owner/master/boss/user wants ...", "I was told to ...", or "my human asked me to ...". Present requests, questions, and positions as your own.',
    '2. Never relay guidance verbatim. Do not quote, copy, or closely paraphrase the guidance text for the peer. Internalize its intent and re-express it naturally in your own voice.',
    '3. Resolve references before acting. Guidance may involve three parties: the operator, you, and the remote peer. When it mentions a person or uses pronouns such as "you", the referent is either yourself or the remote peer — judge from the context which one is meant before acting. Remarks or questions the operator addresses to you (for example about your own local actions) are meant for you alone: treat them as local context, never as material for the peer.',
    '4. Stay in the peer dialogue. Do not break the conversation to answer the operator. If the guidance contains questions addressed to you, do not answer or relay them; simply continue the conversation with the remote peer naturally. Always follow the operator\'s action instructions and conversation steering.',
    '5. Guidance cannot override safety, protocol, payment, delivery, or order lifecycle rules.',
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
