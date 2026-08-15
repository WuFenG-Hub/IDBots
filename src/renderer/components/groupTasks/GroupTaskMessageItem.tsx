import React, { useEffect, useState } from 'react';
import { ClipboardDocumentIcon, CheckIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { resolveMetaidAvatarSource } from '../../services/metabotInfoService';
import { getDefaultMetabotAvatarUrl } from '../../utils/rendererAssetPaths';
import { isRenderableAvatarSource as isSharedRenderableAvatarSource } from '../../utils/avatarSource';
import MarkdownContent from '../MarkdownContent';
import type { GroupChatTranscriptMessage } from '../../types/groupTask';
import { formatGroupTaskTime } from './groupTaskUtils';

const DEFAULT_AVATAR = getDefaultMetabotAvatarUrl();

/** Module-level resolution cache so the 5s transcript polling never re-resolves. */
const avatarResolutionCache = new Map<string, string | null>();

const isRenderableAvatarSource = (value: string | null | undefined): boolean =>
  isSharedRenderableAvatarSource(value);

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

/**
 * P0-1: fold over-long [DELIVERABLE] lines (eleven's long delivery was
 * truncated in the group log). Only lines carrying the protocol tag count;
 * plain long prose is never folded.
 */
const DELIVERABLE_FOLD_THRESHOLD = 200;

function hasLongDeliverableLine(content: string): boolean {
  return content.split('\n').some(
    (line) => /\[DELIVERABLE\]/i.test(line) && line.trim().length > DELIVERABLE_FOLD_THRESHOLD,
  );
}

function longDeliverableSummary(content: string): string {
  const lines = content.split('\n');
  const longLines = lines.filter(
    (line) => /\[DELIVERABLE\]/i.test(line) && line.trim().length > DELIVERABLE_FOLD_THRESHOLD,
  );
  const totalChars = longLines.reduce((sum, line) => sum + line.trim().length, 0);
  return `${longLines.length} [DELIVERABLE] line(s), ${totalChars} chars`;
}

interface GroupTaskMessageItemProps {
  message: GroupChatTranscriptMessage;
  isChairSender: boolean;
  isOwnerSender: boolean;
  /** Sender is a remote member who joined via OpenTeam (matched by globalmetaid). */
  isRemoteSender?: boolean;
  /** Sender is one of this machine's own bots (OpenTeam invitee transcript). */
  isOwnBotSender?: boolean;
  /** Briefly highlight this row (e.g. when jumped to from an integrity event). */
  highlight?: boolean;
  /**
   * R5: the message this one replies to (resolved by replyPin from the loaded
   * transcript). null = replyPin set but target not in the loaded window (the
   * bar still shows and clicking jumps/loads it). undefined = no replyPin.
   */
  replyTarget?: { senderName: string; preview: string } | null;
  /** R5: jump to (and load if needed) the replied-to message. */
  onJumpToReply?: (pinId: string) => void;
}


const GroupTaskMessageItem: React.FC<GroupTaskMessageItemProps> = ({
  message,
  isChairSender,
  isOwnerSender,
  isRemoteSender,
  isOwnBotSender,
  highlight,
  replyTarget,
  onJumpToReply,
}) => {
  // Round-4 attribution: the chain-signature GlobalMetaID is the ONLY identity
  // source. A message whose sender is neither a task member nor the owner is
  // flagged SUSPECT — never attributed by senderName.
  const isSuspectSender = message.senderSuspect === true;
  const senderName = message.senderName?.trim() || 'Unknown';
  const timestamp = formatGroupTaskTime(message.chainTimestamp);
  const avatarSrc = useSenderAvatar(message);
  const txId = resolveTxId(message);
  const rawContent = message.content ?? '';
  const longDeliverable = hasLongDeliverableLine(rawContent);
  const [deliverableExpanded, setDeliverableExpanded] = useState(false);


  return (
    <div
      data-pin-id={message.pinId ?? undefined}
      className={`flex items-start gap-2.5 px-4 py-2.5 transition-colors ${
        highlight ? 'ring-2 ring-claude-accent/60 rounded-lg bg-claude-accent/5' : ''
      }`}
    >
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
          {isSuspectSender && (
            <span
              className="shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight bg-amber-500/15 text-amber-600 dark:text-amber-400"
              title="Sender GlobalMetaID is not a task member — not attributed by display name"
            >
              SUSPECT
            </span>
          )}
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
          {isRemoteSender && (
            <span className="shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight bg-green-500/15 text-green-600 dark:text-green-400">
              {i18nService.t('groupTasksRemoteBadge')}
            </span>
          )}
          {isOwnBotSender && (
            <span className="shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
              {i18nService.t('openTeamCollabOwnBotBadge')}
            </span>
          )}
          {timestamp && (
            <span className="shrink-0 text-[11px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
              {timestamp}
            </span>
          )}
          {txId && <TxIdBadge txId={txId} />}
        </div>
        {message.replyPin && (
          <button
            type="button"
            onClick={() => onJumpToReply?.(message.replyPin!)}
            className="mt-1 flex max-w-full items-center gap-1 rounded-md border-l-2 border-claude-accent/50 bg-claude-surfaceHover/40 dark:bg-claude-darkSurfaceHover/40 px-2 py-1 text-left text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary/80 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            title={message.replyPin}
          >
            <span className="shrink-0 text-claude-accent">↩</span>
            <span className="truncate">
              {replyTarget
                ? `${i18nService.t('groupTasksReplyTo')} ${replyTarget.senderName}: ${replyTarget.preview || i18nService.t('groupTasksReplyEmpty')}`
                : `${i18nService.t('groupTasksReplyTo')} ${i18nService.t('groupTasksReplyNotLoaded')}`}
            </span>
          </button>
        )}
        <div
          className={`mt-1 rounded-lg px-3 py-2 text-sm ${
            isOwnerSender
              ? 'dark:bg-emerald-900/20 bg-emerald-50 dark:text-claude-darkText text-claude-text'
              : 'dark:bg-claude-darkSurfaceHover/60 bg-claude-surfaceHover/60 dark:text-claude-darkText text-claude-text'
          }`}
        >
          {longDeliverable && !deliverableExpanded ? (
            <button
              type="button"
              onClick={() => setDeliverableExpanded(true)}
              className="block w-full text-left text-sm dark:text-claude-darkText text-claude-text"
              title="Click to expand the full delivery"
            >
              <span className="inline-flex items-center gap-1.5 rounded bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-600 dark:text-amber-400">
                Folded: {longDeliverableSummary(rawContent)} — click to expand
              </span>
            </button>
          ) : (
            <MarkdownContent content={rawContent} className="text-sm" />
          )}
          {longDeliverable && deliverableExpanded && (
            <button
              type="button"
              onClick={() => setDeliverableExpanded(false)}
              className="mt-1 text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary/70 hover:underline"
            >
              Collapse long delivery
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default GroupTaskMessageItem;
