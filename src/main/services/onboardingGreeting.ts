/**
 * First-run onboarding greeting: the last-resort assistant message for a Twin
 * Bot chat whose opening turn never greeted anyone.
 *
 * The onboarding chat is created by `cowork:session:createGreeting`, which both
 * creates the session and starts one agent turn driven by the onboarding system
 * prompt. When that turn cannot start, or dies on the way (offline, free quota
 * exhausted, model misconfigured), the session would otherwise open with an
 * error trail and no greeting; this helper seeds the localized fallback text
 * instead, so the very first screen a new user sees is never empty.
 *
 * Lives outside main.ts so the behaviour can be exercised against a real
 * CoworkStore with a fake runner (see tests).
 */

export interface GreetingFallbackStore {
  getSession: (sessionId: string) => {
    status?: 'idle' | 'running' | 'completed' | 'error' | 'error_retried' | 'stopped';
    messages: Array<{ type: string; content?: string }>;
  } | null;
  addMessage: (sessionId: string, message: {
    type: 'assistant';
    content: string;
    metadata: Record<string, unknown>;
  }) => { id: string };
  updateSession: (
    sessionId: string,
    session: { status: 'idle' | 'running' | 'completed' | 'error' | 'error_retried' | 'stopped' },
  ) => unknown;
}

export interface SeedGreetingFallbackInput {
  store: GreetingFallbackStore;
  sessionId: string;
  fallbackGreeting: string;
  /** Whether the greeting turn is still live (false = the session is idle again). */
  isSessionActive: (sessionId: string) => boolean;
  /** Push the seeded message to open renderers (same channel as stream traffic). */
  emitMessage: (sessionId: string, message: unknown) => void;
}

export type SeedGreetingFallbackOutcome = 'seeded' | 'skipped-has-greeting' | 'skipped-no-session';

/**
 * Seed the fallback greeting unless the bot already produced assistant text.
 *
 * The guard is what makes this safe to call on every exit path of the greeting
 * turn: a chat where the bot actually greeted is left untouched, including the
 * case where the user already replied to it.
 */
export function seedGreetingFallbackIfMissing(
  input: SeedGreetingFallbackInput,
): SeedGreetingFallbackOutcome {
  const session = input.store.getSession(input.sessionId);
  if (!session) {
    return 'skipped-no-session';
  }
  const hasAssistantText = session.messages.some(
    (message) => message.type === 'assistant' && Boolean(message.content?.trim()),
  );
  if (hasAssistantText) {
    return 'skipped-has-greeting';
  }
  const message = input.store.addMessage(input.sessionId, {
    type: 'assistant',
    content: input.fallbackGreeting,
    metadata: { hostGreeting: true },
  });
  input.emitMessage(input.sessionId, message);
  // A failed turn can leave the row 'running' when nothing settled it; release
  // it so the renderer does not show a typing indicator for a dead turn.
  if (session.status === 'running' && !input.isSessionActive(input.sessionId)) {
    input.store.updateSession(input.sessionId, { status: 'idle' });
  }
  return 'seeded';
}
