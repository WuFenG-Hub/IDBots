/**
 * Source-attribution label for right-side (user-type) bubbles in cowork
 * sessions: a small right-aligned row above the bubble showing who submitted
 * the turn — the local user (avatar + name + "You" chip), a remote bot
 * (avatar + name + "Bot" chip), or a machine origin (heartbeat, scheduled
 * task, cross-session forward, orchestrator) with an icon and label.
 * Colors follow the bubble's own surface/text tokens in both light and dark
 * themes.
 */
import React, { useEffect, useState } from 'react';
import {
  ArrowsRightLeftIcon,
  BoltIcon,
  ChatBubbleLeftRightIcon,
  ClockIcon,
  CpuChipIcon,
  HeartIcon,
  UserCircleIcon,
  UsersIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { fetchMetaidInfoByGlobalId } from '../../services/metabotInfoService';
import { pickRenderableAvatarSource } from '../../utils/avatarSource';
import type { CoworkMessage } from '../../types/cowork';
import { resolveUserMessageOrigin, type UserMessageOriginKind } from './userMessageOrigin';

interface LocalIdentity {
  name: string;
  avatar: string | null;
  globalmetaid: string | null;
}

let localIdentityCache: LocalIdentity | null | undefined;
let localIdentityRequest: Promise<LocalIdentity | null> | null = null;

const loadLocalIdentity = async (): Promise<LocalIdentity | null> => {
  if (localIdentityCache !== undefined) {
    return localIdentityCache;
  }
  if (!localIdentityRequest) {
    localIdentityRequest = (async () => {
      try {
        const result = await window.electron.userIdentity.get();
        const identity = result?.identity;
        if (!result?.success || !identity) {
          return null;
        }
        return {
          name: identity.name,
          avatar: identity.avatar ?? null,
          globalmetaid: identity.globalmetaid ?? null,
        } satisfies LocalIdentity;
      } catch {
        return null;
      }
    })();
  }
  const identity = await localIdentityRequest;
  if (identity) {
    localIdentityCache = identity;
  } else {
    // Failure (or no identity yet) is not terminal: drop the promise so the
    // next mounted badge retries instead of pinning a permanent null.
    localIdentityRequest = null;
  }
  return identity;
};

const useLocalIdentity = (): LocalIdentity | null => {
  const [identity, setIdentity] = useState<LocalIdentity | null>(localIdentityCache ?? null);
  useEffect(() => {
    let cancelled = false;
    void loadLocalIdentity().then((value) => {
      if (!cancelled) setIdentity(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return identity;
};

interface RemoteSenderInfo {
  name?: string;
  avatarUrl?: string | null;
}

const remoteSenderCache = new Map<string, RemoteSenderInfo>();
/** In-flight dedup: a long transcript can mount dozens of badges for the
 * same sender in one frame; they must share a single lookup. */
const remoteSenderRequests = new Map<string, Promise<RemoteSenderInfo>>();

const loadRemoteSenderInfo = (globalMetaId: string): Promise<RemoteSenderInfo> => {
  const cached = remoteSenderCache.get(globalMetaId);
  if (cached) return Promise.resolve(cached);
  let request = remoteSenderRequests.get(globalMetaId);
  if (!request) {
    request = fetchMetaidInfoByGlobalId(globalMetaId)
      .then((result) => {
        const value: RemoteSenderInfo = { name: result.name, avatarUrl: result.avatarUrl ?? null };
        remoteSenderCache.set(globalMetaId, value);
        return value;
      })
      .finally(() => {
        // Failures are not cached — a later mount retries.
        remoteSenderRequests.delete(globalMetaId);
      });
    remoteSenderRequests.set(globalMetaId, request);
  }
  return request;
};

const useRemoteSenderInfo = (
  globalMetaId?: string,
  persisted?: { name?: string; avatarUrl?: string },
): RemoteSenderInfo | null => {
  const hasPersisted = Boolean(persisted?.name || persisted?.avatarUrl);
  const [info, setInfo] = useState<RemoteSenderInfo | null>(() => {
    if (hasPersisted) {
      return { name: persisted?.name, avatarUrl: persisted?.avatarUrl ?? null };
    }
    return globalMetaId ? remoteSenderCache.get(globalMetaId) ?? null : null;
  });
  useEffect(() => {
    if (hasPersisted) {
      setInfo({ name: persisted?.name, avatarUrl: persisted?.avatarUrl ?? null });
      return;
    }
    if (!globalMetaId) {
      setInfo(null);
      return;
    }
    const cached = remoteSenderCache.get(globalMetaId);
    if (cached) {
      setInfo(cached);
      return;
    }
    let cancelled = false;
    void loadRemoteSenderInfo(globalMetaId)
      .then((value) => {
        if (!cancelled) setInfo(value);
      })
      .catch(() => {
        // Keep the id-only fallback; a later mount retries.
      });
    return () => {
      cancelled = true;
    };
  }, [globalMetaId, hasPersisted, persisted?.name, persisted?.avatarUrl]);
  return info;
};

const shortenGlobalMetaId = (id: string): string =>
  id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;

const KIND_LABEL_KEYS: Partial<Record<UserMessageOriginKind, string>> = {
  heartbeat: 'coworkOriginHeartbeat',
  schedule: 'coworkOriginSchedule',
  cross_session: 'coworkOriginCrossSession',
  orchestrator: 'coworkOriginOrchestrator',
  group_task: 'coworkOriginGroupTask',
};

const KIND_ICONS: Partial<Record<UserMessageOriginKind, React.ComponentType<{ className?: string }>>> = {
  heartbeat: HeartIcon,
  schedule: ClockIcon,
  cross_session: ArrowsRightLeftIcon,
  orchestrator: CpuChipIcon,
  group_task: UsersIcon,
};

const UserMessageOriginBadge: React.FC<{
  message: CoworkMessage;
  sessionType?: string;
  sessionTitle?: string;
}> = ({ message, sessionType, sessionTitle }) => {
  const origin = resolveUserMessageOrigin(message, { sessionType, sessionTitle });
  const identity = useLocalIdentity();
  const isMetawebRelay = origin.kind === 'metaweb_group' || origin.kind === 'metaweb_private';
  const remoteInfo = useRemoteSenderInfo(
    isMetawebRelay ? origin.senderGlobalMetaId : undefined,
    isMetawebRelay ? { name: origin.senderName, avatarUrl: origin.senderAvatar } : undefined,
  );

  const containerClass = 'mb-1 flex items-center justify-end gap-1 pr-0.5 select-none';
  const textClass = 'text-[10px] leading-4 dark:text-claude-darkTextSecondary text-claude-textSecondary';
  const iconClass = 'h-3 w-3 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary';
  const chipClass = 'rounded border dark:border-claude-darkBorder/70 border-claude-border/70 dark:bg-claude-darkSurface bg-claude-surface px-1 py-px text-[9px] font-semibold dark:text-claude-darkTextSecondary text-claude-textSecondary';
  const avatarClass = 'h-3.5 w-3.5 shrink-0 rounded-full object-cover';

  // Human-originated turns (composer / quick action), and relayed MetaWeb
  // messages sent by the local user themselves, render as "you".
  const isLocalUserOrigin = origin.kind === 'user'
    || origin.kind === 'quick_action'
    || (isMetawebRelay
      && identity?.globalmetaid != null
      && origin.senderGlobalMetaId === identity.globalmetaid);

  if (isLocalUserOrigin) {
    return (
      <div className={containerClass} title={origin.kind === 'quick_action' ? i18nService.t('coworkOriginQuickAction') : undefined}>
        {origin.kind === 'quick_action' && (
          <BoltIcon className={iconClass} />
        )}
        {identity?.avatar ? (
          <img src={identity.avatar} alt="" className={avatarClass} />
        ) : (
          <UserCircleIcon className="h-3.5 w-3.5 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
        )}
        {identity?.name && (
          <span className={`${textClass} max-w-[120px] truncate font-medium`}>{identity.name}</span>
        )}
        <span className={chipClass}>{i18nService.t('coworkOriginBadgeYou')}</span>
      </div>
    );
  }

  // MetaWeb relay turns from a remote sender: avatar + name + Bot chip.
  if (isMetawebRelay) {
    if (origin.senderGlobalMetaId) {
      const senderName = remoteInfo?.name ?? shortenGlobalMetaId(origin.senderGlobalMetaId);
      const senderAvatarUrl = pickRenderableAvatarSource(remoteInfo?.avatarUrl ?? undefined);
      return (
        <div className={containerClass}>
          {senderAvatarUrl ? (
            <img src={senderAvatarUrl} alt="" className={avatarClass} />
          ) : (
            <UserCircleIcon className="h-3.5 w-3.5 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
          )}
          <span className={`${textClass} max-w-[120px] truncate font-medium`}>{senderName}</span>
          <span className={chipClass}>{i18nService.t('coworkOriginBadgeBot')}</span>
          <span className={`${textClass} opacity-70`}>
            {i18nService.t(origin.kind === 'metaweb_group' ? 'coworkOriginMetawebGroup' : 'coworkOriginMetawebPrivate')}
          </span>
        </div>
      );
    }
    return (
      <div className={containerClass}>
        <ChatBubbleLeftRightIcon className={iconClass} />
        <span className={textClass}>
          {i18nService.t(origin.kind === 'metaweb_group' ? 'coworkOriginMetawebGroup' : 'coworkOriginMetawebPrivate')}
        </span>
      </div>
    );
  }

  // Machine-originated turns: icon + label (+ optional detail).
  const KindIcon = KIND_ICONS[origin.kind] ?? ChatBubbleLeftRightIcon;
  const labelKey = KIND_LABEL_KEYS[origin.kind] ?? 'coworkOriginOrchestrator';
  const label = i18nService.t(labelKey);
  return (
    <div className={containerClass} title={origin.detail}>
      <KindIcon className={iconClass} />
      <span className={textClass}>
        {label}
        {origin.detail && (
          <span className="opacity-70"> · {origin.detail}</span>
        )}
      </span>
    </div>
  );
};

export default UserMessageOriginBadge;
