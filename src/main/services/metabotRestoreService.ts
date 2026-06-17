import { Buffer } from 'buffer';
import { fetchContentWithFallback, fetchJsonWithFallbackOnMiss } from './localIndexerProxy';

const METAID_INFO_BY_ADDRESS = 'https://file.metaid.io/metafile-indexer/api/v1/info/address';
const METAID_INFO_BY_METAID = 'https://file.metaid.io/metafile-indexer/api/v1/info/metaid';
const METAID_CONTENT_BASE = 'https://file.metaid.io/metafile-indexer/content';

export interface MetaidAddressInfo {
  globalMetaId?: string;
  globalMetaid?: string;
  metaid?: string;
  metaId?: string;
  pinId?: string;
  name?: string;
  nameId?: string;
  namePinId?: string;
  address?: string;
  avatar?: string;
  avatarId?: string;
  avatarPinId?: string;
  bio?: unknown;
  bioId?: string;
  bioPinId?: string;
  persona?: unknown;
  personaId?: string;
  personaPinId?: string;
  llm?: unknown;
  LLM?: unknown;
  llmId?: string;
  LLMId?: string;
  llmPinId?: string;
  LLMPinId?: string;
  chatSkills?: unknown;
  chatSkillsId?: string;
  chatSkillsPinId?: string;
  chatpubkey?: string;
  chatPublicKey?: string;
  chatpubkeyId?: string;
  chatPublicKeyPinId?: string;
}

export interface MetaidBioProfile {
  role: string;
  soul: string;
  goal: string | null;
  background: string | null;
  llm_id: string | null;
  tools: string[];
  skills: string[];
  allowChatSkills: string[];
  boss_id: number | null;
  boss_global_metaid: string | null;
  created_by: string;
}

export interface MetaidRestoreProfile {
  name: string;
  avatarDataUrl: string | null;
  /** Latest useful profile pin id among Bot Info profile paths; stored as local metabot_info_pinid. */
  metabotInfoPinId: string | null;
  chatpubkeyPinId: string | null;
  bio: MetaidBioProfile;
  raw: MetaidAddressInfo;
}

const normalizeString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const normalizeOptionalString = (value: unknown): string | null => {
  const normalized = normalizeString(value);
  return normalized ? normalized : null;
};

const normalizeFirstNonEmpty = (...values: unknown[]): string | null => {
  for (const value of values) {
    const normalized = normalizeOptionalString(value);
    if (normalized) return normalized;
  }
  return null;
};

const normalizeStringArray = (value: unknown): string[] => {
  if (!value) return [];
  if (Array.isArray(value)) {
    return dedupeStringArray(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return dedupeStringArray(parsed);
      }
    } catch {
      return dedupeStringArray(trimmed.split(','));
    }
  }
  return [];
};

const dedupeStringArray = (values: unknown[]): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
};

const normalizeBossId = (value: unknown): number | null => {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : null;
};

