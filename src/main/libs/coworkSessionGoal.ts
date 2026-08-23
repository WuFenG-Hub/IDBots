/**
 * Session goal for the composer's /goal command (host-side port of the DSH
 * goal feature). The DSH version keeps goal state in session-log events and
 * auto-schedules rounds through a round driver; IDBots stores the goal on the
 * session row and injects it as a per-turn prompt section for the DSH and
 * Claude paths alike. Auto-continuation rounds are deliberately out of scope
 * for this port.
 */

export interface CoworkSessionGoal {
  /** The objective text. */
  text: string;
  /** 'active' goals are injected each turn; 'paused' goals are only visible. */
  status: 'active' | 'paused';
  updatedAt: number;
}

/** Parse the cowork_sessions.goal column (JSON); null/invalid → null. */
export function parseSessionGoal(column: string | null | undefined): CoworkSessionGoal | null {
  if (!column) return null;
  try {
    const parsed = JSON.parse(column) as { text?: unknown; status?: unknown; updatedAt?: unknown };
    if (typeof parsed.text !== 'string' || !parsed.text.trim()) return null;
    const status = parsed.status === 'paused' ? 'paused' : 'active';
    return {
      text: parsed.text,
      status,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

/** Serialize a goal for the cowork_sessions.goal column. */
export function serializeSessionGoal(goal: CoworkSessionGoal): string {
  return JSON.stringify({
    text: goal.text,
    status: goal.status,
    updatedAt: goal.updatedAt,
  });
}

/**
 * The per-turn prompt section for an active goal — the persistent counterpart
 * of DSH's per-round `<goal_round>` injection: state the objective and keep
 * driving toward it until it is fully achieved.
 */
export function buildGoalPromptSection(goal: CoworkSessionGoal): string {
  return [
    '<session_goal>',
    goal.text.trim(),
    '</session_goal>',
    '',
    'You are working toward the session goal above. Keep driving the task forward until the goal is fully achieved. Ask for human input only when the goal itself requires a decision you cannot make; when the goal is achieved, state clearly that it is complete.',
  ].join('\n');
}
