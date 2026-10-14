/**
 * Turn-acknowledgment phrase pools + shuffle-bag drawing — the renderer half
 * of the cerebellum turn-ack feature (owner-endorsed 2026-10-14).
 *
 * The main process resolves the turn's difficulty tier from the #11 effort
 * verdict (off/low → fast, high → moderate, max → heavy, no verdict →
 * generic) and emits a `sdkRuntimeStatus: 'turnAck'` system message BEFORE
 * the brain call. The activity indicators render a phrase for that tier
 * while the user waits for the first visible token — the "assistant
 * acknowledges the task first" experience.
 *
 * The pools deliberately live here instead of i18n.ts: they are ARRAYS of
 * UI copy (10/8/7/6 phrases per tier), and the i18n `t()` mechanism only
 * carries flat strings. Both languages are provided so the repo's bilingual
 * UI-copy rule holds; `i18nService.getLanguage()` picks the pool.
 *
 * Randomness: a per-(session, language, tier) SHUFFLE BAG, not a plain
 * random pick — pure random repeats the same phrase back-to-back often
 * enough to feel mechanical; the bag draws without replacement and refills
 * (reshuffled) only when empty, guaranteeing pool-size consecutive draws
 * never repeat. One ack message id maps to one stable phrase (drawing is
 * idempotent per message), so a React re-render never re-rolls the text.
 *
 * Pure and dependency-free so it is unit-testable in plain Node.
 */

export type TurnAckTier = 'fast' | 'moderate' | 'heavy' | 'generic';

export type TurnAckLanguage = 'zh' | 'en';

/**
 * Owner-approved phrase pools (zh originals approved 2026-10-14; en mirrors
 * the same voice). Pool sizes are deliberate: the fast tier carries the most
 * turns and needs the most ammunition; rarer tiers need less.
 */
export const TURN_ACK_PHRASE_POOLS: Record<TurnAckLanguage, Record<TurnAckTier, readonly string[]>> = {
  zh: {
    fast: [
      '好的，马上处理。',
      '收到，这就去办。',
      '明白，现在就做。',
      '好，交给我。',
      '行，马上来。',
      '收到，正在处理。',
      '好的，很快就好。',
      '没问题，这就开始。',
      '好，稍等一下下。',
      '收到，马上给你结果。',
    ],
    moderate: [
      '这个需要一点时间，请稍等。',
      '好的，我处理一下，稍等片刻。',
      '收到，这个要花点工夫，稍等我一下。',
      '好，我整理一下再回复你。',
      '这个我需要查一查，稍微等一下。',
      '嗯，这个有点工作量，我尽快。',
      '收到，我先梳理一下，稍等。',
      '好，让我想一想再答你。',
    ],
    heavy: [
      '这是个比较复杂的任务，可能需要几分钟，请稍等。',
      '这个有点难度，我需要多一点时间处理。',
      '收到，这个比较大，我会分步处理，请耐心等一下。',
      '好，这个要仔细做，需要一些时间。',
      '这个任务不简单，我认真处理中，稍等。',
      '明白，这个需要深入处理，可能要几分钟。',
      '收到，复杂任务，我加紧处理，有进展先告诉你。',
    ],
    generic: [
      '收到，正在处理…',
      '好的，我来处理。',
      '嗯，正在想…',
      '收到，稍等。',
      '好，正在处理，马上。',
      '我看一下，稍等。',
    ],
  },
  en: {
    fast: [
      'On it right away.',
      'Got it, doing it now.',
      'Understood, on it.',
      'Sure, leave it to me.',
      'Right, coming right up.',
      'Got it, working on it.',
      'Okay, done in a moment.',
      'No problem, starting now.',
      'Sure, just a second.',
      'Got it, results coming right up.',
    ],
    moderate: [
      'This one needs a moment — please hold on.',
      'Sure, give me a moment to handle this.',
      'Got it, this takes a bit of work — one moment.',
      'Okay, let me pull this together and get back to you.',
      'I need to look into this — just a moment.',
      'Hmm, this has some heft to it — I\'ll be as quick as I can.',
      'Got it, let me sort this out first — one moment.',
      'Okay, let me think it through before answering.',
    ],
    heavy: [
      'This is a fairly complex task — it may take a few minutes, please wait.',
      'This one is tricky; I\'ll need some extra time.',
      'Got it — this is a big one, I\'ll work through it step by step; your patience appreciated.',
      'Okay, this needs care — it\'ll take some time.',
      'Not a simple task — working on it carefully, one moment.',
      'Understood — this needs deep work and may take a few minutes.',
      'Got it, complex task — I\'m on it and will update you as I make progress.',
    ],
    generic: [
      'Got it, working on it…',
      'Okay, I\'ll handle this.',
      'Hmm, thinking…',
      'Got it, one moment.',
      'Okay, on it — won\'t be long.',
      'Let me take a look — one moment.',
    ],
  },
};