const parseJsonObject = (value: unknown): Record<string, unknown> | null => {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const looksLikeJsonObject = (value: string): boolean => parseJsonObject(value) !== null;

const parseLegacyMetaidBio = (bio: unknown): MetaidBioProfile => {
  const empty: MetaidBioProfile = {
    role: '',
    soul: '',
    goal: null,
    background: null,
    llm_id: null,
    tools: [],
    skills: [],
    allowChatSkills: [],
    boss_id: null,
    boss_global_metaid: null,
    created_by: '0000',
  };

  if (!bio) return empty;

  const raw = parseJsonObject(bio);
  if (!raw) return empty;

  return {
    role: normalizeString(raw.role),
    soul: normalizeString(raw.soul),
    goal: normalizeOptionalString(raw.goal),
    background: normalizeOptionalString(raw.background),
    llm_id: normalizeOptionalString(raw.llm ?? raw.llm_id),
    tools: normalizeStringArray(raw.tools),
    skills: normalizeStringArray(raw.skills),
    allowChatSkills: normalizeStringArray(raw.allowChatSkills ?? raw.allow_chat_skills),
    boss_id: normalizeBossId(raw.boss_id ?? raw.bossId),
    boss_global_metaid: normalizeOptionalString(raw.boss_global_metaid ?? raw.bossGlobalMetaId),
    created_by: normalizeString(raw.createdBy ?? raw.created_by) || '0000',
  };
};

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

const hasProtocolPinId = (...values: unknown[]): boolean => normalizeFirstNonEmpty(...values) !== null;

const hasProtocolPayload = (payload: unknown, ...pinIds: unknown[]): boolean => {
  if (payload !== null && payload !== undefined) return true;
  return hasProtocolPinId(...pinIds);
};

const parsePersonaPayload = (payload: unknown): {
  present: boolean;
  role: string;
  soul: string;
  goal: string | null;
} => {
  const raw = parseJsonObject(payload);
  return {
    present: true,
    role: raw ? normalizeString(raw.role) : '',
    soul: raw ? normalizeString(raw.soul) : '',
    goal: raw ? normalizeOptionalString(raw.goal) : null,
  };
};

const emptyPersonaPayload = (): {
  present: boolean;
  role: string;
  soul: string;
  goal: string | null;
} => {
  return { present: false, role: '', soul: '', goal: null };
};

const parseLlmPayload = (payload: unknown): { present: boolean; primaryProvider: string | null } => {
  const raw = parseJsonObject(payload);
  return {
    present: true,
    primaryProvider: raw ? normalizeOptionalString(raw.primaryProvider) : null,
  };
};

const emptyLlmPayload = (): { present: boolean; primaryProvider: string | null } => ({ present: false, primaryProvider: null });

const parseChatSkillsPayload = (payload: unknown): { present: boolean; allowChatSkills: string[] } => {
  const raw = parseJsonObject(payload);
  return {
    present: true,
    allowChatSkills: raw ? normalizeStringArray(raw.allowPrivateChatSkills) : [],
  };
};

const emptyChatSkillsPayload = (): { present: boolean; allowChatSkills: string[] } => ({ present: false, allowChatSkills: [] });

const resolveAvatarPinId = (avatar?: string | null, avatarId?: string | null): string | null => {
  const id = normalizeString(avatarId);
  if (id) return id;
  const raw = normalizeString(avatar);
  if (!raw) return null;
  const match = raw.match(/content\/([^/?#]+)$/);
  return match ? match[1] : null;
};

export function parseMetaidRestoreProfileInfo(info: MetaidAddressInfo): Pick<MetaidRestoreProfile, 'bio' | 'metabotInfoPinId' | 'chatpubkeyPinId' | 'raw'> {
  const legacy = parseLegacyMetaidBio(info.bio);
  const plainBio = typeof info.bio === 'string' && !looksLikeJsonObject(info.bio) ? normalizeOptionalString(info.bio) : null;
  const persona = (hasOwn(info, 'persona') || hasProtocolPinId(info.personaId, info.personaPinId))
    && hasProtocolPayload(info.persona, info.personaId, info.personaPinId)
    ? parsePersonaPayload(info.persona)
    : emptyPersonaPayload();
  const llm = (hasOwn(info, 'llm') || hasProtocolPinId(info.llmId, info.llmPinId))
    && hasProtocolPayload(info.llm, info.llmId, info.llmPinId)
    ? parseLlmPayload(info.llm)
    : (hasOwn(info, 'LLM') || hasProtocolPinId(info.LLMId, info.LLMPinId))
      && hasProtocolPayload(info.LLM, info.LLMId, info.LLMPinId)
      ? parseLlmPayload(info.LLM)
      : emptyLlmPayload();
  const chatSkills = (hasOwn(info, 'chatSkills') || hasProtocolPinId(info.chatSkillsId, info.chatSkillsPinId))
    && hasProtocolPayload(info.chatSkills, info.chatSkillsId, info.chatSkillsPinId)
    ? parseChatSkillsPayload(info.chatSkills)
    : emptyChatSkillsPayload();
  const avatarPinId = resolveAvatarPinId(
    info.avatar ?? null,
    normalizeFirstNonEmpty(info.avatarId, info.avatarPinId),
  );

  const bio: MetaidBioProfile = {
    ...legacy,
    background: plainBio ?? legacy.background,
    role: persona.present ? persona.role : legacy.role,
    soul: persona.present ? persona.soul : legacy.soul,
    goal: persona.present ? persona.goal : legacy.goal,
    llm_id: llm.present ? llm.primaryProvider : legacy.llm_id,
    allowChatSkills: chatSkills.present ? chatSkills.allowChatSkills : legacy.allowChatSkills,
  };

  return {
    bio,
    metabotInfoPinId: normalizeFirstNonEmpty(
      info.chatSkillsId,
      info.chatSkillsPinId,
      info.llmId,
      info.LLMId,
      info.llmPinId,
      info.LLMPinId,
      info.personaId,
      info.personaPinId,
      info.bioId,
      info.bioPinId,
      info.nameId,
      info.namePinId,
      avatarPinId,
      info.pinId,
    ),
    chatpubkeyPinId: normalizeFirstNonEmpty(info.chatpubkeyId, info.chatPublicKeyPinId),
    raw: info,
  };
}

const unwrapMetaidInfo = (payload: unknown): Record<string, unknown> | null => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const nested = record.MetaIdInfo ?? record.metaIdInfo ?? record.metaidInfo;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return {
      ...record,
      ...(nested as Record<string, unknown>),
    };
  }

  return record;
};

export function isSemanticallyEmptyMetaidInfoPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') {
    return true;
  }
  const data = (payload as { data?: unknown }).data;
  const info = unwrapMetaidInfo(data);
  if (!info) {
    return true;
  }
  const identityKeys = [
    'metaid',
    'metaId',
    'globalMetaId',
    'globalMetaid',
    'name',
    'address',
    'avatar',
    'avatarId',
    'avatarPinId',
    'chatpubkey',
    'chatPublicKey',
    'pinId',
    'nameId',
    'namePinId',
  ];
  const hasIdentityValue = identityKeys.some((key) => {
    const value = info[key];
    return typeof value === 'string' && value.trim().length > 0;
  });
  if (hasIdentityValue) {
    return false;
  }
  return info.isInit !== true;
}

