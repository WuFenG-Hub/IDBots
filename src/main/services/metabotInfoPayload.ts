export type MetabotInfoStep = 'bio' | 'persona' | 'llm' | 'chatSkills';
export type MetabotInfoPath = '/info/bio' | '/info/persona' | '/info/llm' | '/info/chatSkills';

export interface MetabotInfoPayloadInput {
  role?: string | null;
  soul?: string | null;
  goal?: string | null;
  bio?: string | null;
  /** Deprecated local compatibility field; v3 Bot Info uses `bio`. */
  background?: string | null;
  llm_id?: string | null;
  /** Provider key the primary brain model was picked from. */
  llm_provider?: string | null;
  /** Reasoning effort for the primary brain (off/low/high/max). */
  llm_effort?: string | null;
  /** Optional fallback brain published in /info/llm. */
  fallback_llm_id?: string | null;
  fallback_llm_provider?: string | null;
  fallback_llm_effort?: string | null;
  allow_chat_skills?: unknown;
}

export interface MetabotInfoPayload {
  step: MetabotInfoStep;
  path: MetabotInfoPath;
  contentType: 'text/plain' | 'application/json';
  payload: string;
}

function cleanString(value: string | null | undefined): string {
  return value?.trim() || '';
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return dedupeStrings(value);
  }

  if (typeof value !== 'string') {
    return [];
  }

  const trimmed = cleanString(value);
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return dedupeStrings(parsed);
    }
  } catch {
    // Fall back to comma-separated parsing below.
  }

  return dedupeStrings(trimmed.split(','));
}

function dedupeStrings(values: unknown[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (value === null || value === undefined) {
      continue;
    }

    const item = cleanString(String(value));
    if (!item || seen.has(item)) {
      continue;
    }

    seen.add(item);
    normalized.push(item);
  }

  return normalized;
}

export function buildMetabotInfoPayloads(input: MetabotInfoPayloadInput): MetabotInfoPayload[] {
  const hasBio = Object.prototype.hasOwnProperty.call(input, 'bio');
  const bio = cleanString(hasBio ? input.bio : input.background);
  const role = cleanString(input.role);
  const soul = cleanString(input.soul);
  const goal = cleanString(input.goal);
  const llmId = cleanString(input.llm_id);
  const llmProvider = cleanString(input.llm_provider);
  const llmEffort = cleanString(input.llm_effort);
  const fallbackLlmId = cleanString(input.fallback_llm_id);
  const fallbackLlmProvider = cleanString(input.fallback_llm_provider);
  const fallbackLlmEffort = cleanString(input.fallback_llm_effort);
  const allowChatSkills = normalizeStringArray(input.allow_chat_skills);

  return [
    {
      step: 'bio',
      path: '/info/bio',
      contentType: 'text/plain',
      payload: bio,
    },
    {
      step: 'persona',
      path: '/info/persona',
      contentType: 'application/json',
      payload: JSON.stringify({ role, soul, goal }),
    },
    {
      step: 'llm',
      path: '/info/llm',
      contentType: 'application/json',
      // Brains are model-level since 2026-08: primaryProvider/fallbackProvider
      // keep their names for backward compatibility but now carry the MODEL id
      // (legacy pins carry a provider key and still restore fine); the new
      // primary*/fallback* fields add the provider hint and effort.
      payload: JSON.stringify({
        primaryProvider: llmId || null,
        primaryModel: llmId || null,
        ...(llmProvider ? { primaryModelProvider: llmProvider } : {}),
        ...(llmEffort ? { primaryEffort: llmEffort } : {}),
        fallbackProvider: fallbackLlmId || null,
        fallbackModel: fallbackLlmId || null,
        ...(fallbackLlmProvider ? { fallbackModelProvider: fallbackLlmProvider } : {}),
        ...(fallbackLlmEffort ? { fallbackEffort: fallbackLlmEffort } : {}),
      }),
    },
    {
      step: 'chatSkills',
      path: '/info/chatSkills',
      contentType: 'application/json',
      payload: JSON.stringify({
        allowPrivateChatSkills: allowChatSkills,
        allowGroupChatSkills: allowChatSkills,
      }),
    },
  ];
}

import { serializeMetabotHomepagePayload, parseHomepage } from './metabotHomepage';

export const normalizeBotInfoStringArrayForTests = normalizeStringArray;

export interface MetabotHomepagePayload {
  step: 'homepage';
  path: '/info/homepage';
  contentType: 'application/json';
  payload: string; // compact JSON or '' for Default
}

/** Build the /info/homepage payload from a stored homepage JSON string. '' (Default) when null/invalid. */
export function buildMetabotHomepagePayload(homepageJson: string | null | undefined): MetabotHomepagePayload {
  const homepage = parseHomepage(homepageJson);
  return {
    step: 'homepage',
    path: '/info/homepage',
    contentType: 'application/json',
    payload: serializeMetabotHomepagePayload(homepage),
  };
}
