/**
 * Cerebellum (小脑) memory re-ranker — the first real call site of the
 * optional fast decision model (TypeSafe JEV, POST {baseUrl}/v1/systemone).
 *
 * One request carries one state (the current user message + the candidate
 * memory pool) and one Noul question per candidate: each question asks
 * whether that memory is useful context for replying to the current message,
 * and the returned noul probability (0..1) becomes the entry's relevance
 * score downstream.
 *
 * Pure and Electron-free so it is unit-testable in plain Node; the caller
 * injects the fetch implementation. In the app this MUST be
 * session.defaultSession.fetch: the Electron net stack follows the system
 * proxy, while bare Node fetch is region-blocked (HTTP 451) for some users.
 *
 * Failure contract: rankMemoriesWithCerebellum NEVER throws and returns null
 * on HTTP errors, network errors, abort/timeout, and malformed payloads, so
 * the recall path always falls back to the lexical ranker silently.
 */

import type { ResolvedCerebellumConfig } from '../libs/cerebellumConfig';

/**
 * Minimal structural subset of fetch. Both Electron's session.fetch and
 * Node's global fetch satisfy it; tests inject fakes.
 */
export type CerebellumFetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Per-turn prompt assembly must never stall on the cerebellum: one ranking
 * call gets a hard abort deadline, after which the turn proceeds with the
 * lexical ranking.
 */
export const CEREBELLUM_MEMORY_RANK_TIMEOUT_MS = 1500;

/**
 * Candidate cap for one /v1/systemone request — state size and question
 * count both scale linearly with the pool. Candidates beyond the cap keep
 * their lexical score downstream (they are simply absent from the score map).
 */
export const CEREBELLUM_MEMORY_MAX_CANDIDATES = 200;

/**
 * Below this combined pool size the lexical ranker is already adequate and a
 * cerebellum round-trip is not worth its latency — skip the call entirely.
 */
export const CEREBELLUM_MEMORY_MIN_POOL = 12;

export interface CerebellumMemoryCandidate {
  id: string;
  text: string;
}

/**
 * Noul instruction template for the per-memory relevance question. ONE
 * template so the wording stays tunable in a single place; `{{INDEX}}` is
 * replaced with the candidate's position in `state.memories`. Instructions
 * are in English per TypeSafe's English-primary guidance and reference state
 * fields by backticked dot-index path; the state itself carries the user's
 * original (often Chinese) text.
 */
export const CEREBELLUM_MEMORY_RANK_INSTRUCTIONS =
  'Would the memory at `memories[{{INDEX}}].text` be useful context for the assistant ' +
  "when replying to the user's current message at `current_message`? " +
  'Useful means the memory contains a durable fact, preference, commitment, or prior ' +
  'instruction about the user that is relevant to this specific message — not merely ' +
  'shared keywords.';

export const CEREBELLUM_MEMORY_RANK_CRITERIA = {
  true: 'Replying to the current message would be noticeably better with this memory in context.',
  false: 'This memory is unrelated to the current message, or only shares surface words.',
} as const;

export interface CerebellumNoulQuestion {
  type: 'noul';
  instructions: string;
  criteria: { true: string; false: string };
}

export interface CerebellumMemoryRankRequest {
  state: {
    current_message: string;
    memories: CerebellumMemoryCandidate[];
  };
  model: string;
  questions: Record<string, CerebellumNoulQuestion>;
}

export function cerebellumMemoryQuestionId(index: number): string {
  return `mem_${index}`;
}

/** One Noul question per candidate memory, all evaluated against the same state. */
export function buildMemoryRankQuestions(count: number): Record<string, CerebellumNoulQuestion> {
  const questions: Record<string, CerebellumNoulQuestion> = {};
  for (let index = 0; index < count; index += 1) {
    questions[cerebellumMemoryQuestionId(index)] = {
      type: 'noul',
      instructions: CEREBELLUM_MEMORY_RANK_INSTRUCTIONS.replaceAll('{{INDEX}}', String(index)),
      criteria: { ...CEREBELLUM_MEMORY_RANK_CRITERIA },
    };
  }
  return questions;
}

export function buildMemoryRankRequest(input: {
  currentUserText: string;
  memories: CerebellumMemoryCandidate[];
  model: string;
}): CerebellumMemoryRankRequest {
  const memories = input.memories.map((memory) => ({ id: memory.id, text: memory.text }));
  return {
    state: {
      current_message: input.currentUserText,
      memories,
    },
    model: input.model,
    questions: buildMemoryRankQuestions(memories.length),
  };
}

/**
 * Map answers back to memory ids: `answers[mem_<i>]` belongs to
 * `memories[i]`. Missing, non-object, or non-numeric-noul answers are
 * skipped — those ids simply keep their lexical score downstream. Returns
 * null only when the payload shape itself is unusable (no `answers` object).
 */
export function parseMemoryRankAnswers(
  payload: unknown,
  memories: readonly CerebellumMemoryCandidate[],
): Map<string, number> | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const answers = (payload as { answers?: unknown }).answers;
  if (!answers || typeof answers !== 'object') {
    return null;
  }
  const scores = new Map<string, number>();
  for (let index = 0; index < memories.length; index += 1) {
    const answer = (answers as Record<string, unknown>)[cerebellumMemoryQuestionId(index)];
    if (!answer || typeof answer !== 'object') {
      continue;
    }
    const noul = (answer as { noul?: unknown }).noul;
    if (typeof noul !== 'number' || !Number.isFinite(noul)) {
      continue;
    }
    scores.set(memories[index].id, noul);
  }
  return scores;
}

export async function rankMemoriesWithCerebellum(input: {
  config: ResolvedCerebellumConfig;
  fetchImpl: CerebellumFetchLike;
  currentUserText: string;
  memories: CerebellumMemoryCandidate[];
  timeoutMs?: number;
}): Promise<Map<string, number> | null> {
  const { config, fetchImpl, currentUserText } = input;
  const memories = input.memories.slice(0, CEREBELLUM_MEMORY_MAX_CANDIDATES);
  if (!currentUserText.trim() || memories.length === 0) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, input.timeoutMs ?? CEREBELLUM_MEMORY_RANK_TIMEOUT_MS),
  );
  try {
    const response = await fetchImpl(`${config.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildMemoryRankRequest({
        currentUserText,
        memories,
        model: config.model,
      })),
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return parseMemoryRankAnswers(await response.json(), memories);
  } catch {
    // Network errors, aborts/timeouts and JSON parse failures all land here:
    // the caller falls back to lexical ranking silently.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
