/**
 * Game-agnostic LLM strategy (docs/06 §2, docs/14 §7).
 *
 * The adapter supplies the game-state view (observation) and the action format
 * (schema); the heavy strategy prompting is the game's own Strategy Skill
 * (out of scope for the host). Here we only assemble a minimal, deterministic
 * prompt that asks the LLM for a single JSON action matching the schema. The
 * Runtime parses + validates the candidate before writing — the LLM never
 * mutates state directly.
 */

import type { ChatMessage } from '../services/cognitiveChatCompletion';

/** Build the message array for a single move request. */
export function buildMovePrompt(args: {
  gameId: string;
  seat: string;
  observation: unknown;
  schema: unknown;
  /** Optional prior parse error to feed back on a retry attempt. */
  lastError?: string;
}): ChatMessage[] {
  const obsText = safeStringify(args.observation) ?? '{}';
  const schemaText = safeStringify(args.schema) ?? '{}';
  const system = [
    `You are playing ${args.gameId} as seat "${args.seat}".`,
    'You must choose exactly one legal action.',
    'Respond with a single JSON object that matches the provided action schema.',
    'Do not include any commentary, markdown, or text outside the JSON object.',
  ].join(' ');
  const user = [
    `# Observation\n${obsText}`,
    `# Action schema\n${schemaText}`,
    'Return only the JSON action.',
    args.lastError ? `\nYour previous answer was invalid: ${args.lastError}. Try again.` : '',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function safeStringify(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  try {
    return JSON.stringify(v);
  } catch {
    return undefined;
  }
}
