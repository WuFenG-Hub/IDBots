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
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { fetchMetaidInfoByGlobalId } from '../../services/metabotInfoService';
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
  localIdentityCache = identity;
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

const useRemoteSenderInfo = (globalMetaId?: string): RemoteSenderInfo | null => {
  const [info, setInfo] = useState<RemoteSenderInfo | null>(
    globalMetaId ? remoteSenderCache.get(globalMetaId) ?? null : null,
  );
  useEffect(() => {
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
    void fetchMetaidInfoByGlobalId(globalMetaId)
      .then((result) => {
        const value: RemoteSenderInfo = { name: result.name, avatarUrl: result.avatarUrl ?? null };
        remoteSenderCache.set(globalMetaId, value);
        if (!cancelled) setInfo(value);
      })
      .catch(() => {
        // Keep the id-only fallback; do not cache failures so a later retry can succeed.
      });
    return () => {
      cancelled = true;
    };
  }, [globalMetaId]);
  return info;
};

const shortenGlobalMetaId = (id: string): string =>
  id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;

const KIND_LABEL_KEYS: Partial<Record<UserMessageOriginKind, string>> = {
  heartbeat: 'coworkOriginHeartbeat',
  schedule: 'coworkOriginSchedule',
  cross_session: 'coworkOriginCrossSession',
  orchestrator: 'coworkOriginOrchestrator',
};

const KIND_ICONS: Partial<Record<UserMessageOriginKind, React.ComponentType<{ className?: string }>>> = {
  heartbeat: HeartIcon,
  schedule: ClockIcon,
  cross_session: ArrowsRightLeftIcon,
  orchestrator: CpuChipIcon,
};

const UserMessageOriginBadge: React.FC<{
  message: CoworkMessage;
  sessionType?: string;
  sessionTitle?: string;
}> = ({ message, sessionType, sessionTitle }) => {
  const origin = resolveUserMessageOrigin(message, { sessionType, sessionTitle });
  const identity = useLocalIdentity();
  const isMetawebRelay = origin.kind === 'metaweb_group' || origin.kind === 'metaweb_private';
  const remoteInfo = useRemoteSenderInfo(isMetawebRelay ? origin.senderGlobalMetaId : undefined);

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
      return (
        <div className={containerClass}>
          {remoteInfo?.avatarUrl ? (
            <img src={remoteInfo.avatarUrl} alt="" className={avatarClass} />
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