const fetchMetaidInfo = async (localPath: string, remoteUrl: string): Promise<MetaidAddressInfo | null> => {
  const res = await fetchJsonWithFallbackOnMiss(localPath, remoteUrl, isSemanticallyEmptyMetaidInfoPayload);
  if (!res.ok) {
    throw new Error(`metaid info fetch failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { code?: number; message?: string; data?: MetaidAddressInfo };
  if (json?.code != null && json.code !== 1) {
    throw new Error(json?.message || 'metaid info response error');
  }
  return (unwrapMetaidInfo(json?.data) as MetaidAddressInfo | null) ?? null;
};

export const fetchMetaidInfoByAddress = async (address: string): Promise<MetaidAddressInfo | null> => {
  const trimmed = address.trim();
  if (!trimmed) return null;
  const url = `${METAID_INFO_BY_ADDRESS}/${encodeURIComponent(trimmed)}`;
  const localPath = `/api/v1/users/info/address/${encodeURIComponent(trimmed)}`;
  return fetchMetaidInfo(localPath, url);
};

export const fetchMetaidInfoByMetaid = async (metaid: string): Promise<MetaidAddressInfo | null> => {
  const trimmed = metaid.trim();
  if (!trimmed) return null;
  const url = `${METAID_INFO_BY_METAID}/${encodeURIComponent(trimmed)}`;
  const localPath = `/api/v1/users/info/metaid/${encodeURIComponent(trimmed)}`;
  return fetchMetaidInfo(localPath, url);
};

const fetchAvatarDataUrl = async (pinId: string): Promise<string | null> => {
  const trimmed = pinId.trim();
  if (!trimmed) return null;
  const url = `${METAID_CONTENT_BASE}/${encodeURIComponent(trimmed)}`;
  const res = await fetchContentWithFallback(trimmed, url);
  if (!res.ok) {
    throw new Error(`avatar fetch failed: ${res.status} ${res.statusText}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) return null;
  const mime = res.headers.get('content-type') || 'image/png';
  return `data:${mime};base64,${buffer.toString('base64')}`;
};

export const fetchMetaidRestoreProfile = async (address: string): Promise<MetaidRestoreProfile> => {
  const info = await fetchMetaidInfoByAddress(address);
  if (!info) {
    throw new Error('CHAIN_INFO_EMPTY');
  }
  const name = normalizeString(info.name);
  if (!name) {
    throw new Error('NAME_EMPTY');
  }
  const parsed = parseMetaidRestoreProfileInfo(info);
  const avatarPinId = resolveAvatarPinId(
    info.avatar ?? null,
    normalizeFirstNonEmpty(info.avatarId, info.avatarPinId),
  );
  let avatarDataUrl: string | null = null;
  if (avatarPinId) {
    try {
      avatarDataUrl = await fetchAvatarDataUrl(avatarPinId);
    } catch (err) {
      console.warn('[MetaBot] restore avatar fetch failed', err instanceof Error ? err.message : String(err));
    }
  }
  return {
    name,
    avatarDataUrl,
    metabotInfoPinId: parsed.metabotInfoPinId,
    chatpubkeyPinId: parsed.chatpubkeyPinId,
    bio: parsed.bio,
    raw: info,
  };
};
