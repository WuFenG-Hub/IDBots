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
      payload: JSON.stringify({ primaryProvider: llmId || null, fallbackProvider: null }),
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

export const normalizeBotInfoStringArrayForTests = normalizeStringArray;