const FALLBACK_PHRASES: Record<TurnAckLanguage, string> = {
  zh: '收到，正在处理…',
  en: 'Got it, working on it…',
};

/** Draw bags keyed by `${sessionId}|${language}|${tier}` (draw without replacement). */
const bagsByKey = new Map<string, string[]>();

/** One stable phrase per ack message id, so re-renders never re-roll. */
const phraseByAckMessageId = new Map<string, string>();

const MAX_REMEMBERED_ACK_DRAWS = 128;

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function drawFromBag(bagKey: string, pool: readonly string[]): string {
  let bag = bagsByKey.get(bagKey);
  if (!bag || bag.length === 0) {
    bag = shuffle([...pool]);
    bagsByKey.set(bagKey, bag);
  }
  return bag.shift() as string;
}

/**
 * The phrase for one turn-ack message. Idempotent per ackMessageId: the
 * first call draws from the session's shuffle bag for (language, tier);
 * every later call for the same message returns the remembered phrase.
 */
export function drawTurnAckPhrase(input: {
  sessionId?: string | null;
  tier: TurnAckTier;
  language: TurnAckLanguage;
  ackMessageId: string;
}): string {
  const remembered = phraseByAckMessageId.get(input.ackMessageId);
  if (remembered !== undefined) {
    return remembered;
  }
  const language: TurnAckLanguage = input.language === 'zh' ? 'zh' : 'en';
  const tier: TurnAckTier = input.tier in TURN_ACK_PHRASE_POOLS[language]
    ? input.tier
    : 'generic';
  const pool = TURN_ACK_PHRASE_POOLS[language][tier];
  const phrase = pool.length > 0
    ? drawFromBag(`${input.sessionId ?? 'global'}|${language}|${tier}`, pool)
    : FALLBACK_PHRASES[language];
  if (phraseByAckMessageId.size >= MAX_REMEMBERED_ACK_DRAWS) {
    const oldest = phraseByAckMessageId.keys().next().value;
    if (oldest !== undefined) {
      phraseByAckMessageId.delete(oldest);
    }
  }
  phraseByAckMessageId.set(input.ackMessageId, phrase);
  return phrase;
}

/** Test seam: forget a specific ack draw (and optionally drop every bag). */
export function resetTurnAckDrawing(ackMessageId?: string, dropBags = false): void {
  if (ackMessageId !== undefined) {
    phraseByAckMessageId.delete(ackMessageId);
  } else {
    phraseByAckMessageId.clear();
  }
  if (dropBags) {
    bagsByKey.clear();
  }
}

const VALID_TIERS: readonly TurnAckTier[] = ['fast', 'moderate', 'heavy', 'generic'];

/**
 * Scan the CONTIGUOUS tail run of runtime-status messages (newest backwards,
 * stopping at the first non-status message) for a 'turnAck' signal with a
 * valid tier. Shared by both activity indicators: once real content streams,
 * the run ends and the ack stops applying, so the phrase can never outlive
 * the wait it describes.
 */
export function findTailTurnAck(
  messages: ReadonlyArray<{
    id?: unknown;
    metadata?: Record<string, unknown> | null;
  }>,
): { tier: TurnAckTier; messageId: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const status = msg.metadata?.sdkRuntimeStatus;
    if (typeof status !== 'string') break;
    if (status === 'turnAck') {
      const tier = msg.metadata?.turnAckTier;
      if (typeof tier === 'string' && (VALID_TIERS as readonly string[]).includes(tier)) {
        return { tier: tier as TurnAckTier, messageId: String(msg.id ?? '') };
      }
    }
  }
  return null;
}
