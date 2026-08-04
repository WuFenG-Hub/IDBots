import React, { useEffect, useState } from 'react';
import { ClipboardDocumentIcon, CheckIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { resolveMetaidAvatarSource } from '../../services/metabotInfoService';
import { getDefaultMetabotAvatarUrl } from '../../utils/rendererAssetPaths';
import MarkdownContent from '../MarkdownContent';
import type { GroupChatTranscriptMessage } from '../../types/groupTask';
import { formatGroupTaskTime } from './groupTaskUtils';

const DEFAULT_AVATAR = getDefaultMetabotAvatarUrl();

/** Module-level resolution cache so the 5s transcript polling never re-resolves. */
const avatarResolutionCache = new Map<string, string | null>();

const isRenderableAvatarSource = (value: string | null | undefined): boolean => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.startsWith('data:image/')
    || normalized.startsWith('http://')
    || normalized.startsWith('https://')
    || normalized.startsWith('blob:');
};

/**
 * Resolve a sender avatar to a renderable URL. Raw MetaWeb avatar values
 * (metafile:// refs, pin ids) go through the main-process resolver used by the
 * A2A views; anything unresolvable falls back to the default metabot avatar.
 */
function useSenderAvatar(message: GroupChatTranscriptMessage): string {
  const raw = message.senderAvatar?.trim() ?? '';
  const direct = isRenderableAvatarSource(raw) ? raw : null;
  const reference = direct ? null : (raw || message.senderGlobalMetaId?.trim() || null);
  const [resolved, setResolved] = useState<string | null>(
    reference ? avatarResolutionCache.get(reference) ?? null : null,
  );

  useEffect(() => {
    if (!reference) return;
    if (avatarResolutionCache.has(reference)) {
      setResolved(avatarResolutionCache.get(reference) ?? null);
      return;
    }
    let cancelled = false;
    resolveMetaidAvatarSource(reference)
      .then((url) => {
        avatarResolutionCache.set(reference, url);
        if (!cancelled) setResolved(url);
      })
      .catch(() => {
        avatarResolutionCache.set(reference, null);
      });
    return () => {
      cancelled = true;
    };
  }, [reference]);

  return direct ?? resolved ?? DEFAULT_AVATAR;
}

/** Full on-chain tx id for the message: explicit tx_id, else pinId minus its 'i0' output suffix. */
function resolveTxId(message: GroupChatTranscriptMessage): string | null {
  const explicit = message.txId?.trim();
  if (explicit) return explicit;
  const pin = message.pinId?.trim();
  if (!pin) return null;
  return pin.endsWith('i0') ? pin.slice(0, -2) : pin;
}

const TxIdBadge: React.FC<{ txId: string }> = ({ txId }) => {
  const [copied, setCopied] = useState(false);
  const short = txId.length > 12 ? `${txId.slice(0, 6)}…${txId.slice(-4)}` : txId;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(txId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable (permissions) — the title tooltip still shows the full id
    }
  };

  return (
    <span className="inline-flex shrink-0 items-center gap-0.5" title={txId}>
      <span className="font-mono text-[10px] dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">
        {short}
      </span>
      <button
        type="button"
        onClick={() => void handleCopy()}
        title={i18nService.t(copied ? 'groupTasksTxidCopied' : 'groupTasksCopyTxid')}
        aria-label={i18nService.t(copied ? 'groupTasksTxidCopied' : 'groupTasksCopyTxid')}
        className="rounded p-0.5 dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover hover:text-claude-text dark:hover:text-claude-darkText transition-colors"
      >
        {copied
          ? <CheckIcon className="h-3 w-3 text-emerald-500" />
          : <ClipboardDocumentIcon className="h-3 w-3" />}
      </button>
    </span>
  );
};

interface GroupTaskMessageItemProps {
  message: GroupChatTranscriptMessage;
  isChairSender: boolean;
  isOwnerSender: boolean;
}

const GroupTaskMessageItem: React.FC<GroupTaskMessageItemProps> = ({
  message,
  isChairSender,
  isOwnerSender,
}) => {
  const senderName = message.senderName?.trim() || 'Unknown';
  const timestamp = formatGroupTaskTime(message.chainTimestamp);
  const avatarSrc = useSenderAvatar(message);
  const txId = resolveTxId(message);

  return (
    <div className="flex items-start gap-2.5 px-4 py-2.5">
      {/* Avatar */}
      <img
        src={avatarSrc}
        alt={senderName}
        className="h-8 w-8 shrink-0 rounded-full object-cover dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover"
        onError={(e) => { (e.currentTarget as HTMLImageElement).src = DEFAULT_AVATAR; }}
      />

      {/* Body */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate">
            {senderName}
          </span>
          {isChairSender && (
            <span className="shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight bg-claude-accent/15 text-claude-accent">
              {i18nService.t('groupTasksChairBadge')}
            </span>
          )}
          {isOwnerSender && (
            <span className="shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
              {i18nService.t('groupTasksOwnerBadge')}
            </span>
          )}
          {timestamp && (
            <span className="shrink-0 text-[11px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
              {timestamp}
            </span>
          )}
          {txId && <TxIdBadge txId={txId} />}
        </div>
        <div
          className={`mt-1 rounded-lg px-3 py-2 text-sm ${
            isOwnerSender
              ? 'dark:bg-emerald-900/20 bg-emerald-50 dark:text-claude-darkText text-claude-text'
              : 'dark:bg-claude-darkSurfaceHover/60 bg-claude-surfaceHover/60 dark:text-claude-darkText text-claude-text'
          }`}
        >
          <MarkdownContent content={message.content ?? ''} className="text-sm" />
        </div>
      </div>
    </div>
  );
};

export default GroupTaskMessageItem;
