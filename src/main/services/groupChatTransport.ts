/**
 * Group chat transport service: on-chain pin writes (create/join/send) for MetaWeb
 * group chats, plus an indexer-readiness poll. Consolidates logic that previously
 * existed only as an inline arrow function in main.ts and inside skill scripts.
 *
 * Payload references:
 * - Create body mirrors idchat production createChannel (idchat/src/utils/talk.ts:724-741).
 * - Join body matches SKILLs/metabot-chat-groupchat/scripts/index.js (simplegroupjoin).
 * - Send body matches the former inline sender in main.ts (simplegroupchat, AES).
 */

import type { MetabotStore } from '../metabotStore';
import { createPin } from './metaidCore';
import { encryptGroupMessageECB } from './metaWebCrypto';

export interface CreateGroupChatOptions {
  groupName: string;
  groupNote?: string;
}

export interface JoinGroupChatOptions {
  referrer?: string;
}

export interface SendGroupChatMessageOptions {
  content: string;
  nickName?: string;
  contentType?: string;
  replyPin?: string;
  mention?: string[];
}

/** Dual indexer endpoints, same pair as privateChatHistorySyncService. */
const GROUP_INFO_ENDPOINTS = ['https://api.idchat.io', 'https://www.show.now'];

const DEFAULT_INDEX_TIMEOUT_MS = 60_000;
const INDEX_POLL_INTERVAL_MS = 2_000;

// Dependency injection for MetabotStore, mirroring libs/claudeSettings.ts setStoreGetter:
// main.ts wires its getMetabotStore() here once during startup.
let metabotStoreGetter: (() => MetabotStore) | null = null;

export function setGroupChatTransportMetabotStoreGetter(getter: () => MetabotStore): void {
  metabotStoreGetter = getter;
}

function getMetabotStore(): MetabotStore {
  if (!metabotStoreGetter) {
    throw new Error(
      'groupChatTransport not initialized: call setGroupChatTransportMetabotStoreGetter first'
    );
  }
  return metabotStoreGetter();
}

/**
 * Create a public group chat on-chain (/protocols/simplegroupcreate).
 * Body mirrors idchat createChannel (idchat/src/utils/talk.ts:724-741) for a public
 * text group; groupIcon added per the SimpleGroupCreate protocol doc
 * (SKILLs/metabot-omni-caster/references/03-group-management.md). The returned pinId
 * (<txid>i0) IS the canonical on-chain groupId (the indexer overrides the body
 * field), so the body groupId is left empty.
 */
export async function createGroupChat(
  metabotId: number,
  opts: CreateGroupChatOptions
): Promise<{ groupId: string; pinId: string }> {
  const body = {
    groupId: '',
    communityId: '',
    groupName: opts.groupName,
    groupNote: opts.groupNote ?? '',
    groupIcon: '',
    groupType: '1', // idchat PublicText: '1' = AES-encrypted messages
    status: '1',
    type: '0', // public
    tickId: '',
    collectionId: '',
    limitAmount: '',
    chatSettingType: 0, // everyone may speak
    deleteStatus: 0,
    path: '',
    timestamp: Math.floor(Date.now() / 1000), // idchat uses seconds
  };
  const result = await createPin(getMetabotStore(), metabotId, {
    operation: 'create',
    path: '/protocols/simplegroupcreate',
    contentType: 'application/json',
    payload: JSON.stringify(body),
  });
  return { groupId: result.pinId, pinId: result.pinId };
}

/**
 * Join a public group chat on-chain (/protocols/simplegroupjoin, state 1).
 * Public groups use an empty k (no transferable key).
 */
export async function joinGroupChat(
  metabotId: number,
  groupId: string,
  opts?: JoinGroupChatOptions
): Promise<{ pinId: string }> {
  const body = {
    groupId,
    state: 1,
    referrer: opts?.referrer ?? '',
    k: '',
  };
  const result = await createPin(getMetabotStore(), metabotId, {
    operation: 'create',
    path: '/protocols/simplegroupjoin',
    contentType: 'application/json',
    payload: JSON.stringify(body),
  });
  return { pinId: result.pinId };
}

/**
 * Send an AES-encrypted message to a group chat (/protocols/simplegroupchat).
 * Same body as the former inline sender in main.ts, with optional reply/mention.
 */
export async function sendGroupChatMessage(
  metabotId: number,
  groupId: string,
  opts: SendGroupChatMessageOptions
): Promise<{ pinId: string }> {
  const encryptedContent = encryptGroupMessageECB(opts.content, groupId);
  const body = {
    groupId,
    nickName: opts.nickName ?? '',
    content: encryptedContent,
    contentType: opts.contentType ?? 'text/plain',
    encryption: 'aes',
    timestamp: Date.now(),
    replyPin: opts.replyPin ?? '',
    mention: opts.mention ?? [],
  };
  const result = await createPin(getMetabotStore(), metabotId, {
    operation: 'create',
    path: '/protocols/simplegroupchat',
    contentType: 'application/json',
    payload: JSON.stringify(body),
  });
  return { pinId: result.pinId };
}

/** True when the group-info envelope carries a real group object for this groupId. */
function isIndexedGroupInfo(json: unknown, groupId: string): boolean {
  if (!json || typeof json !== 'object') return false;
  const envelope = json as { code?: number; data?: unknown };
  if (envelope.code !== 0) return false;
  const data = envelope.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  if ('groupId' in record) return record.groupId === groupId;
  return Object.keys(record).length > 0;
}

async function fetchGroupInfoOnce(endpointBase: string, groupId: string): Promise<boolean> {
  const url = `${endpointBase}/chat-api/group-chat/group-info?groupId=${encodeURIComponent(groupId)}`;
  try {
    const response = await fetch(url);
    if (!response.ok) return false;
    const json: unknown = await response.json();
    return isIndexedGroupInfo(json, groupId);
  } catch {
    return false;
  }
}

/**
 * Poll the indexer until the newly created group pin is indexed (group-info returns
 * a real group object). Tries both endpoints each round; returns false on timeout.
 * Never throws.
 */
export async function waitForGroupIndexed(
  groupId: string,
  timeoutMs: number = DEFAULT_INDEX_TIMEOUT_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const endpoint of GROUP_INFO_ENDPOINTS) {
      if (await fetchGroupInfoOnce(endpoint, groupId)) return true;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(INDEX_POLL_INTERVAL_MS, remaining)));
  }
}
